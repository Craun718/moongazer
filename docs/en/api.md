# API Reference

## Project Structure

```
src/
├── index.ts              # Public exports
├── types.ts              # Domain types (AgentTool, AgentMessage, ...)
├── tool.ts               # defineTool helper (TypeBox schema -> typed tool)
├── transport.ts          # ChatTransport interface
├── agent.ts              # Agent runtime (createAgent)
├── emitter.ts            # Lightweight emitter
└── adapters/
    └── openai.ts         # OpenAI streaming adapter
```

## Table of Contents

- [createAgent](#createagent)
- [AgentHooks](#agenthooks)
- [createOpenAITransport](#createopentransport)
- [createEmitter](#createemitter)
- [ChatTransport](#chattransport)
- [AgentEvent](#agentevent)
- [AgentMessage](#agentmessage)
- [AgentTool](#agenttool)
- [defineTool](#definetool)
- [AgentRunHandle](#agentrunhandle)
- [TransportEvent](#transportevent)
- [OpenAIRawStream](#openairawstream)

---

## createAgent

Creates an agent instance with its own tool registry and abort controller, allowing multiple agents to run concurrently without module-level singletons.

```typescript
function createAgent(options: AgentOptions): Agent;
```

### AgentOptions

| Property      | Type            | Default      | Description                     |
| ------------- | --------------- | ------------ | ------------------------------- |
| `transport`   | `ChatTransport` | — (required) | Streaming chat transport        |
| `tools`       | `AgentTool[]`   | `[]`         | Initial tool list               |
| `toolSources` | `ToolSource[]`  | `[]`         | Refreshable remote tool sources |
| `maxSteps`    | `number`        | `6`          | Max tool round-trips            |
| `hooks`       | `AgentHooks`    | —            | Hooks shared by every run       |

### Agent

```typescript
interface Agent {
  /** Register a tool */
  registerTool(tool: AgentTool): void;
  /** Run the agent */
  run(options: RunOptions): AgentRunHandle;
}
```

#### RunOptions

| Property   | Type             | Default      | Description                        |
| ---------- | ---------------- | ------------ | ---------------------------------- |
| `messages` | `AgentMessage[]` | — (required) | Conversation history (not mutated) |
| `signal`   | `AbortSignal`    | —            | External abort signal              |
| `hooks`    | `RunHooks`       | —            | Hooks scoped to this run           |

#### Example

```typescript
const agent = createAgent({
  transport: myTransport,
  tools: [myTool],
  maxSteps: 4,
});

const handle = agent.run({
  messages: [{ role: "user", content: "Hello!" }],
});

handle.subscribe((event) => {
  if (event.type === "content") process.stdout.write(event.delta);
});
```

---

## AgentHooks

Hooks are decision points in the agent runtime. They complement `AgentEvent`: events are read-only notifications, while hooks can modify request data, short-circuit work, or stop a run.

```text
run start
  -> tool source discovery / refresh
  -> each model round
     -> beforeModelRequest
     -> transport streaming
     -> afterModelResponse
     -> beforeToolExecute
     -> tool execute
     -> afterToolExecute
     -> shouldContinue
  -> run end
```

Agent-level hooks are passed to `createAgent({ hooks })`. Run-level hooks are passed to `agent.run({ hooks })`. At the same point, agent hooks run first and run hooks run second; mutations returned by one hook are visible to the next.

```typescript
interface AgentHooks {
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
```

| Hook                  | Timing                                                | Can return                             |
| --------------------- | ----------------------------------------------------- | -------------------------------------- |
| `onRunStart`          | Before tool discovery                                 | Observation only                       |
| `beforeToolsResolved` | Before each `ToolSource.list()`                       | Observation only                       |
| `afterToolsResolved`  | After local/source merge and local-name precedence    | `{ tools }`                            |
| `beforeModelRequest`  | Before each transport request                         | messages, tools, or stop               |
| `afterModelResponse`  | After stream completion, before tools run             | assistant message, tool calls, or stop |
| `beforeToolExecute`   | After argument parsing, defaults, and validation      | args, short-circuit result, or stop    |
| `afterToolExecute`    | After execution or an isolated tool error             | result or stop                         |
| `shouldContinue`      | After a round when built-in rules allow another round | `{ continue: false }`                  |
| `onRunEnd`            | After the terminal event                              | Observation only                       |

Key rules:

- Hook inputs use readonly arrays; return replacement arrays instead of mutating inputs.
- `beforeModelRequest` messages affect only that provider request and are not added to the transcript.
- `beforeModelRequest` tools are both advertised and used for execution lookup.
- Returned tool lists cannot contain duplicate names.
- Arguments returned by `beforeToolExecute` are defaulted and validated again.
- A `beforeToolExecute` result skips `tool.execute`; `afterToolExecute` still runs with `shortCircuited: true`.
- Unknown tools still invoke tool hooks with `tool: undefined`.
- Tool failures, invalid arguments, and ordinary tool-hook failures become `<tool_error>` results.
- Discovery, model, `shouldContinue`, and `onRunStart` hook failures terminate the run.
- A stop result emits `stopped`; external cancellation or `handle.stop()` emits `abort`.
- `onRunEnd` runs once for every terminal state; its own failure is logged without replacing the terminal event.
- `shouldContinue` cannot extend a run beyond `maxSteps`.

```typescript
const handle = agent.run({
  messages,
  hooks: {
    beforeModelRequest: ({ messages, tools }) => ({
      messages: [...messages, { role: "system", content: `Tenant: ${tenantId}` }],
      tools: tools.filter((tool) => permissions.canCall(tool.name)),
    }),
    beforeToolExecute: ({ tool }) => {
      if (!tool || !permissions.canCall(tool.name)) {
        return { result: "<tool_error>permission denied</tool_error>" };
      }
    },
    afterToolExecute: ({ result }) => ({ result: redactSecrets(result) }),
    onRunEnd: ({ status, messages }) => {
      void saveTranscript({ status, messages });
    },
  },
});
```

---

## createOpenAITransport

Wraps an OpenAI-compatible raw stream into a provider-agnostic `ChatTransport`. Translates `AgentMessage`/`AgentTool` into OpenAI wire format and reassembles fragmented streaming tool-call deltas.

```typescript
function createOpenAITransport(raw: OpenAIRawStream): ChatTransport;
```

### OpenAIRawStream

```typescript
type OpenAIRawStream = (
  request: OpenAIRawRequest,
  signal: AbortSignal,
) => AsyncIterable<OpenAIChatChunk>;
```

The application owns the URL, auth, and transport mechanism (e.g. SSE); it only needs to yield chunks as they arrive and reject on auth errors.

#### OpenAIRawRequest

```typescript
interface OpenAIRawRequest {
  messages: OpenAIWireMessage[];
  tools?: OpenAIWireTool[];
  tool_choice?: "auto" | "none" | "required";
}
```

#### Example

```typescript
const rawStream: OpenAIRawStream = async function* (request, signal) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ ...request, model: "gpt-4o", stream: true }),
    signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // ... parse SSE "data: ..." lines and yield OpenAIChatChunk
  }
};

const transport = createOpenAITransport(rawStream);
```

---

## createEmitter

Creates a minimal zero-dependency emitter supporting multiple subscribers, so a run can be observed by a logger, a store adapter, and telemetry simultaneously.

```typescript
function createEmitter<T>(): Emitter<T>;
```

### Emitter

```typescript
interface Emitter<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
  close(): void;
}
```

---

## ChatTransport

Provider-agnostic streaming transport. The agent loop depends only on this interface; each provider implements it via an adapter.

```typescript
interface ChatTransport {
  stream(request: TransportRequest): AsyncIterable<TransportEvent>;
}
```

### TransportRequest

```typescript
interface TransportRequest {
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
}
```

### TransportEvent

```typescript
type TransportEvent =
    | { type: "content"; delta: string }
    | { type: "tool_calls"; calls: ToolCallPart[] }
    | { type: "finish"; reason: string };
    | { type: "reasoning"; delta: string }
```

| Type         | Description                                                 |
| ------------ | ----------------------------------------------------------- |
| `content`    | Text delta                                                  |
| `tool_calls` | Tool calls (reassembled)                                    |
| `finish`     | Stream finished                                             |
| `reasoning`  | Reasoning text delta from the model (e.g. chain-of-thought) |

---

## AgentEvent

All events emitted by the agent runtime during a run. Subscribe via `AgentRunHandle.subscribe`.

```typescript
type AgentEvent =
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
```

| Type              | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `assistant_start` | Assistant started responding                                |
| `content`         | Text delta                                                  |
| `tool_calls`      | Model requested tool calls                                  |
| `tool_result`     | Tool execution completed                                    |
| `done`            | Run completed normally                                      |
| `error`           | Run encountered an error                                    |
| `abort`           | Run was aborted                                             |
| `reasoning`       | Reasoning text delta from the model (e.g. chain-of-thought) |
| `stopped`         | A hook explicitly stopped the run                           |

---

## AgentMessage

Provider-agnostic representation of a conversation message.

```typescript
interface AgentMessage {
  role: AgentRole;
  content: string | null;
  toolCalls?: ToolCallPart[];
  toolCallId?: string;
}
```

### AgentRole

```typescript
type AgentRole = "system" | "user" | "assistant" | "tool";
```

### ToolCallPart

```typescript
interface ToolCallPart {
  id: string;
  name: string;
  /** Raw JSON arguments string from the model */
  arguments: string;
}
```

---

## AgentTool

Tool definition. `parameters` is a [TypeBox](https://www.npmjs.com/package/@sinclair/typebox) `TObject` schema — it doubles as the JSON Schema sent to the model and as the compile-time type of `execute`'s argument (via `Static<T>`), so the schema and the handler can no longer drift apart.

```typescript
import { Type, type Static } from "@pulonia/moongazer";

interface AgentTool<T extends TObject = TObject> {
  name: string;
  description: string;
  /** TypeBox object schema; serialized as JSON Schema for the model */
  parameters: T;
  execute: (args: Static<T>) => Promise<unknown> | unknown;
}
```

Before each invocation, the agent runtime runs `Value.Default(tool.parameters, parsedArgs)` to fill schema `default` values, then `Value.Assert(tool.parameters, ...)` to validate. `execute` receives the validated value; invalid tool arguments are surfaced as an `error` event instead of being silently coerced.

## defineTool

Inferred-type helper and the recommended way to build a tool. `T` is inferred from `parameters`, so you never annotate the generic by hand and `execute`'s argument type stays in sync with the schema.

```typescript
function defineTool<T extends TObject>(opts: {
  name: string;
  description: string;
  parameters: T;
  execute: (args: Static<T>) => Promise<unknown> | unknown;
}): AgentTool<T>;
```

#### Example

```typescript
import { defineTool, Type } from "@pulonia/moongazer";

const searchTool = defineTool({
  name: "web_search",
  description: "Search the internet",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
  }),
  execute: async ({ query }) => {
    // `query` is typed as `string`
    return `Results for "${query}" ...`;
  },
});
```

---

## AgentRunHandle

Controls a running agent.

```typescript
interface AgentRunHandle {
  runId: string;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  stop(): void;
}
```

| Member      | Description                                                |
| ----------- | ---------------------------------------------------------- |
| `runId`     | Stable identifier for tracing and telemetry                |
| `subscribe` | Subscribe to agent events; returns an unsubscribe function |
| `stop`      | Abort the run, keeping partial content received            |

---

## OpenAI Wire Types

These types describe the wire format for interacting with OpenAI-compatible APIs. No runtime dependency.

### OpenAIChatChunk / OpenAIChoice / OpenAIDelta / OpenAIToolCallDelta

```typescript
interface OpenAIChatChunk {
  choices?: OpenAIChoice[];
}

interface OpenAIChoice {
  index: number;
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

interface OpenAIDelta {
  content?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
  reasoning_content?: string | null;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}
```

### OpenAIWireMessage / OpenAIWireTool / OpenAIWireFunctionCall

```typescript
interface OpenAIWireMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAIWireFunctionCall[];
  tool_call_id?: string;
}

interface OpenAIWireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIWireFunctionCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
```

---

## Constants

`Type` and `Static` are re-exported from `@sinclair/typebox` so callers can build schemas with a single import surface.

| Name                | Value | Description                               |
| ------------------- | ----- | ----------------------------------------- |
| `DEFAULT_MAX_STEPS` | `6`   | Default max tool rounds for `createAgent` |
