/**
 * @moongazer/mcp - MCP (Model Context Protocol) client support for moongazer.
 *
 * This package keeps MCP machinery out of the moongazer core: a hand-rolled
 * Streamable HTTP client and a JSON Schema -> TypeBox converter that bridges
 * MCP tool `inputSchema`s to moongazer's `AgentTool`s.
 */

// JSON-RPC message types and standard error codes.
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from "./json-rpc/types";
export {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "./json-rpc/types";

// JSON Schema -> TypeBox converter for MCP tool input schemas.
export { inputSchemaToTypeBox } from "./schema/convert";
export type { JsonSchema } from "./schema/convert";

// Browser-native Streamable HTTP transport and MCP client.
export { HttpMcpTransport, McpHttpError } from "./http";
export type { HttpMcpTransportOptions, McpRequestOptions } from "./http";
export { createMcpClient, MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from "./client";
export type { CreateMcpClientOptions, McpClientInfo, McpProtocolVersion } from "./client";
