# moongazer

A lightweight, framework-agnostic TypeScript library for building LLM agent loops with tool-use support.

## Overview

**moongazer** abstracts LLM streaming completions behind a `ChatTransport` interface, then provides an event-driven agent runtime on top. It does not tie to any specific model provider — you can use the built-in OpenAI adapter or write a custom adapter for any other provider.

### Features

- **Provider-agnostic** — adapt any LLM provider via the `ChatTransport` interface
- **Tool calls** — native function calling with automatic reassembly of streaming tool-call deltas
- **Event-driven** — the agent runtime exposes `AgentEvent` via a subscriber pattern, making it easy to integrate with logging, storage, and UI
- **Abort support** — safely abort an in-flight run while keeping content already received
- **Zero runtime dependencies** — the core library has no runtime dependencies (the OpenAI adapter only defines TypeScript types, no `openai` package dependency)

## Installation

```bash
pnpm add moongazer
```

## Quick Start

```typescript
import { createAgent, createOpenAITransport } from "moongazer";
import type { OpenAIRawStream } from "moongazer";

// 1. Define a tool
const getWeather = {
  name: "get_weather",
  description: "Get weather for a city",
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
});
```

## Project Structure

```
src/
├── index.ts              # Public exports
├── types.ts              # Domain types
├── transport.ts          # ChatTransport interface
├── agent.ts              # Agent runtime (createAgent)
├── emitter.ts            # Lightweight emitter
└── adapters/
    └── openai.ts         # OpenAI streaming adapter
```

## License

[MIT](LICENSE)
