import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { inputSchemaToTypeBox } from "./convert";

/** Plain-JSON view of a TypeBox node (symbol [Kind] etc. are dropped). */
type JsonObj = { [key: string]: any };
function json(node: unknown): JsonObj {
  return JSON.parse(JSON.stringify(node)) as JsonObj;
}

describe("inputSchemaToTypeBox - shape", () => {
  it("converts a basic object with required and optional primitives", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
    });
    expect(json(t)).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, count: { type: "integer" } },
    });
  });

  it("omits `required` when every property is optional", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
    });
    expect(json(t)).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("preserves string constraints (format/pattern/minLength) verbatim", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { email: { type: "string", format: "email", pattern: "^x", minLength: 2 } },
      required: ["email"],
    });
    expect(json(t).properties.email).toEqual({
      type: "string",
      format: "email",
      pattern: "^x",
      minLength: 2,
    });
  });

  it("preserves number/integer bounds", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { n: { type: "integer", minimum: 0, maximum: 10 }, f: { type: "number" } },
      required: ["n", "f"],
    });
    expect(json(t).properties.n).toEqual({ type: "integer", minimum: 0, maximum: 10 });
    expect(json(t).properties.f).toEqual({ type: "number" });
  });

  it("converts enum -> union of literals", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
      required: ["color"],
    });
    expect(json(t).properties.color).toEqual({
      anyOf: [
        { const: "red", type: "string" },
        { const: "green", type: "string" },
        { const: "blue", type: "string" },
      ],
    });
  });

  it("converts const -> literal", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { mode: { const: "fast" } },
      required: ["mode"],
    });
    expect(json(t).properties.mode).toEqual({ const: "fast", type: "string" });
  });

  it("converts const null -> null type", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { x: { const: null } },
      required: ["x"],
    });
    expect(json(t).properties.x).toEqual({ type: "null" });
  });

  it("preserves object/array const verbatim (permissive)", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { point: { const: { x: 1, y: 2 } } },
      required: ["point"],
    });
    expect(json(t).properties.point).toEqual({ const: { x: 1, y: 2 } });
  });

  it("converts nested object + array", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        addr: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["tags", "addr"],
    });
    expect(json(t).properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
    });
    expect(json(t).properties.addr).toEqual({
      type: "object",
      required: ["city"],
      properties: { city: { type: "string" } },
    });
  });

  it("preserves additionalProperties:false", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(json(t).additionalProperties).toBe(false);
  });

  it("inlines a $ref against $defs", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      $defs: {
        Addr: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
      properties: { home: { $ref: "#/$defs/Addr" } },
      required: ["home"],
    });
    expect(json(t).properties.home).toEqual({
      type: "object",
      required: ["city"],
      properties: { city: { type: "string" } },
    });
  });

  it("inlines a $ref against definitions", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      definitions: { Id: { type: "integer" } },
      properties: { id: { $ref: "#/definitions/Id" } },
      required: ["id"],
    });
    expect(json(t).properties.id).toEqual({ type: "integer" });
  });

  it("preserves an unresolvable $ref verbatim (permissive)", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { ext: { $ref: "https://example.com/schema.json" } },
      required: ["ext"],
    });
    expect(json(t).properties.ext).toEqual({ $ref: "https://example.com/schema.json" });
  });

  it("terminates a cyclic $ref instead of infinite-looping", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      $defs: {
        Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
      required: ["root"],
    });
    const root = json(t).properties.root;
    // First level inlined; second-level `next` falls back to verbatim $ref.
    expect(root.properties.next).toEqual({ $ref: "#/$defs/Node" });
  });

  it("preserves `not` verbatim (permissive)", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { x: { not: { type: "string" } } },
      required: ["x"],
    });
    expect(json(t).properties.x).toEqual({ not: { type: "string" } });
  });

  it("preserves patternProperties verbatim (permissive)", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { x: { type: "object", patternProperties: { "^x": { type: "string" } } } },
      required: ["x"],
    });
    expect(json(t).properties.x.patternProperties).toEqual({ "^x": { type: "string" } });
  });

  it("preserves if/then/else verbatim (permissive)", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema `then` keyword
      properties: { x: { if: { type: "string" }, then: { const: "y" } } },
      required: ["x"],
    });
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema `then` keyword
    expect(json(t).properties.x).toEqual({ if: { type: "string" }, then: { const: "y" } });
  });

  it("converts allOf -> intersect", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: {
        x: { allOf: [{ type: "string" }, { minLength: 2 }] },
      },
      required: ["x"],
    });
    expect(json(t).properties.x).toEqual({
      allOf: [{ type: "string" }, { minLength: 2 }],
    });
  });

  it("converts anyOf/oneOf -> union", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["v"],
    });
    expect(json(t).properties.v).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("converts nullable type array -> union with null", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { name: { type: ["string", "null"], minLength: 1 } },
      required: ["name"],
    });
    expect(json(t).properties.name).toEqual({
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    });
  });
});

describe("inputSchemaToTypeBox - validation behavior", () => {
  it("asserts required vs optional and types", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
    });
    expect(() => Value.Assert(t, { name: "x", count: 5 })).not.toThrow();
    expect(() => Value.Assert(t, { name: "x" })).not.toThrow();
    expect(() => Value.Assert(t, {})).toThrow(); // missing required `name`
    expect(() => Value.Assert(t, { name: 1 })).toThrow(); // wrong type
  });

  it("enforces additionalProperties:false", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(() => Value.Assert(t, { a: "x" })).not.toThrow();
    expect(() => Value.Assert(t, { a: "x", extra: 1 })).toThrow();
  });

  it("enforces string constraints", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { s: { type: "string", minLength: 2 } },
      required: ["s"],
    });
    expect(() => Value.Assert(t, { s: "ab" })).not.toThrow();
    expect(() => Value.Assert(t, { s: "a" })).toThrow();
  });

  it("accepts any value for an unsupported (Unknown) subtree", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { x: { not: { type: "string" } }, y: { type: "string" } },
      required: ["y"],
    });
    expect(() => Value.Assert(t, { y: "hi", x: 999 })).not.toThrow();
    expect(() => Value.Assert(t, { y: "hi", x: "str" })).not.toThrow();
    expect(() => Value.Assert(t, { y: "hi" })).not.toThrow();
  });

  it("accepts any value for an unresolvable $ref subtree", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { ext: { $ref: "https://example.com/s.json" } },
      required: ["ext"],
    });
    expect(() => Value.Assert(t, { ext: { anything: 1 } })).not.toThrow();
    expect(() => Value.Assert(t, { ext: 42 })).not.toThrow();
  });

  it("applies schema defaults via Value.Default", () => {
    const t = inputSchemaToTypeBox({
      type: "object",
      properties: { n: { type: "integer", default: 7 } },
      required: [],
    });
    expect(Value.Default(t, {})).toEqual({ n: 7 });
  });
});

describe("inputSchemaToTypeBox - errors", () => {
  it("throws when inputSchema is a primitive", () => {
    expect(() => inputSchemaToTypeBox({ type: "string" })).toThrow(/object/);
  });

  it("throws when inputSchema is an array", () => {
    expect(() => inputSchemaToTypeBox([1, 2, 3])).toThrow(/object/);
  });

  it("throws when inputSchema is null", () => {
    expect(() => inputSchemaToTypeBox(null)).toThrow(/object/);
  });

  it("accepts an object schema without explicit type but with properties", () => {
    const t = inputSchemaToTypeBox({ properties: { a: { type: "string" } }, required: ["a"] });
    expect(() => Value.Assert(t, { a: "x" })).not.toThrow();
  });
});
