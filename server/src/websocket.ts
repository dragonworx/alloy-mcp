import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { createPairingProof, verifyPairingProof } from "./auth.js";
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
  private lastPongTime: number = 0;
  private missedPongs: number = 0;
  private readonly maxMissedPongs = 3;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private serverToolNames: string[] = [];

  constructor(
    private readonly config: ServerConfig,
    private readonly pairingToken: string
  ) {}

  /** Set the list of server-registered tool names for handshake validation */
  setServerToolNames(names: string[]): void {
    this.serverToolNames = names;
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  get extensionVersion(): string | null {
    return this.extensionInfo?.version ?? null;
  }

  get extensionCapabilities(): string[] {
    return this.extensionInfo?.capabilities ?? [];
  }

  get listeningPort(): number | null {
    return this.server?.port ?? null;
  }

  start(): void {
    const { port, host } = this.config.websocket;

    try {
      this.server = Bun.serve({
        hostname: host,
        port,
        fetch(req, server) {
          // Only upgrade actual WebSocket requests
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            if (!isAllowedExtensionOrigin(req.headers.get("origin"))) {
              return new Response("Forbidden", { status: 403 });
            }
            if (server.upgrade(req, { data: undefined })) return undefined;
          }
          return new Response("WebSocket server", { status: 200 });
        },
        websocket: {
          open: (ws) => this.handleOpen(ws),
          message: (ws, message) => void this.handleMessage(ws, message),
          close: (ws) => this.handleClose(ws),
          maxPayloadLength: 32 * 1_048_576,
        },
      });
    } catch (err) {
      logger.error(`Failed to bind WebSocket server on ${host}:${port}`, (err as Error).message);
      throw err;
    }

    logger.info(`WebSocket server listening on ws://${host}:${port}`);
  }

  stop(): void {
    this.stopHeartbeat();
    this.clearHandshakeTimer();
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
      this.pendingConnection = null;
      this.pendingServerNonce = null;
      this.pendingConfirmationNonce = null;
      this.pendingHandshake = null;
    }
    this.server?.stop();
    logger.info("WebSocket server stopped");
  }

  async sendToolRequest(tool: string, params: Record<string, unknown>): Promise<ToolResponse> {
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

  private handleOpen(ws: ServerWebSocket<unknown>): void {
    if (this.connection || this.pendingConnection) {
      logger.warn("Rejecting additional connection (max 1) \u2014 existing connection is active");
      ws.close(4000, "Only one connection allowed");
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
        this.pendingConnection = null;
        this.pendingServerNonce = null;
        this.pendingConfirmationNonce = null;
        this.pendingHandshake = null;
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

      if (data.type === "pong") {
        this.lastPongTime = Date.now();
        this.missedPongs = 0;
        logger.debug("Heartbeat pong received");
        return;
      }

      // Handle page connection logging
      if (data.event) {
        logger.debug("Extension event", data);
        return;
      }

      if (data.requestId) {
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
    this.pendingConnection = null;
    this.pendingServerNonce = null;
    this.pendingConfirmationNonce = null;
    this.pendingHandshake = null;
    this.clearHandshakeTimer();
    ws.close(code, reason);
  }

  private handleClose(ws: ServerWebSocket<unknown>): void {
    if (ws === this.pendingConnection) {
      this.pendingConnection = null;
      this.pendingServerNonce = null;
      this.pendingConfirmationNonce = null;
      this.pendingHandshake = null;
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
      this.pendingConnection = null;
      this.pendingServerNonce = null;
      this.pendingConfirmationNonce = null;
      this.pendingHandshake = null;
      this.clearHandshakeTimer();
      ws.close(4004, "Extension authentication confirmation failed");
      return;
    }

    const msg = this.pendingHandshake;
    this.clearHandshakeTimer();
    this.pendingConnection = null;
    this.pendingServerNonce = null;
    this.pendingConfirmationNonce = null;
    this.pendingHandshake = null;
    this.connection = ws;
    this.extensionInfo = msg;
    this.lastPongTime = Date.now();
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
    this.lastPongTime = Date.now();
    this.missedPongs = 0;
    this.heartbeatInterval = setInterval(() => {
      // Check if previous pong was received
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > 35_000) {
        this.missedPongs++;
        logger.warn(`Heartbeat: no pong received (missed ${this.missedPongs}/${this.maxMissedPongs}, last pong ${Math.round(timeSinceLastPong / 1000)}s ago)`);
        if (this.missedPongs >= this.maxMissedPongs) {
          logger.error("Heartbeat failure: extension unresponsive, closing connection");
          if (this.connection) {
            try {
              this.connection.close(4001, "Heartbeat timeout");
            } catch (_) { /* ignore */ }
          }
          return;
        }
      }
      this.send({ type: "ping", timestamp: Date.now() });
    }, 30_000);
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
}
