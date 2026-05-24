import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const GROUP = resolve("dist/state/group.js");
const ITERATE = resolve("dist/state/iterate.js");
const REDUCE = resolve("dist/state/reduce.js");

function run(script: string, env: Record<string, string>, args: string[]): any {
  const out = execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

test("group: deterministic path-prefix partitions by first segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-"));
  const env = { GROUP_STATE_DIR: dir };
  const srcFile = join(dir, "src.json");
  writeFileSync(
    srcFile,
    JSON.stringify({
      source: "inline",
      data: [{ id: "src/a.ts" }, { id: "src/b.ts" }, { id: "lib/c.ts" }],
    }),
    "utf8",
  );
  run(GROUP, env, ["init", "g1", "--method", "path-prefix", "--input-source", srcFile, "--method-config", JSON.stringify({ depth: 1 })]);
  const res = run(GROUP, env, ["run-deterministic", "g1"]);
  assert.equal(res.items_total, 3);
  assert.equal(res.groups_count, 2); // src, lib
  assert.ok(existsSync(res.output));
  const groups = JSON.parse(readFileSync(res.output, "utf8"));
  const ids = groups.map((g: any) => g.id).sort();
  assert.deepEqual(ids, ["lib", "src"]);
});

test("group: regex method groups by first capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-"));
  const env = { GROUP_STATE_DIR: dir };
  const srcFile = join(dir, "src.json");
  writeFileSync(srcFile, JSON.stringify({ source: "inline", data: [{ id: "TICKET-1" }, { id: "TICKET-2" }, { id: "BUG-9" }] }), "utf8");
  run(GROUP, env, ["init", "g2", "--method", "regex", "--input-source", srcFile, "--method-config", JSON.stringify({ pattern: "^([A-Z]+)-", field: "id" })]);
  const res = run(GROUP, env, ["run-deterministic", "g2"]);
  assert.equal(res.groups_count, 2); // TICKET, BUG
});

test("iterate: until-loop stops when predicate satisfied", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  run(ITERATE, env, [
    "init",
    "i1",
    "--stage",
    JSON.stringify({ type: "bash", command: "echo iter $ITER_INDEX" }),
    "--stop",
    JSON.stringify({ type: "bash", command: '[ "$ITER_INDEX" -ge 2 ]', mode: "until" }),
    "--max-iterations",
    "10",
  ]);
  const actions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = run(ITERATE, env, ["run-iteration", "i1"]);
    actions.push(r.reason ?? r.action);
    if (r.action === "stop") break;
  }
  assert.deepEqual(actions, ["continue", "continue", "predicate_satisfied"]);
  const status = run(ITERATE, env, ["status", "i1"]);
  assert.equal(status.status, "done");
  assert.equal(status.stop_reason, "predicate_satisfied");
  assert.equal(status.iteration_count, 3);
});

test("iterate: accepts plain-string --stage/--stop (no JSON needed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  // plain strings; --mode defaults to until → stop when the predicate exits 0
  run(ITERATE, env, ["init", "s1", "--stage", "echo iter $ITER_INDEX", "--stop", '[ "$ITER_INDEX" -ge 1 ]']);
  for (let i = 0; i < 5; i++) {
    if (run(ITERATE, env, ["run-iteration", "s1"]).action === "stop") break;
  }
  const status = run(ITERATE, env, ["status", "s1"]);
  assert.equal(status.stop_reason, "predicate_satisfied");
  assert.equal(status.iteration_count, 2); // index 0 (continue) then index 1 (stop)
});

test("iterate: max-iterations hard cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  run(ITERATE, env, [
    "init", "i2",
    "--stage", JSON.stringify({ type: "bash", command: "echo $RANDOM" }),
    "--stop", JSON.stringify({ type: "bash", command: "false", mode: "until" }),
    "--max-iterations", "2",
    "--no-convergence-check",
  ]);
  let last: any;
  for (let i = 0; i < 5; i++) {
    last = run(ITERATE, env, ["run-iteration", "i2"]);
    if (last.action === "stop") break;
  }
  assert.equal(last.reason, "max_iterations");
  assert.equal(run(ITERATE, env, ["status", "i2"]).status, "done");
});

test("repeat (--times): runs exactly N times then stops at max_iterations", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  // no --stop → never-satisfied predicate; terminates only at --times
  run(ITERATE, env, ["init", "rep", "--stage", JSON.stringify({ type: "bash", command: "echo run $ITER_INDEX" }), "--times", "3"]);
  let last: any;
  let runs = 0;
  for (let i = 0; i < 6; i++) {
    last = run(ITERATE, env, ["run-iteration", "rep"]);
    if (last.action === "stop") break;
    runs++;
  }
  assert.equal(last.reason, "max_iterations");
  assert.equal(runs, 3); // exactly 3 continues before the cap
  assert.equal(run(ITERATE, env, ["status", "rep"]).iteration_count, 3);
});

test("while (--check-first): false guard up front runs the body zero times", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  run(ITERATE, env, [
    "init", "wh",
    "--stage", JSON.stringify({ type: "bash", command: "echo SHOULD_NOT_RUN" }),
    "--stop", JSON.stringify({ type: "bash", command: "false", mode: "while" }), // false → stop immediately
    "--check-first",
  ]);
  const r = run(ITERATE, env, ["run-iteration", "wh"]);
  assert.equal(r.action, "stop");
  assert.equal(r.reason, "predicate_satisfied");
  assert.equal(r.checked, "before");
  const status = run(ITERATE, env, ["status", "wh"]);
  assert.equal(status.iteration_count, 0); // body never ran
  assert.equal(status.status, "done");
});

test("while (--check-first): guard checked before each run", () => {
  const dir = mkdtempSync(join(tmpdir(), "iter-"));
  const env = { ITERATE_STATE_DIR: dir };
  run(ITERATE, env, [
    "init", "wh2",
    "--stage", JSON.stringify({ type: "bash", command: "echo body $ITER_INDEX" }),
    "--stop", JSON.stringify({ type: "bash", command: '[ "$ITER_INDEX" -lt 2 ]', mode: "while" }),
    "--check-first",
  ]);
  for (let i = 0; i < 6; i++) {
    if (run(ITERATE, env, ["run-iteration", "wh2"]).action === "stop") break;
  }
  // index 0,1 pass the guard and run; at index 2 the guard fails before running → 2 bodies
  assert.equal(run(ITERATE, env, ["status", "wh2"]).iteration_count, 2);
});

test("reduce: materialize resolves inline + file inputs, then complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-"));
  const env = { REDUCE_STATE_DIR: dir };
  const fileInput = join(dir, "data.json");
  writeFileSync(fileInput, JSON.stringify({ findings: 3 }), "utf8");
  const inputs = join(dir, "inputs.json");
  writeFileSync(inputs, JSON.stringify([{ source: "inline", data: { note: "hi" } }, { source: "file", path: fileInput }]), "utf8");

  run(REDUCE, env, ["init", "r1", "--inputs", inputs, "--task-prompt", "summarize"]);
  const mat = run(REDUCE, env, ["materialize", "r1", "--out", join(dir, "materialized.json")]);
  assert.equal(mat.input_blocks, 2);
  const materialized = JSON.parse(readFileSync(mat.materialized, "utf8"));
  assert.equal(materialized.inputs[1].data.findings, 3);

  run(REDUCE, env, ["start", "r1"]);
  const digest = join(dir, "digest.md");
  writeFileSync(digest, "# Digest\nall good", "utf8");
  const done = run(REDUCE, env, ["complete", "r1", "--output-path", digest]);
  assert.equal(done.status, "done");
  assert.equal(run(REDUCE, env, ["status", "r1"]).result_pointer, digest);
});
