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

export type MaybePromise<T> = T | Promise<T>;

export interface StopResult {
  stop: true;
  reason?: string;
}

export interface AgentHookBase {
  runId: string;
  signal: AbortSignal;
}

export interface RunStartContext extends AgentHookBase {
  messages: readonly AgentMessage[];
}

export interface RunEndContext extends AgentHookBase {
  status: "done" | "error" | "abort" | "stopped";
  steps: number;
  messages: readonly AgentMessage[];
  error?: unknown;
}

export interface ToolsPhaseContext extends AgentHookBase {
  reason: "initial" | "invalidated";
  source?: ToolSource;
}

export interface ToolsMutationResult {
  tools?: AgentTool[];
}

export interface ToolsResolvedContext extends AgentHookBase {
  reason: "initial" | "invalidated";
  source?: ToolSource;
  tools: readonly AgentTool[];
}

export interface ModelRequestContext extends AgentHookBase {
  step: number;
  maxSteps: number;
}

export interface ModelRequestMutationResult {
  messages?: AgentMessage[];
  tools?: AgentTool[];
}

export interface BeforeModelRequestInput {
  messages: readonly AgentMessage[];
  tools: readonly AgentTool[];
}

export interface ModelResponseContext extends AgentHookBase {
  step: number;
  message: AgentMessage;
  toolCalls: readonly ToolCallPart[];
  finishReason?: string;
}

export interface ModelResponseMutationResult {
  message?: AgentMessage;
  toolCalls?: ToolCallPart[];
}

export interface ToolExecutionContextData extends AgentHookBase {
  step: number;
  call: ToolCallPart;
  tool?: AgentTool;
}

export interface ToolArgsMutationResult {
  args?: Record<string, unknown>;
}

export interface ToolShortCircuitResult {
  result: string;
}

export interface BeforeToolExecuteInput extends ToolArgsMutationResult {
  args: Readonly<Record<string, unknown>>;
}

export interface AfterToolExecuteInput {
  args: Readonly<Record<string, unknown>>;
  result: string;
  error?: unknown;
  durationMs: number;
  shortCircuited: boolean;
}

export interface ToolResultMutationResult {
  result?: string;
}

export interface ContinueContext extends AgentHookBase {
  step: number;
  maxSteps: number;
  messages: readonly AgentMessage[];
  lastToolResults: readonly string[];
}

export interface ContinueDecision {
  continue?: boolean;
  reason?: string;
}

export interface AgentHooks {
  onRunStart?: (ctx: RunStartContext) => MaybePromise<void>;
  onRunEnd?: (ctx: RunEndContext) => MaybePromise<void>;

  beforeToolsResolved?: (ctx: ToolsPhaseContext) => MaybePromise<void>;
  afterToolsResolved?: (ctx: ToolsResolvedContext) => MaybePromise<ToolsMutationResult | void>;

  beforeModelRequest?: (
    ctx: ModelRequestContext & BeforeModelRequestInput,
  ) => MaybePromise<ModelRequestMutationResult | StopResult | void>;
  afterModelResponse?: (
    ctx: ModelResponseContext,
  ) => MaybePromise<ModelResponseMutationResult | StopResult | void>;

  beforeToolExecute?: (
    ctx: ToolExecutionContextData & BeforeToolExecuteInput,
  ) => MaybePromise<ToolArgsMutationResult | ToolShortCircuitResult | StopResult | void>;
  afterToolExecute?: (
    ctx: ToolExecutionContextData & AfterToolExecuteInput,
  ) => MaybePromise<ToolResultMutationResult | StopResult | void>;

  shouldContinue?: (ctx: ContinueContext) => MaybePromise<ContinueDecision | void>;
}

export type RunHooks = AgentHooks;

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
  | {
      type: "tool_result";
      id: string;
      result: string;
      name?: string;
      durationMs?: number;
    }
  | { type: "done" }
  | { type: "error"; error: unknown }
  | { type: "abort" }
  | { type: "reasoning"; delta: string }
  | { type: "stopped"; reason?: string };

export interface AgentRunHandle {
  /** Stable identifier for this run; useful for tracing and telemetry. */
  runId: string;
  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Abort the in-flight run, keeping whatever was already received. */
  stop(): void;
}
