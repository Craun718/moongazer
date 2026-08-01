import type { JsonRpcError, JsonRpcMessage } from "./json-rpc/types";

/** Options for the browser-native MCP Streamable HTTP transport. */
export interface HttpMcpTransportOptions {
  /** MCP server's Streamable HTTP endpoint. */
  url: string | URL;
  /** Headers sent with every request, such as `Authorization`. */
  headers?: HeadersInit;
  /** Fetch implementation. Defaults to the browser global. */
  fetch?: typeof globalThis.fetch;
}

/** An HTTP or JSON-RPC error returned by an MCP server. */
export class McpHttpError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, options?: { status?: number; code?: number; data?: unknown }) {
    super(message);
    this.name = "McpHttpError";
    this.status = options?.status;
    this.code = options?.code;
    this.data = options?.data;
  }
}

type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Browser-only MCP Streamable HTTP client transport. It deliberately uses
 * `fetch` rather than exposing a byte-stream or process transport, so callers
 * can connect only to a remote HTTP endpoint.
 */
export class HttpMcpTransport {
  private nextId = 1;
  private sessionId: string | undefined;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Headers;
  private readonly notificationHandlers = new Set<NotificationHandler>();

  constructor(options: HttpMcpTransportOptions) {
    this.endpoint = String(options.url);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("MCP HTTP transport requires a Fetch API implementation");
    }
    this.headers = new Headers(options.headers);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async request<R>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<R> {
    const id = this.nextId++;
    const controller = new AbortController();
    const signal = anySignal(options?.signal, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) timer = setTimeout(() => controller.abort(), options.timeout);

    try {
      const messages = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      const response = messages.find((message) => isResponseFor(message, id));
      if (!response) throw new McpHttpError(`request "${method}" returned no JSON-RPC response`);
      if (response.error) throw rpcError(response.error);
      return response.result as R;
    } catch (error) {
      if (signal?.aborted && options?.signal?.aborted) {
        void this.notify("notifications/cancelled", { requestId: id, reason: "Cancelled by client" });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async post(message: JsonRpcMessage, signal?: AbortSignal): Promise<JsonRpcMessage[]> {
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("Content-Type", "application/json");
    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
    if (!response.ok) {
      throw new McpHttpError(`MCP HTTP request failed (${response.status})`, { status: response.status });
    }
    const sessionId = response.headers.get("MCP-Session-Id");
    if (sessionId) this.sessionId = sessionId;

    const messages = await readMessages(response);
    for (const inbound of messages) {
      if (isNotification(inbound)) {
        for (const handler of this.notificationHandlers) handler(inbound.method, inbound.params);
      }
    }
    return messages;
  }
}

async function readMessages(response: Response): Promise<JsonRpcMessage[]> {
  if (response.status === 202 || response.status === 204 || !response.body) return [];
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) return [];
  if (contentType.includes("text/event-stream")) return parseSse(text);
  return [JSON.parse(text) as JsonRpcMessage];
}

function parseSse(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) messages.push(JSON.parse(data) as JsonRpcMessage);
  }
  return messages;
}

function isResponseFor(
  message: JsonRpcMessage,
  id: number,
): message is JsonRpcMessage & { id: number | string; result?: unknown; error?: JsonRpcError } {
  return "id" in message && message.id === id && ("result" in message || "error" in message);
}

function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { method: string; params?: unknown } {
  return "method" in message && typeof message.method === "string" && !("id" in message);
}

function rpcError(error: JsonRpcError): McpHttpError {
  return new McpHttpError(error.message, { code: error.code, data: error.data });
}

function anySignal(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}
