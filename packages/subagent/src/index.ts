import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  MaybePromise,
  ToolExecutionContext,
  ToolHooks,
} from "@pulonia/moongazer";
import type { TObject, Static } from "@sinclair/typebox";

export interface CreateSubagentToolOptions<T extends TObject = TObject> {
  /** Tool name exposed to the parent agent's model. */
  name: string;
  /** Tool description exposed to the parent agent's model. */
  description: string;
  /** TypeBox schema for arguments accepted from the parent agent. */
  parameters: T;
  /** Build the child agent's isolated conversation from parent-tool input. */
  buildMessages(args: Static<T>, ctx: ToolExecutionContext): MaybePromise<AgentMessage[]>;
  /** Observe the child agent's events without extending its run. */
  onEvent?: (event: AgentEvent) => MaybePromise<void>;
  /** Hooks owned by the generated tool. */
  hooks?: ToolHooks<T>;
}

function runSubagent(
  agent: Agent,
  messages: AgentMessage[],
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => MaybePromise<void>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stoppedReason: string | undefined;

    const settle = (outcome: string): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error("Subagent run failed"));
    };

    const handle = agent.run({
      messages,
      signal,
      hooks: {
        onRunEnd: ({ status, messages: finalMessages, error }) => {
          if (status === "error") {
            fail(error);
            return;
          }
          if (status === "abort") {
            settle("<subagent_error>Subagent run aborted</subagent_error>");
            return;
          }
          if (status === "stopped") {
            const reason = stoppedReason ? `: ${stoppedReason}` : "";
            settle(`<subagent_error>Subagent run stopped${reason}</subagent_error>`);
            return;
          }

          const finalMessage = finalMessages.at(-1);
          if (finalMessage?.role === "assistant" && !finalMessage.toolCalls?.length) {
            settle(finalMessage.content ?? "");
            return;
          }
          settle(
            "<subagent_error>Subagent ended without a final assistant response</subagent_error>",
          );
        },
      },
    });

    handle.subscribe((event) => {
      if (onEvent) {
        void Promise.resolve()
          .then(() => onEvent(event))
          .catch((err) => {
            console.warn("[moongazer/subagent] onEvent observer failed:", err);
          });
      }

      if (event.type === "stopped") {
        stoppedReason = event.reason;
      } else if (event.type === "error") {
        fail(event.error);
      }
    });
  });
}

/**
 * Expose an agent as a tool in a parent agent.
 *
 * The child keeps an isolated conversation and tool set. Only the parent tool's
 * abort signal is shared, so stopping the parent also stops an in-flight child
 * run. The tool result is the child's final assistant content, not its full
 * transcript; observer errors are isolated from the child run.
 */
export function createSubagentTool<T extends TObject>(
  agent: Agent,
  options: CreateSubagentToolOptions<T>,
): AgentTool<T> {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    hooks: options.hooks,
    async execute(args, ctx) {
      const messages = await options.buildMessages(args, ctx);
      return runSubagent(agent, [...messages], ctx.signal, options.onEvent);
    },
  };
}
