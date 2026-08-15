import { Type } from "@sinclair/typebox";
import type {
  ArrayOptions,
  IntegerOptions,
  NumberOptions,
  ObjectOptions,
  SchemaOptions,
  StringOptions,
  TObject,
  TSchema,
} from "@sinclair/typebox";

/**
 * MCP tools expose their arguments as a JSON Schema `inputSchema`. moongazer's
 * tool layer is built on TypeBox schemas (`AgentTool<T extends TObject>`), and
 * TypeBox's `Value.Default`/`Value.Assert` operate on genuine TypeBox types at
 * runtime. Rather than casting the raw JSON Schema (which would leave the
 * compile-time `T` and the runtime checks out of sync), this module rebuilds a
 * TypeBox `TObject` from an MCP `inputSchema`, preserving constraints
 * faithfully and degrading to `Type.Unsafe` for constructs TypeBox cannot
 * express directly (`$ref` that can't be resolved, `not`,
 * `patternProperties`, `if/then/else`, tuples, ...). Unsupported subtrees are
 * rebuilt as `Type.Unknown` carrying the original JSON Schema verbatim: the
 * `[Kind]: 'Unknown'` symbol makes `Value.Assert` accept any value (Unknown is
 * TypeBox's permissive escape hatch), while the verbatim fields survive JSON
 * serialization so the model still sees the real constraints. The tradeoff is
 * no local validation for that subtree only. (`Type.Unsafe` would also round-trip
 * verbatim but makes `Value.Assert` throw "Unknown type" on any value, so it is
 * unsuitable here.)
 */

/** A raw JSON Schema object as understood here. */
export type JsonSchema = Record<string, unknown>;
/** Named definition buckets (`$defs` / `definitions`) keyed by their token. */
type Defs = Record<string, JsonSchema>;

/** Narrow an unknown value to a JSON Schema object, or throw. */
function asJsonObject(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP tool inputSchema must be a JSON object");
  }
  return value as JsonSchema;
}

/** A value is a plain JSON object (not an array). */
function isJsonObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect `$defs` and `definitions` into a flat token -> schema map. */
function collectDefs(schema: JsonSchema): Defs {
  const defs: Defs = {};
  for (const key of ["$defs", "definitions"] as const) {
    const bucket = schema[key];
    if (isJsonObject(bucket)) {
      for (const [token, node] of Object.entries(bucket)) {
        if (isJsonObject(node)) defs[token] = node;
      }
    }
  }
  return defs;
}

/** Copy only the listed keys (when present) and cast to the target option type. */
function pick<T>(schema: JsonSchema, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in schema) out[key] = schema[key];
  return out as T;
}

/** Annotation-only options (no structural constraints) for composite nodes. */
const ANNOTATION_KEYS = ["description", "default", "title", "$id", "examples"] as const;
function annotations(schema: JsonSchema): SchemaOptions {
  return pick<SchemaOptions>(schema, ANNOTATION_KEYS);
}

/** Structural constraint keys kept for arrays (raw `items` is rebuilt, not kept). */
const ARRAY_OPT_KEYS = [
  "minItems",
  "maxItems",
  "uniqueItems",
  "description",
  "default",
  "title",
] as const;
/** Structural constraint keys kept for objects (raw `properties` is rebuilt). */
const OBJECT_OPT_KEYS = [
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "description",
  "default",
  "title",
] as const;

/** A literal for a JSON `const`/`enum` value, choosing the right TypeBox node. */
function literalFor(value: unknown): TSchema {
  if (value === null) return Type.Null();
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return Type.Literal(value);
  }
  // Object/array consts have no direct TypeBox literal; preserve verbatim.
  return Type.Unknown({ const: value } as SchemaOptions);
}

/**
 * Resolve a `$ref` against the collected defs. Only `#/$defs/<token>` and
 * `#/definitions/<token>` forms are inlined; anything else (external URIs,
 * internal pointer paths) is left to the caller as an unsafe verbatim node.
 * `stack` guards against self-referential cycles.
 */
function resolveRef(ref: string, defs: Defs, stack: Set<string>): TSchema | undefined {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  const token = match[1] ?? "";
  if (token === "" || stack.has(token)) return undefined;
  const target = defs[token];
  if (!target) return undefined;
  return convertNode(target, defs, new Set(stack).add(token));
}

/**
 * Convert a single JSON Schema node to a TypeBox schema. `stack` tracks the
 * chain of def tokens currently being inlined so cyclic `$ref`s terminate.
 */
function convertNode(schema: JsonSchema, defs: Defs, stack: Set<string>): TSchema {
  // `$ref` takes precedence: a ref node carries no other usable structure.
  if (typeof schema.$ref === "string") {
    return resolveRef(schema.$ref, defs, stack) ?? Type.Unknown(schema as SchemaOptions);
  }

  // `const` -> a single literal.
  if ("const" in schema) {
    return literalFor(schema.const);
  }

  // `enum` -> union of literals.
  if (Array.isArray(schema.enum)) {
    const members = schema.enum.map(literalFor);
    return members.length === 0
      ? Type.Unknown(annotations(schema))
      : members.length === 1
        ? members[0]!
        : Type.Union(members, annotations(schema));
  }

  // Composite combinators.
  if (Array.isArray(schema.allOf)) {
    const members = schema.allOf.filter(isJsonObject).map((s) => convertNode(s, defs, stack));
    return members.length === 0
      ? Type.Unknown(annotations(schema))
      : members.length === 1
        ? members[0]!
        : Type.Intersect(members, annotations(schema));
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const list = (schema.anyOf ?? schema.oneOf) as unknown;
    const members = (Array.isArray(list) ? list : [])
      .filter(isJsonObject)
      .map((s) => convertNode(s, defs, stack));
    return members.length === 0
      ? Type.Unknown(annotations(schema))
      : members.length === 1
        ? members[0]!
        : Type.Union(members, annotations(schema));
  }

  // Constructs TypeBox can't express directly -> preserve verbatim.
  if ("not" in schema || "patternProperties" in schema || "if" in schema) {
    return Type.Unknown(schema as SchemaOptions);
  }

  const type = schema.type;

  // `type: ["string", "null"]` etc. -> union of the listed types. Each member
  // gets a single `type` so constraints (minLength, ...) land on the right leaf.
  if (Array.isArray(type)) {
    const members = type.map((t) => leafForType(String(t), { ...schema, type: String(t) }));
    return members.length === 0
      ? Type.Unknown(annotations(schema))
      : members.length === 1
        ? members[0]!
        : Type.Union(members, annotations(schema));
  }

  if (typeof type === "string") {
    if (type === "array") return convertArray(schema, defs, stack);
    return leafForType(type, schema);
  }

  // No `type` and no combinator (e.g. `{}`, or a constraint-only refinement
  // like `{minLength:2}` used inside allOf). Preserve the schema verbatim so it
  // round-trips to the model; validation is permissive for such subtrees.
  return Type.Unknown(schema as SchemaOptions);
}

/** Build a leaf TypeBox node for a primitive `type`, carrying the schema's
 *  constraints verbatim (format/pattern/minLength/... all round-trip). */
function leafForType(type: string, schema: JsonSchema): TSchema {
  switch (type) {
    case "string":
      return Type.String(schema as StringOptions);
    case "number":
      return Type.Number(schema as NumberOptions);
    case "integer":
      return Type.Integer(schema as IntegerOptions);
    case "boolean":
      return Type.Boolean(annotations(schema));
    case "null":
      return Type.Null(annotations(schema));
    default:
      // Unknown/extended type (e.g. "array" of tuples handled elsewhere, custom
      // types) -> preserve verbatim so the model still sees the constraints.
      return Type.Unknown(schema as SchemaOptions);
  }
}

/** Convert an array schema. The single-schema `items` form recurses; the tuple
 *  form (`items: [...]`) and unsupported shapes are preserved verbatim. */
function convertArray(schema: JsonSchema, defs: Defs, stack: Set<string>): TSchema {
  const items = schema.items;
  if (Array.isArray(items)) {
    // Tuple form: positional semantics don't map cleanly onto Type.Array;
    // keep the schema verbatim so it round-trips to the model.
    return Type.Unknown(schema as SchemaOptions);
  }
  const itemNode = isJsonObject(items) ? convertNode(items, defs, stack) : Type.Unknown(); // missing/true `items` -> any element allowed
  return Type.Array(itemNode, pick<ArrayOptions>(schema, ARRAY_OPT_KEYS));
}

/** Convert an object schema (the only shape allowed at the top level). */
function convertObject(schema: JsonSchema, defs: Defs, stack: Set<string>): TObject {
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const requiredList = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const required = new Set(requiredList);

  const tProperties: Record<string, TSchema> = {};
  for (const [key, sub] of Object.entries(properties)) {
    const node = isJsonObject(sub)
      ? convertNode(sub, defs, stack)
      : Type.Unknown({} as SchemaOptions);
    tProperties[key] = required.has(key) ? node : Type.Optional(node);
  }
  return Type.Object(tProperties, pick<ObjectOptions>(schema, OBJECT_OPT_KEYS));
}

/**
 * Convert an MCP tool `inputSchema` into a TypeBox `TObject`.
 *
 * @throws if `inputSchema` is not an object schema describing an object
 *   (`type: "object"` or carrying `properties`).
 */
export function inputSchemaToTypeBox(inputSchema: unknown): TObject {
  const schema = asJsonObject(inputSchema);
  if (schema.type !== "object" && !isJsonObject(schema.properties)) {
    throw new Error(
      `MCP tool inputSchema must describe an object (got type=${JSON.stringify(schema.type)})`,
    );
  }
  const defs = collectDefs(schema);
  return convertObject(schema, defs, new Set());
}
