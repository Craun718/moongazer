import type { AgentMessage, AgentTool, ToolCallPart } from "./types";

/** Events emitted by a `ChatTransport` while streaming a single completion. */
export type TransportEvent =
  | { type: "content"; delta: string }
  | { type: "tool_calls"; calls: ToolCallPart[] }
  | { type: "reasoning"; delta: string }
  | { type: "finish"; reason: string };

export interface TransportRequest {
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
}

/**
 * Provider-agnostic streaming transport. The agent loop depends only on this
 * interface; each provider implements it (or adapts a raw stream) via an
 * adapter such as `createOpenAITransport`.
 */
export interface ChatTransport {
  stream(request: TransportRequest): AsyncIterable<TransportEvent>;
}
