/**
 * End-to-end cross-turn simulation (F6).
 *
 * Every interaction below is a SEPARATE `node` subprocess that shares only the on-disk state
 * dir — no in-process or in-conversation state carries over. This is exactly the property
 * that makes runs survive context compaction: resumption depends solely on `state.json`, and
 * the Stop hook reconstructs everything it needs from disk each turn. We simulate the turn
 * cycle: fire the Stop hook → if it blocks, do the work its resume message prescribes → fire
 * again → ... until the hook goes silent (run complete).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ENUM = resolve("dist/state/foreach.js");
const ITERATE = resolve("dist/state/iterate.js");
const PIPE = resolve("dist/state/pipe.js");
const HOOK = resolve("dist/hook/continue.js");

function baseEnv(): Record<string, string> {
  const b = mkdtempSync(join(tmpdir(), "e2e-"));
  return {
    FOREACH_STATE_DIR: join(b, "foreach"),
    GROUP_STATE_DIR: join(b, "group"),
    ITERATE_STATE_DIR: join(b, "iterate"),
    PIPE_STATE_DIR: join(b, "pipe"),
    REDUCE_STATE_DIR: join(b, "reduce"),
  };
}

function run(script: string, env: Record<string, string>, args: string[], input = ""): string {
  return execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, input });
}
function lastJson(out: string): any {
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}
/** Fire the Stop hook (fresh process). Returns the block decision, or null when silent. */
function fireHook(env: Record<string, string>): { decision: string; reason: string } | null {
  const out = run(HOOK, env, [], "{}").trim();
  return out ? JSON.parse(out) : null;
}

test("E2E: Stop hook drives an /agentflow:foreach run to completion across simulated turns", () => {
  const env = baseEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]), "utf8");
  run(ENUM, env, ["init", "r", "--items", items]);

  let turns = 0;
  for (; turns < 25; turns++) {
    const decision = fireHook(env);
    if (decision === null) break; // hook silent → run complete
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /agentflow:foreach run 'r'/);
    // Simulate one turn of model work: claim + complete exactly one item.
    const claimed = lastJson(run(ENUM, env, ["claim", "r", "--count", "1"]));
    if (claimed.length) run(ENUM, env, ["complete", "r", claimed[0].id]);
  }
  assert.ok(turns < 25, "did not converge");
  const status = lastJson(run(ENUM, env, ["status", "r"]));
  assert.equal(status.run_status, "done");
  assert.equal(status.done, 3);
  assert.equal(turns, 3); // exactly one item completed per turn
});

test("E2E: Stop hook drives an /iterate until-loop to completion across turns", () => {
  const env = baseEnv();
  run(ITERATE, env, [
    "init", "r",
    "--stage", JSON.stringify({ type: "bash", command: "echo iter $ITER_INDEX" }),
    "--stop", JSON.stringify({ type: "bash", command: '[ "$ITER_INDEX" -ge 2 ]', mode: "until" }),
    "--max-iterations", "10",
  ]);

  let turns = 0;
  for (; turns < 25; turns++) {
    const decision = fireHook(env);
    if (decision === null) break;
    assert.match(decision.reason, /iterate run 'r'/);
    run(ITERATE, env, ["run-iteration", "r"]); // one iteration per turn
  }
  const status = lastJson(run(ITERATE, env, ["status", "r"]));
  assert.equal(status.status, "done");
  assert.equal(status.stop_reason, "predicate_satisfied");
});

test("E2E: Stop hook + pipe drive complete a deterministic pipeline across turns", () => {
  const env = baseEnv();
  const srcFile = join(env["PIPE_STATE_DIR"]!, "..", "src.json");
  writeFileSync(srcFile, JSON.stringify({ source: "inline", data: [{ id: "src/a" }, { id: "lib/b" }] }), "utf8");
  const stages = join(env["PIPE_STATE_DIR"]!, "..", "stages.json");
  writeFileSync(
    stages,
    JSON.stringify([
      { name: "echo", type: "bash", spec: { command: 'echo step1 > "$PIPE_OUTPUT_PATH"' } },
      { name: "grp", type: "primitive", spec: { cmd: "group", init_args: ["--method", "path-prefix", "--input-source", srcFile, "--method-config", JSON.stringify({ depth: 1 })] } },
    ]),
    "utf8",
  );
  run(PIPE, env, ["init", "r", "--stages", stages]);

  let turns = 0;
  for (; turns < 25; turns++) {
    const decision = fireHook(env);
    if (decision === null) break;
    assert.match(decision.reason, /pipe run 'r'/);
    // Model work prescribed by the resume message: tick the pipe forward.
    run(PIPE, env, ["drive", "r", "--max-steps", "50"]); // auto-runs the deterministic stages
  }
  const status = lastJson(run(PIPE, env, ["status", "r"]));
  assert.equal(status.status, "done");
  assert.equal(status.stages[1].child_cmd, "group");
});

test("E2E: a completed run never re-blocks (hook is silent at terminal state)", () => {
  const env = baseEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "only" }]), "utf8");
  run(ENUM, env, ["init", "r", "--items", items]);
  const claimed = lastJson(run(ENUM, env, ["claim", "r", "--count", "1"]));
  run(ENUM, env, ["complete", "r", claimed[0].id]);
  // Fire the hook twice — must stay silent both times.
  assert.equal(fireHook(env), null);
  assert.equal(fireHook(env), null);
});
