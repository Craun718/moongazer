import { createEmitter } from "./emitter";
import type { ChatTransport } from "./transport";
import type { AgentEvent, AgentMessage, AgentRunHandle, AgentTool, ToolCallPart } from "./types";

import { Value } from "@sinclair/typebox/value";

export interface Agent {
  registerTool(tool: AgentTool): void;
  run(options: RunOptions): AgentRunHandle;
}

export interface RunOptions {
  /** Conversation history; the agent does not mutate the caller's array. */
  messages: AgentMessage[];
  signal?: AbortSignal;
}

export interface AgentOptions {
  transport: ChatTransport;
  tools?: AgentTool[];
  /** Maximum tool round-trips before stopping to avoid runaway loops. */
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 6;

/** Parse JSON tool-call arguments, tolerating empty/invalid payloads. */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Create an agent instance. Holds its own tool registry and abort controller,
 * so multiple agents can run concurrently (no module-level singletons).
 */
export function createAgent(options: AgentOptions): Agent {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const tools = new Map<string, AgentTool>();
  for (const tool of options.tools ?? []) tools.set(tool.name, tool);

  return {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    run({ messages, signal }) {
      const emitter = createEmitter<AgentEvent>();
      const controller = new AbortController();
      const stop = (): void => {
        controller.abort();
      };

      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      // Working copy of the conversation used as transport context. Local to
      // this run, so the caller's array is never mutated.
      const context: AgentMessage[] = [...messages];

      const exec = async (): Promise<void> => {
        // Yield once so callers can subscribe before the first event fires.
        await Promise.resolve();
        try {
          let steps = 0;
          for (;;) {
            steps += 1;
            emitter.emit({ type: "assistant_start" });

            let roundContent = "";
            let roundCalls: ToolCallPart[] = [];

            for await (const event of options.transport.stream({
              messages: context,
              tools: [...tools.values()],
              signal: controller.signal,
            })) {
              if (controller.signal.aborted) break;
              if (event.type === "content") {
                roundContent += event.delta;
                emitter.emit({ type: "content", delta: event.delta });
              } else if (event.type === "tool_calls") {
                roundCalls = event.calls;
                emitter.emit({ type: "tool_calls", calls: event.calls });
              }
            }

            if (controller.signal.aborted) {
              emitter.emit({ type: "abort" });
              break;
            }

            context.push({
              role: "assistant",
              content: roundContent || null,
              toolCalls: roundCalls.length > 0 ? roundCalls : undefined,
            });

            if (roundCalls.length === 0) {
              emitter.emit({ type: "done" });
              break;
            }

            for (const call of roundCalls) {
              const tool = tools.get(call.name);
              const args = parseArgs(call.arguments);
              const outcome = tool
                ? await tool.execute(Value.Cast(tool.parameters, args))
                : `Unknown tool: ${call.name}`;
              const result = typeof outcome === "string" ? outcome : JSON.stringify(outcome);
              context.push({ role: "tool", toolCallId: call.id, content: result });
              emitter.emit({ type: "tool_result", id: call.id, result });
            }

            if (steps >= maxSteps) {
              emitter.emit({ type: "done" });
              break;
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            emitter.emit({ type: "error", error: err });
          } else {
            emitter.emit({ type: "abort" });
          }
        } finally {
          emitter.close();
        }
      };

      void exec();

      return {
        subscribe: (listener) => emitter.subscribe(listener),
        stop,
      };
    },
  };
}
