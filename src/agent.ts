import { createEmitter } from "./emitter";
import type { ChatTransport } from "./transport";
import type {
  AgentEvent,
  AgentHooks,
  AgentMessage,
  AgentRunHandle,
  AgentTool,
  RunHooks,
  StopResult,
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
  /** Hooks scoped to this run. They run after agent-level hooks. */
  hooks?: RunHooks;
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
  /** Hooks shared by every run created from this agent. */
  hooks?: AgentHooks;
}

export const DEFAULT_MAX_STEPS = 6;

class HookStopError extends Error {
  constructor(readonly reason?: string) {
    super(reason ? `Agent run stopped by hook: ${reason}` : "Agent run stopped by hook");
  }
}

function isStopResult(value: unknown): value is StopResult {
  return typeof value === "object" && value !== null && (value as { stop?: unknown }).stop === true;
}

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

function serializeResult(outcome: unknown): string {
  return typeof outcome === "string" ? outcome : JSON.stringify(outcome);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

function toolError(name: string, err: unknown): string {
  return `<tool_error name="${name}">${errorMessage(err)}</tool_error>`;
}

function assertUniqueTools(tools: readonly AgentTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name after hooks: "${tool.name}"`);
    }
    seen.add(tool.name);
  }
}

function createRunId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create an agent instance. Holds its own tool registry, and each run owns its
 * abort controller, so multiple agents and runs can execute concurrently.
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
    run({ messages, signal, hooks: runHooksInput }) {
      const runId = createRunId();
      const emitter = createEmitter<AgentEvent>();
      const controller = new AbortController();
      const runHooks = runHooksInput ?? {};
      const hookSets = [options.hooks ?? {}, runHooks];
      const stop = (): void => {
        controller.abort();
      };

      let onExternalAbort: (() => void) | undefined;
      if (signal) {
        onExternalAbort = () => controller.abort();
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onExternalAbort, { once: true });
      }

      // Working copy of the conversation used as transport context. Local to
      // this run, so the caller's array is never mutated.
      const context: AgentMessage[] = [...messages];
      const throwIfAborted = (): void => {
        if (controller.signal.aborted) throw new Error("Agent run aborted");
      };

      const getHooks = <K extends keyof AgentHooks>(point: K) =>
        hookSets.flatMap((set) => {
          const hook = set[point];
          return hook ? [hook] : [];
        });

      const exec = async (): Promise<void> => {
        // Yield once so callers can subscribe before the first event fires.
        await Promise.resolve();

        const runTools = new Map<string, AgentTool>(tools);
        const localNames = new Set(tools.keys());
        const sourceNames = new Map<ToolSource, Set<string>>();
        const stale = new Set<ToolSource>();
        const unsubs: Array<() => void> = [];
        let steps = 0;
        let terminalEvent: AgentEvent | undefined;
        let endStatus: "done" | "error" | "abort" | "stopped" = "done";
        let endError: unknown;
        let stopRequested = false;
        let hookStopError: HookStopError | undefined;

        const stopFromHook: (reason?: string) => never = (reason) => {
          stopRequested = true;
          hookStopError = new HookStopError(reason);
          controller.abort();
          throw hookStopError;
        };

        const markEnd = (
          status: "done" | "error" | "abort" | "stopped",
          error?: unknown,
          reason?: string,
        ): void => {
          if (terminalEvent) return;
          endStatus = status;
          endError = error;
          terminalEvent =
            status === "error"
              ? { type: "error", error }
              : status === "abort"
                ? { type: "abort" }
                : status === "stopped"
                  ? { type: "stopped", reason }
                  : { type: "done" };
        };

        const beforeToolsResolved = async (
          reason: "initial" | "invalidated",
          source?: ToolSource,
        ): Promise<void> => {
          throwIfAborted();
          for (const hook of getHooks("beforeToolsResolved")) {
            await hook({ runId, signal: controller.signal, reason, source });
            throwIfAborted();
          }
        };

        const afterToolsResolved = async (
          reason: "initial" | "invalidated",
          source?: ToolSource,
        ): Promise<void> => {
          throwIfAborted();
          let resolved = [...runTools.values()];
          for (const hook of getHooks("afterToolsResolved")) {
            const result = await hook({
              runId,
              signal: controller.signal,
              reason,
              source,
              tools: [...resolved],
            });
            throwIfAborted();
            if (isStopResult(result)) stopFromHook(result.reason);
            if (result?.tools !== undefined) {
              assertUniqueTools(result.tools);
              resolved = result.tools;
            }
          }
          runTools.clear();
          for (const tool of resolved) runTools.set(tool.name, tool);
        };

        const refreshSource = async (
          source: ToolSource,
          reason: "initial" | "invalidated",
        ): Promise<void> => {
          await beforeToolsResolved(reason, source);

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
          if (old) {
            for (const name of old) {
              if (!localNames.has(name)) runTools.delete(name);
            }
          }
          const names = new Set<string>();
          for (const tool of remote) {
            if (localNames.has(tool.name)) {
              console.warn(
                `[moongazer] tool "${tool.name}" from source shadows local tool; skipping`,
              );
              continue;
            }
            runTools.set(tool.name, tool);
            names.add(tool.name);
          }
          sourceNames.set(source, names);
          stale.delete(source);

          await afterToolsResolved(reason, source);
        };

        const executeCall = async (
          call: ToolCallPart,
          executionTools: Map<string, AgentTool>,
        ): Promise<{ result: string; durationMs: number }> => {
          const startedAt = Date.now();
          const tool = executionTools.get(call.name);
          let args = parseArgs(call.arguments);
          let error: unknown;
          let shortCircuited = false;
          let result: string | undefined;
          let toolHooksEntered = false;

          const beforeHooks = getHooks("beforeToolExecute");
          const afterHooks = [...getHooks("afterToolExecute")].reverse();
          const toolBeforeHook = tool?.hooks?.beforeExecute;
          const toolAfterHook = tool?.hooks?.afterExecute;

          try {
            throwIfAborted();
            if (tool) args = prepareArgs(call.name, tool, args);

            for (const hook of beforeHooks) {
              if (stopRequested) throw hookStopError;
              const outcome = await hook({
                runId,
                signal: controller.signal,
                step: steps,
                call,
                tool,
                args: { ...args },
              });
              if (stopRequested) throw hookStopError;
              throwIfAborted();
              if (isStopResult(outcome)) stopFromHook(outcome.reason);
              if (outcome && "result" in outcome && outcome.result !== undefined) {
                result = outcome.result;
                shortCircuited = true;
                break;
              }
              if (outcome && "args" in outcome && outcome.args !== undefined) {
                args = outcome.args;
                if (tool) args = prepareArgs(call.name, tool, args);
              }
            }

            if (result === undefined && tool) {
              toolHooksEntered = true;
            }

            if (result === undefined && toolBeforeHook) {
              const outcome = await toolBeforeHook({
                call,
                signal: controller.signal,
                args: { ...args },
              });
              throwIfAborted();
              if (outcome && "result" in outcome && outcome.result !== undefined) {
                result = outcome.result;
                shortCircuited = true;
              } else if (outcome && "args" in outcome && outcome.args !== undefined) {
                args = outcome.args;
                if (tool) args = prepareArgs(call.name, tool, args);
              }
            }

            if (result === undefined) {
              const outcome = tool
                ? await tool.execute(args, { signal: controller.signal })
                : `Unknown tool: ${call.name}`;
              result = serializeResult(outcome);
            }
          } catch (err) {
            if (stopRequested && hookStopError) throw hookStopError;
            if (err instanceof HookStopError || controller.signal.aborted) throw err;
            error = err;
            result = toolError(call.name, err);
          }

          if (toolHooksEntered && toolAfterHook) {
            try {
              const outcome = await toolAfterHook({
                call,
                signal: controller.signal,
                args: { ...args },
                result: result as string,
                ...(error === undefined ? {} : { error }),
                durationMs: Date.now() - startedAt,
                shortCircuited,
              });
              throwIfAborted();
              if (outcome?.result !== undefined) result = outcome.result;
            } catch (err) {
              if (stopRequested && hookStopError) throw hookStopError;
              if (err instanceof HookStopError || controller.signal.aborted) throw err;
              error = err;
              result = toolError(call.name, err);
            }
          }

          try {
            for (const hook of afterHooks) {
              if (stopRequested) throw hookStopError;
              const outcome = await hook({
                runId,
                signal: controller.signal,
                step: steps,
                call,
                tool,
                args: { ...args },
                result: result as string,
                error,
                durationMs: Date.now() - startedAt,
                shortCircuited,
              });
              if (stopRequested) throw hookStopError;
              throwIfAborted();
              if (isStopResult(outcome)) stopFromHook(outcome.reason);
              if (outcome?.result !== undefined) result = outcome.result;
            }
          } catch (err) {
            if (stopRequested && hookStopError) throw hookStopError;
            if (err instanceof HookStopError || controller.signal.aborted) throw err;
            error = err;
            result = toolError(call.name, err);
          }

          return { result: result as string, durationMs: Date.now() - startedAt };
        };

        try {
          throwIfAborted();
          const inputMessages = [...context];
          for (const hook of getHooks("onRunStart")) {
            await hook({
              runId,
              signal: controller.signal,
              messages: [...inputMessages],
            });
            throwIfAborted();
          }

          if (sources.length === 0) await afterToolsResolved("initial");
          for (const source of sources) {
            await refreshSource(source, "initial");
            if (source.onInvalidated) {
              const unsub = source.onInvalidated(() => {
                stale.add(source);
              });
              if (unsub) unsubs.push(unsub);
            }
          }

          for (;;) {
            steps += 1;

            // Re-list any sources that reported invalidation since the last round.
            if (stale.size > 0) {
              const toRefresh = [...stale];
              stale.clear();
              for (const source of toRefresh) await refreshSource(source, "invalidated");
            }

            let requestMessages = [...context];
            let requestTools = [...runTools.values()];
            for (const hook of getHooks("beforeModelRequest")) {
              const outcome = await hook({
                runId,
                signal: controller.signal,
                step: steps,
                maxSteps,
                messages: [...requestMessages],
                tools: [...requestTools],
              });
              throwIfAborted();
              if (isStopResult(outcome)) stopFromHook(outcome.reason);
              if (outcome?.messages !== undefined) requestMessages = [...outcome.messages];
              if (outcome?.tools !== undefined) {
                assertUniqueTools(outcome.tools);
                requestTools = [...outcome.tools];
              }
            }
            assertUniqueTools(requestTools);
            const executionTools = new Map(requestTools.map((tool) => [tool.name, tool]));

            emitter.emit({ type: "assistant_start" });

            let roundContent = "";
            let roundCalls: ToolCallPart[] = [];
            let finishReason: string | undefined;

            for await (const event of options.transport.stream({
              messages: [...requestMessages],
              tools: [...requestTools],
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
              } else if (event.type === "finish") {
                finishReason = event.reason;
              }
            }
            throwIfAborted();

            let assistantMessage: AgentMessage = {
              role: "assistant",
              content: roundContent || null,
              toolCalls: roundCalls.length > 0 ? roundCalls : undefined,
            };
            let finalCalls = [...roundCalls];
            for (const hook of getHooks("afterModelResponse")) {
              const outcome = await hook({
                runId,
                signal: controller.signal,
                step: steps,
                message: {
                  ...assistantMessage,
                  toolCalls: finalCalls.length > 0 ? finalCalls : undefined,
                },
                toolCalls: [...finalCalls],
                finishReason,
              });
              throwIfAborted();
              if (isStopResult(outcome)) stopFromHook(outcome.reason);
              if (outcome?.message !== undefined) {
                assistantMessage = { ...outcome.message };
                finalCalls = outcome.message.toolCalls ? [...outcome.message.toolCalls] : [];
              }
              if (outcome?.toolCalls !== undefined) {
                finalCalls = [...outcome.toolCalls];
                assistantMessage = {
                  ...assistantMessage,
                  toolCalls: finalCalls.length > 0 ? finalCalls : undefined,
                };
              }
            }

            const finalMessage: AgentMessage = {
              ...assistantMessage,
              toolCalls: finalCalls.length > 0 ? finalCalls : undefined,
            };
            roundCalls = finalCalls;
            context.push(finalMessage);

            if (roundCalls.length === 0) {
              markEnd("done");
              break;
            }

            emitter.emit({ type: "tool_calls", calls: roundCalls });

            const results: string[] = [];
            const outcomes = await Promise.all(
              roundCalls.map((call) => executeCall(call, executionTools)),
            );
            for (let index = 0; index < roundCalls.length; index += 1) {
              const call = roundCalls[index]!;
              const outcome = outcomes[index]!;
              results.push(outcome.result);
              context.push({ role: "tool", toolCallId: call.id, content: outcome.result });
              emitter.emit({
                type: "tool_result",
                id: call.id,
                result: outcome.result,
                name: call.name,
                durationMs: outcome.durationMs,
              });
            }

            if (steps >= maxSteps) {
              markEnd("done");
              break;
            }

            for (const hook of getHooks("shouldContinue")) {
              const decision = await hook({
                runId,
                signal: controller.signal,
                step: steps,
                maxSteps,
                messages: [...context],
                lastToolResults: [...results],
              });
              throwIfAborted();
              if (decision?.continue === false) {
                markEnd("done");
                break;
              }
            }
            if (terminalEvent) break;
          }
        } catch (err) {
          if (hookStopError) {
            markEnd("stopped", undefined, hookStopError.reason);
          } else if (controller.signal.aborted) {
            markEnd("abort");
          } else {
            console.error("[moongazer] agent run error:", err);
            markEnd("error", err);
          }
        } finally {
          if (terminalEvent) emitter.emit(terminalEvent);
          for (const hook of getHooks("onRunEnd")) {
            try {
              await hook({
                runId,
                signal: controller.signal,
                status: endStatus,
                steps,
                messages: [...context],
                ...(endError === undefined ? {} : { error: endError }),
              });
            } catch (err) {
              console.error("[moongazer] onRunEnd hook failed:", err);
            }
          }
          for (const unsub of unsubs) {
            try {
              unsub();
            } catch {
              /* ignore unsubscribe errors */
            }
          }
          if (onExternalAbort && signal && !signal.aborted) {
            signal.removeEventListener("abort", onExternalAbort);
          }
          emitter.close();
        }
      };

      void exec().catch((err) => {
        // exec is fully guarded; this only protects against future refactors.
        console.error("[moongazer] unexpected agent execution failure:", err);
        emitter.emit({ type: "error", error: err });
        emitter.close();
      });

      return {
        runId,
        subscribe: (listener) => emitter.subscribe(listener),
        stop,
      };
    },
  };
}
