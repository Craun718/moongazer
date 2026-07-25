# moongazer

轻量级、框架无关的 TypeScript 库，用于构建带工具调用 (tool-use) 能力的 LLM 代理循环。  
A lightweight, framework-agnostic TypeScript library for building LLM agent loops with tool-use support.

## 概述 / Overview

**moongazer** 将 LLM 流式补全抽象为 `ChatTransport` 接口，并在此基础上提供事件驱动的代理运行时。它不绑定任何具体模型提供商——你可以直接使用内置的 OpenAI 适配器，或为其他提供商编写自定义适配器。  
**moongazer** abstracts LLM streaming completions behind a `ChatTransport` interface, then provides an event-driven agent runtime on top. It does not tie to any specific model provider — you can use the built-in OpenAI adapter or write a custom adapter for any other provider.

### 核心特性 / Features

- **提供者无关** — 通过 `ChatTransport` 接口适配任何 LLM 提供商  
  **Provider-agnostic** — adapt any LLM provider via the `ChatTransport` interface
- **工具调用** — 原生支持函数调用，自动拼接流式工具参数片段  
  **Tool calls** — native function calling with automatic reassembly of streaming tool-call deltas
- **事件驱动** — 代理运行时通过订阅者模式暴露 `AgentEvent`，便于日志、存储和 UI 集成  
  **Event-driven** — the agent runtime exposes `AgentEvent` via a subscriber pattern, making it easy to integrate with logging, storage, and UI
- **中止支持** — 安全地中止正在运行中的轮次，保留已收到的内容  
  **Abort support** — safely abort an in-flight run while keeping content already received
- **零外部依赖** — 核心库无运行时依赖（OpenAI 适配器只定义 TypeScript 类型，无 `openai` 包依赖）  
  **Zero runtime dependencies** — the core library has no runtime dependencies (the OpenAI adapter only defines TypeScript types, no `openai` package dependency)

## 安装 / Installation

```bash
pnpm add moongazer
```

## 快速开始 / Quick Start

```typescript
import { createAgent, createOpenAITransport } from "moongazer";
import type { OpenAIRawStream } from "moongazer";

// 1. 定义一个工具 / Define a tool
const getWeather = {
  name: "get_weather",
  description: "获取指定城市的天气 / Get weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  },
  execute: async ({ city }: { city: string }) => {
    return `Weather in ${city}: sunny, 22°C`;
  },
};

// 2. 创建 OpenAI 传输层 / Create OpenAI transport
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
  // ... parse SSE chunks and yield OpenAIChatChunk objects
};

const transport = createOpenAITransport(rawStream);

// 3. 创建代理并运行 / Create agent and run
const agent = createAgent({ transport, tools: [getWeather] });

const handle = agent.run({
  messages: [{ role: "user", content: "北京今天天气怎么样？" }],
});

handle.subscribe((event) => {
  if (event.type === "content") console.log(event.delta);
});
```

## 项目结构 / Project Structure

```
src/
├── index.ts              # 公开导出 / Public exports
├── types.ts              # 领域类型 / Domain types
├── transport.ts          # ChatTransport 接口 / ChatTransport interface
├── agent.ts              # 代理运行时 / Agent runtime (createAgent)
├── emitter.ts            # 轻量级事件发射器 / Lightweight emitter
└── adapters/
    └── openai.ts         # OpenAI 流式适配器 / OpenAI streaming adapter
```

## 许可 / License

[MIT](LICENSE)
