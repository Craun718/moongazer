export type {
  AgentRole,
  AgentMessage,
  AgentTool,
  AgentEvent,
  AgentRunHandle,
  ToolCallPart,
  ToolExecutionContext,
  ToolSource,
  MaybePromise,
  StopResult,
  AgentHookBase,
  RunStartContext,
  RunEndContext,
  ToolsPhaseContext,
  ToolsMutationResult,
  ToolsResolvedContext,
  ModelRequestContext,
  ModelRequestMutationResult,
  BeforeModelRequestInput,
  ModelResponseContext,
  ModelResponseMutationResult,
  ToolExecutionContextData,
  ToolArgsMutationResult,
  ToolShortCircuitResult,
  BeforeToolExecuteInput,
  AfterToolExecuteInput,
  ToolResultMutationResult,
  ContinueContext,
  ContinueDecision,
  AgentHooks,
  RunHooks,
} from "./types";

export type { ChatTransport, TransportEvent, TransportRequest } from "./transport";

export { createAgent, DEFAULT_MAX_STEPS } from "./agent";
export type { Agent, AgentOptions, RunOptions } from "./agent";

export { defineTool } from "./tool";

// Re-export TypeBox's schema builder and type helper so callers can define
// tools with a single import surface (`Type.Object`, `Type.String`, ...).
export { Type, type Static } from "@sinclair/typebox";

export { createEmitter } from "./emitter";
export type { Emitter } from "./emitter";

export { createOpenAITransport } from "./adapters/openai";
export type {
  OpenAIRawStream,
  OpenAIRawRequest,
  OpenAIChatChunk,
  OpenAIChoice,
  OpenAIDelta,
  OpenAIToolCallDelta,
  OpenAIWireMessage,
  OpenAIWireTool,
  OpenAIWireFunctionCall,
} from "./adapters/openai";
