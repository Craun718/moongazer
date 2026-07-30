import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "./agent";
import type { Agent } from "./agent";
import type { ChatTransport, TransportEvent } from "./transport";
import type { AgentEvent, AgentMessage } from "./types";

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
    if (ev.type === "done" || ev.type === "error" || ev.type === "abort") resolve();
  });
  return done.then(() => events);
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

  it("emits an error event when a tool throws", async () => {
    const boom = new Error("kaboom");
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "fail", arguments: "{}" }] }],
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

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      // The throwing tool produces no tool_result; the run surfaces an error.
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
      expect((events.at(-1) as Extract<AgentEvent, { type: "error" }>).error).toBe(boom);
      // The original error is also logged for traceability before the event fires.
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("agent run error"), boom);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects wrong-type arguments with an error event", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: '{"n":"abc"}' }] }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        { name: "f", description: "", parameters: Type.Object({ n: Type.Number() }), execute: () => "ok" },
      ],
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      // execute is never reached; the bad args surface as an error event.
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
      const err = (events.at(-1) as Extract<AgentEvent, { type: "error" }>).error as Error;
      expect(err.message).toContain('Invalid arguments for tool "f"');
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing required arguments with an error event", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: "{}" }] }],
    ]);
    const agent = createAgent({
      transport,
      tools: [
        { name: "f", description: "", parameters: Type.Object({ n: Type.Number() }), execute: () => "ok" },
      ],
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      expect(events.some((e) => e.type === "tool_result")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects constraint-violating arguments with an error event", async () => {
    const transport = scriptedTransport([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "f", arguments: '{"n":1}' }] }],
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

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await runToCompletion(agent, [{ role: "user", content: "go" }]);

      expect(events.some((e) => e.type === "tool_result")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
    } finally {
      spy.mockRestore();
    }
  });
});
