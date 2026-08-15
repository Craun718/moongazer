import { createEmitter } from "./emitter";
import type { ChatTransport } from "./transport";
import type {
  AgentEvent,
  AgentMessage,
  AgentRunHandle,
  AgentTool,
  ToolCallPart,
  ToolSource,
} from "./types";

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
  /**
   * Remote/refreshable tool sources merged into the registry per run. Local
   * tools shadow source tools on name collision.
   */
  toolSources?: ToolSource[];
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
 * Apply schema defaults, then strictly validate the model's arguments.
 *
 * Unlike `Value.Cast` (which silently coerces bad values into conforming but
 * semantically wrong data), this only fills missing `default` values and then
 * rejects anything that still fails the schema. A failure here is caught by the
 * tool-execution guard and surfaced to the model as a `<tool_error>` result
 * string rather than aborting the whole run.
 */
function prepareArgs(name: string, tool: AgentTool, args: Record<string, unknown>) {
  const value = Value.Default(tool.parameters, args);
  try {
    Value.Assert(tool.parameters, value);
  } catch (err) {
    throw new Error(`Invalid arguments for tool "${name}": ${(err as Error).message}`);
  }
  return value;
}

/**
 * Create an agent instance. Holds its own tool registry and abort controller,
 * so multiple agents can run concurrently (no module-level singletons).
 */
export function createAgent(options: AgentOptions): Agent {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const tools = new Map<string, AgentTool>();
  for (const tool of options.tools ?? []) tools.set(tool.name, tool);
  const sources = options.toolSources ?? [];

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

        // --- Merge local tools + remote tool sources for this run ---
        // Local tools are seeded first and never displaced; a source tool whose
        // name collides with a local tool is skipped (local wins) with a
        // warning. Sources are listed at run start and re-listed at the next
        // round boundary when they report invalidation (never mid-round).
        const runTools = new Map<string, AgentTool>(tools);
        const localNames = new Set(tools.keys());
        const sourceNames = new Map<ToolSource, Set<string>>();
        const stale = new Set<ToolSource>();
        const unsubs: Array<() => void> = [];

        const refreshSource = async (source: ToolSource): Promise<void> => {
          let remote: AgentTool[];
          try {
            remote = await source.list({ signal: controller.signal });
          } catch (err) {
            // Aborts propagate; transient list failures keep the stale tool set.
            if (controller.signal.aborted) throw err;
            console.warn("[moongazer] tool source list failed, keeping stale tools:", err);
            stale.delete(source);
            return;
          }
          // Swap this source's contributions: drop its old names (unless they
          // are local), then add the new ones. Local names always win.
          const old = sourceNames.get(source);
          if (old) for (const name of old) if (!localNames.has(name)) runTools.delete(name);
          const names = new Set<string>();
          for (const tool of remote) {
            if (localNames.has(tool.name)) {
              console.warn(`[moongazer] tool "${tool.name}" from source shadows local tool; skipping`);
              continue;
            }
            runTools.set(tool.name, tool);
            names.add(tool.name);
          }
          sourceNames.set(source, names);
          stale.delete(source);
        };

        try {
          for (const source of sources) {
            await refreshSource(source);
            if (source.onInvalidated) {
              const unsub = source.onInvalidated(() => {
                stale.add(source);
              });
              if (unsub) unsubs.push(unsub);
            }
          }

          let steps = 0;
          for (;;) {
            steps += 1;

            // Re-list any sources that reported invalidation since the last round.
            if (stale.size > 0) {
              const toRefresh = [...stale];
              stale.clear();
              for (const s of toRefresh) await refreshSource(s);
            }

            emitter.emit({ type: "assistant_start" });

            let roundContent = "";
            let roundCalls: ToolCallPart[] = [];

            for await (const event of options.transport.stream({
              messages: context,
              tools: [...runTools.values()],
              signal: controller.signal,
            })) {
              if (controller.signal.aborted) break;
              if (event.type === "content") {
                roundContent += event.delta;
                emitter.emit({ type: "content", delta: event.delta });
              } else if (event.type === "reasoning") {
                emitter.emit({ type: "reasoning", delta: event.delta });
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
              const tool = runTools.get(call.name);
              let result: string;
              try {
                const outcome = tool
                  ? await tool.execute(
                      prepareArgs(call.name, tool, parseArgs(call.arguments)),
                      { signal: controller.signal },
                    )
                  : `Unknown tool: ${call.name}`;
                result = typeof outcome === "string" ? outcome : JSON.stringify(outcome);
              } catch (err) {
                // Abort propagates (re-thrown) so the run stops cleanly. Any
                // other failure - a thrown handler, invalid args, or a failing
                // remote call - is isolated into a tool-result error string fed
                // back to the model so the run can continue instead of dying.
                if (controller.signal.aborted) throw err;
                result = `<tool_error name="${call.name}">${(err as Error).message}</tool_error>`;
              }
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
            // Surface the original stack so silent failures (e.g. transport
            // errors) aren't demoted to a UI string with no console trace.
            console.error("[moongazer] agent run error:", err);
            emitter.emit({ type: "error", error: err });
          } else {
            emitter.emit({ type: "abort" });
          }
        } finally {
          for (const unsub of unsubs) {
            try {
              unsub();
            } catch {
              /* ignore unsubscribe errors */
            }
          }
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
