/**
 * moongazer domain types.
 *
 * Provider-agnostic message, tool, and event shapes. Nothing here depends on
 * any specific model provider's wire format; the OpenAI adapter in
 * `adapters/openai.ts` translates to/from that format.
 */

import type { TObject, Static } from "@sinclair/typebox";

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

/**
 * Per-call context handed to a tool's `execute`. Carries the run's abort
 * signal so remote/async tools (e.g. MCP-backed tools) can be cancelled when
 * the run is stopped. Local tools may simply ignore it.
 */
export interface ToolExecutionContext {
  signal: AbortSignal;
}

export interface AgentTool<T extends TObject = TObject> {
  name: string;
  description: string;
  /**
   * TypeBox object schema describing the tool's parameters. Also serves as the
   * JSON Schema sent to the model (symbol metadata is stripped on serialization).
   */
  parameters: T;
  execute: (args: Static<T>, ctx: ToolExecutionContext) => Promise<unknown> | unknown;
}

/**
 * A source of tools that the agent merges into its registry per run. Used to
 * bridge remote tool providers (such as an MCP server) whose tool set is
 * discovered at runtime and may change. Local tools registered directly on the
 * agent always take precedence over tools with the same name from a source.
 */
export interface ToolSource {
  /** Return the source's current tool set. Called at run start and on invalidation. */
  list(ctx: ToolExecutionContext): Promise<AgentTool[]>;
  /**
   * Subscribe to "the tool set may have changed". The agent re-lists at the
   * next round boundary (never mid-round). Returns an unsubscribe function.
   * Optional: sources with a static tool set may omit it.
   */
  onInvalidated?: (listener: () => void) => () => void;
  /** Release any connections/resources held by the source. */
  close(): void;
}

export type AgentEvent =
  | { type: "assistant_start" }
  | { type: "content"; delta: string }
  | { type: "tool_calls"; calls: ToolCallPart[] }
  | { type: "tool_result"; id: string; result: string }
  | { type: "done" }
  | { type: "error"; error: unknown }
  | { type: "abort" }
  | { type: "reasoning"; delta: string };

export interface AgentRunHandle {
  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Abort the in-flight run, keeping whatever was already received. */
  stop(): void;
}
