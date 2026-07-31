import { encodeMessage, LineReader } from "./framing";
import { INTERNAL_ERROR, METHOD_NOT_FOUND } from "./types";
import type { JsonRpcError, JsonRpcMessage, JsonRpcRequest } from "./types";

/**
 * A bidirectional transport over which JSON-RPC messages are exchanged as
 * newline-delimited JSON. `JsonRpcConnection` is transport-agnostic: stdio
 * (a child process), an in-memory pipe (tests), and (later) HTTP/SSE all
 * implement this surface. `onData` feeds raw chunks that the connection frames
 * via `LineReader`; `write` accepts a fully-framed string (already
 * newline-terminated by `encodeMessage`); `close` tears the transport down.
 */
export interface DuplexLike {
  onData(cb: (chunk: Uint8Array | string) => void): void;
  write(data: string): void;
  close(): void;
}

/** A JSON-RPC error surfaced as a typed exception. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = "RpcError";
    this.code = err.code;
    this.data = err.data;
  }
}

/** Handle an inbound server->client request (a reverse request). */
export type JsonRpcRequestHandler = (req: JsonRpcRequest) => Promise<unknown> | unknown;

export interface JsonRpcConnectionOptions {
  /** Default per-request timeout in milliseconds. */
  defaultTimeout?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A JSON-RPC 2.0 connection over a `DuplexLike` transport.
 *
 * Correlates outbound requests with inbound responses, dispatches inbound
 * notifications and reverse requests, and supports per-request abort and
 * timeout. On abort the connection sends `notifications/cancelled` (per the
 * MCP spec) so the server can stop work, then rejects the caller.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly reader = new LineReader();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandler: JsonRpcRequestHandler | undefined;
  private closed = false;
  private readonly defaultTimeout: number | undefined;

  constructor(
    private readonly transport: DuplexLike,
    options?: JsonRpcConnectionOptions,
  ) {
    this.defaultTimeout = options?.defaultTimeout;
    this.transport.onData((chunk) => {
      for (const line of this.reader.push(chunk)) this.handleLine(line);
    });
  }

  /** Send a request and await its response. Aborts/timeouts reject. */
  request<R = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<R> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.closed) return Promise.reject(new Error("connection closed"));

    return new Promise<R>((resolve, reject) => {
      const id = this.nextId++;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        return true;
      };
      const onAbort = (): void => {
        if (!finish()) return;
        this.notify("notifications/cancelled", { requestId: id, reason: "Cancelled by client" });
        reject(new Error("aborted"));
      };
      const onTimeout = (): void => {
        if (finish()) reject(new Error(`request "${method}" timed out`));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options?.timeout ?? this.defaultTimeout;
      if (timeout) timer = setTimeout(onTimeout, timeout);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          if (finish()) resolve(value as R);
        },
        reject: (error: Error) => {
          if (finish()) reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a fire-and-forget notification (no response expected). */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Register a handler for an inbound notification method. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Register a single handler for inbound reverse requests. */
  onRequest(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Reject all pending requests and tear down the transport. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    this.transport.close();
  }

  private send(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.transport.write(encodeMessage(message));
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    if (msg.jsonrpc !== "2.0") return;

    const method = msg.method;
    const id = msg.id;

    if (typeof method === "string") {
      if (id !== undefined && id !== null) {
        this.handleServerRequest({
          jsonrpc: "2.0",
          id: id as number | string,
          method,
          params: msg.params,
        });
      } else {
        this.notificationHandlers.get(method)?.(msg.params);
      }
      return;
    }

    if (id !== undefined && id !== null) {
      const pending = this.pending.get(id as number | string);
      if (!pending) return;
      const error = msg.error as JsonRpcError | undefined;
      if (error) pending.reject(new RpcError(error));
      else pending.resolve(msg.result);
    }
  }

  private handleServerRequest(req: JsonRpcRequest): void {
    const respond = (result: unknown, error?: JsonRpcError): void => {
      this.send(
        error
          ? { jsonrpc: "2.0", id: req.id, error }
          : { jsonrpc: "2.0", id: req.id, result },
      );
    };
    if (this.requestHandler) {
      // Defer the call to a microtask: a handler that throws synchronously
      // must reject this chain (and yield an internal-error response) rather
      // than escape into the transport's onData callback.
      const handler = this.requestHandler;
      Promise.resolve()
        .then(() => handler(req))
        .then(
          (r) => respond(r),
          (e) => respond(undefined, { code: INTERNAL_ERROR, message: (e as Error).message }),
        );
    } else {
      respond(undefined, { code: METHOD_NOT_FOUND, message: `method not found: ${req.method}` });
    }
  }
}
