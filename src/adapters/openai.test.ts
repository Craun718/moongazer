import { describe, expect, it } from "vitest";
import { createOpenAITransport } from "./openai";
import type { OpenAIChatChunk, OpenAIRawStream } from "./openai";
import type { TransportEvent } from "../transport";

/** Build a minimal streaming chunk carrying the given delta fields. */
function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): OpenAIChatChunk {
  return {
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  } as unknown as OpenAIChatChunk;
}

/** A raw stream that replays a fixed list of chunks. */
function rawFrom(chunks: OpenAIChatChunk[]): OpenAIRawStream {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const signal = new AbortController().signal;

describe("createOpenAITransport", () => {
  it("emits content deltas in arrival order", async () => {
    const transport = createOpenAITransport(
      rawFrom([chunk({ content: "Hel" }), chunk({ content: "lo" })]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);
    const text = events.map((e) => (e.type === "content" ? e.delta : "")).join("");
    expect(text).toBe("Hello");
  });

  it("reassembles a tool call whose arguments arrive in fragments", async () => {
    const transport = createOpenAITransport(
      rawFrom([
        chunk({
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get" } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ' "Paris"}' } }] }, "tool_calls"),
      ]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);
    const calls = events.find((e) => e.type === "tool_calls");
    expect(calls).toEqual({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "get", arguments: '{"city": "Paris"}' }],
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });

  it("tracks multiple tool calls by their index", async () => {
    const transport = createOpenAITransport(
      rawFrom([
        chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f1" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "f2" } }] }, "tool_calls"),
      ]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);
    const calls = events.find((e) => e.type === "tool_calls");
    expect(calls?.type === "tool_calls" && calls.calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("ignores chunks without choices", async () => {
    const transport = createOpenAITransport(
      rawFrom([{ choices: [] } as unknown as OpenAIChatChunk]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);
    expect(events).toEqual([]);
  });

  it("emits reasoning deltas alongside content", async () => {
    const transport = createOpenAITransport(
      rawFrom([
        chunk({ reasoning_content: "Let me think about", content: "" }),
        chunk({ reasoning_content: " this step by step", content: "" }),
        chunk({ reasoning_content: "", content: "Here is the answer." }),
      ]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);

    const reasoning = events
      .filter((e): e is { type: "reasoning"; delta: string } => e.type === "reasoning")
      .map((e) => e.delta)
      .join("");
    const content = events
      .filter((e): e is { type: "content"; delta: string } => e.type === "content")
      .map((e) => e.delta)
      .join("");

    expect(reasoning).toBe("Let me think about this step by step");
    expect(content).toBe("Here is the answer.");
  });

  it("ignores empty reasoning_content", async () => {
    const transport = createOpenAITransport(
      rawFrom([chunk({ reasoning_content: null, content: "Hello" })]),
    );
    const events: TransportEvent[] = [];
    for await (const e of transport.stream({ messages: [], tools: [], signal })) events.push(e);
    const reasoning = events.filter((e) => e.type === "reasoning");
    expect(reasoning).toEqual([]);
  });
});
