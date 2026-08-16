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

    socket = new WebSocket(`ws://localhost:${bridge.listeningPort}`, {
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

    socket = new WebSocket(`ws://localhost:${bridge.listeningPort}`, {
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

    socket = new WebSocket(`ws://localhost:${bridge.listeningPort}`, {
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

    socket = new WebSocket(`ws://localhost:${bridge.listeningPort}`, {
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