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

| Property    | Type            | Default      | Description              |
| ----------- | --------------- | ------------ | ------------------------ |
| `transport` | `ChatTransport` | — (required) | Streaming chat transport |
| `tools`     | `AgentTool[]`   | `[]`         | Initial tool list        |
| `maxSteps`  | `number`        | `6`          | Max tool round-trips     |

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
    | { type: "tool_result"; id: string; result: string }
    | { type: "done" }
    | { type: "error"; error: unknown }
    | { type: "abort" };
    | { type: "reasoning"; delta: string }
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
import { Type, type Static } from "moongazer";

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
import { defineTool, Type } from "moongazer";

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
  subscribe(listener: (event: AgentEvent) => void): () => void;
  stop(): void;
}
```

| Method      | Description                                                |
| ----------- | ---------------------------------------------------------- |
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
