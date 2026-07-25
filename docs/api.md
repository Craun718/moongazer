# API 参考 / API Reference

## 目录 / Table of Contents

- [createAgent](#createagent)
- [createOpenAITransport](#createopentransport)
- [createEmitter](#createemitter)
- [ChatTransport](#chattransport)
- [AgentEvent](#agentevent)
- [AgentMessage](#agentmessage)
- [AgentTool](#agenttool)
- [AgentRunHandle](#agentrunhandle)
- [TransportEvent](#transportevent)
- [OpenAIRawStream](#openairawstream)

---

## createAgent

创建代理实例。持有独立的工具注册表和中止控制器，多个代理可并发运行，无模块级单例。  
Creates an agent instance with its own tool registry and abort controller, allowing multiple agents to run concurrently without module-level singletons.

```typescript
function createAgent(options: AgentOptions): Agent;
```

### AgentOptions

| 属性 / Property | 类型 / Type     | 默认值 / Default     | 描述 / Description                                    |
| --------------- | --------------- | -------------------- | ----------------------------------------------------- |
| `transport`     | `ChatTransport` | —（必填 / required） | 流式聊天传输层 / Streaming chat transport             |
| `tools`         | `AgentTool[]`   | `[]`                 | 初始工具列表 / Initial tool list                      |
| `maxSteps`      | `number`        | `6`                  | 工具调用最大轮次，防止无限循环 / Max tool round-trips |

### Agent

```typescript
interface Agent {
    /** 注册一个工具 / Register a tool */
    registerTool(tool: AgentTool): void;
    /** 运行代理 / Run the agent */
    run(options: RunOptions): AgentRunHandle;
}
```

#### RunOptions

| 属性 / Property | 类型 / Type      | 默认值 / Default | 描述 / Description                            |
| --------------- | ---------------- | ---------------- | --------------------------------------------- |
| `messages`      | `AgentMessage[]` | —（必填）        | 对话历史（不会被变异） / Conversation history |
| `signal`        | `AbortSignal`    | —                | 外部中止信号 / External abort signal          |

#### 示例 / Example

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

将 OpenAI 兼容的原始流包装为提供者无关的 `ChatTransport`。负责将 `AgentMessage`/`AgentTool` 翻译为 OpenAI 线路格式，并重组碎片化的流式工具调用参数。  
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

应用程序拥有 URL、鉴权和传输机制（例如 SSE）；只需在数据到达时 yield chunk，在鉴权失败时 reject。  
The application owns the URL, auth, and transport mechanism (e.g. SSE); it only needs to yield chunks as they arrive and reject on auth errors.

#### OpenAIRawRequest

```typescript
interface OpenAIRawRequest {
    messages: OpenAIWireMessage[];
    tools?: OpenAIWireTool[];
    tool_choice?: "auto" | "none" | "required";
}
```

#### 示例 / Example

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

创建轻量级事件发射器，支持多个订阅者。每个运行可通过多个订阅者同时被日志、存储适配器和遥测观察。  
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

提供者无关的流式传输接口。代理循环仅依赖此接口；每个提供商通过适配器（如 `createOpenAITransport`）实现它。  
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
```

| 事件类型 / Type | 描述 / Description                  |
| --------------- | ----------------------------------- |
| `content`       | 文本增量 / Text delta               |
| `tool_calls`    | 工具调用（已重组完成） / Tool calls |
| `finish`        | 流结束及原因 / Stream finished      |

---

## AgentEvent

代理运行时在运行期间发出的所有事件。通过 `AgentRunHandle.subscribe` 订阅。  
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
```

| 事件类型 / Type   | 描述 / Description                            |
| ----------------- | --------------------------------------------- |
| `assistant_start` | 助手开始响应 / Assistant started responding   |
| `content`         | 文本增量 / Text delta                         |
| `tool_calls`      | 模型请求工具调用 / Model requested tool calls |
| `tool_result`     | 工具执行完成 / Tool execution completed       |
| `done`            | 运行正常结束 / Run completed normally         |
| `error`           | 运行出错 / Run encountered an error           |
| `abort`           | 运行被中止 / Run was aborted                  |

---

## AgentMessage

对话消息的提供者无关表示。  
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
    /** 模型发出的原始 JSON 参数字符串 / Raw JSON arguments string from the model */
    arguments: string;
}
```

---

## AgentTool

工具定义。`parameters` 使用 JSON Schema 描述参数。  
Tool definition. `parameters` uses JSON Schema to describe arguments.

```typescript
interface AgentTool<TArgs = Record<string, unknown>> {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: TArgs) => Promise<unknown> | unknown;
}
```

#### 示例 / Example

```typescript
const searchTool: AgentTool<{ query: string }> = {
    name: "web_search",
    description: "搜索互联网 / Search the internet",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
    },
    execute: async ({ query }) => {
        // 实现搜索逻辑 / implement search logic
        return `Results for "${query}" ...`;
    },
};
```

---

## AgentRunHandle

控制正在运行的代理。  
Controls a running agent.

```typescript
interface AgentRunHandle {
    subscribe(listener: (event: AgentEvent) => void): () => void;
    stop(): void;
}
```

| 方法 / Method | 描述 / Description                                         |
| ------------- | ---------------------------------------------------------- |
| `subscribe`   | 订阅代理事件，返回取消订阅函数 / Subscribe to agent events |
| `stop`        | 中止运行，保留已收到的部分内容 / Abort the run             |

---

## OpenAI 线路类型 / OpenAI Wire Types

这些类型用于与 OpenAI 兼容 API 交互时描述线路格式。无运行时依赖。  
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

## 常量 / Constants

| 名称 / Name         | 值 / Value | 描述 / Description                                         |
| ------------------- | ---------- | ---------------------------------------------------------- |
| `DEFAULT_MAX_STEPS` | `6`        | `createAgent` 的默认最大工具轮次 / Default max tool rounds |
