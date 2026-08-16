import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DualStdioTransport } from "../src/stdio-transport.js";

const request: JSONRPCMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "test/request",
};

function nextMessage(transport: DualStdioTransport): Promise<JSONRPCMessage> {
  return new Promise(resolve => {
    transport.onmessage = resolve;
  });
}

describe("DualStdioTransport", () => {
  test("reads and replies with JSONL framing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new DualStdioTransport(input, output);
    const message = nextMessage(transport);
    await transport.start();

    input.write(`${JSON.stringify(request)}\n`);
    expect(await message).toEqual(request);

    const written = new Promise<string>(resolve => output.once("data", chunk => resolve(String(chunk))));
    await transport.send(request);
    expect(await written).toBe(`${JSON.stringify(request)}\n`);
    await transport.close();
  });

  test("reads fragmented Content-Length framing and replies in kind", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new DualStdioTransport(input, output);
    const message = nextMessage(transport);
    await transport.start();

    const body = JSON.stringify(request);
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    input.write(framed.slice(0, 12));
    input.write(framed.slice(12));
    expect(await message).toEqual(request);

    const written = new Promise<string>(resolve => output.once("data", chunk => resolve(String(chunk))));
    await transport.send(request);
    expect(await written).toBe(framed);
    await transport.close();
  });

  test("closes once when explicit close is followed by input EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new DualStdioTransport(input, output);
    let closeCount = 0;
    transport.onclose = () => closeCount++;
    await transport.start();

    await transport.close();
    input.end();
    await new Promise(resolve => setImmediate(resolve));
    expect(closeCount).toBe(1);
  });

  test("rejects when stdout cannot write", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("output failed"));
      },
    });
    const transport = new DualStdioTransport(input, output);
    await transport.start();

    await expect(transport.send(request)).rejects.toThrow("output failed");
    await transport.close();
  });

  test("rejects oversized JSONL and Content-Length frames", async () => {
    for (const payload of [
      `${JSON.stringify({ ...request, method: "x".repeat(80) })}\n`,
      "Content-Length: 65\r\n\r\n",
    ]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const transport = new DualStdioTransport(input, output, { maxMessageBytes: 64 });
      const error = new Promise<Error>(resolve => {
        transport.onerror = resolve;
      });
      await transport.start();

      input.write(payload);
      expect((await error).message).toContain("exceeds 64 bytes");
      await transport.close();
    }
  });

  test("rejects sends after close", async () => {
    const transport = new DualStdioTransport(new PassThrough(), new PassThrough());
    await transport.start();
    await transport.close();
    await expect(transport.send(request)).rejects.toThrow("Transport is closed");
  });

  test("retains stdout error handling until a pending write settles", async () => {
    const input = new PassThrough();
    let finishWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        finishWrite = callback;
      },
    });
    const transport = new DualStdioTransport(input, output);
    await transport.start();

    const pendingSend = transport.send(request);
    await new Promise(resolve => setImmediate(resolve));
    await transport.close();
    expect(output.listenerCount("error")).toBe(1);

    finishWrite?.();
    await pendingSend;
    expect(output.listenerCount("error")).toBe(0);
  });
});