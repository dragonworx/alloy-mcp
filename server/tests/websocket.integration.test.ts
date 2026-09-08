import { afterEach, describe, expect, test } from "bun:test";
import { createPairingProof, verifyPairingProof } from "../src/auth.js";
import { defaultConfig } from "../src/config.js";
import { WebSocketBridge } from "../src/websocket.js";

const token = "cd".repeat(32);
let bridge: WebSocketBridge | null = null;
let socket: WebSocket | null = null;

afterEach(() => {
  socket?.close();
  socket = null;
  bridge?.stop();
  bridge = null;
});

describe("authenticated WebSocket bridge", () => {
  test("authenticates both peers and completes a tool round trip", async () => {
    bridge = new WebSocketBridge({
      ...defaultConfig,
      websocket: { ...defaultConfig.websocket, port: 0 },
    }, token);
    bridge.setServerToolNames(["list_tabs"]);
    bridge.start();

    expect(bridge.isConnected).toBe(false);
    expect(bridge.listeningPort).toBeNumber();

    socket = new WebSocket(`ws://127.0.0.1:${bridge.listeningPort}`, {
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      },
    } as never);

    const extensionNonce = "ef".repeat(32);
    let serverNonce = "";
    const authenticated = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Authentication timed out")), 2_000);

      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "auth_challenge") {
          serverNonce = message.serverNonce;
          expect(message.limits).toEqual({
            maxScreenshotDimension: 4096,
            maxScreenshotPayloadBytes: 24 * 1_048_576,
          });
          socket!.send(JSON.stringify({
            type: "handshake",
            version: "1.0.0-test",
            capabilities: ["list_tabs"],
            browserId: "integration-test",
            extensionNonce,
            proof: createPairingProof(token, "extension", message.serverNonce, extensionNonce),
          }));
          return;
        }

        if (message.type === "handshake_ack") {
          const expected = createPairingProof(
            token,
            "server",
            serverNonce,
            extensionNonce,
            message.confirmationNonce
          );
          if (!verifyPairingProof(message.proof, expected)) {
            reject(new Error("Invalid server proof"));
            return;
          }
          expect(bridge!.isConnected).toBe(false);
          socket!.send(JSON.stringify({
            type: "handshake_complete",
            proof: createPairingProof(
              token,
              "extension-confirmation",
              serverNonce,
              extensionNonce,
              message.confirmationNonce
            ),
            timestamp: Date.now(),
          }));
          return;
        }

        if (message.type === "auth_ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await authenticated;
    expect(bridge.isConnected).toBe(true);

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId && message.tool === "list_tabs") {
        socket!.send(JSON.stringify({
          requestId: message.requestId,
          result: [{ tabId: 7, title: "Test tab" }],
          timestamp: Date.now(),
        }));
      }
    });

    const response = await bridge.sendToolRequest("list_tabs", {});
    expect(response.result).toEqual([{ tabId: 7, title: "Test tab" }]);
  });

  test("rejects browser-page origins before WebSocket admission", async () => {
    bridge = new WebSocketBridge({
      ...defaultConfig,
      websocket: { ...defaultConfig.websocket, port: 0 },
    }, token);
    bridge.start();

    socket = new WebSocket(`ws://127.0.0.1:${bridge.listeningPort}`, {
      headers: { Origin: "https://example.com" },
    } as never);

    const rejected = new Promise<void>(resolve => {
      socket!.addEventListener("error", () => resolve(), { once: true });
      socket!.addEventListener("close", () => resolve(), { once: true });
    });
    await rejected;
    expect(bridge.isConnected).toBe(false);
  });

  test("rejects an extension with the wrong pairing token", async () => {
    bridge = new WebSocketBridge({
      ...defaultConfig,
      websocket: { ...defaultConfig.websocket, port: 0 },
    }, token);
    bridge.start();

    socket = new WebSocket(`ws://127.0.0.1:${bridge.listeningPort}`, {
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      },
    } as never);

    const closeCode = new Promise<number>(resolve => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "auth_challenge") return;
        socket!.send(JSON.stringify({
          type: "handshake",
          version: "1.0.0-test",
          capabilities: ["list_tabs"],
          browserId: "unpaired-extension",
          extensionNonce: "ef".repeat(32),
          proof: "0".repeat(64),
        }));
      });
      socket!.addEventListener("close", event => resolve(event.code), { once: true });
    });

    expect(await closeCode).toBe(4004);
    expect(bridge.isConnected).toBe(false);
  });

  test("rejects replaying the initial extension proof as confirmation", async () => {
    bridge = new WebSocketBridge({
      ...defaultConfig,
      websocket: { ...defaultConfig.websocket, port: 0 },
    }, token);
    bridge.setServerToolNames(["list_tabs"]);
    bridge.start();

    socket = new WebSocket(`ws://127.0.0.1:${bridge.listeningPort}`, {
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      },
    } as never);

    const extensionNonce = "ef".repeat(32);
    let initialProof = "";
    const closeCode = new Promise<number>(resolve => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "auth_challenge") {
          initialProof = createPairingProof(token, "extension", message.serverNonce, extensionNonce);
          socket!.send(JSON.stringify({
            type: "handshake",
            version: "1.0.0-test",
            capabilities: ["list_tabs"],
            browserId: "replay-test",
            extensionNonce,
            proof: initialProof,
          }));
          return;
        }
        if (message.type === "handshake_ack") {
          socket!.send(JSON.stringify({
            type: "handshake_complete",
            proof: initialProof,
            timestamp: Date.now(),
          }));
        }
      });
      socket!.addEventListener("close", event => resolve(event.code), { once: true });
    });

    expect(await closeCode).toBe(4004);
    expect(bridge.isConnected).toBe(false);
  });
});

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** Drive a full two-way handshake and resolve once the bridge accepts the socket. */
async function authenticate(bridge: WebSocketBridge, nonceSeed: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.listeningPort}`, {
    headers: { Origin: EXTENSION_ORIGIN },
  } as never);
  const extensionNonce = nonceSeed.repeat(32);
  let serverNonce = "";

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Authentication timed out")), 2_000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "auth_challenge") {
        serverNonce = message.serverNonce;
        ws.send(JSON.stringify({
          type: "handshake",
          version: "1.0.0-test",
          capabilities: ["list_tabs"],
          browserId: "integration-test",
          extensionNonce,
          proof: createPairingProof(token, "extension", serverNonce, extensionNonce),
        }));
        return;
      }
      if (message.type === "handshake_ack") {
        ws.send(JSON.stringify({
          type: "handshake_complete",
          proof: createPairingProof(
            token,
            "extension-confirmation",
            serverNonce,
            extensionNonce,
            message.confirmationNonce
          ),
          timestamp: Date.now(),
        }));
        return;
      }
      if (message.type === "auth_ready") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  return ws;
}

function startBridge(): WebSocketBridge {
  const started = new WebSocketBridge({
    ...defaultConfig,
    websocket: { ...defaultConfig.websocket, port: 0 },
  }, token);
  started.setServerToolNames(["list_tabs"]);
  started.start();
  return started;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe("reconnect handling", () => {
  test("a newly authenticated extension supersedes the previous connection", async () => {
    bridge = startBridge();

    const first = await authenticate(bridge, "ef");
    expect(bridge.isConnected).toBe(true);

    // The first socket is a zombie the server has no way to notice yet. It used
    // to hold the single connection slot until the heartbeat expired, so every
    // reconnect the extension attempted in the meantime was refused.
    const firstCloseCode = new Promise<number>((resolve) => {
      first.addEventListener("close", (event) => resolve((event as CloseEvent).code));
    });

    socket = await authenticate(bridge, "ab");
    expect(bridge.isConnected).toBe(true);
    expect(await firstCloseCode).toBe(4006);

    // The replacement, not the zombie, is what now serves tools.
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId && message.tool === "list_tabs") {
        socket!.send(JSON.stringify({
          requestId: message.requestId,
          result: ["from the replacement"],
          timestamp: Date.now(),
        }));
      }
    });

    const response = await bridge.sendToolRequest("list_tabs", {});
    expect(response.result).toEqual(["from the replacement"]);
  });

  test("in-flight requests fail fast when the extension reconnects", async () => {
    bridge = startBridge();

    const first = await authenticate(bridge, "ef");
    // Attach the handler up front: the supersede rejects this synchronously,
    // before the second handshake finishes awaiting.
    const settled = bridge.sendToolRequest("list_tabs", {})
      .then(() => "resolved", (error: Error) => error.message);

    socket = await authenticate(bridge, "ab");
    expect(await settled).toContain("Extension reconnected");
    first.close();
  });

  test("keepalives are acknowledged so the extension can detect a dead socket", async () => {
    bridge = startBridge();
    socket = await authenticate(bridge, "ef");

    const acknowledged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("keepalive was not acknowledged")), 2_000);
      socket!.addEventListener("message", (event) => {
        if (JSON.parse(String(event.data)).type === "keepalive_ack") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    socket.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }));
    await acknowledged;
  });
});

describe("shared hub across processes", () => {
  const HUB_PORT = 39_026;
  let leader: WebSocketBridge | null = null;
  let follower: WebSocketBridge | null = null;
  const extensions: WebSocket[] = [];

  afterEach(() => {
    for (const ext of extensions.splice(0)) {
      try { ext.close(); } catch { /* ignore */ }
    }
    follower?.stop();
    follower = null;
    leader?.stop();
    leader = null;
  });

  function startBridgeOn(port: number): WebSocketBridge {
    const started = new WebSocketBridge({
      ...defaultConfig,
      websocket: { ...defaultConfig.websocket, port },
    }, token);
    started.setServerToolNames(["list_tabs"]);
    started.start();
    return started;
  }

  async function authenticateOn(bridge: WebSocketBridge, nonceSeed: string): Promise<WebSocket> {
    const ws = await authenticate(bridge, nonceSeed);
    extensions.push(ws);
    return ws;
  }

  function answerListTabs(ext: WebSocket, result: unknown): void {
    ext.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId && message.tool === "list_tabs") {
        ext.send(JSON.stringify({ requestId: message.requestId, result, timestamp: Date.now() }));
      }
    });
  }

  test("a second server becomes a follower and relays tool calls through the leader", async () => {
    leader = startBridgeOn(HUB_PORT);
    const extension = await authenticateOn(leader, "ef");
    answerListTabs(extension, [{ tabId: 3, title: "Leader tab" }]);

    // The second process cannot bind the port, so it joins the leader instead of failing.
    follower = startBridgeOn(HUB_PORT);
    expect(follower.listeningPort).toBeNull();
    await waitFor(() => follower!.isConnected, "the follower to see the extension via the hub");

    const response = await follower.sendToolRequest("list_tabs", {});
    expect(response.result).toEqual([{ tabId: 3, title: "Leader tab" }]);
    expect(follower.extensionVersion).toBe("1.0.0-test");
  });

  test("a follower reports the extension as disconnected once the leader loses it", async () => {
    leader = startBridgeOn(HUB_PORT);
    const extension = await authenticateOn(leader, "ef");

    follower = startBridgeOn(HUB_PORT);
    await waitFor(() => follower!.isConnected, "the follower to see the extension via the hub");

    // Dropping the extension leaves the hub link intact but no browser to serve.
    extension.close();
    await waitFor(() => !follower!.isConnected, "the follower to observe the extension drop");

    await expect(follower.sendToolRequest("list_tabs", {})).rejects.toThrow("Chrome extension is not connected");
  });

  test("a follower re-elects itself as leader when the hub goes away", async () => {
    leader = startBridgeOn(HUB_PORT);
    const firstExtension = await authenticateOn(leader, "ef");
    answerListTabs(firstExtension, ["from the first leader"]);

    follower = startBridgeOn(HUB_PORT);
    await waitFor(() => follower!.isConnected, "the follower to join the hub");

    // The leader's window closes and frees the port.
    leader.stop();
    leader = null;
    firstExtension.close();

    await waitFor(() => follower!.listeningPort === HUB_PORT, "the follower to take over the port", 6_000);

    // The promoted leader owns the extension connection directly now.
    const secondExtension = await authenticateOn(follower, "ab");
    answerListTabs(secondExtension, ["from the promoted leader"]);

    const response = await follower.sendToolRequest("list_tabs", {});
    expect(response.result).toEqual(["from the promoted leader"]);
  });
});
