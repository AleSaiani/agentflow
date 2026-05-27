import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const LOAD = resolve("workflows/remediate/load.mjs");
const DISPOSITION = resolve("workflows/remediate/disposition.mjs");
const RECONCILE = resolve("workflows/remediate/reconcile.mjs");
function tmp() {
  return mkdtempSync(join(tmpdir(), "rem-"));
}
function node(script: string, env: Record<string, string>): any {
  return JSON.parse(execFileSync("node", [script], { encoding: "utf8", env: { ...process.env, ...env } }).trim());
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

test("remediate load: types filter keeps code, drops test/sample/doc findings", () => {
  const dir = tmp();
  const f = join(dir, "f.json");
  writeFileSync(f, JSON.stringify([
    { file: "src/Foo.cs", severity: "major", note: "code" },
    { file: "tests/FooTests.cs", severity: "major", note: "test" },
    { file: "samples/Demo.cs", severity: "major", note: "sample" },
    { file: "docs/readme.md", severity: "major", note: "doc" },
  ]));
  const items = load({ REMEDIATE_FINDINGS: f, REMEDIATE_TYPES: "code" });
  assert.deepEqual(items.map((i: any) => i.data.file), ["src/Foo.cs"]);
  assert.equal(items[0].data.type, "code");
});

test("remediate disposition: every item gets a disposition; missing → failed; bare detected", () => {
  const dir = tmp();
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([
    { id: "x", data: { file: "a.ts", type: "code", severity: "major" } },
    { id: "y", data: { file: "b.ts", type: "code" } },
    { id: "z", data: { file: "c.ts", type: "code" } },
  ]));
  const feDir = join(dir, "fe");
  mkdirSync(join(feDir, "rev"), { recursive: true });
  writeFileSync(join(feDir, "rev", "state.json"), JSON.stringify({ items: {
    x: { id: "x", status: "done", result: { disposition: "fixed", reason: "done", file: "a.ts" } },
    y: { id: "y", status: "done", result: {} }, // no disposition → bare
    // z absent → not processed
  } }));
  const out = join(dir, "out");
  const summary = node(DISPOSITION, { REMEDIATE_ITEMS: items, REMEDIATE_FIX_RUN: "rev", REMEDIATE_FOREACH_DIR: feDir, REMEDIATE_OUT_DIR: out });
  assert.equal(summary.total, 3);
  assert.equal(summary.counts.fixed, 1);
  assert.equal(summary.counts.failed, 1); // z not processed
  assert.equal(summary.bare, 1); // y returned no disposition
  const dj = JSON.parse(readFileSync(join(out, "dispositions.json"), "utf8"));
  assert.equal(dj.dispositions.find((d: any) => d.id === "z").disposition, "failed");
});

test("remediate reconcile: flags a fixed item whose file was not actually changed (git truth)", () => {
  const dir = tmp();
  const r = join(dir, "repo");
  mkdirSync(join(r, "src"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "a@b.c");
  g("config", "user.name", "t");
  writeFileSync(join(r, "src", "a.ts"), "a\n");
  writeFileSync(join(r, "src", "c.ts"), "c\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(join(r, "src", "a.ts"), "a fixed\n"); // only a.ts actually changes

  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "dispositions.json"), JSON.stringify({ dispositions: [
    { id: "x", file: "src/a.ts", disposition: "fixed" },
    { id: "z", file: "src/c.ts", disposition: "fixed" }, // claimed but c.ts not touched
  ] }));
  const rep = node(RECONCILE, { RECONCILE_DISPOSITIONS: join(out, "dispositions.json"), RECONCILE_REPO: r, RECONCILE_BASE: "HEAD", RECONCILE_OUT_DIR: out });
  assert.equal(rep.reconciled, false);
  assert.deepEqual(rep.fixed_without_change, ["z"]);
  assert.equal(rep.changed_files, 1);
});
