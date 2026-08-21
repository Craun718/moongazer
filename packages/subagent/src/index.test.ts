import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  defineTool,
  Type,
  type AgentEvent,
  type ChatTransport,
  type TransportEvent,
} from "@pulonia/moongazer";
import { createSubagentTool } from "./index";

function scriptedTransport(responses: TransportEvent[][]): {
  transport: ChatTransport;
  requests: Array<{ signal: AbortSignal; messages: unknown[] }>;
} {
  let call = 0;
  const requests: Array<{ signal: AbortSignal; messages: unknown[] }> = [];
  const transport: ChatTransport = {
    async *stream(request) {
      requests.push({ signal: request.signal, messages: request.messages });
      const response = responses[call++] ?? [{ type: "finish", reason: "stop" }];
      for (const event of response) yield event;
    },
  };
  return { transport, requests };
}

function runToCompletion(agent: ReturnType<typeof createAgent>): Promise<AgentEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    const handle = agent.run({ messages: [{ role: "user", content: "go" }] });
    handle.subscribe((event) => {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        if (event.type === "error") reject(event.error);
        else resolve(events);
      }
    });
  });
}

describe("createSubagentTool", () => {
  it("returns the child's final assistant content after tool use", async () => {
    const search = defineTool({
      name: "search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: ({ query }) => `results for ${query}`,
    });
    const { transport } = scriptedTransport([
      [
        { type: "content", delta: "I will search." },
        {
          type: "tool_calls",
          calls: [{ id: "child-call", name: "search", arguments: '{"query":"agents"}' }],
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "content", delta: "final child answer" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const child = createAgent({ transport, tools: [search], maxSteps: 2 });
    const onEvent = vi.fn();
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
      onEvent,
    });

    const result = await delegate.execute(
      { task: "research agents" },
      { signal: new AbortController().signal },
    );

    expect(result).toBe("final child answer");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
  });

  it("returns the child's canonical assistant message after response hooks", async () => {
    const child = createAgent({
      transport: {
        async *stream() {
          yield { type: "content", delta: "raw answer" };
          yield { type: "finish", reason: "stop" };
        },
      },
      hooks: {
        afterModelResponse: ({ message }) => ({
          message: { ...message, content: "rewritten answer" },
        }),
      },
    });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });

    await expect(
      delegate.execute({ task: "go" }, { signal: new AbortController().signal }),
    ).resolves.toBe("rewritten answer");
  });

  it("propagates child errors to the parent tool boundary", async () => {
    const child = createAgent({
      transport: {
        async *stream() {
          const shouldFail = true;
          if (shouldFail) throw new Error("child transport failed");
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });

    await expect(
      delegate.execute({ task: "go" }, { signal: new AbortController().signal }),
    ).rejects.toThrow("child transport failed");
  });

  it("passes the parent tool signal to the child run", async () => {
    const requests: Array<{ signal: AbortSignal }> = [];
    let transportStarted: (() => void) | undefined;
    const child = createAgent({
      transport: {
        async *stream(request) {
          requests.push({ signal: request.signal });
          transportStarted?.();
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "content", delta: "child answer" };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });
    const controller = new AbortController();

    const started = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });
    const result = delegate.execute({ task: "go" }, { signal: controller.signal });
    await started;
    controller.abort();
    await result;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it("returns an explicit result when the child is already aborted", async () => {
    const { transport, requests } = scriptedTransport([
      [
        { type: "content", delta: "never emitted" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const child = createAgent({ transport });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(delegate.execute({ task: "go" }, { signal: controller.signal })).resolves.toBe(
      "<subagent_error>Subagent run aborted</subagent_error>",
    );
    expect(requests).toHaveLength(0);
  });

  it("does not return an assistant's tool-request preamble as its final answer", async () => {
    const search = defineTool({
      name: "search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: ({ query }) => `results for ${query}`,
    });
    const child = createAgent({
      transport: {
        async *stream() {
          yield { type: "content", delta: "I will search first." };
          yield {
            type: "tool_calls",
            calls: [{ id: "child-call", name: "search", arguments: '{"query":"agents"}' }],
          };
          yield { type: "finish", reason: "tool_calls" };
        },
      },
      tools: [search],
      maxSteps: 1,
    });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });

    await expect(
      delegate.execute({ task: "go" }, { signal: new AbortController().signal }),
    ).resolves.toBe(
      "<subagent_error>Subagent ended without a final assistant response</subagent_error>",
    );
  });

  it("isolates onEvent observer failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { transport } = scriptedTransport([
        [
          { type: "content", delta: "child answer" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const child = createAgent({ transport });
      const delegate = createSubagentTool(child, {
        name: "delegate",
        description: "Delegate work",
        parameters: Type.Object({ task: Type.String() }),
        buildMessages: ({ task }) => [{ role: "user", content: task }],
        onEvent: async () => {
          throw new Error("observer failed");
        },
      });

      await expect(
        delegate.execute({ task: "go" }, { signal: new AbortController().signal }),
      ).resolves.toBe("child answer");
      expect(warn).toHaveBeenCalledWith(
        "[moongazer/subagent] onEvent observer failed:",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("feeds the child result back through a parent agent run", async () => {
    const child = createAgent({
      transport: {
        async *stream() {
          yield { type: "content", delta: "child answer" };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const delegate = createSubagentTool(child, {
      name: "delegate",
      description: "Delegate work",
      parameters: Type.Object({ task: Type.String() }),
      buildMessages: ({ task }) => [{ role: "user", content: task }],
    });
    const { transport, requests } = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [
            {
              id: "parent-call",
              name: "delegate",
              arguments: '{"task":"research"}',
            },
          ],
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "content", delta: "parent answer" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const parent = createAgent({ transport, tools: [delegate] });

    const events = await runToCompletion(parent);

    expect(events).toContainEqual({
      type: "tool_result",
      id: "parent-call",
      result: "child answer",
      name: "delegate",
      durationMs: expect.any(Number),
    });
    const toolResult = requests[1]?.messages.find(
      (message) => (message as { role?: string }).role === "tool",
    );
    expect((toolResult as { content?: string }).content).toBe("child answer");
  });
});
