import type { AgentTool, ToolExecutionContext, ToolSource } from "moongazer";
import { encodeMcpHeaderValue, HttpMcpTransport } from "./http";
import type { HttpMcpTransportOptions } from "./http";
import { inputSchemaToTypeBox } from "./schema/convert";
import {
  isModernProtocolVersion,
  isSupportedProtocolVersion,
  MCP_PROTOCOL_VERSION,
} from "./versions";
import type { McpProtocolVersion } from "./versions";

export { MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from "./versions";
export type { McpProtocolVersion } from "./versions";

/** Client identity sent in the initialize handshake. */
export interface McpClientInfo {
  name: string;
  version: string;
}

export interface CreateMcpClientOptions extends HttpMcpTransportOptions {
  /**
   * Fallback namespace for tool names (`namespace:tool`) when the server does
   * not report `serverInfo.name`. Defaults to `"mcp"`.
   */
  name?: string;
  /**
   * Protocol revision to speak. `2025-06-18` remains the default for backwards
   * compatibility; `2025-11-25` is the final legacy revision; `2026-07-28` is
   * the stateless modern revision.
   */
  protocolVersion?: McpProtocolVersion;
  /** Timeout (ms) for legacy initialize or modern `server/discover`. Default 30000. */
  initTimeout?: number;
  /** Default per-request timeout (ms) applied to `tools/list` and `tools/call`. */
  defaultTimeout?: number;
  /** Client info sent in initialize. Defaults to `{ name: "moongazer", version: "0.1.0" }`. */
  clientInfo?: McpClientInfo;
}

// --- Loose MCP result shapes. Servers vary, so these stay permissive. ---

interface InitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}
interface DiscoverResult {
  resultType?: string;
  supportedVersions?: unknown;
  capabilities?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
interface ToolDefinition {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}
interface ToolsListResult {
  resultType?: string;
  tools?: ToolDefinition[];
}
interface CallToolResult {
  resultType?: string;
  content?: Array<{ type?: string; text?: string } | unknown>;
  isError?: boolean;
}

interface HeaderBinding {
  path: string[];
  name: string;
}

/**
 * Create an MCP client that exposes a server's tools as a moongazer
 * `ToolSource`. Legacy revisions perform `initialize`; modern 2026 MCP performs
 * `server/discover` for identity and then sends protocol metadata on every
 * request. Tools are listed on demand at agent run start.
 *
 * Tool names are namespaced as `server:tool` so tools from multiple servers -
 * and local tools - never collide. Each tool's `inputSchema` is rebuilt as a
 * TypeBox schema so the agent's default-filling and validation apply; `execute`
 * forwards to `tools/call` and maps the result to text. `isError` results are
 * thrown so the agent's tool-error isolation surfaces them to the model as
 * `<tool_error name="...">`.
 */
export async function createMcpClient(options: CreateMcpClientOptions): Promise<ToolSource> {
  const transport = new HttpMcpTransport(options);
  const requestedVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  const clientInfo = options.clientInfo ?? { name: "moongazer", version: "0.1.0" };
  transport.setClientInfo(clientInfo);

  let capabilities: Record<string, unknown> | undefined;
  let serverName: string | undefined;

  if (isModernProtocolVersion(requestedVersion)) {
    // Modern MCP is stateless: there is no initialize/initialized handshake and
    // no session header. Discovery is optional by spec, but gives this client a
    // stable namespace and advertises whether the server exposes tools at all.
    const discover = await transport.request<DiscoverResult>(
      "server/discover",
      undefined,
      { timeout: options.initTimeout ?? 30000 },
    );
    assertComplete(discover, "server/discover");
    capabilities = discover?.capabilities;
    serverName = serverInfoFromResultMeta(discover?._meta);
  } else {
    const init = await transport.request<InitializeResult>(
      "initialize",
      {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo,
      },
      { timeout: options.initTimeout ?? 30000 },
    );

    // A legacy server may lower the negotiated revision to one it supports.
    // Only revisions implemented by this package can be accepted here.
    const negotiated = init?.protocolVersion ?? requestedVersion;
    if (!isSupportedProtocolVersion(negotiated)) {
      throw new Error(`MCP server requested unsupported protocol version: ${negotiated}`);
    }
    transport.setProtocolVersion(negotiated);

    // Required by both legacy Streamable HTTP revisions. The notification is
    // sent after version negotiation and uses any session returned by init.
    await transport.notify("notifications/initialized");
    capabilities = init?.capabilities;
    serverName = init?.serverInfo?.name;
  }

  const namespace = sanitizeNamespace(serverName ?? options.name ?? "mcp");

  const list = async (ctx: ToolExecutionContext): Promise<AgentTool[]> => {
    // Absence of the `tools` capability means there is nothing to bridge.
    if (capabilities && typeof capabilities.tools === "undefined") return [];
    const res = await transport.request<ToolsListResult>("tools/list", undefined, {
      signal: ctx.signal,
      timeout: options.defaultTimeout,
    });
    assertComplete(res, "tools/list");
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    // Isolate per-tool schema conversion failures: one bad inputSchema skips
    // just that tool (with a warning) instead of failing the whole list.
    const result: AgentTool[] = [];
    for (const def of tools) {
      try {
        result.push(makeTool(transport, namespace, def, options.defaultTimeout));
      } catch (err) {
        console.warn(
          `[moongazer/mcp] skipping tool "${def?.name}" with invalid inputSchema:`,
          err,
        );
      }
    }
    return result;
  };

  const onInvalidated = (listener: () => void): (() => void) =>
    transport.onNotification((method) => {
      if (method === "notifications/tools/list_changed") listener();
    });

  // ToolSource.close is synchronous, while HTTP DELETE is naturally async. Do
  // not make agent teardown wait on a best-effort legacy session termination.
  const close = (): void => {
    void transport.close().catch((err) => console.warn("[moongazer/mcp] close failed:", err));
  };

  return { list, onInvalidated, close };
}

/** Build a namespaced `AgentTool` from an MCP tool definition. */
function makeTool(
  transport: HttpMcpTransport,
  namespace: string,
  def: ToolDefinition,
  defaultTimeout: number | undefined,
): AgentTool {
  const rawName = typeof def.name === "string" ? def.name : "";
  const fullName = rawName ? `${namespace}:${rawName}` : namespace;
  const parameters = inputSchemaToTypeBox(def.inputSchema);
  const modern = isModernProtocolVersion(transport.getProtocolVersion());
  const bindings = modern ? headerBindings(def.inputSchema) : [];
  const execute: AgentTool["execute"] = async (args, ctx) => {
    const res = await transport.request<CallToolResult>(
      "tools/call",
      { name: rawName, arguments: args },
      { signal: ctx.signal, timeout: defaultTimeout, headers: headersForBindings(bindings, args) },
    );
    return mapCallResult(res);
  };
  return {
    name: fullName,
    description: typeof def.description === "string" ? def.description : "",
    parameters,
    execute,
  };
}

/**
 * Map an MCP `CallToolResult` to a string: concatenate `text` content in order,
 * dropping non-text content. A result with `isError: true` is thrown so the
 * agent's tool-error isolation wraps it as `<tool_error name="...">`.
 */
function mapCallResult(res: CallToolResult | undefined): string {
  if (res?.resultType !== undefined && res.resultType !== "complete") {
    throw new Error(`Unsupported MCP tool resultType: ${res.resultType}`);
  }
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content
    .map((c) => (isTextContent(c) ? c.text : null))
    .filter((t): t is string => typeof t === "string")
    .join("\n");
  if (res?.isError) {
    throw new Error(text || "MCP tool call failed (isError)");
  }
  return text;
}

/** Modern results are polymorphic; tool bridging only supports complete results. */
function assertComplete(res: { resultType?: string } | undefined, method: string): void {
  if (res?.resultType !== undefined && res.resultType !== "complete") {
    throw new Error(`Unsupported MCP ${method} resultType: ${res.resultType}`);
  }
}

function serverInfoFromResultMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const info = meta?.["io.modelcontextprotocol/serverInfo"] as
    | { name?: unknown }
    | undefined;
  return typeof info?.name === "string" ? info.name : undefined;
}

/**
 * Collect `x-mcp-header` annotations reachable through `properties` chains.
 * This is the only placement allowed by modern MCP; annotations in arrays,
 * composition, or `$ref` subtrees must cause the tool to be rejected.
 */
function headerBindings(inputSchema: unknown): HeaderBinding[] {
  const bindings: HeaderBinding[] = [];
  collectHeaderBindings(inputSchema, [], bindings);
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(binding.name)) {
      throw new Error(`invalid x-mcp-header name: ${binding.name}`);
    }
    const key = binding.name.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate x-mcp-header name: ${binding.name}`);
    seen.add(key);
  }
  return bindings;
}

function collectHeaderBindings(
  schema: unknown,
  path: string[],
  output: HeaderBinding[],
): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;

  for (const [key, child] of Object.entries(properties)) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
    const annotation = (child as { [x: string]: unknown })["x-mcp-header"];
    if (annotation !== undefined) {
      if (typeof annotation !== "string") {
        throw new Error("x-mcp-header must be a string");
      }
      const type = (child as { type?: unknown }).type;
      if (type !== "string" && type !== "integer" && type !== "boolean") {
        throw new Error("x-mcp-header may only annotate string, integer, or boolean properties");
      }
      output.push({ path: [...path, key], name: annotation });
    }
    collectHeaderBindings(child, [...path, key], output);
  }
}

function headersForBindings(bindings: HeaderBinding[], args: unknown): HeadersInit | undefined {
  if (bindings.length === 0) return undefined;
  const headers = new Headers();
  for (const binding of bindings) {
    const value = valueAtPath(args, binding.path);
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && (!Number.isInteger(value) || !Number.isSafeInteger(value))) {
      throw new Error(`Mcp-Param-${binding.name} requires a safe integer`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Mcp-Param-${binding.name} requires a primitive value`);
    }
    headers.set(`Mcp-Param-${binding.name}`, encodeMcpHeaderValue(String(value)));
  }
  return headers;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isTextContent(c: unknown): c is { type: "text"; text: string } {
  if (typeof c !== "object" || c === null) return false;
  const node = c as { type?: unknown; text?: unknown };
  return node.type === "text" && typeof node.text === "string";
}

/** Reduce a server name to a safe namespace prefix (no `:`/whitespace/etc.). */
function sanitizeNamespace(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned || "mcp";
}
