import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.js";
import { getToolRequestTimeout, isAllowedExtensionOrigin, isValidHandshakeMessage } from "../src/websocket.js";

describe("WebSocket admission", () => {
  test("accepts only Chrome extension origins", () => {
    expect(isAllowedExtensionOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe(true);
    expect(isAllowedExtensionOrigin("https://example.com")).toBe(false);
    expect(isAllowedExtensionOrigin("http://localhost:3001")).toBe(false);
    expect(isAllowedExtensionOrigin(null)).toBe(false);
  });

  test("requires a bounded extension handshake with a core capability", () => {
    expect(isValidHandshakeMessage({
      type: "handshake",
      version: "1.0.0",
      capabilities: ["list_tabs", "navigate"],
      browserId: "browser-id",
      extensionNonce: "extension-nonce-1234",
      proof: "a".repeat(64),
    })).toBe(true);

    expect(isValidHandshakeMessage({
      type: "handshake",
      version: "1.0.0",
      capabilities: ["diagnostics"],
      browserId: "browser-id",
      extensionNonce: "extension-nonce-1234",
      proof: "a".repeat(64),
    })).toBe(false);
    expect(isValidHandshakeMessage({ type: "handshake" })).toBe(false);
  });
});

describe("tool request timeouts", () => {
  test("covers screenshots and bounded long-running operations", () => {
    expect(getToolRequestTimeout(defaultConfig, "capture_element", {})).toBe(60_000);
    expect(getToolRequestTimeout(defaultConfig, "navigate", {})).toBe(35_000);
    expect(getToolRequestTimeout(defaultConfig, "wait_for_element", { timeout: 90_000 })).toBe(95_000);
    expect(getToolRequestTimeout(defaultConfig, "type_text", {
      text: "a".repeat(1000),
      delayPerChar: 100,
    })).toBe(105_000);
  });
});