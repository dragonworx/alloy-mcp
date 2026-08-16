import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const PROOF_PATTERN = /^[a-f0-9]{64}$/i;

export function getPairingTokenPath(): string {
  return process.env.ALLOY_MCP_TOKEN_FILE || join(homedir(), ".config", "alloy-mcp", "token");
}

export function validatePairingToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new Error("Alloy MCP pairing token must contain exactly 64 hexadecimal characters");
  }
  return normalized;
}

function assertPrivateOwner(path: string, uid: number, mode: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error(`Alloy MCP pairing path must be owned by the current user: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`Alloy MCP pairing path must not be accessible by group or other users: ${path}`);
  }
}

function assertPrivateTokenDirectory(tokenPath: string): void {
  const directory = dirname(tokenPath);
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Alloy MCP pairing token directory must be a real directory: ${directory}`);
  }
  assertPrivateOwner(directory, stats.uid, stats.mode);
}

function readPairingTokenFile(tokenPath: string): string {
  assertPrivateTokenDirectory(tokenPath);
  const descriptor = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(`Alloy MCP pairing token must be a regular, singly linked file: ${tokenPath}`);
    }
    assertPrivateOwner(tokenPath, stats.uid, stats.mode);
    return validatePairingToken(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

export function loadPairingToken(): string {
  if (process.env.ALLOY_MCP_TOKEN) {
    return validatePairingToken(process.env.ALLOY_MCP_TOKEN);
  }

  const tokenPath = getPairingTokenPath();
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  assertPrivateTokenDirectory(tokenPath);
  const token = randomBytes(32).toString("hex");

  try {
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readPairingTokenFile(tokenPath);
  }

  return readPairingTokenFile(tokenPath);
}

export function createPairingProof(
  token: string,
  role: "extension" | "server" | "extension-confirmation",
  serverNonce: string,
  extensionNonce: string,
  confirmationNonce?: string
): string {
  const confirmationContext = confirmationNonce ? `:${confirmationNonce}` : "";
  return createHmac("sha256", Buffer.from(validatePairingToken(token), "hex"))
    .update(`alloy-mcp-v1:${role}:${serverNonce}:${extensionNonce}${confirmationContext}`)
    .digest("hex");
}

export function verifyPairingProof(actual: string, expected: string): boolean {
  if (!PROOF_PATTERN.test(actual) || !PROOF_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}