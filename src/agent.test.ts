import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "./agent";
import type { Agent } from "./agent";
import type { ChatTransport, TransportEvent } from "./transport";
import type { AgentEvent, AgentHooks, AgentMessage, AgentTool, ToolSource } from "./types";

/** A transport that replays scripted rounds and captures the context it saw. */
function scriptedTransport(rounds: TransportEvent[][], captured?: string[][]): ChatTransport {
  let i = 0;
  return {
    async *stream({ messages, signal }) {
      captured?.push(messages.map((m) => m.role));
      const events = rounds[i++] ?? [];
      for (const ev of events) {
        if (signal.aborted) break;
        yield ev;
      }
    },
  };
}

/** Run an agent to completion, collecting all emitted events. */
function runToCompletion(agent: Agent, messages: AgentMessage[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const handle = agent.run({ messages });
  handle.subscribe((ev) => {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error" || ev.type === "abort" || ev.type === "stopped")
      resolve();
  });
  return done.then(() => events);
}

/** Run with hooks and resolve only after onRunEnd has completed. */
function runWithHooks(
  agent: Agent,
  messages: AgentMessage[],
  hooks: AgentHooks,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const handle = agent.run({
    messages,
    hooks: {
      ...hooks,
      onRunEnd: async (ctx) => {
        await hooks.onRunEnd?.(ctx);
        resolve();
      },
    },
  });
  handle.subscribe((ev) => {
    events.push(ev);
  });
  return done.then(() => events);
}

/** A controllable ToolSource for tests: swap its tool set and signal invalidation. */
function makeSource(initial: AgentTool[]) {
  let current = initial;
  let calls = 0;
  const listeners = new Set<() => void>();
  const source: ToolSource = {
    list: async () => {
      calls += 1;
      return current;
    },
    onInvalidated: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close: () => {},
  };
  return {
    source,
    setTools: (t: AgentTool[]) => {
      current = t;
    },
    invalidate: () => {
      for (const l of listeners) l();
    },
    listCalls: () => calls,
  };
}

describe("createAgent", () => {
  it("runs a tool round then a final answer", async () => {
    const captured: string[][] = [];
    const transport = scriptedTransport(
      [
        [
          { type: "content", delta: "查一下。" },
          {
            type: "tool_calls",
            calls: [{ id: "c1", name: "get_current_time", arguments: "{}" }],
          },
        ],
        [{ type: "content", delta: "现在是 11:37。" }],
      ],
      captured,
    );
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "get_current_time",
          description: "time",
          parameters: Type.Object({}),
          execute: () => "11:37",
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "几点了" }]);

    expect(events.map((e) => e.type)).toEqual([
      "assistant_start",
      "content",
      "tool_calls",
      "tool_result",
      "assistant_start",
      "content",
      "done",
    ]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "content" }> => e.type === "content")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("查一下。现在是 11:37。");
    // Round 2 context includes the prior assistant turn and tool result.
    expect(captured).toEqual([["user"], ["user", "assistant", "tool"]]);
  });

  it("stops at maxSteps", async () => {
    const loop: TransportEvent[] = [
      { type: "tool_calls", calls: [{ id: "x", name: "f", arguments: "{}" }] },
    ];
    const transport = scriptedTransport([loop, loop, loop, loop]);
    const agent = createAgent({
      transport,
      tools: [{ name: "f", description: "", parameters: Type.Object({}), execute: () => "r" }],
      maxSteps: 2,
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.filter((e) => e.type === "assistant_start")).toHaveLength(2);
  });

  it("aborts keeping the partial content received so far", async () => {
    const transport: ChatTransport = {
      async *stream() {
        yield { type: "content", delta: "x" };
        yield { type: "content", delta: "y" };
        yield { type: "content", delta: "z" };
      },
    };
    const agent = createAgent({ transport, tools: [] });

    const events: AgentEvent[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const handle = agent.run({ messages: [{ role: "user", content: "q" }] });
    handle.subscribe((ev) => {
      events.push(ev);
      if (ev.type === "content" && ev.delta === "x") handle.stop();
      if (ev.type === "abort" || ev.type === "done") resolve();
    });
    await done;

    const deltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "content" }> => e.type === "content",
    );
    expect(deltas.map((e) => e.delta)).toEqual(["x"]);
    expect(events.at(-1)).toMatchObject({ type: "abort" });
  });

  it("decodes the model's tool-call JSON before invoking execute", async () => {
    let received: unknown = undefined;
    const transport = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "weather", arguments: '{"city":"Paris"}' }],
        },
      ],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "weather",
          description: "weather",
          parameters: Type.Object({ city: Type.String() }),
          execute: (args) => {
            received = args;
            return "sunny";
          },
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "paris weather" }]);

    expect(received).toEqual({ city: "Paris" });
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toBe("sunny");
  });

  it("applies schema defaults during decode", async () => {
    let received: unknown = undefined;
    const transport = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "inc", arguments: "{}" }],
        },
      ],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "inc",
          description: "increment",
          parameters: Type.Object({ n: Type.Number({ default: 5 }) }),
          execute: (args) => {
            received = args;
            return "ok";
          },
        },
      ],
    });

    await runToCompletion(agent, [{ role: "user", content: "go" }]);

    expect(received).toEqual({ n: 5 });
  });

  it("handles an unknown tool by reporting it instead of crashing", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "ghost", arguments: "{}" }] }],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({ transport, tools: [] });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    // No registered tool: the agent degrades to a string result and keeps going.
    expect(result?.result).toBe("Unknown tool: ghost");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("tolerates malformed JSON tool-call arguments", async () => {
    let received: unknown = undefined;
    const transport = scriptedTransport([
      [
        // Truncated JSON: parseArgs catches and falls back to {}.
        { type: "tool_calls", calls: [{ id: "c1", name: "inc", arguments: '{"n":' }] },
      ],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "inc",
          description: "increment",
          parameters: Type.Object({ n: Type.Number({ default: 5 }) }),
          execute: (args) => {
            received = args;
            return "ok";
          },
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    // Bad JSON degraded to {} (not leaked to execute), then Cast filled the default.
    expect(received).toEqual({ n: 5 });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("tolerates a non-JSON / empty arguments string (broken model output)", async () => {
    let received: unknown = undefined;
    const transport = scriptedTransport([
      [
        // Model emitted nothing usable: parseArgs's `!raw` branch returns {}.
        { type: "tool_calls", calls: [{ id: "c1", name: "inc", arguments: "" }] },
      ],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "inc",
          description: "increment",
          parameters: Type.Object({ n: Type.Number({ default: 5 }) }),
          execute: (args) => {
            received = args;
            return "ok";
          },
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    expect(received).toEqual({ n: 5 });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("isolates a throwing tool as a tool_result error string and continues", async () => {
    const boom = new Error("kaboom");
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "fail", arguments: "{}" }] }],
      [{ type: "content", delta: "recovered" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "fail",
          description: "fails",
          parameters: Type.Object({}),
          execute: () => {
            throw boom;
          },
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    // The throwing tool becomes an error string fed back to the model; the run continues.
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toBe(`<tool_error name="fail">kaboom</tool_error>`);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("isolates wrong-type arguments as a tool_result error string and continues", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: '{"n":"abc"}' }] }],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "f",
          description: "",
          parameters: Type.Object({ n: Type.Number() }),
          execute: () => "ok",
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    // execute is never reached; the bad args surface as a tool_result, not an error.
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toContain("tool_error");
    expect(result?.result).toContain('Invalid arguments for tool "f"');
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("isolates missing required arguments as a tool_result error string", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: "{}" }] }],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "f",
          description: "",
          parameters: Type.Object({ n: Type.Number() }),
          execute: () => "ok",
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toContain("tool_error");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("isolates constraint-violating arguments as a tool_result error string", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: '{"n":1}' }] }],
      [{ type: "content", delta: "ok" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "f",
          description: "",
          parameters: Type.Object({ n: Type.Number({ minimum: 100 }) }),
          execute: () => "ok",
        },
      ],
    });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toContain("tool_error");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("merges tools from a ToolSource into the run", async () => {
    const { source } = makeSource([
      {
        name: "remote_tool",
        description: "r",
        parameters: Type.Object({}),
        execute: () => "remote-result",
      },
    ]);
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "remote_tool", arguments: "{}" }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({ transport, toolSources: [source] });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.result).toBe("remote-result");
  });

  it("local tools shadow source tools on name collision", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { source } = makeSource([
        { name: "dup", description: "", parameters: Type.Object({}), execute: () => "remote" },
      ]);
      const transport = scriptedTransport([
        [{ type: "tool_calls", calls: [{ id: "c1", name: "dup", arguments: "{}" }] }],
        [{ type: "content", delta: "done" }],
      ]);
      const agent = createAgent({
        transport,
        tools: [
          { name: "dup", description: "", parameters: Type.Object({}), execute: () => "local" },
        ],
        toolSources: [source],
      });

      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      const result = events.find(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
      );
      expect(result?.result).toBe("local");
    } finally {
      spy.mockRestore();
    }
  });

  it("re-lists a tool source on invalidation at the next round boundary", async () => {
    const { source, setTools, invalidate, listCalls } = makeSource([]);
    const toolB: AgentTool = {
      name: "b",
      description: "",
      parameters: Type.Object({}),
      execute: () => "b-result",
    };
    const toolA: AgentTool = {
      name: "a",
      description: "",
      parameters: Type.Object({}),
      execute: () => {
        // While executing, the source gains a new tool and signals invalidation.
        setTools([toolA, toolB]);
        invalidate();
        return "a-result";
      },
    };
    setTools([toolA]);

    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "1", name: "a", arguments: "{}" }] }],
      [{ type: "tool_calls", calls: [{ id: "2", name: "b", arguments: "{}" }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({ transport, toolSources: [source] });

    const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

    // Initial list at run start + one re-list after invalidation.
    expect(listCalls()).toBe(2);
    const bResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.id === "2",
    );
    expect(bResult?.result).toBe("b-result");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("keeps going when a source's initial list fails (non-abort)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source: ToolSource = {
        list: async () => {
          throw new Error("list boom");
        },
        close: () => {},
      };
      const transport = scriptedTransport([[{ type: "content", delta: "ok" }]]);
      const agent = createAgent({ transport, toolSources: [source] });

      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces abort during tool execution as abort, not error", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((r) => {
      toolStarted = r;
    });
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "1", name: "slow", arguments: "{}" }] }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "slow",
          description: "",
          parameters: Type.Object({}),
          execute: (_args, ctx) => {
            toolStarted();
            return new Promise<string>((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const handle = agent.run({ messages: [{ role: "user", content: "go" }] });
    handle.subscribe((ev) => {
      events.push(ev);
      if (ev.type === "abort" || ev.type === "error" || ev.type === "done") resolve();
    });

    await started;
    handle.stop();
    await done;

    expect(events.at(-1)).toMatchObject({ type: "abort" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("agent hooks", () => {
  it("applies model-request mutations per round without changing the transcript", async () => {
    const requests: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
    const transport: ChatTransport = {
      async *stream({ messages, tools }) {
        requests.push({ messages: [...messages], tools: tools.map((tool) => tool.name) });
        if (requests.length === 1) {
          yield {
            type: "tool_calls",
            calls: [{ id: "blocked", name: "blocked", arguments: "{}" }],
          };
        } else {
          yield { type: "content", delta: "done" };
        }
      },
    };
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "allowed",
          description: "",
          parameters: Type.Object({}),
          execute: () => "allowed-result",
        },
        {
          name: "blocked",
          description: "",
          parameters: Type.Object({}),
          execute: () => "blocked-result",
        },
      ],
    });

    let finalMessages: readonly AgentMessage[] = [];
    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeModelRequest: ({ messages, tools }) => ({
        messages: [...messages, { role: "system", content: "request-only context" }],
        tools: tools.filter((tool) => tool.name === "allowed"),
      }),
      onRunEnd: ({ messages }) => {
        finalMessages = messages;
      },
    });

    expect(requests.map((request) => request.tools)).toEqual([["allowed"], ["allowed"]]);
    expect(requests[0]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: "request-only context",
    });
    expect(requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
    ]);
    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(result?.result).toBe("Unknown tool: blocked");
    expect(finalMessages.some((message) => message.role === "system")).toBe(false);
  });

  it("applies finalized model-response mutations before tools run", async () => {
    const calls: string[] = [];
    const transport = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [{ id: "raw", name: "raw_tool", arguments: '{"n":1}' }],
        },
      ],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "safe_tool",
          description: "",
          parameters: Type.Object({ n: Type.Number() }),
          execute: ({ n }) => `safe:${n}`,
        },
        {
          name: "raw_tool",
          description: "",
          parameters: Type.Object({ n: Type.Number() }),
          execute: () => "raw-result",
        },
      ],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      afterModelResponse: ({ toolCalls }) => ({
        message: { role: "assistant", content: "calling safe tool" },
        toolCalls: [{ id: toolCalls[0]!.id, name: "safe_tool", arguments: '{"n":7}' }],
      }),
    });

    const toolEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_calls" }> => event.type === "tool_calls",
    );
    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(toolEvent?.calls[0]?.name).toBe("safe_tool");
    expect(result?.result).toBe("safe:7");
    expect(calls).toEqual([]);
  });

  it("validates arguments mutated by beforeToolExecute", async () => {
    let received = 0;
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "inc", arguments: '{"n":1}' }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "inc",
          description: "",
          parameters: Type.Object({ n: Type.Number() }),
          execute: (args) => {
            received = (args as { n: number }).n;
            return "ok";
          },
        },
      ],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeToolExecute: () => ({ args: { n: "bad" } }),
    });

    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(received).toBe(0);
    expect(result?.result).toContain('Invalid arguments for tool "inc"');
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("short-circuits tool execution and records metadata in afterToolExecute", async () => {
    const after: Array<{ result: string; shortCircuited: boolean; durationMs: number }> = [];
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "deny", arguments: "{}" }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "deny",
          description: "",
          parameters: Type.Object({}),
          execute: () => "should-not-run",
        },
      ],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeToolExecute: () => ({ result: "permission denied" }),
      afterToolExecute: (ctx) => {
        after.push({
          result: ctx.result,
          shortCircuited: ctx.shortCircuited,
          durationMs: ctx.durationMs,
        });
      },
    });

    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(result).toMatchObject({ result: "permission denied", name: "deny" });
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(after).toEqual([
      { result: "permission denied", shortCircuited: true, durationMs: expect.any(Number) },
    ]);
  });

  it("rewrites results and preserves tool errors in afterToolExecute", async () => {
    const seenErrors: unknown[] = [];
    const transport = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [
            { id: "ok", name: "read", arguments: "{}" },
            { id: "bad", name: "boom", arguments: "{}" },
          ],
        },
      ],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "read",
          description: "",
          parameters: Type.Object({}),
          execute: () => "secret-token",
        },
        {
          name: "boom",
          description: "",
          parameters: Type.Object({}),
          execute: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      afterToolExecute: (ctx) => {
        if (ctx.error) seenErrors.push(ctx.error);
        return { result: ctx.call.id === "ok" ? "redacted" : "recovered" };
      },
    });

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(results.map((event) => event.result)).toEqual(["redacted", "recovered"]);
    expect((seenErrors[0] as Error).message).toBe("kaboom");
  });

  it("runs calls in one round concurrently while preserving transcript order", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = scriptedTransport([
      [
        {
          type: "tool_calls",
          calls: [
            { id: "slow", name: "slow", arguments: "{}" },
            { id: "fast", name: "fast", arguments: "{}" },
          ],
        },
      ],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        {
          name: "slow",
          description: "",
          parameters: Type.Object({}),
          execute: async () => {
            started += 1;
            await gate;
            return "slow-result";
          },
        },
        {
          name: "fast",
          description: "",
          parameters: Type.Object({}),
          execute: async () => {
            started += 1;
            await gate;
            return "fast-result";
          },
        },
      ],
    });

    const eventsPromise = runToCompletion(agent, [{ role: "user", content: "go" }]);
    await vi.waitFor(() => expect(started).toBe(2));
    release();
    const events = await eventsPromise;

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(results.map((event) => event.id)).toEqual(["slow", "fast"]);
    expect(results.map((event) => event.result)).toEqual(["slow-result", "fast-result"]);
  });

  it("chains agent hooks before run hooks and passes mutations forward", async () => {
    const order: string[] = [];
    let received = 0;
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "inc", arguments: '{"n":1}' }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const baseTool: AgentTool = {
      name: "inc",
      description: "",
      parameters: Type.Object({ n: Type.Number() }),
      execute: (args) => {
        received = (args as { n: number }).n;
        return "ok";
      },
    };
    const agent = createAgent({
      transport,
      tools: [baseTool],
      hooks: {
        beforeToolExecute: (ctx) => {
          order.push("agent-before");
          return { args: { ...ctx.args, n: 2 } };
        },
        afterToolExecute: () => {
          order.push("agent-after");
        },
      },
    });

    await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeToolExecute: (ctx) => {
        order.push("run-before");
        return { args: { ...ctx.args, n: 3 } };
      },
      afterToolExecute: () => {
        order.push("run-after");
      },
    });

    expect(received).toBe(3);
    expect(order).toEqual(["agent-before", "run-before", "agent-after", "run-after"]);
  });

  it("emits stopped when a hook requests a stop and still runs onRunEnd", async () => {
    const endStatuses: string[] = [];
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "stop", arguments: "{}" }] }],
    ]);
    const agent = createAgent({
      transport,
      tools: [{ name: "stop", description: "", parameters: Type.Object({}), execute: () => "ok" }],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeToolExecute: () => ({ stop: true, reason: "policy" }),
      onRunEnd: ({ status }) => {
        endStatuses.push(status);
      },
    });

    expect(events.at(-1)).toMatchObject({ type: "stopped", reason: "policy" });
    expect(endStatuses).toEqual(["stopped"]);
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
  });

  it("observes and filters resolved ToolSource tools at refresh boundaries", async () => {
    const reasons: string[] = [];
    const { source, setTools, invalidate } = makeSource([]);
    const firstTool: AgentTool = {
      name: "first",
      description: "",
      parameters: Type.Object({}),
      execute: () => {
        setTools([
          firstTool,
          {
            name: "second",
            description: "",
            parameters: Type.Object({}),
            execute: () => "second-result",
          },
        ]);
        invalidate();
        return "first-result";
      },
    };
    setTools([firstTool]);
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "1", name: "first", arguments: "{}" }] }],
      [{ type: "tool_calls", calls: [{ id: "2", name: "second", arguments: "{}" }] }],
      [{ type: "content", delta: "done" }],
    ]);
    const agent = createAgent({
      transport,
      toolSources: [source],
      hooks: {
        beforeToolsResolved: ({ reason }) => {
          reasons.push(`before:${reason}`);
        },
        afterToolsResolved: ({ reason, tools }) => {
          reasons.push(`after:${reason}:${tools.map((tool) => tool.name).join(",")}`);
          return { tools: tools.filter((tool) => tool.name !== "forbidden") };
        },
      },
    });

    await runWithHooks(agent, [{ role: "user", content: "go" }], {});

    expect(reasons).toEqual([
      "before:initial",
      "after:initial:first",
      "before:invalidated",
      "after:invalidated:first,second",
    ]);
  });

  it("stops before the next model round when shouldContinue returns false", async () => {
    let rounds = 0;
    const transport: ChatTransport = {
      async *stream() {
        rounds += 1;
        yield {
          type: "tool_calls",
          calls: [{ id: `c${rounds}`, name: "noop", arguments: "{}" }],
        };
      },
    };
    const agent = createAgent({
      transport,
      maxSteps: 5,
      tools: [{ name: "noop", description: "", parameters: Type.Object({}), execute: () => "ok" }],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      shouldContinue: () => ({ continue: false }),
    });

    expect(rounds).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("rejects duplicate tool names returned by model-request hooks", async () => {
    const transport = scriptedTransport([[{ type: "content", delta: "done" }]]);
    const agent = createAgent({
      transport,
      tools: [{ name: "dup", description: "", parameters: Type.Object({}), execute: () => "ok" }],
    });

    const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
      beforeModelRequest: ({ messages, tools }) => ({
        messages: [...messages],
        tools: [...tools, ...tools],
      }),
    });

    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("passes the final transcript and error to onRunEnd", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = new Error("transport boom");
      const transport: ChatTransport = {
        stream() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.reject(failure),
              };
            },
          };
        },
      };
      const agent = createAgent({ transport });

      let endStatus = "";
      let endError: unknown;
      let endMessages: readonly AgentMessage[] = [];
      const events = await runWithHooks(agent, [{ role: "user", content: "go" }], {
        onRunEnd: ({ status, error, messages }) => {
          endStatus = status;
          endError = error;
          endMessages = messages;
        },
      });

      expect(events.at(-1)).toMatchObject({ type: "error", error: failure });
      expect(endStatus).toBe("error");
      expect(endError).toBe(failure);
      expect(endMessages).toEqual([{ role: "user", content: "go" }]);
    } finally {
      spy.mockRestore();
    }
  });
});
