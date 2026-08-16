import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPairingProof,
  loadPairingToken,
  validatePairingToken,
  verifyPairingProof,
} from "../src/auth.js";

describe("pairing authentication", () => {
  const token = "ab".repeat(32);

  test("creates role- and nonce-bound proofs", () => {
    const extensionProof = createPairingProof(token, "extension", "server-nonce", "extension-nonce");
    const serverProof = createPairingProof(token, "server", "server-nonce", "extension-nonce");
    const confirmationProof = createPairingProof(
      token,
      "extension-confirmation",
      "server-nonce",
      "extension-nonce",
      "confirmation-nonce"
    );

    expect(extensionProof).toHaveLength(64);
    expect(extensionProof).not.toBe(serverProof);
    expect(confirmationProof).not.toBe(extensionProof);
    expect(verifyPairingProof(extensionProof, extensionProof)).toBe(true);
    expect(verifyPairingProof(extensionProof, serverProof)).toBe(false);
  });

  test("rejects malformed tokens and proofs", () => {
    expect(() => validatePairingToken("short")).toThrow();
    expect(verifyPairingProof("not-hex", "a".repeat(64))).toBe(false);
  });

  test("loads tokens only from private regular files", () => {
    const root = mkdtempSync(join(tmpdir(), "chrome-mcp-auth-"));
    const directory = join(root, "private");
    const tokenPath = join(directory, "token");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(tokenPath, token, { mode: 0o600 });
    const previousToken = process.env.CHROME_MCP_TOKEN;
    const previousPath = process.env.CHROME_MCP_TOKEN_FILE;

    try {
      delete process.env.CHROME_MCP_TOKEN;
      process.env.CHROME_MCP_TOKEN_FILE = tokenPath;
      expect(loadPairingToken()).toBe(token);

      chmodSync(tokenPath, 0o644);
      expect(() => loadPairingToken()).toThrow("must not be accessible by group or other users");
      chmodSync(tokenPath, 0o600);

      const linkedPath = join(directory, "linked-token");
      symlinkSync(tokenPath, linkedPath);
      process.env.CHROME_MCP_TOKEN_FILE = linkedPath;
      expect(() => loadPairingToken()).toThrow();

      process.env.CHROME_MCP_TOKEN_FILE = tokenPath;
      chmodSync(directory, 0o755);
      expect(() => loadPairingToken()).toThrow("must not be accessible by group or other users");
    } finally {
      if (previousToken == null) delete process.env.CHROME_MCP_TOKEN;
      else process.env.CHROME_MCP_TOKEN = previousToken;
      if (previousPath == null) delete process.env.CHROME_MCP_TOKEN_FILE;
      else process.env.CHROME_MCP_TOKEN_FILE = previousPath;
      chmodSync(directory, 0o700);
      rmSync(root, { recursive: true });
    }
  });
});