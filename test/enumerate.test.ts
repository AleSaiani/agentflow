import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = resolve("dist/state/enumerate.js");

function run(stateDir: string, args: string[]): any {
  const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ENUMERATE_STATE_DIR: stateDir } });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

test("enumerate (unfold): init → start → complete records the generated items.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-gen-"));
  run(dir, ["init", "g1", "--prompt", "Break the outline into chapters", "--execution", "main-thread"]);
  run(dir, ["start", "g1"]);

  // simulate the generator (agent or main-thread) writing the list
  const items = join(dir, "chapters.json");
  writeFileSync(items, JSON.stringify([
    { id: "ch-1", data: { title: "Introduction" } },
    { id: "ch-2", data: { title: "Core ideas" } },
    { id: "ch-3", data: { title: "Conclusion" } },
  ]), "utf8");

  const done = run(dir, ["complete", "g1", "--items-path", items]);
  assert.equal(done.status, "done");
  assert.equal(done.items, 3);

  const status = run(dir, ["status", "g1"]);
  assert.equal(status.items_generated, 3);
  assert.equal(status.result_pointer, items);
});

test("enumerate (unfold): --prompt is required; validate-only does not write", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-gen-"));
  const v = run(dir, ["init", "gv", "--prompt", "x", "--validate-only"]);
  assert.equal(v.valid, true);
  // missing --prompt fails
  assert.throws(
    () => run(dir, ["init", "gx"]),
    /--prompt .* is required/,
  );
});

test("enumerate (unfold): complete rejects a non-array items file", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-gen-"));
  run(dir, ["init", "gb", "--prompt", "list"]);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ not: "an array" }), "utf8");
  assert.throws(() => run(dir, ["complete", "gb", "--items-path", bad]), /must be a JSON array/);
});
