import type { Server, ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { createPairingProof, verifyPairingProof } from "./auth.js";
import { ErrorCode } from "./errors.js";
import { logger } from "./logger.js";
import type { ServerConfig } from "./config.js";
import { serverOnlyToolNames } from "./tools.js";

export interface ToolRequest {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResponse {
  requestId: string;
  result?: unknown;
  error?: { message: string; code: number; details?: unknown };
  timestamp: number;
}

interface PendingRequest {
  resolve: (value: ToolResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type BridgeFailure = "not_connected" | "connection_lost" | "shutdown" | "timeout";

export class BridgeRequestError extends Error {
  constructor(public readonly reason: BridgeFailure, message: string) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

interface HandshakeMessage {
  type: "handshake";
  version: string;
  capabilities: string[];
  browserId: string;
  extensionNonce: string;
  proof: string;
}

export type SocketKind = "extension" | "follower";
type SocketData = { kind: SocketKind };

/** A peer Alloy server that relays its tool calls through this leader. */
interface FollowerState {
  authenticated: boolean;
  serverNonce: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FollowerHandshakeMessage {
  type: "follower_handshake";
  followerNonce: string;
  proof: string;
}

/** Followers connect here; the extension uses the root path. */
const FOLLOWER_PATH = "/follower";
/** A follower (or a leader waiting on one) must finish auth within this window. */
const FOLLOWER_CONNECT_TIMEOUT_MS = 4_000;
/** Delay before a stranded follower retries leading or rejoining. */
const HUB_REJOIN_DELAY_MS = 250;
/** Follower -> leader keepalive cadence; also refreshes cached extension status. */
const HUB_KEEPALIVE_INTERVAL_MS = 5_000;

export function isAllowedExtensionOrigin(origin: string | null): boolean {
  return origin !== null && /^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin);
}

export function isValidHandshakeMessage(value: unknown): value is HandshakeMessage {
  if (typeof value !== "object" || value === null) return false;

  const message = value as Record<string, unknown>;
  return message.type === "handshake"
    && typeof message.version === "string"
    && message.version.length > 0
    && message.version.length <= 64
    && typeof message.browserId === "string"
    && message.browserId.length > 0
    && message.browserId.length <= 128
    && typeof message.extensionNonce === "string"
    && message.extensionNonce.length >= 16
    && message.extensionNonce.length <= 128
    && typeof message.proof === "string"
    && /^[a-f0-9]{64}$/i.test(message.proof)
    && Array.isArray(message.capabilities)
    && message.capabilities.length <= 500
    && message.capabilities.includes("list_tabs")
    && message.capabilities.every(
      capability => typeof capability === "string" && capability.length > 0 && capability.length <= 100
    );
}

export function isValidFollowerHandshake(value: unknown): value is FollowerHandshakeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === "follower_handshake"
    && typeof message.followerNonce === "string"
    && message.followerNonce.length >= 16
    && message.followerNonce.length <= 128
    && typeof message.proof === "string"
    && /^[a-f0-9]{64}$/i.test(message.proof);
}

export function getToolRequestTimeout(
  config: ServerConfig,
  tool: string,
  params: Record<string, unknown>
): number {
  if (tool === "take_screenshot" || tool === "capture_element") {
    return config.timeouts.screenshot;
  }

  let expectedDuration = config.timeouts.toolExecution - 5_000;
  if (["navigate", "go_back", "go_forward", "refresh_page"].includes(tool)) {
    expectedDuration = config.timeouts.pageLoad;
  }
  if (typeof params.timeout === "number") expectedDuration = params.timeout;
  if (typeof params.duration === "number") expectedDuration = params.duration;
  if (tool === "type_text" && typeof params.text === "string") {
    expectedDuration = params.text.length * (typeof params.delayPerChar === "number" ? params.delayPerChar : 50);
  }
  if (tool === "press_key" && typeof params.repeat === "number") {
    expectedDuration = Math.max(0, params.repeat - 1)
      * (typeof params.delay === "number" ? params.delay : 50);
  }
  return Math.max(config.timeouts.toolExecution, Math.min(115_000, expectedDuration + 5_000));
}

export class WebSocketBridge {
  private connection: ServerWebSocket<unknown> | null = null;
  private pendingConnection: ServerWebSocket<unknown> | null = null;
  private pendingServerNonce: string | null = null;
  private pendingConfirmationNonce: string | null = null;
  private pendingHandshake: HandshakeMessage | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private extensionInfo: HandshakeMessage | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastActivityTime: number = 0;
  private missedPongs: number = 0;
  private connectedSince: number = 0;
  /** Ping cadence. Short so a dead peer is noticed in seconds, not minutes. */
  private readonly heartbeatIntervalMs = 5_000;
  /** Silence that counts as a missed beat. Generous enough to ride out a busy tool call. */
  private readonly silenceThresholdMs = 15_000;
  private readonly maxMissedPongs = 3;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private serverToolNames: string[] = [];

  /**
   * "leader" owns the port and the single extension connection. "follower"
   * could not bind the port, so it relays its tool calls through the leader.
   * The role flips at runtime during re-election when a leader goes away.
   */
  private role: "leader" | "follower" = "leader";
  private stopped = false;

  // Leader-only: peer servers relaying their tool calls through us.
  private readonly followers = new Map<ServerWebSocket<SocketData>, FollowerState>();
  // Leader-only: maps an in-flight relayed request to the follower awaiting it.
  private readonly followerRouting = new Map<string, ServerWebSocket<SocketData>>();

  // Follower-only: our client link to the leader and the status it reports.
  private hubClient: WebSocket | null = null;
  private hubAuthenticated = false;
  private hubServerNonce: string | null = null;
  private hubNonce = "";
  private hubKeepalive: ReturnType<typeof setInterval> | null = null;
  private hubConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private hubExtensionConnected = false;
  private hubExtensionVersion: string | null = null;
  private hubExtensionCapabilities: string[] = [];
  private hubLastActivityTime = 0;
  private hubConnectedSince = 0;

  constructor(
    private readonly config: ServerConfig,
    private readonly pairingToken: string
  ) {}

  /** Set the list of server-registered tool names for handshake validation */
  setServerToolNames(names: string[]): void {
    this.serverToolNames = names;
  }

  get isConnected(): boolean {
    if (this.role === "follower") return this.hubAuthenticated && this.hubExtensionConnected;
    return this.connection !== null;
  }

  get extensionVersion(): string | null {
    if (this.role === "follower") return this.hubExtensionVersion;
    return this.extensionInfo?.version ?? null;
  }

  get extensionCapabilities(): string[] {
    if (this.role === "follower") return this.hubExtensionCapabilities;
    return this.extensionInfo?.capabilities ?? [];
  }

  get listeningPort(): number | null {
    return this.server?.port ?? null;
  }

  /** Milliseconds since the extension last sent anything, or null when disconnected. */
  get millisecondsSinceLastActivity(): number | null {
    if (this.role === "follower") {
      return this.hubExtensionConnected ? Date.now() - this.hubLastActivityTime : null;
    }
    return this.connection ? Date.now() - this.lastActivityTime : null;
  }

  get connectedSinceTimestamp(): number | null {
    if (this.role === "follower") {
      return this.hubExtensionConnected ? this.hubConnectedSince : null;
    }
    return this.connection ? this.connectedSince : null;
  }

  start(): void {
    this.stopped = false;
    this.joinOrLead();
  }

  /**
   * Elect a role by trying to own the port. Whoever binds first is the leader;
   * every other window's server becomes a follower that relays through it.
   */
  private joinOrLead(): void {
    if (this.stopped) return;
    this.clearRejoinTimer();
    if (this.bindAsLeader()) return;
    this.connectAsFollower();
  }

  private bindAsLeader(): boolean {
    const { port, host } = this.config.websocket;
    try {
      this.server = Bun.serve({
        hostname: host,
        port,
        fetch: (req, server) => this.handleUpgrade(req, server as Server<SocketData>),
        websocket: {
          open: (ws) => this.dispatchOpen(ws as ServerWebSocket<SocketData>),
          message: (ws, message) => this.dispatchMessage(ws as ServerWebSocket<SocketData>, message),
          close: (ws) => this.dispatchClose(ws as ServerWebSocket<SocketData>),
          maxPayloadLength: 32 * 1_048_576,
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        logger.info(`Port ${port} is already owned by an Alloy hub; joining it as a follower`);
        return false;
      }
      logger.error(`Failed to bind WebSocket server on ${host}:${port}`, (err as Error).message);
      throw err;
    }

    this.role = "leader";
    logger.info(`WebSocket server listening on ws://${host}:${port} (hub leader)`);
    return true;
  }

  private handleUpgrade(req: Request, server: Server<SocketData>): Response | undefined {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket server", { status: 200 });
    }

    const origin = req.headers.get("origin");
    const pathname = new URL(req.url).pathname;

    if (pathname === FOLLOWER_PATH) {
      // Followers are local Alloy server processes, never browser pages. A native
      // WebSocket client sends no Origin; browsers always do. Refusing any Origin
      // keeps web pages off this path even before the token handshake runs.
      if (origin !== null) return new Response("Forbidden", { status: 403 });
      if (server.upgrade(req, { data: { kind: "follower" } as SocketData })) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (!isAllowedExtensionOrigin(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (server.upgrade(req, { data: { kind: "extension" } as SocketData })) return undefined;
    return new Response("WebSocket server", { status: 200 });
  }

  private dispatchOpen(ws: ServerWebSocket<SocketData>): void {
    if (ws.data.kind === "follower") this.handleFollowerOpen(ws);
    else this.handleOpen(ws);
  }

  private dispatchMessage(ws: ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (ws.data.kind === "follower") this.handleFollowerMessage(ws, message);
    else void this.handleMessage(ws, message);
  }

  private dispatchClose(ws: ServerWebSocket<SocketData>): void {
    if (ws.data.kind === "follower") this.handleFollowerSocketClose(ws);
    else this.handleClose(ws);
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.stopHubKeepalive();
    this.clearHandshakeTimer();
    this.clearHubConnectTimer();
    this.clearRejoinTimer();
    this.rejectAllPending("shutdown", "Server shutting down");
    if (this.connection) {
      try {
        this.connection.close(1001, "Server shutting down");
      } catch (_) { /* ignore close errors */ }
      this.connection = null;
    }
    if (this.pendingConnection) {
      try {
        this.pendingConnection.close(1001, "Server shutting down");
      } catch (_) { /* ignore close errors */ }
      this.clearPendingState();
    }
    for (const [ws, state] of this.followers) {
      if (state.timer) clearTimeout(state.timer);
      try {
        ws.close(1001, "Server shutting down");
      } catch (_) { /* ignore close errors */ }
    }
    this.followers.clear();
    this.followerRouting.clear();
    if (this.hubClient) {
      try {
        this.hubClient.close(1001, "Server shutting down");
      } catch (_) { /* ignore close errors */ }
      this.hubClient = null;
    }
    this.hubAuthenticated = false;
    this.hubExtensionConnected = false;
    this.server?.stop();
    this.server = null;
    logger.info("WebSocket bridge stopped");
  }

  async sendToolRequest(tool: string, params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.role === "follower") return this.sendViaHub(tool, params);

    const requestId = crypto.randomUUID();
    const request: ToolRequest = {
      requestId,
      tool,
      params,
      timestamp: Date.now(),
    };

    if (!this.isConnected) {
      throw new BridgeRequestError("not_connected", "Chrome extension is not connected");
    }

    return new Promise<ToolResponse>((resolve, reject) => {
      const timeout = getToolRequestTimeout(this.config, tool, params);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new BridgeRequestError("timeout", `Tool execution timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      if (this.isConnected) {
        this.send(request);
      }
    });
  }

  /** Follower path: relay a tool call to the leader and await its response. */
  private sendViaHub(tool: string, params: Record<string, unknown>): Promise<ToolResponse> {
    const client = this.hubClient;
    if (!this.hubAuthenticated || !client) {
      return Promise.reject(new BridgeRequestError("not_connected", "Alloy hub is not connected"));
    }
    if (!this.hubExtensionConnected) {
      return Promise.reject(new BridgeRequestError("not_connected", "Chrome extension is not connected"));
    }

    const requestId = crypto.randomUUID();
    const request: ToolRequest = { requestId, tool, params, timestamp: Date.now() };

    return new Promise<ToolResponse>((resolve, reject) => {
      const timeout = getToolRequestTimeout(this.config, tool, params);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new BridgeRequestError("timeout", `Tool execution timed out after ${timeout}ms`));
      }, timeout);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        client.send(JSON.stringify(request));
      } catch (_) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new BridgeRequestError("connection_lost", "Alloy hub connection lost"));
      }
    });
  }

  private clearPendingState(): void {
    this.pendingConnection = null;
    this.pendingServerNonce = null;
    this.pendingConfirmationNonce = null;
    this.pendingHandshake = null;
  }

  private handleOpen(ws: ServerWebSocket<unknown>): void {
    // An in-progress handshake still gets exclusive use of the slot, bounded by
    // the handshake timer, so an unauthenticated peer cannot displace one.
    // An already-authenticated connection does NOT block a new attempt: it may
    // be a socket the OS never told us died, and refusing the replacement used
    // to strand the extension until the heartbeat finally expired. Taking over
    // still requires completing the full handshake, below.
    if (this.pendingConnection) {
      logger.warn("Rejecting a connection while another handshake is in progress");
      ws.close(4000, "Handshake already in progress");
      return;
    }

    this.pendingConnection = ws;
    this.pendingServerNonce = randomBytes(32).toString("hex");
    this.pendingConfirmationNonce = null;
    this.pendingHandshake = null;
    logger.info("WebSocket connected; awaiting extension handshake");
    ws.send(JSON.stringify({
      type: "auth_challenge",
      serverNonce: this.pendingServerNonce,
      requestedCapabilities: this.serverToolNames,
      limits: {
        maxScreenshotDimension: this.config.limits.maxScreenshotDimension,
        maxScreenshotPayloadBytes: this.config.limits.maxScreenshotPayloadBytes,
      },
      timestamp: Date.now(),
    }));
    this.startHandshakeTimer(ws);
  }

  private startHandshakeTimer(ws: ServerWebSocket<unknown>): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      if (this.pendingConnection === ws) {
        this.clearPendingState();
        ws.close(4002, "Extension handshake timed out");
      }
    }, 5_000);
  }

  private async handleMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): Promise<void> {
    try {
      const data = JSON.parse(typeof message === "string" ? message : message.toString());

      if (ws === this.pendingConnection) {
        this.handlePendingMessage(ws, data);
        return;
      }

      if (ws !== this.connection) return;

      // Any frame proves the peer is alive, not just an explicit pong.
      this.lastActivityTime = Date.now();
      this.missedPongs = 0;

      if (data.type === "pong") {
        logger.debug("Heartbeat pong received");
        return;
      }

      // The extension probes us with keepalives; acknowledging them lets it
      // detect a half-open socket from its side too.
      if (data.type === "keepalive") {
        this.send({ type: "keepalive_ack", timestamp: Date.now() });
        return;
      }

      // Handle page connection logging
      if (data.event) {
        logger.debug("Extension event", data);
        return;
      }

      if (data.requestId) {
        const follower = this.followerRouting.get(data.requestId);
        if (follower) {
          this.followerRouting.delete(data.requestId);
          try {
            follower.send(JSON.stringify(data));
          } catch (_) { /* follower vanished; drop the response */ }
          return;
        }
        this.handleToolResponse(data as ToolResponse);
      }
    } catch (err) {
      logger.error("Failed to parse message", err);
      if (ws === this.pendingConnection) {
        this.rejectPendingHandshake(ws, 4003, "Invalid extension handshake");
      }
    }
  }

  private handlePendingMessage(ws: ServerWebSocket<unknown>, data: unknown): void {
    if (this.pendingHandshake) {
      this.handleHandshakeConfirmation(ws, data);
      return;
    }
    if (!isValidHandshakeMessage(data) || !this.pendingServerNonce) {
      this.rejectPendingHandshake(ws, 4003, "Invalid extension handshake");
      return;
    }
    const expectedProof = createPairingProof(
      this.pairingToken,
      "extension",
      this.pendingServerNonce,
      data.extensionNonce
    );
    if (!verifyPairingProof(data.proof, expectedProof)) {
      this.rejectPendingHandshake(ws, 4004, "Extension authentication failed");
      return;
    }
    this.beginHandshakeConfirmation(ws, data);
  }

  private rejectPendingHandshake(ws: ServerWebSocket<unknown>, code: number, reason: string): void {
    this.clearPendingState();
    this.clearHandshakeTimer();
    ws.close(code, reason);
  }

  private handleClose(ws: ServerWebSocket<unknown>): void {
    if (ws === this.pendingConnection) {
      this.clearPendingState();
      this.clearHandshakeTimer();
      logger.warn("WebSocket disconnected before extension handshake");
      return;
    }

    // Only clear state if the closing WS is our active connection.
    // Rejected connections also fire close — ignore those.
    if (ws !== this.connection) {
      logger.debug("Non-primary WebSocket closed (rejected or stale)");
      return;
    }
    logger.warn("Chrome extension disconnected");
    this.connection = null;
    this.extensionInfo = null;
    this.stopHeartbeat();
    this.rejectAllPending("connection_lost", "Chrome extension disconnected");
    this.broadcastHubStatus();
  }

  private beginHandshakeConfirmation(ws: ServerWebSocket<unknown>, msg: HandshakeMessage): void {
    if (!this.pendingServerNonce) {
      ws.close(4003, "Invalid extension handshake");
      return;
    }
    const confirmationNonce = randomBytes(32).toString("hex");
    const serverProof = createPairingProof(
      this.pairingToken,
      "server",
      this.pendingServerNonce,
      msg.extensionNonce,
      confirmationNonce
    );
    this.pendingConfirmationNonce = confirmationNonce;
    this.pendingHandshake = msg;
    this.startHandshakeTimer(ws);
    ws.send(JSON.stringify({
      type: "handshake_ack",
      proof: serverProof,
      confirmationNonce,
      timestamp: Date.now(),
    }));
  }

  private handleHandshakeConfirmation(ws: ServerWebSocket<unknown>, data: unknown): void {
    if (!this.pendingServerNonce || !this.pendingConfirmationNonce || !this.pendingHandshake) {
      ws.close(4003, "Invalid extension handshake confirmation");
      return;
    }
    const confirmation = data as Record<string, unknown>;
    const expectedProof = createPairingProof(
      this.pairingToken,
      "extension-confirmation",
      this.pendingServerNonce,
      this.pendingHandshake.extensionNonce,
      this.pendingConfirmationNonce
    );
    if (
      confirmation.type !== "handshake_complete"
      || typeof confirmation.proof !== "string"
      || !verifyPairingProof(confirmation.proof, expectedProof)
    ) {
      this.clearPendingState();
      this.clearHandshakeTimer();
      ws.close(4004, "Extension authentication confirmation failed");
      return;
    }

    const msg = this.pendingHandshake;
    const superseded = this.connection;
    this.clearHandshakeTimer();
    this.clearPendingState();

    // A freshly authenticated extension replaces whatever we were holding. The
    // old socket is usually a zombie the OS never told us about, and refusing
    // the new one would strand the extension until the heartbeat expired.
    if (superseded && superseded !== ws) {
      logger.warn("Replacing the previous extension connection with a newly authenticated one");
      this.stopHeartbeat();
      this.rejectAllPending("connection_lost", "Extension reconnected; in-flight request abandoned");
      try {
        superseded.close(4006, "Superseded by a newer extension connection");
      } catch (_) { /* ignore close errors */ }
    }

    this.connection = ws;
    this.extensionInfo = msg;
    this.lastActivityTime = Date.now();
    this.connectedSince = Date.now();
    this.missedPongs = 0;
    logger.info("Extension handshake complete", {
      version: msg.version,
      capabilities: msg.capabilities.length,
      browserId: msg.browserId,
    });

    // Validate tool name alignment with extension capabilities
    if (Array.isArray(msg.capabilities) && this.serverToolNames.length > 0) {
      const serverOnlyTools = new Set<string>(serverOnlyToolNames);
      const extensionTools = new Set(msg.capabilities);
      const missingInExtension = this.serverToolNames.filter(t => !serverOnlyTools.has(t) && !extensionTools.has(t));
      const extraInExtension = msg.capabilities.filter((t: string) => !this.serverToolNames.includes(t));
      if (missingInExtension.length > 0) {
        logger.warn("Tools registered on server but missing in extension", missingInExtension);
      }
      if (extraInExtension.length > 0) {
        logger.warn("Tools in extension but not registered on server", extraInExtension);
      }
    }

    this.startHeartbeat();
    this.send({ type: "auth_ready", timestamp: Date.now() });
    this.broadcastHubStatus();
  }

  private handleToolResponse(response: ToolResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      logger.warn("Received response for unknown request", { requestId: response.requestId });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.requestId);
    pending.resolve(response);
  }

  private send(data: unknown): void {
    if (this.connection) {
      this.connection.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastActivityTime = Date.now();
    this.missedPongs = 0;
    this.heartbeatInterval = setInterval(() => {
      const silenceMs = Date.now() - this.lastActivityTime;
      if (silenceMs > this.silenceThresholdMs) {
        this.missedPongs++;
        logger.warn(`Heartbeat: extension silent for ${Math.round(silenceMs / 1000)}s (missed ${this.missedPongs}/${this.maxMissedPongs})`);
        if (this.missedPongs >= this.maxMissedPongs) {
          logger.error("Heartbeat failure: extension unresponsive, dropping connection");
          const dead = this.connection;
          // Drop our own reference immediately. A half-open socket can swallow
          // close() without ever firing onclose, and until we let go of it the
          // extension's reconnect has nothing to take over from.
          this.connection = null;
          this.extensionInfo = null;
          this.stopHeartbeat();
          this.rejectAllPending("connection_lost", "Chrome extension stopped responding");
          if (dead) {
            try {
              dead.close(4001, "Heartbeat timeout");
            } catch (_) { /* ignore close errors */ }
          }
          this.broadcastHubStatus();
          return;
        }
      }
      this.send({ type: "ping", timestamp: Date.now() });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private rejectAllPending(reason: BridgeFailure, message: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeRequestError(reason, message));
    }
    this.pendingRequests.clear();
  }

  // ─── Leader: follower (peer server) handling ──────────────────────

  private handleFollowerOpen(ws: ServerWebSocket<SocketData>): void {
    const serverNonce = randomBytes(32).toString("hex");
    const timer = setTimeout(() => {
      if (this.followers.get(ws)?.authenticated === false) {
        this.followers.delete(ws);
        try {
          ws.close(4002, "Follower handshake timed out");
        } catch (_) { /* ignore close errors */ }
      }
    }, FOLLOWER_CONNECT_TIMEOUT_MS);
    this.followers.set(ws, { authenticated: false, serverNonce, timer });
    ws.send(JSON.stringify({ type: "auth_challenge", serverNonce, timestamp: Date.now() }));
    logger.info("Follower connecting; awaiting handshake");
  }

  private handleFollowerMessage(ws: ServerWebSocket<SocketData>, message: string | Buffer): void {
    const state = this.followers.get(ws);
    if (!state) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(typeof message === "string" ? message : message.toString());
    } catch (_) {
      this.dropFollower(ws, 4003, "Invalid follower message");
      return;
    }

    if (!state.authenticated) {
      this.authenticateFollower(ws, state, data);
      return;
    }

    if (data.type === "keepalive") {
      ws.send(JSON.stringify({ type: "keepalive_ack", ...this.hubStatusPayload(), timestamp: Date.now() }));
      return;
    }
    if (typeof data.requestId === "string" && typeof data.tool === "string") {
      this.relayFollowerRequest(ws, data as unknown as ToolRequest);
    }
  }

  private authenticateFollower(
    ws: ServerWebSocket<SocketData>,
    state: FollowerState,
    data: Record<string, unknown>
  ): void {
    if (!isValidFollowerHandshake(data)) {
      this.dropFollower(ws, 4003, "Invalid follower handshake");
      return;
    }
    const expected = createPairingProof(this.pairingToken, "follower", state.serverNonce, data.followerNonce);
    if (!verifyPairingProof(data.proof, expected)) {
      this.dropFollower(ws, 4004, "Follower authentication failed");
      return;
    }

    state.authenticated = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const proof = createPairingProof(this.pairingToken, "hub", state.serverNonce, data.followerNonce);
    ws.send(JSON.stringify({ type: "follower_ack", proof, timestamp: Date.now() }));
    ws.send(JSON.stringify({ type: "hub_status", ...this.hubStatusPayload(), timestamp: Date.now() }));
    logger.info("Follower authenticated; relaying its tool calls to the extension");
  }

  private relayFollowerRequest(ws: ServerWebSocket<SocketData>, request: ToolRequest): void {
    if (!this.connection) {
      ws.send(JSON.stringify({
        requestId: request.requestId,
        error: { message: "Chrome extension is not connected", code: ErrorCode.EXTENSION_NOT_CONNECTED },
        timestamp: Date.now(),
      }));
      return;
    }
    this.followerRouting.set(request.requestId, ws);
    this.send({
      requestId: request.requestId,
      tool: request.tool,
      params: request.params,
      timestamp: Date.now(),
    });
  }

  private dropFollower(ws: ServerWebSocket<SocketData>, code: number, reason: string): void {
    const state = this.followers.get(ws);
    if (state?.timer) clearTimeout(state.timer);
    this.followers.delete(ws);
    try {
      ws.close(code, reason);
    } catch (_) { /* ignore close errors */ }
  }

  private handleFollowerSocketClose(ws: ServerWebSocket<SocketData>): void {
    const state = this.followers.get(ws);
    if (state?.timer) clearTimeout(state.timer);
    this.followers.delete(ws);
    for (const [requestId, target] of this.followerRouting) {
      if (target === ws) this.followerRouting.delete(requestId);
    }
    logger.info("Follower disconnected");
  }

  private hubStatusPayload(): {
    extensionConnected: boolean;
    extensionVersion: string | null;
    extensionCapabilities: string[];
    lastActivityTime: number;
    connectedSince: number;
  } {
    return {
      extensionConnected: this.connection !== null,
      extensionVersion: this.extensionInfo?.version ?? null,
      extensionCapabilities: this.extensionInfo?.capabilities ?? [],
      lastActivityTime: this.connection ? this.lastActivityTime : 0,
      connectedSince: this.connection ? this.connectedSince : 0,
    };
  }

  private broadcastHubStatus(): void {
    if (this.followers.size === 0) return;
    const payload = JSON.stringify({ type: "hub_status", ...this.hubStatusPayload(), timestamp: Date.now() });
    for (const [ws, state] of this.followers) {
      if (!state.authenticated) continue;
      try {
        ws.send(payload);
      } catch (_) { /* ignore send errors */ }
    }
  }

  // ─── Follower: client link to the leader ──────────────────────────

  private connectAsFollower(): void {
    if (this.stopped) return;
    this.role = "follower";

    const { port } = this.config.websocket;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}${FOLLOWER_PATH}`);
    } catch (_) {
      this.scheduleRejoin();
      return;
    }

    this.hubClient = ws;
    this.hubAuthenticated = false;
    this.hubServerNonce = null;
    this.hubNonce = randomBytes(16).toString("hex");
    this.hubConnectTimer = setTimeout(() => {
      if (!this.hubAuthenticated) {
        try {
          ws.close();
        } catch (_) { /* ignore close errors */ }
      }
    }, FOLLOWER_CONNECT_TIMEOUT_MS);

    ws.addEventListener("message", (event) => this.handleHubMessage(String(event.data)));
    ws.addEventListener("close", () => this.onHubLinkClosed(ws));
    ws.addEventListener("error", () => this.onHubLinkClosed(ws));
  }

  private handleHubMessage(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (data.type) {
      case "auth_challenge": {
        if (typeof data.serverNonce !== "string") return;
        this.hubServerNonce = data.serverNonce;
        const proof = createPairingProof(this.pairingToken, "follower", data.serverNonce, this.hubNonce);
        this.hubClient?.send(JSON.stringify({ type: "follower_handshake", followerNonce: this.hubNonce, proof }));
        return;
      }
      case "follower_ack": {
        this.completeHubHandshake(data);
        return;
      }
      case "hub_status":
      case "keepalive_ack": {
        this.applyHubStatus(data);
        return;
      }
      default: {
        if (typeof data.requestId === "string") this.handleToolResponse(data as unknown as ToolResponse);
      }
    }
  }

  private completeHubHandshake(data: Record<string, unknown>): void {
    if (!this.hubServerNonce || typeof data.proof !== "string") return;
    const expected = createPairingProof(this.pairingToken, "hub", this.hubServerNonce, this.hubNonce);
    if (!verifyPairingProof(data.proof, expected)) {
      logger.error("Alloy hub failed authentication; refusing to trust it");
      try {
        this.hubClient?.close(4004, "Hub authentication failed");
      } catch (_) { /* ignore close errors */ }
      return;
    }
    this.hubAuthenticated = true;
    this.clearHubConnectTimer();
    this.startHubKeepalive();
    logger.info("Connected to the Alloy hub as a follower");
  }

  private applyHubStatus(data: Record<string, unknown>): void {
    if (typeof data.extensionConnected === "boolean") this.hubExtensionConnected = data.extensionConnected;
    if ("extensionVersion" in data) {
      this.hubExtensionVersion = typeof data.extensionVersion === "string" ? data.extensionVersion : null;
    }
    if (Array.isArray(data.extensionCapabilities)) {
      this.hubExtensionCapabilities = data.extensionCapabilities.filter((c): c is string => typeof c === "string");
    }
    if (typeof data.lastActivityTime === "number") this.hubLastActivityTime = data.lastActivityTime;
    if (typeof data.connectedSince === "number") this.hubConnectedSince = data.connectedSince;
  }

  private onHubLinkClosed(ws: WebSocket): void {
    if (this.stopped) return;
    if (this.hubClient !== ws) return; // stale event from a superseded socket

    this.hubClient = null;
    this.hubAuthenticated = false;
    this.hubExtensionConnected = false;
    this.stopHubKeepalive();
    this.clearHubConnectTimer();
    this.rejectAllPending("connection_lost", "Alloy hub connection lost");
    logger.warn("Alloy hub link closed; will try to lead or rejoin");
    this.scheduleRejoin();
  }

  private startHubKeepalive(): void {
    this.stopHubKeepalive();
    this.hubKeepalive = setInterval(() => {
      try {
        this.hubClient?.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }));
      } catch (_) { /* the close handler re-elects */ }
    }, HUB_KEEPALIVE_INTERVAL_MS);
  }

  private stopHubKeepalive(): void {
    if (this.hubKeepalive) {
      clearInterval(this.hubKeepalive);
      this.hubKeepalive = null;
    }
  }

  private clearHubConnectTimer(): void {
    if (this.hubConnectTimer) {
      clearTimeout(this.hubConnectTimer);
      this.hubConnectTimer = null;
    }
  }

  private scheduleRejoin(): void {
    if (this.stopped || this.rejoinTimer) return;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.joinOrLead();
    }, HUB_REJOIN_DELAY_MS);
  }

  private clearRejoinTimer(): void {
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }
}
