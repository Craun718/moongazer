import type { AgentTool, ToolExecutionContext, ToolSource } from "moongazer";
import { HttpMcpTransport } from "./http";
import type { HttpMcpTransportOptions } from "./http";
import { inputSchemaToTypeBox } from "./schema/convert";

/** MCP protocol version this client advertises in the initialize handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

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
  /** Per-request timeout (ms) for the initialize handshake. Default 30000. */
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
interface ToolDefinition {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}
interface ToolsListResult {
  tools?: ToolDefinition[];
}
interface CallToolResult {
  content?: Array<{ type?: string; text?: string } | unknown>;
  isError?: boolean;
}

/**
 * Create an MCP client that exposes a server's tools as a moongazer
 * `ToolSource`. Performs the `initialize` handshake up front, then lists tools
 * on demand (at run start and whenever the agent re-lists on invalidation).
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

  const init = await transport.request<InitializeResult>(
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: options.clientInfo ?? { name: "moongazer", version: "0.1.0" },
    },
    { timeout: options.initTimeout ?? 30000 },
  );
  // Per spec: after a successful initialize the client MUST notify initialized.
  await transport.notify("notifications/initialized");

  const namespace = sanitizeNamespace(init?.serverInfo?.name ?? options.name ?? "mcp");

  const list = async (ctx: ToolExecutionContext): Promise<AgentTool[]> => {
    const res = await transport.request<ToolsListResult>("tools/list", undefined, {
      signal: ctx.signal,
      timeout: options.defaultTimeout,
    });
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

  const close = (): void => {};

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
  const execute: AgentTool["execute"] = async (args, ctx) => {
    const res = await transport.request<CallToolResult>(
      "tools/call",
      { name: rawName, arguments: args },
      { signal: ctx.signal, timeout: defaultTimeout },
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
