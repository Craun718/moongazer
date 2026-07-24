/**
 * moongazer domain types.
 *
 * Provider-agnostic message, tool, and event shapes. Nothing here depends on
 * any specific model provider's wire format; the OpenAI adapter in
 * `adapters/openai.ts` translates to/from that format.
 */

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallPart {
  id: string;
  name: string;
  /** Raw JSON arguments string exactly as emitted by the model. */
  arguments: string;
}

export interface AgentMessage {
  role: AgentRole;
  /** Assistant turns that only request tools use `null`. */
  content: string | null;
  /** Present on assistant turns that request tool calls. */
  toolCalls?: ToolCallPart[];
  /** Present on tool result messages. */
  toolCallId?: string;
}

export interface AgentTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
  execute: (args: TArgs) => Promise<unknown> | unknown;
}

export type AgentEvent =
  | { type: "assistant_start" }
  | { type: "content"; delta: string }
  | { type: "tool_calls"; calls: ToolCallPart[] }
  | { type: "tool_result"; id: string; result: string }
  | { type: "done" }
  | { type: "error"; error: unknown }
  | { type: "abort" };

export interface AgentRunHandle {
  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Abort the in-flight run, keeping whatever was already received. */
  stop(): void;
}
