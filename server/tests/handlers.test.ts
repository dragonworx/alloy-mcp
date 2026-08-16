import { describe, expect, test } from "bun:test";
import { handleToolCall } from "../src/handlers.js";
import { BridgeRequestError, type ToolResponse, type WebSocketBridge } from "../src/websocket.js";

function fakeBridge(options: {
  connected?: boolean;
  response?: ToolResponse;
  error?: Error;
  onRequest?: (tool: string, params: Record<string, unknown>) => void;
} = {}): WebSocketBridge {
  return {
    isConnected: options.connected ?? false,
    extensionVersion: options.connected ? "test" : null,
    extensionCapabilities: options.connected ? ["list_tabs"] : [],
    async sendToolRequest(tool: string, params: Record<string, unknown>) {
      options.onRequest?.(tool, params);
      if (options.error) throw options.error;
      return options.response ?? { requestId: "test", result: null, timestamp: Date.now() };
    },
  } as unknown as WebSocketBridge;
}

function parseText(result: Awaited<ReturnType<typeof handleToolCall>>, index = 0): Record<string, unknown> {
  const content = result.content[index];
  if (content.type !== "text") throw new Error("Expected text content");
  return JSON.parse(content.text);
}

describe("tool dispatcher", () => {
  test("serves ping without an extension", async () => {
    const result = await handleToolCall(fakeBridge(), "ping", {});
    expect(parseText(result)).toMatchObject({ status: "pong", extensionConnected: false });
  });

  test("blocks browser tools while disconnected", async () => {
    const result = await handleToolCall(fakeBridge(), "list_tabs", {});
    expect(parseText(result)).toMatchObject({ code: 1000 });
  });

  test("coerces schema-compatible scalar parameters", async () => {
    let received: Record<string, unknown> | undefined;
    const bridge = fakeBridge({
      connected: true,
      onRequest: (_tool, params) => { received = params; },
    });
    await handleToolCall(bridge, "close_tab", { tabId: "7" });
    expect(received?.tabId).toBe(7);
  });

  test("maps lost bridge requests separately from timeouts", async () => {
    const bridge = fakeBridge({
      connected: true,
      error: new BridgeRequestError("connection_lost", "extension disconnected"),
    });
    const result = await handleToolCall(bridge, "list_tabs", {});
    expect(parseText(result)).toMatchObject({ code: 1001 });
  });

  test("normalizes screenshot data URIs to MCP raw base64", async () => {
    const bridge = fakeBridge({
      connected: true,
      response: {
        requestId: "test",
        result: { image: "data:image/png;base64,YQ==", mimeType: "image/png", format: "png" },
        timestamp: Date.now(),
      },
    });
    const result = await handleToolCall(bridge, "take_screenshot", {});
    expect(result.content[0]).toMatchObject({ type: "image", data: "YQ==", mimeType: "image/png" });
  });
});