# API 参考

## 项目结构

```
src/
├── index.ts              # 公开导出
├── types.ts              # 领域类型（AgentTool、AgentMessage 等）
├── tool.ts               # defineTool 辅助函数（TypeBox schema -> 带类型的工具）
├── transport.ts          # ChatTransport 接口
├── agent.ts              # 代理运行时（createAgent）
├── emitter.ts            # 轻量级事件发射器
└── adapters/
    └── openai.ts         # OpenAI 流式适配器
```

## 目录

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

创建代理实例。持有独立的工具注册表和中止控制器，多个代理可并发运行，无模块级单例。

```typescript
function createAgent(options: AgentOptions): Agent;
```

### AgentOptions

| 属性          | 类型            | 默认值    | 描述                           |
| ------------- | --------------- | --------- | ------------------------------ |
| `transport`   | `ChatTransport` | —（必填） | 流式聊天传输层                 |
| `tools`       | `AgentTool[]`   | `[]`      | 初始工具列表                   |
| `toolSources` | `ToolSource[]`  | `[]`      | 可刷新的远程工具来源           |
| `maxSteps`    | `number`        | `6`       | 工具调用最大轮次，防止无限循环 |
| `hooks`       | `AgentHooks`    | —         | 所有 run 共享的 hooks          |

### Agent

```typescript
interface Agent {
  /** 注册一个工具 */
  registerTool(tool: AgentTool): void;
  /** 运行代理 */
  run(options: RunOptions): AgentRunHandle;
}
```

#### RunOptions

| 属性       | 类型             | 默认值    | 描述                   |
| ---------- | ---------------- | --------- | ---------------------- |
| `messages` | `AgentMessage[]` | —（必填） | 对话历史（不会被变异） |
| `signal`   | `AbortSignal`    | —         | 外部中止信号           |
| `hooks`    | `RunHooks`       | —         | 当前 run 专属 hooks    |

#### 示例

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

Hooks 是 agent runtime 的决策点。它们与 `AgentEvent` 互补：事件是给观察者的只读通知，hooks 可以修改请求数据、短路工作或停止运行。

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

Agent 级 hooks 通过 `createAgent({ hooks })` 传入；run 级 hooks 通过 `agent.run({ hooks })` 传入。同一 hook 点先执行 agent hooks，再执行 run hooks；前一个 hook 返回的修改对后一个 hook 可见。

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

| Hook                  | 时机                                  | 可返回                                |
| --------------------- | ------------------------------------- | ------------------------------------- |
| `onRunStart`          | 工具发现前                            | 仅观察                                |
| `beforeToolsResolved` | 每次 `ToolSource.list()` 前           | 仅观察                                |
| `afterToolsResolved`  | 本地/来源工具合并和本地优先规则应用后 | `{ tools }`                           |
| `beforeModelRequest`  | 每次 transport 请求前                 | messages、tools 或 stop               |
| `afterModelResponse`  | 流结束后、工具执行前                  | assistant message、tool calls 或 stop |
| `beforeToolExecute`   | 参数解析、默认值和校验后              | args、短路 result 或 stop             |
| `afterToolExecute`    | 工具执行或隔离的工具错误后            | result 或 stop                        |
| `shouldContinue`      | 内置规则允许进入下一轮时              | `{ continue: false }`                 |
| `onRunEnd`            | 终态事件后                            | 仅观察                                |

关键规则：

- Hook 输入使用 readonly 数组；需要修改时返回替换数组，不要原地修改入参。
- `beforeModelRequest` 的 messages 只影响本次 provider 请求，不写入 canonical transcript。
- `beforeModelRequest` 的 tools 同时用于模型可见列表和实际执行查找。
- Hook 返回的工具列表不允许重复 name。
- `beforeToolExecute` 返回的 args 会重新应用默认值并执行 schema 校验。
- `beforeToolExecute` 返回 result 时跳过 `tool.execute`；`afterToolExecute` 仍会执行，且 `shortCircuited: true`。
- Unknown tool 也会触发工具 hooks，其中 `tool` 为 `undefined`。
- 工具失败、非法参数和普通工具 hook 失败都会转换为 `<tool_error>` result。
- 工具发现、模型阶段、`shouldContinue` 和 `onRunStart` hook 失败会终止 run。
- Hook 返回 stop 时发出 `stopped`；外部取消或 `handle.stop()` 发出 `abort`。
- `onRunEnd` 对每种终态只执行一次；它自身失败只记录日志，不替换已发出的终态。
- `shouldContinue` 不能突破 `maxSteps`。

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

将 OpenAI 兼容的原始流包装为提供者无关的 `ChatTransport`。负责将 `AgentMessage`/`AgentTool` 翻译为 OpenAI 线路格式，并重组碎片化的流式工具调用参数。

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

#### OpenAIRawRequest

```typescript
interface OpenAIRawRequest {
  messages: OpenAIWireMessage[];
  tools?: OpenAIWireTool[];
  tool_choice?: "auto" | "none" | "required";
}
```

#### 示例

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
    // ... 解析 SSE "data: ..." 行并 yield OpenAIChatChunk
  }
};

const transport = createOpenAITransport(rawStream);
```

---

## createEmitter

创建轻量级事件发射器，支持多个订阅者。每个运行可通过多个订阅者同时被日志、存储适配器和遥测观察。

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

| 事件类型     | 描述                               |
| ------------ | ---------------------------------- |
| `content`    | 文本增量                           |
| `tool_calls` | 工具调用（已重组完成）             |
| `finish`     | 流结束及原因                       |
| `reasoning`  | 来自模型的推理文本增量（如思维链） |

---

## AgentEvent

代理运行时在运行期间发出的所有事件。通过 `AgentRunHandle.subscribe` 订阅。

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

| 事件类型          | 描述                               |
| ----------------- | ---------------------------------- |
| `assistant_start` | 助手开始响应                       |
| `content`         | 文本增量                           |
| `tool_calls`      | 模型请求工具调用                   |
| `tool_result`     | 工具执行完成                       |
| `done`            | 运行正常结束                       |
| `error`           | 运行出错                           |
| `abort`           | 运行被中止                         |
| `reasoning`       | 来自模型的推理文本增量（如思维链） |
| `stopped`         | Hook 主动停止运行                  |

---

## AgentMessage

对话消息的提供者无关表示。

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
  /** 模型发出的原始 JSON 参数字符串 */
  arguments: string;
}
```

---

## AgentTool

工具定义。`parameters` 是一个 TypeBox `TObject` schema —— 它同时作为发送给模型的 JSON Schema 和 `execute` 入参的编译期类型（通过 `Static<T>`），因此 schema 与处理函数不会再失配。

```typescript
import { Type, type Static } from "@pulonia/moongazer";

interface AgentTool<T extends TObject = TObject> {
  name: string;
  description: string;
  /** TypeBox 对象 schema；序列化为 JSON Schema 发给模型 */
  parameters: T;
  execute: (args: Static<T>) => Promise<unknown> | unknown;
}
```

每次调用前，代理运行时先对模型返回的 JSON 执行 `Value.Default(tool.parameters, parsedArgs)` 填充 schema 的 `default` 值，再用 `Value.Assert(tool.parameters, ...)` 严格校验。`execute` 拿到的是校验通过的值；不合法的工具参数会作为 `error` 事件抛出，而不会被静默强制转换。

## defineTool

带类型推断的辅助函数，是构建工具的推荐方式。`T` 由 `parameters` 推断，无需手写泛型，`execute` 的入参类型始终与 schema 同步。

```typescript
function defineTool<T extends TObject>(opts: {
  name: string;
  description: string;
  parameters: T;
  execute: (args: Static<T>) => Promise<unknown> | unknown;
}): AgentTool<T>;
```

#### 示例

```typescript
import { defineTool, Type } from "@pulonia/moongazer";

const searchTool = defineTool({
  name: "web_search",
  description: "搜索互联网",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词" }),
  }),
  execute: async ({ query }) => {
    // `query` 类型为 `string`
    return `Results for "${query}" ...`;
  },
});
```

---

## AgentRunHandle

控制正在运行的代理。

```typescript
interface AgentRunHandle {
  runId: string;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  stop(): void;
}
```

| 成员        | 描述                           |
| ----------- | ------------------------------ |
| `runId`     | 用于链路追踪和遥测的稳定 ID    |
| `subscribe` | 订阅代理事件，返回取消订阅函数 |
| `stop`      | 中止运行，保留已收到的部分内容 |

---

## OpenAI 线路类型

这些类型用于与 OpenAI 兼容 API 交互时描述线路格式。无运行时依赖。

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

## 常量

`Type` 与 `Static` 从 `@sinclair/typebox` 重新导出，调用者用单一导入即可构建 schema。

| 名称                | 值  | 描述                             |
| ------------------- | --- | -------------------------------- |
| `DEFAULT_MAX_STEPS` | `6` | `createAgent` 的默认最大工具轮次 |
