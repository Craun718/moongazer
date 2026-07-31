import { describe, expect, it } from "vitest";
import { LineReader, encodeMessage } from "./framing";
import type { JsonRpcRequest } from "./types";

const enc = new TextEncoder();

/** Drain all complete lines from a sequence of chunks. */
function drain(chunks: Array<Uint8Array | string>): string[] {
  const reader = new LineReader();
  const lines: string[] = [];
  for (const chunk of chunks) for (const line of reader.push(chunk)) lines.push(line);
  return lines;
}

describe("encodeMessage", () => {
  it("serializes a message as one JSON line plus a newline", () => {
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(encodeMessage(msg)).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });
});

describe("LineReader", () => {
  it("yields a single message from one complete chunk", () => {
    const lines = drain([enc.encode('{"id":1}\n')]);
    expect(lines).toEqual(['{"id":1}']);
  });

  it("yields two messages from one chunk", () => {
    const lines = drain([enc.encode('{"id":1}\n{"id":2}\n')]);
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("reassembles a message split across chunks", () => {
    const lines = drain([enc.encode('{"id":1}'), enc.encode('\n')]);
    expect(lines).toEqual(['{"id":1}']);
  });

  it("reassembles a message split mid-field across chunks", () => {
    const lines = drain([enc.encode('{"id":'), enc.encode('1}\n')]);
    expect(lines).toEqual(['{"id":1}']);
  });

  it("holds a trailing partial line until the next chunk completes it", () => {
    const reader = new LineReader();
    const first = [...reader.push(enc.encode('{"id":1}\n{"id":2'))];
    const second = [...reader.push(enc.encode('}\n'))];
    expect(first).toEqual(['{"id":1}']);
    expect(second).toEqual(['{"id":2}']);
  });

  it("decodes multibyte UTF-8 split at a chunk boundary (2-byte seq)", () => {
    // "café" -> 0x63 0x61 0x66 0xC3 0xA9 ; split between 0xC3 and 0xA9.
    const bytes = enc.encode("café\n");
    const a = bytes.subarray(0, 4); // ends on the lead byte 0xC3
    const b = bytes.subarray(4); // 0xA9 + newline
    const lines = drain([a, b]);
    expect(lines).toEqual(["café"]);
  });

  it("decodes multibyte UTF-8 split mid-codepoint (4-byte emoji)", () => {
    // "x😀y" -> 'x' + 0xF0 0x9F 0x98 0x80 + 'y' ; split after 2 of 4 bytes.
    const bytes = enc.encode("x😀y\n");
    const a = bytes.subarray(0, 3); // 'x' + 0xF0 0x9F
    const b = bytes.subarray(3); // 0x98 0x80 + 'y' + newline
    const lines = drain([a, b]);
    expect(lines).toEqual(["x😀y"]);
  });

  it("accepts string chunks too", () => {
    const lines = drain(['{"id":1}\n', '{"id":2}\n']);
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("ignores a trailing newline-less fragment with no prior buffer", () => {
    expect(drain([enc.encode("no-newline-here")])).toEqual([]);
  });

  it("skips blank lines between messages", () => {
    // NDJSON never carries an empty message; stray blank lines are ignored.
    const lines = drain([enc.encode('{"id":1}\n\n{"id":2}\n')]);
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("skips a whitespace-only line", () => {
    const lines = drain([enc.encode('{"id":1}\n   \t\n{"id":2}\n')]);
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
  });
});
