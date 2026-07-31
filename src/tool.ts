import type { TObject, Static } from "@sinclair/typebox";
import type { AgentTool, ToolExecutionContext } from "./types";

/**
 * Define a tool from a TypeBox schema.
 *
 * The parameter type `T` is inferred from `parameters`, so `execute`'s input
 * type and the JSON Schema sent to the model stay in sync at compile time:
 * the schema and the handler can no longer drift apart. The agent loop also
 * runs `Value.Default` (to fill schema `default` values) and then
 * `Value.Assert` over the model's JSON before invoking `execute`, so invalid
 * arguments are surfaced as a tool-result error string (fed back to the model)
 * instead of being silently coerced.
 *
 * `execute` receives a `ToolExecutionContext` carrying the run's abort signal,
 * so long-running or remote tools can be cancelled when the run stops.
 *
 * `defineTool` is the recommended constructor; `AgentTool` can still be used
 * directly when callers want to specify `T` explicitly.
 */
export function defineTool<T extends TObject>(opts: {
  name: string;
  description: string;
  /** TypeBox object schema; also serves as the JSON Schema sent to the model. */
  parameters: T;
  execute: (args: Static<T>, ctx: ToolExecutionContext) => Promise<unknown> | unknown;
}): AgentTool<T> {
  return opts;
}
