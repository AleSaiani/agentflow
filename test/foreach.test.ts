import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = resolve("dist/state/foreach.js");

/** Run the foreach CLI as a subprocess; returns parsed JSON stdout (last line). */
function run(stateDir: string, args: string[]): any {
  const out = execFileSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FOREACH_STATE_DIR: stateDir },
  });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

test("foreach CLI: checkbox init pre-marks [x], claim/complete drives to done", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const md = join(dir, "plan.md");
  writeFileSync(md, "- [ ] task one {model:opus}\n- [x] task two\n- [ ] task three\n", "utf8");

  const init = run(dir, ["init", "r1", "--checkbox", md]);
  assert.equal(init.total, 3);
  assert.equal(init.run_id, "r1");

  let status = run(dir, ["status", "r1"]);
  assert.equal(status.done, 1); // the [x] item
  assert.equal(status.pending, 2);
  assert.equal(status.run_status, "pending"); // not started until first claim

  // claim one pending item
  const claimed = run(dir, ["claim", "r1", "--count", "1"]);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "in_progress");
  // per-item override carried through (first pending item is "task one {model:opus}")
  assert.equal(claimed[0].task?.model, "opus");

  // complete it
  run(dir, ["complete", "r1", claimed[0].id, "--result", JSON.stringify({ ok: true })]);
  // claim + complete the last one
  const c2 = run(dir, ["claim", "r1", "--count", "5"]);
  run(dir, ["complete", "r1", c2[0].id]);

  status = run(dir, ["status", "r1"]);
  assert.equal(status.pending, 0);
  assert.equal(status.in_progress, 0);
  assert.equal(status.run_status, "done"); // finalized when all terminal

  // view write-back reflects statuses onto the markdown
  const view = run(dir, ["view", "r1", "--checkbox", md]);
  assert.ok(view.toggled >= 1);
  const out = readFileSync(md, "utf8");
  assert.match(out, /- \[x\] task one/);
  assert.match(out, /- \[x\] task three/);
});

test("foreach CLI: complete-batch + fail/retry + reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "x" }, { id: "y" }, { id: "z" }]), "utf8");
  run(dir, ["init", "r2", "--items", items, "--max-retries", "0"]);
  // Realistic flow: claim (dispatch) before recording results, so attempts > max_retries
  // on failure routes z to failed rather than retry.
  run(dir, ["claim", "r2", "--count", "9"]);

  const results = join(dir, "results.json");
  writeFileSync(
    results,
    JSON.stringify([
      { id: "x", ok: true, result: { v: 1 } },
      { id: "y", result: { v: 2 } }, // lenient ok inference
      { id: "z", ok: false, error: "boom" }, // max-retries 0 → failed
    ]),
    "utf8",
  );
  const batch = run(dir, ["complete-batch", "r2", "--results", results]);
  assert.equal(batch.completed, 2);
  assert.equal(batch.failed, 1);

  const status = run(dir, ["status", "r2"]);
  assert.equal(status.done, 2);
  assert.equal(status.failed, 1);
  assert.equal(status.run_status, "done"); // all terminal (done|failed)

  // reset failed → pending
  const reset = run(dir, ["reset", "r2", "--failed-to-pending"]);
  assert.equal(reset.reset, 1);
  assert.equal(run(dir, ["status", "r2"]).pending, 1);
});

test("foreach CLI: --folder auto-moves files todo→in-progress→done on claim/complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const board = join(dir, "tasks");
  mkdirSync(join(board, "todo"), { recursive: true });
  writeFileSync(join(board, "todo", "a.md"), "do a", "utf8");
  writeFileSync(join(board, "todo", "b.md"), "do b", "utf8");

  const init = run(dir, ["init", "rf", "--folder", board]);
  assert.equal(init.total, 2);
  // both files still in todo/ right after init
  assert.ok(existsSync(join(board, "todo", "a.md")));

  // claim one → its file moves todo/ → in-progress/, no view step
  const claimed = run(dir, ["claim", "rf", "--count", "1"]);
  const id = claimed[0].id; // sorted → "a.md"
  assert.ok(existsSync(join(board, "in-progress", id)), "claimed file should be in in-progress/");
  assert.ok(!existsSync(join(board, "todo", id)));

  // complete it → moves in-progress/ → done/
  run(dir, ["complete", "rf", id]);
  assert.ok(existsSync(join(board, "done", id)), "completed file should be in done/");
  assert.ok(!existsSync(join(board, "in-progress", id)));

  // the untouched item stays in todo/
  const other = id === "a.md" ? "b.md" : "a.md";
  assert.ok(existsSync(join(board, "todo", other)));
});

test("foreach CLI: --prompt-file loads operation from a file; --serial forces concurrency/chunk", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const op = join(dir, "op.txt");
  writeFileSync(op, "Review this file for security bugs.\nReport severity.\n", "utf8");
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf8");

  const init = run(dir, ["init", "pf", "--items", items, "--prompt-file", op, "--serial"]);
  assert.equal(init.serial, true);
  assert.equal(init.carry, false);

  const state = JSON.parse(readFileSync(join(dir, "pf", "state.json"), "utf8"));
  assert.match(state.task_prompt, /Review this file for security bugs/);
  assert.equal(state.config.concurrency, 1);
  assert.equal(state.config.chunk_size, "1");

  // --prompt and --prompt-file are mutually exclusive (non-zero exit → throws)
  assert.throws(() => run(dir, ["init", "pf2", "--items", items, "--prompt", "x", "--prompt-file", op]));
});

test("foreach CLI: --carry implies serial; claim-serial returns the previous item's result", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]), "utf8");
  const init = run(dir, ["init", "cr", "--items", items, "--carry", "--prompt", "step"]);
  assert.equal(init.serial, true);
  assert.equal(init.carry, true);

  const c1 = run(dir, ["claim-serial", "cr"]);
  assert.equal(c1.item.id, "a"); // first pending, in list order
  assert.equal(c1.prev_result, null);

  run(dir, ["complete", "cr", "a", "--result", JSON.stringify({ v: 1 })]);
  const c2 = run(dir, ["claim-serial", "cr"]);
  assert.equal(c2.item.id, "b");
  assert.equal(c2.prev_id, "a");
  assert.deepEqual(c2.prev_result, { v: 1 }); // carry from the previous item

  // resume-safe: re-claiming without completing returns the same in_progress item, attempts not bumped
  const again = run(dir, ["claim-serial", "cr"]);
  assert.equal(again.item.id, "b");
  assert.equal(again.item.attempts, 1);
});

test("foreach CLI: --shard k/N partitions items by index; bad shard errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]), "utf8");

  const s0 = run(dir, ["init", "s0", "--items", items, "--shard", "0/2", "--prompt", "x"]);
  assert.equal(s0.total, 2);
  assert.equal(s0.shard, "0/2");
  assert.deepEqual((run(dir, ["list", "s0"]) as any[]).map((i) => i.id), ["a", "c"]);

  run(dir, ["init", "s1", "--items", items, "--shard", "1/2", "--prompt", "x"]);
  assert.deepEqual((run(dir, ["list", "s1"]) as any[]).map((i) => i.id), ["b", "d"]);

  assert.throws(() => run(dir, ["init", "bad", "--items", items, "--shard", "3/2", "--prompt", "x"]));
});

test("foreach CLI: --stop-file pauses (status.paused) while the file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }]), "utf8");
  const stop = join(dir, "STOP");
  run(dir, ["init", "sf", "--items", items, "--stop-file", stop, "--prompt", "x"]);
  assert.equal(run(dir, ["status", "sf"]).paused, false);
  writeFileSync(stop, "", "utf8");
  assert.equal(run(dir, ["status", "sf"]).paused, true);
});

test("foreach CLI: validate-only does not read items or write state", () => {
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const v = run(dir, ["init", "rX", "--items", join(dir, "nope.json"), "--validate-only"]);
  assert.equal(v.valid, true);
  assert.equal(v.kind, null);
});

test("foreach CLI: --kind resolves task-kinds.md WITHOUT CLAUDE_PLUGIN_ROOT (root from module path)", () => {
  // Regression: the spawned CLI must find the bundled skills/foreach/task-kinds.md from its own
  // location, not from $CLAUDE_PLUGIN_ROOT (which is not exported to the Bash tool). run() here does
  // NOT set CLAUDE_PLUGIN_ROOT.
  const dir = mkdtempSync(join(tmpdir(), "enum-cli-"));
  const v = run(dir, ["init", "rk", "--items", join(dir, "nope.json"), "--kind", "code-review", "--validate-only"]);
  assert.equal(v.valid, true);
  assert.equal(v.kind, "code-review");
});
