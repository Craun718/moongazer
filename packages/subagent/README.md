# @pulonia/moongazer-subagent

Turn a moongazer agent into a tool that a parent agent can call.

```ts
import { createAgent, createOpenAITransport, Type, defineTool } from "@pulonia/moongazer";
import { createSubagentTool } from "@pulonia/moongazer-subagent";

const search = defineTool({
  name: "search",
  description: "Search the web",
  parameters: Type.Object({ query: Type.String() }),
  execute: async ({ query }) => searchWeb(query),
});

const researchAgent = createAgent({
  transport: createOpenAITransport(rawStream),
  tools: [search],
  maxSteps: 8,
});

const research = createSubagentTool(researchAgent, {
  name: "research",
  description: "Research a topic and return a concise summary.",
  parameters: Type.Object({
    task: Type.String(),
  }),
  buildMessages: ({ task }) => [{ role: "user", content: task }],
  onEvent(event) {
    // Forward child events to your own logger or UI.
  },
});

const manager = createAgent({
  transport: createOpenAITransport(rawStream),
  tools: [research],
});
```

The child conversation and tool set are deliberately not inherited from the
parent. This keeps delegation behavior explicit: the caller chooses the child
transport, tools, hooks, `maxSteps`, and prompt shape. The parent tool's abort
signal is passed to the child run, so stopping the parent also stops the child.
The tool returns the child's final assistant content. A failed child run throws
and is surfaced through moongazer's normal `<tool_error>` isolation.

This package uses the same version number as `@pulonia/moongazer`.
