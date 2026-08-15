import type { JsonRpcError, JsonRpcMessage } from "./json-rpc/types";
import type { McpClientInfo } from "./client";
import type { McpProtocolVersion } from "./versions";
import { isModernProtocolVersion } from "./versions";

/** Options for the browser-native MCP Streamable HTTP transport. */
export interface HttpMcpTransportOptions {
  /** MCP server's Streamable HTTP endpoint. */
  url: string | URL;
  /** Headers sent with every request, such as `Authorization`. */
  headers?: HeadersInit;
  /** Fetch implementation. Defaults to the browser global. */
  fetch?: typeof globalThis.fetch;
  /** Initial protocol revision. Legacy revisions may negotiate a lower one. */
  protocolVersion?: McpProtocolVersion;
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

interface SsePayload {
  messages: JsonRpcMessage[];
  lastEventId?: string;
  retry?: number;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** Request-only headers, used for modern `Mcp-Param-*` metadata. */
  headers?: HeadersInit;
}

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
  private protocolVersion: McpProtocolVersion;
  private clientInfo: McpClientInfo;
  private handshakeComplete = false;

  constructor(options: HttpMcpTransportOptions) {
    this.endpoint = String(options.url);
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
    this.clientInfo = { name: "moongazer", version: "0.1.0" };
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

  getProtocolVersion(): McpProtocolVersion {
    return this.protocolVersion;
  }

  /** Set after legacy negotiation and before `notifications/initialized`. */
  setProtocolVersion(version: McpProtocolVersion): void {
    this.protocolVersion = version;
    this.handshakeComplete = true;
  }

  setClientInfo(clientInfo: McpClientInfo): void {
    this.clientInfo = clientInfo;
  }

  async request<R>(method: string, params?: unknown, options?: McpRequestOptions): Promise<R> {
    const id = this.nextId++;
    const controller = new AbortController();
    const signal = anySignal(options?.signal, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) timer = setTimeout(() => controller.abort(), options.timeout);

    try {
      const messages = await this.post(
        { jsonrpc: "2.0", id, method, params: this.prepareParams(method, params) },
        signal,
        method,
        params,
        options?.headers,
        options?.timeout,
      );
      const response = messages.find((message) => isResponseFor(message, id));
      if (!response) throw new McpHttpError(`request "${method}" returned no JSON-RPC response`);
      if (response.error) throw rpcError(response.error);
      return response.result as R;
    } catch (error) {
      if (signal?.aborted && options?.signal?.aborted) {
        // Legacy HTTP sends an explicit cancellation notification. In 2026,
        // aborting fetch closes the request-scoped SSE stream; that disconnect
        // is itself the cancellation signal and no notification is sent.
        if (!isModernProtocolVersion(this.protocolVersion)) {
          void this.notify("notifications/cancelled", {
            requestId: id,
            reason: "Cancelled by client",
          });
        }
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, undefined, method, params);
  }

  /**
   * Terminate a legacy session. Modern MCP has no protocol session, so closing
   * a 2026 transport is intentionally a no-op.
   */
  async close(): Promise<void> {
    if (!this.sessionId || isModernProtocolVersion(this.protocolVersion)) return;
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("MCP-Session-Id", this.sessionId);
    headers.set("MCP-Protocol-Version", this.protocolVersion);
    const response = await this.fetchImpl(this.endpoint, { method: "DELETE", headers });
    // Consume the response body so the connection can be released/reused.
    await response.arrayBuffer().catch(() => undefined);
    this.sessionId = undefined;
  }

  private prepareParams(method: string, params?: unknown): unknown {
    if (!isModernProtocolVersion(this.protocolVersion)) return params;
    // Modern MCP sends identity, capabilities, and revision with every request.
    // Capabilities are empty because this client consumes only MCP tools.
    const base = (typeof params === "object" && params !== null ? params : {}) as {
      _meta?: Record<string, unknown>;
    };
    return {
      ...base,
      _meta: {
        ...base._meta,
        "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
        "io.modelcontextprotocol/clientInfo": this.clientInfo,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }

  private async post(
    message: JsonRpcMessage,
    signal?: AbortSignal,
    method?: string,
    rawParams?: unknown,
    extraHeaders?: HeadersInit,
    timeout?: number,
  ): Promise<JsonRpcMessage[]> {
    const requestId = "id" in message && typeof message.id === "number" ? message.id : undefined;
    const canResume =
      this.protocolVersion === "2025-11-25" && requestId !== undefined && this.handshakeComplete;

    let headers = this.buildHeaders(method, rawParams, extraHeaders, false);
    let response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
    if (!response.ok) {
      throw new McpHttpError(`MCP HTTP request failed (${response.status})`, {
        status: response.status,
      });
    }
    this.captureSession(response);
    let payload = await readMessages(response);
    let messages = payload.messages;

    // 2025-11-25 allows a server to close an SSE connection before the final
    // JSON-RPC response. If it emitted an event id, resume that request stream
    // with GET + Last-Event-ID instead of treating the disconnect as failure.
    const deadline = timeout === undefined ? undefined : Date.now() + timeout;
    while (
      canResume &&
      payload.lastEventId !== undefined &&
      !messages.some((item) => isResponseFor(item, requestId)) &&
      !signal?.aborted
    ) {
      if (payload.retry !== undefined && deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new McpHttpError("MCP HTTP request timed out");
        await sleep(Math.min(payload.retry, remaining));
      } else if (payload.retry !== undefined) {
        await sleep(payload.retry);
      }
      if (signal?.aborted) break;

      headers = this.buildHeaders(undefined, undefined, undefined, true);
      headers.set("Last-Event-ID", payload.lastEventId);
      response = await this.fetchImpl(this.endpoint, { method: "GET", headers, signal });
      if (!response.ok) {
        throw new McpHttpError(`MCP HTTP stream resume failed (${response.status})`, {
          status: response.status,
        });
      }
      this.captureSession(response);
      payload = await readMessages(response);
      messages = [...messages, ...payload.messages];
    }

    for (const inbound of messages) {
      if (isNotification(inbound)) {
        for (const handler of this.notificationHandlers) handler(inbound.method, inbound.params);
      }
    }
    return messages;
  }

  private buildHeaders(
    method: string | undefined,
    rawParams: unknown,
    extraHeaders: HeadersInit | undefined,
    sseOnly: boolean,
  ): Headers {
    const headers = new Headers(this.headers);
    headers.set("Accept", sseOnly ? "text/event-stream" : "application/json, text/event-stream");
    if (!sseOnly) headers.set("Content-Type", "application/json");
    if (extraHeaders) {
      for (const [key, value] of new Headers(extraHeaders)) headers.set(key, value);
    }

    if (isModernProtocolVersion(this.protocolVersion)) {
      // 2026 mirrors routing metadata into headers for intermediaries; the
      // JSON body remains the source of truth.
      headers.set("MCP-Protocol-Version", this.protocolVersion);
      if (method) headers.set("Mcp-Method", method);
      if (method === "tools/call") {
        const name = (rawParams as { name?: unknown } | undefined)?.name;
        if (typeof name === "string") headers.set("Mcp-Name", encodeMcpHeaderValue(name));
      }
    } else if (this.handshakeComplete) {
      // Legacy initialization negotiates the revision. The negotiated value is
      // mandatory on every request after the initialize response.
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }

    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);
    return headers;
  }

  private captureSession(response: Response): void {
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) this.sessionId = sessionId;
  }
}

async function readMessages(response: Response): Promise<SsePayload> {
  if (response.status === 202 || response.status === 204 || !response.body) {
    return { messages: [] };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) return { messages: [] };
  if (contentType.includes("text/event-stream")) return parseSse(text);
  return { messages: [JSON.parse(text) as JsonRpcMessage] };
}

function parseSse(text: string): SsePayload {
  const messages: JsonRpcMessage[] = [];
  let lastEventId: string | undefined;
  let retry: number | undefined;
  for (const event of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data: string[] = [];
    for (const line of event.split("\n")) {
      if (line.startsWith("id:")) lastEventId = line.slice(3).trimStart();
      else if (line.startsWith("retry:")) {
        const parsed = Number.parseInt(line.slice(6).trimStart(), 10);
        if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
      } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) messages.push(JSON.parse(data.join("\n")) as JsonRpcMessage);
  }
  return { messages, lastEventId, retry };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Encode a modern mirrored header value. Values outside visible ASCII
 * (plus SP/HTAB) use MCP's UTF-8 Base64 sentinel form.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plain = /^[\t\x20-\x7e]+$/.test(value) && value.trim() === value;
  // A literal that looks like MCP's Base64 sentinel must itself be encoded,
  // otherwise a receiver could decode an unrelated plain string.
  if (plain && !value.startsWith("=?base64?")) return value;
  return `=?base64?${utf8Base64(value)}?=`;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += table[(triplet >> 18) & 63]!;
    out += table[(triplet >> 12) & 63]!;
    out += b === undefined ? "=" : table[(triplet >> 6) & 63]!;
    out += c === undefined ? "=" : table[triplet & 63]!;
  }
  return out;
}

function anySignal(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}
