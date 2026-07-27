# moongazer

轻量级、框架无关的 TypeScript 库，用于构建带工具调用 (tool-use) 能力的 LLM 代理循环。

## 概述

**moongazer** 将 LLM 流式补全抽象为 `ChatTransport` 接口，并在此基础上提供事件驱动的代理运行时。它不绑定任何具体模型提供商——你可以直接使用内置的 OpenAI 适配器，或为其他提供商编写自定义适配器。

### 核心特性

- **提供者无关** — 通过 `ChatTransport` 接口适配任何 LLM 提供商
- **类型安全工具** — 用 TypeBox schema 定义工具；`execute` 入参类型由 schema 推断，运行时通过 `Value.Cast` 对模型 JSON 做强制转换/校验
- **推理内容** — 从支持 `reasoning_content` 的模型（如 OpenAI o1/o3）中流式输出 `reasoning` 增量事件
- **工具调用** — 原生支持函数调用，自动拼接流式工具参数片段
- **事件驱动** — 代理运行时通过订阅者模式暴露 `AgentEvent`，便于日志、存储和 UI 集成
- **中止支持** — 安全地中止正在运行中的轮次，保留已收到的内容
- **最小依赖** — 仅 `@sinclair/typebox` 一个运行时依赖（OpenAI 适配器只定义 TypeScript 类型，无 `openai` 包依赖）

## 安装

```bash
pnpm add moongazer
```

## 快速开始

```typescript
import {
    createAgent,
    createOpenAITransport,
    defineTool,
    Type,
} from "moongazer";
import type { OpenAIRawStream } from "moongazer";

// 1. 定义一个工具
const getWeather = defineTool({
    name: "get_weather",
    description: "获取指定城市的天气",
    parameters: Type.Object({
        city: Type.String(),
    }),
    execute: async ({ city }) => {
        return `Weather in ${city}: sunny, 22°C`;
    },
});

// 2. 创建 OpenAI 传输层
const rawStream: OpenAIRawStream = async function* (request, signal) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ ...request, model: "gpt-4o", stream: true }),
        signal,
    });
    const reader = response.body!.getReader();
    // ... 解析 SSE 分片并 yield OpenAIChatChunk 对象
};

const transport = createOpenAITransport(rawStream);

// 3. 创建代理并运行
const agent = createAgent({ transport, tools: [getWeather] });

const handle = agent.run({
    messages: [{ role: "user", content: "北京今天天气怎么样？" }],
});

handle.subscribe((event) => {
    if (event.type === "content") console.log(event.delta);
    if (event.type === "reasoning") console.log(event.delta);
});
```

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

## 许可

[MIT](LICENSE)
