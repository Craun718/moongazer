import type { ChatTransport } from "../transport";
import type { AgentMessage, AgentTool, ToolCallPart } from "../types";

// --- Vendored OpenAI wire shapes (structural only; no `openai` dependency) ---

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIDelta {
  content?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIChoice {
  index: number;
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

export interface OpenAIChatChunk {
  choices?: OpenAIChoice[];
}

export interface OpenAIWireFunctionCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIWireMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAIWireFunctionCall[];
  tool_call_id?: string;
}

export interface OpenAIWireTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAIRawRequest {
  messages: OpenAIWireMessage[];
  tools?: OpenAIWireTool[];
  tool_choice?: "auto" | "none" | "required";
}

/**
 * A raw OpenAI-compatible stream: receives the wire request and produces an
 * async iterable of OpenAI-shaped chunks. The application owns the URL, auth,
 * and transport mechanism (e.g. SSE); it only needs to yield chunks as they
 * arrive and reject on auth errors.
 */
export type OpenAIRawStream = (
  request: OpenAIRawRequest,
  signal: AbortSignal,
) => AsyncIterable<OpenAIChatChunk>;

// --- Streaming accumulator (reassembles fragmented tool-call deltas) ---

interface Slot {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface Accumulator {
  finishReason: string | null;
  toolCalls: (Slot | undefined)[];
}

function createAccumulator(): Accumulator {
  return { finishReason: null, toolCalls: [] };
}

/**
 * Merge one streaming chunk into the accumulator. Tool-call deltas are keyed by
 * their `index`: the model streams `id`/`function.name` once and then
 * `function.arguments` as a sequence of JSON string fragments that we append.
 */
function accumulateChunk(acc: Accumulator, chunk: OpenAIChatChunk): void {
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  const calls = choice.delta?.tool_calls;
  if (!calls) return;
  for (const incoming of calls) {
    const idx = incoming.index;
    let slot = acc.toolCalls[idx];
    if (!slot) {
      slot = { index: idx, id: "", name: "", arguments: "" };
      acc.toolCalls[idx] = slot;
    }
    if (incoming.id) slot.id = incoming.id;
    if (incoming.function?.name) slot.name += incoming.function.name;
    if (typeof incoming.function?.arguments === "string") {
      slot.arguments += incoming.function.arguments;
    }
  }
}

function finalizeToolCalls(acc: Accumulator): ToolCallPart[] {
  return acc.toolCalls
    .filter((slot): slot is Slot => slot !== undefined)
    .map((slot) => ({ id: slot.id, name: slot.name, arguments: slot.arguments }));
}

// --- AgentMessage <-> OpenAI wire ---

function toWireMessage(message: AgentMessage): OpenAIWireMessage {
  if (message.role === "assistant") {
    const out: OpenAIWireMessage = { role: "assistant", content: message.content };
    if (message.toolCalls && message.toolCalls.length > 0) {
      out.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return out;
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId ?? "" };
  }
  return { role: message.role, content: message.content };
}

function toWireTool(tool: AgentTool): OpenAIWireTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/**
 * Wrap an OpenAI-compatible raw stream into a provider-agnostic `ChatTransport`.
 * Translates `AgentMessage`/`AgentTool` into OpenAI wire format and reassembles
 * fragmented streaming tool-call deltas into finalized tool calls.
 */
export function createOpenAITransport(raw: OpenAIRawStream): ChatTransport {
  return {
    async *stream({ messages, tools, signal }) {
      const wireMessages = messages.map(toWireMessage);
      const wireTools = tools.length > 0 ? tools.map(toWireTool) : undefined;
      const request: OpenAIRawRequest = wireTools
        ? { messages: wireMessages, tools: wireTools, tool_choice: "auto" }
        : { messages: wireMessages };

      const acc = createAccumulator();
      for await (const chunk of raw(request, signal)) {
        accumulateChunk(acc, chunk);
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content !== "") {
          yield { type: "content", delta: content };
        }
      }

      const calls = finalizeToolCalls(acc);
      if (calls.length > 0) yield { type: "tool_calls", calls };
      if (acc.finishReason) yield { type: "finish", reason: acc.finishReason };
    },
  };
}
