# moongazer

A lightweight, framework-agnostic TypeScript library for building LLM agent loops with tool-use support.

English | [Chinese](./README.zh.md)

## Overview

**moongazer** abstracts LLM streaming completions behind a `ChatTransport` interface, then provides an event-driven agent runtime on top. It does not tie to any specific model provider — you can use the built-in OpenAI adapter or write a custom adapter for any other provider.

### Features

- **Provider-agnostic** — adapt any LLM provider via the `ChatTransport` interface
- **Type-safe tools** — define tools with TypeBox schemas; the `execute` argument type is inferred from the schema, and the model's JSON is validated at runtime (defaults applied, invalid args rejected) via `Value.Default` + `Value.Assert`
- **Reasoning content** — streams `reasoning` deltas from models that emit `reasoning_content` (e.g. OpenAI o1/o3)
- **Tool calls** — native function calling with automatic reassembly of streaming tool-call deltas
- **Event-driven** — the agent runtime exposes `AgentEvent` via a subscriber pattern, making it easy to integrate with logging, storage, and UI
- **Abort support** — safely abort an in-flight run while keeping content already received
- **Minimal dependencies** — only `@sinclair/typebox` as a runtime dependency (the OpenAI adapter defines TypeScript types only, no `openai` package)

## Installation

```bash
pnpm add moongazer
```

## API Documentation

[API Documentation](./docs/en/api.md)

## Quick Start

```typescript
import { createAgent, createOpenAITransport, defineTool, Type } from "moongazer";
import type { OpenAIRawStream } from "moongazer";

// 1. Define a tool
const getWeather = defineTool({
  name: "get_weather",
  description: "Get weather for a city",
  parameters: Type.Object({
    city: Type.String(),
  }),
  execute: async ({ city }) => {
    return `Weather in ${city}: sunny, 22°C`;
  },
});

// 2. Create OpenAI transport
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

// 3. Create agent and run
const agent = createAgent({ transport, tools: [getWeather] });

const handle = agent.run({
  messages: [{ role: "user", content: "What is the weather in Beijing today?" }],
});

handle.subscribe((event) => {
  if (event.type === "content") console.log(event.delta);
  if (event.type === "reasoning") console.log(event.delta);
});
```

## Demo Project

[Demo](https://github.com/Craun718/WebAgentDemo)

## License

[MIT](LICENSE)
