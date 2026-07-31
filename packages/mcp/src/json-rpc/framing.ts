import type { JsonRpcMessage } from "./types";

/**
 * MCP's stdio transport uses newline-delimited JSON (NDJSON): each JSON-RPC
 * message is serialized as a single line of UTF-8 text terminated by `\n`, and
 * messages MUST NOT contain embedded newlines. (This is NOT LSP-style
 * Content-Length framing.)
 *
 * `LineReader` reassembles complete lines from arbitrary byte/string chunks,
 * correctly handling messages split across chunks and multibyte UTF-8
 * sequences split across a chunk boundary (via a stateful `TextDecoder`).
 */

/** Serialize a message to its wire form: a single JSON line + newline. */
export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Buffered line reader. Feed it chunks (bytes or strings); it yields each
 * complete line (without the trailing newline). Incomplete trailing data is
 * retained until the next chunk completes it. Blank/whitespace-only lines are
 * skipped: NDJSON never carries an empty message, and real servers
 * occasionally print stray blank lines on stdout.
 */
export class LineReader {
  private buffer = "";
  private decoder = new TextDecoder();

  /** Feed a chunk; yields each complete non-blank line. */
  *push(chunk: Uint8Array | string): Generator<string> {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim() !== "") yield line;
    }
  }
}
