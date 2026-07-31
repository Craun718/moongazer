/**
 * @moongazer/mcp - MCP (Model Context Protocol) client support for moongazer.
 *
 * This package keeps MCP machinery out of the moongazer core: a hand-rolled
 * JSON-RPC 2.0 layer (NDJSON framing + connection) and a JSON Schema -> TypeBox
 * converter that bridges MCP tool `inputSchema`s to moongazer's `AgentTool`s.
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

// NDJSON framing codec.
export { LineReader, encodeMessage } from "./json-rpc/framing";

// JSON-RPC connection (request/response correlation, notifications, reverse
// requests, abort, timeout).
export { JsonRpcConnection, RpcError } from "./json-rpc/connection";
export type {
  DuplexLike,
  JsonRpcRequestHandler,
  JsonRpcConnectionOptions,
} from "./json-rpc/connection";

// JSON Schema -> TypeBox converter for MCP tool input schemas.
export { inputSchemaToTypeBox } from "./schema/convert";
export type { JsonSchema } from "./schema/convert";
