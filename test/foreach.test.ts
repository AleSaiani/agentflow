import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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
