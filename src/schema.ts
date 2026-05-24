/**
 * Restricted, zero-dep JSON-schema validator — enough to harden the determinism boundary: a stage
 * declares the shape of its structured output, and the engine checks it before any downstream code
 * branches on that data. Supports a practical subset: `type` (string|number|integer|boolean|object|
 * array|null, or an array of them), `enum`, `required`, `properties`, `items`. Unknown keywords are
 * ignored. Returns the first error message, or null when valid.
 */

type Schema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object | undefined
}

export function validateSchema(data: unknown, schema: unknown, path = "$"): string | null {
  if (schema === null || typeof schema !== "object") return null;
  const s = schema as Schema;

  if (s["type"] !== undefined) {
    const types = Array.isArray(s["type"]) ? (s["type"] as string[]) : [s["type"] as string];
    const actual = typeOf(data);
    const ok = types.some(
      (t) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(data)),
    );
    if (!ok) return `${path}: expected type ${types.join("|")}, got ${actual}`;
  }

  if (Array.isArray(s["enum"])) {
    const allowed = s["enum"] as unknown[];
    if (!allowed.some((e) => JSON.stringify(e) === JSON.stringify(data)))
      return `${path}: value ${JSON.stringify(data)} not in enum ${JSON.stringify(allowed)}`;
  }

  // object constraints
  if (s["required"] || s["properties"]) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      if (s["type"] === "object") return `${path}: expected object, got ${typeOf(data)}`;
    } else {
      const obj = data as Record<string, unknown>;
      for (const req of (s["required"] as string[]) ?? []) if (!(req in obj)) return `${path}.${req}: required property missing`;
      for (const [k, sub] of Object.entries((s["properties"] as Record<string, unknown>) ?? {})) {
        if (k in obj) {
          const err = validateSchema(obj[k], sub, `${path}.${k}`);
          if (err) return err;
        }
      }
    }
  }

  // array items
  if (s["items"] && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const err = validateSchema(data[i], s["items"], `${path}[${i}]`);
      if (err) return err;
    }
  }

  return null;
}
