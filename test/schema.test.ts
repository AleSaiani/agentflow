import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../dist/schema.js";

test("validateSchema: type, required, properties, items, enum, integer", () => {
  // valid object
  assert.equal(validateSchema({ ok: true, n: 3 }, { type: "object", required: ["ok", "n"], properties: { n: { type: "integer" } } }), null);
  // missing required
  assert.match(validateSchema({ ok: true }, { type: "object", required: ["n"] }) ?? "", /\$\.n: required/);
  // wrong type
  assert.match(validateSchema({ n: "x" }, { properties: { n: { type: "integer" } } }) ?? "", /\$\.n: expected type integer/);
  // integer vs float
  assert.match(validateSchema(3.5, { type: "integer" }) ?? "", /expected type integer/);
  assert.equal(validateSchema(3, { type: "integer" }), null);
  // enum
  assert.equal(validateSchema("low", { enum: ["low", "high"] }), null);
  assert.match(validateSchema("mid", { enum: ["low", "high"] }) ?? "", /not in enum/);
  // array items
  assert.equal(validateSchema([{ id: "a" }, { id: "b" }], { type: "array", items: { required: ["id"] } }), null);
  assert.match(validateSchema([{ id: "a" }, {}], { type: "array", items: { required: ["id"] } }) ?? "", /\$\[1\]\.id: required/);
  // unknown keywords ignored; top-level type mismatch
  assert.match(validateSchema("hi", { type: "object" }) ?? "", /expected object/);
});
