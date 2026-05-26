import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const LOAD = resolve("workflows/remediate/load.mjs");
function tmp() {
  return mkdtempSync(join(tmpdir(), "rem-"));
}
function load(env: Record<string, string>): any {
  return JSON.parse(execFileSync("node", [LOAD], { encoding: "utf8", env: { ...process.env, ...env } }));
}

test("remediate load: findings → one fix item each, filtered by min_severity", () => {
  const dir = tmp();
  const f = join(dir, "f.json");
  writeFileSync(f, JSON.stringify([
    { file: "a.ts", rule_id: "x", severity: "major", note: "bug", suggestion: "do y" },
    { file: "b.ts", severity: "minor", note: "nit" },
    { file: "c.ts", rule_id: "z", severity: "critical", note: "boom" },
  ]));
  const items = load({ REMEDIATE_FINDINGS: f, REMEDIATE_MIN_SEVERITY: "major" });
  assert.equal(items.length, 2); // minor dropped
  const a = items.find((i: any) => i.data.file === "a.ts");
  assert.match(a.data.instruction, /bug/);
  assert.match(a.data.instruction, /do y/); // suggestion folded in
  assert.ok(items.some((i: any) => i.data.file === "c.ts" && i.data.severity === "critical"));
});

test("remediate load: markdown checklist → only the unchecked items", () => {
  const dir = tmp();
  const cl = join(dir, "cl.md");
  writeFileSync(cl, "- [ ] Fix the login redirect\n- [x] already done\n- [ ] Add parser tests\n");
  const items = load({ REMEDIATE_CHECKLIST: cl });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i: any) => i.data.instruction), ["Fix the login redirect", "Add parser tests"]);
});
