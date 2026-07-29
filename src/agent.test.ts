import { describe, expect, it } from "vitest";
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
});
