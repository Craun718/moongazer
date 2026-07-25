import type { TObject, Static } from "@sinclair/typebox";
import type { AgentTool } from "./types";

/**
 * Define a tool from a TypeBox schema.
 *
 * The parameter type `T` is inferred from `parameters`, so `execute`'s input
 * type and the JSON Schema sent to the model stay in sync at compile time:
 * the schema and the handler can no longer drift apart. The agent loop also
 * runs `Value.Cast` over the model's JSON before invoking `execute`, so
 * defaults and basic type coercion are applied at runtime.
 *
 * `defineTool` is the recommended constructor; `AgentTool` can still be used
 * directly when callers want to specify `T` explicitly.
 */
export function defineTool<T extends TObject>(opts: {
  name: string;
  description: string;
  /** TypeBox object schema; also serves as the JSON Schema sent to the model. */
  parameters: T;
  execute: (args: Static<T>) => Promise<unknown> | unknown;
}): AgentTool<T> {
  return opts;
}
