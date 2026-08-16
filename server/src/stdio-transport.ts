/**
 * Custom stdio transport that supports BOTH Content-Length framing (LSP-style)
 * and newline-delimited JSON (JSONL). Claude Code uses Content-Length framing,
 * while the MCP SDK's standard stdio transport uses JSONL.
 *
 * This transport auto-detects the incoming format and responds in kind.
 */
import process from "node:process";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

type TransportCloseHandler = () => void;
type TransportErrorHandler = (error: Error) => void;
type TransportMessageHandler = (message: JSONRPCMessage) => void;

export interface StdioTransportLimits {
  maxMessageBytes: number;
  maxHeaderBytes: number;
}

const DEFAULT_LIMITS: StdioTransportLimits = {
  maxMessageBytes: 32 * 1_048_576,
  maxHeaderBytes: 8 * 1_024,
};

export class DualStdioTransport {
  private _started = false;
  private _closed = false;
  private _buffer = Buffer.alloc(0);
  private _useContentLength: boolean | null = null; // auto-detect
  private _pendingWrites = 0;
  private readonly _limits: StdioTransportLimits;

  onclose?: TransportCloseHandler;
  onerror?: TransportErrorHandler;
  onmessage?: TransportMessageHandler;

  constructor(
    private readonly _stdin: NodeJS.ReadableStream = process.stdin,
    private readonly _stdout: NodeJS.WritableStream = process.stdout,
    limits: Partial<StdioTransportLimits> = {}
  ) {
    this._limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async start(): Promise<void> {
    if (this._closed) throw new Error("Transport is closed");
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
    this._stdin.on("data", this._onData);
    this._stdin.on("error", this._onError);
    this._stdin.on("end", this._onEnd);
    this._stdout.on("error", this._onError);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._stdin.removeListener("data", this._onData);
    this._stdin.removeListener("error", this._onError);
    this._stdin.removeListener("end", this._onEnd);
    if (this._pendingWrites === 0) this._stdout.removeListener("error", this._onError);
    const remainingListeners = (this._stdin as any).listenerCount?.("data") ?? 0;
    if (remainingListeners === 0) {
      (this._stdin as any).pause?.();
    }
    this._buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this._closed) return Promise.reject(new Error("Transport is closed"));

    return new Promise((resolve, reject) => {
      const json = JSON.stringify(message);
      if (Buffer.byteLength(json) > this._limits.maxMessageBytes) {
        reject(new Error(`Stdio message exceeds ${this._limits.maxMessageBytes} bytes`));
        return;
      }

      let data: string;
      if (this._useContentLength !== false) {
        // Default to Content-Length framing (what Claude Code expects)
        data = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      } else {
        // JSONL mode
        data = json + "\n";
      }

      this._pendingWrites++;
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        this._pendingWrites--;
        if (this._closed && this._pendingWrites === 0) {
          this._stdout.removeListener("error", this._onError);
        }
        if (error) reject(error);
        else resolve();
      };

      try {
        this._stdout.write(data, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readonly _onData = (chunk: Buffer): void => {
    const maxBufferedBytes = this._limits.maxMessageBytes + this._limits.maxHeaderBytes + 4;
    if (chunk.length > maxBufferedBytes - this._buffer.length) {
      this._failInput(`Stdio frame exceeds ${this._limits.maxMessageBytes} bytes`);
      return;
    }
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._processBuffer();
  };

  private readonly _onError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly _onEnd = (): void => {
    void this.close();
  };

  private _detectFraming(): boolean {
    if (this._useContentLength !== null) return true;

    const preview = this._buffer.toString("utf8", 0, Math.min(20, this._buffer.length));
    if (preview.startsWith("Content-Length")) {
      this._useContentLength = true;
      return true;
    }
    if (preview.startsWith("{")) {
      this._useContentLength = false;
      return true;
    }
    if (this._buffer.length > this._limits.maxHeaderBytes) {
      this._failInput(`Stdio header exceeds ${this._limits.maxHeaderBytes} bytes`);
    }
    return false;
  }

  private _failInput(message: string): void {
    this.onerror?.(new Error(message));
    void this.close();
  }

  private _processBuffer(): void {
    while (this._buffer.length > 0) {
      if (!this._detectFraming()) return;
      const processed = this._useContentLength
        ? this._processContentLength()
        : this._processJsonl();
      if (!processed) return;
    }
  }

  private _processContentLength(): boolean {
    // Look for \r\n\r\n header separator
    const headerEnd = this._buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (this._buffer.length > this._limits.maxHeaderBytes) {
        this._failInput(`Stdio header exceeds ${this._limits.maxHeaderBytes} bytes`);
      }
      return false;
    }
    if (headerEnd > this._limits.maxHeaderBytes) {
      this._failInput(`Stdio header exceeds ${this._limits.maxHeaderBytes} bytes`);
      return false;
    }

    // Parse Content-Length from headers
    const headerStr = this._buffer.toString("utf8", 0, headerEnd);
    const match = headerStr.split("\r\n")
      .map(line => /^Content-Length:\s*(\d+)\s*$/i.exec(line))
      .find((value): value is RegExpExecArray => value !== null);
    if (!match) {
      this._failInput("Missing or invalid Content-Length header");
      return false;
    }

    const contentLength = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(contentLength) || contentLength > this._limits.maxMessageBytes) {
      this._failInput(`Stdio message exceeds ${this._limits.maxMessageBytes} bytes`);
      return false;
    }
    const bodyStart = headerEnd + 4;

    // Check if we have the full body
    if (this._buffer.length < bodyStart + contentLength) {
      return false; // Need more data
    }

    // Extract and parse body
    const body = this._buffer.toString("utf8", bodyStart, bodyStart + contentLength);
    this._buffer = this._buffer.subarray(bodyStart + contentLength);

    try {
      const message = JSONRPCMessageSchema.parse(JSON.parse(body));
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }

    return true;
  }

  private _processJsonl(): boolean {
    const index = this._buffer.indexOf("\n");
    if (index === -1) {
      if (this._buffer.length > this._limits.maxMessageBytes) {
        this._failInput(`Stdio message exceeds ${this._limits.maxMessageBytes} bytes`);
      }
      return false;
    }
    if (index > this._limits.maxMessageBytes) {
      this._failInput(`Stdio message exceeds ${this._limits.maxMessageBytes} bytes`);
      return false;
    }

    const line = this._buffer.toString("utf8", 0, index).replace(/\r$/, "");
    this._buffer = this._buffer.subarray(index + 1);

    if (line.length === 0) return true; // skip empty lines

    try {
      const message = JSONRPCMessageSchema.parse(JSON.parse(line));
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }

    return true;
  }
}
