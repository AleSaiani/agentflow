import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const FOREACH = resolve("dist/state/foreach.js");
const RUNS = resolve("dist/runs.js");
const HOOK = resolve("dist/hook/continue.js");

/** All primitive state dirs (and the global PAUSED sentinel) under one temp base — repo stays clean. */
function freshEnv(): { env: Record<string, string>; base: string } {
  const base = mkdtempSync(join(tmpdir(), "runs-"));
  return {
    base,
    env: {
      AGENTFLOW_DIR: base,
      FOREACH_STATE_DIR: join(base, "foreach"),
      GROUP_STATE_DIR: join(base, "group"),
      ITERATE_STATE_DIR: join(base, "iterate"),
      PIPE_STATE_DIR: join(base, "pipe"),
      REDUCE_STATE_DIR: join(base, "reduce"),
      STEP_STATE_DIR: join(base, "step"),
      QUEUE_STATE_DIR: join(base, "queue"),
      ENUMERATE_STATE_DIR: join(base, "enumerate"),
    },
  };
}

function run(script: string, env: Record<string, string>, args: string[], input = ""): string {
  return execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, input });
}

function lastJson(out: string): any {
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

function statePathOf(env: Record<string, string>, cmd: string, id: string): string {
  return join(env[`${cmd.toUpperCase()}_STATE_DIR`]!, id, "state.json");
}
function readState(env: Record<string, string>, cmd: string, id: string): any {
  return JSON.parse(readFileSync(statePathOf(env, cmd, id), "utf8"));
}
function patchState(env: Record<string, string>, cmd: string, id: string, patch: Record<string, unknown>): void {
  const p = statePathOf(env, cmd, id);
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }, null, 2), "utf8");
}

/** Init a pending foreach (auto_continue default true → has residual work). */
function initForeach(env: Record<string, string>, id: string, n = 2): void {
  const items = join(env["AGENTFLOW_DIR"]!, `items-${id}.json`);
  writeFileSync(items, JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}` }))), "utf8");
  run(FOREACH, env, ["init", id, "--items", items]);
}

test("scheduling is FIFO by created_at — the oldest job advances first, not alphabetical", () => {
  const { env } = freshEnv();
  initForeach(env, "z-old");
  initForeach(env, "a-new");
  // z-old is older despite sorting last alphabetically; a-new is newer despite sorting first.
  patchState(env, "foreach", "z-old", { created_at: "2026-01-01T00:00:00Z" });
  patchState(env, "foreach", "a-new", { created_at: "2026-06-01T00:00:00Z" });

  const decision = lastJson(run(HOOK, env, [], "{}"));
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /'z-old'/); // FIFO winner
  assert.equal(readState(env, "foreach", "z-old").auto_continues, 1); // pre-incremented winner
  assert.equal(readState(env, "foreach", "a-new").auto_continues, 0); // untouched
});

test("priority overrides FIFO — a higher-priority newer job jumps the queue", () => {
  const { env } = freshEnv();
  initForeach(env, "z-old");
  initForeach(env, "a-new");
  patchState(env, "foreach", "z-old", { created_at: "2026-01-01T00:00:00Z" });
  patchState(env, "foreach", "a-new", { created_at: "2026-06-01T00:00:00Z" });

  run(RUNS, env, ["priority", "a-new", "5"]);
  assert.equal(readState(env, "foreach", "a-new").priority, 5);

  const decision = lastJson(run(HOOK, env, [], "{}"));
  assert.match(decision.reason, /'a-new'/);
  assert.equal(readState(env, "foreach", "a-new").auto_continues, 1);
  assert.equal(readState(env, "foreach", "z-old").auto_continues, 0);
});

test("global pause freezes everything; resume unfreezes", () => {
  const { env } = freshEnv();
  initForeach(env, "r1");

  const paused = lastJson(run(RUNS, env, ["pause"]));
  assert.equal(paused.paused, true);
  assert.ok(existsSync(join(env["AGENTFLOW_DIR"]!, "PAUSED")));

  assert.equal(run(HOOK, env, [], "{}").trim(), ""); // silent — nothing auto-resumes
  assert.equal(readState(env, "foreach", "r1").auto_continues, 0);

  run(RUNS, env, ["resume"]);
  assert.ok(!existsSync(join(env["AGENTFLOW_DIR"]!, "PAUSED")));
  assert.equal(lastJson(run(HOOK, env, [], "{}")).decision, "block"); // back in business
});

test("per-job stop coexists with other running jobs", () => {
  const { env } = freshEnv();
  initForeach(env, "keep");
  initForeach(env, "hold");
  patchState(env, "foreach", "keep", { created_at: "2026-06-01T00:00:00Z" }); // newer
  patchState(env, "foreach", "hold", { created_at: "2026-01-01T00:00:00Z" }); // older → would win FIFO

  const stopped = lastJson(run(RUNS, env, ["stop", "hold"]));
  assert.equal(stopped.paused, true);
  assert.equal(readState(env, "foreach", "hold").paused, true);

  // 'hold' is older but paused, so the hook skips it and advances 'keep'.
  const decision = lastJson(run(HOOK, env, [], "{}"));
  assert.match(decision.reason, /'keep'/);
  assert.equal(readState(env, "foreach", "hold").auto_continues, 0);

  run(RUNS, env, ["resume", "hold"]);
  assert.equal(readState(env, "foreach", "hold").paused, false);
});

test("list shows active top-level jobs with a queue position", () => {
  const { env } = freshEnv();
  initForeach(env, "j1");
  initForeach(env, "j2");
  patchState(env, "foreach", "j1", { created_at: "2026-01-01T00:00:00Z" });
  patchState(env, "foreach", "j2", { created_at: "2026-06-01T00:00:00Z" });

  const out = JSON.parse(run(RUNS, env, ["list", "--json"]));
  assert.equal(out.global_paused, false);
  assert.equal(out.jobs.length, 2);
  const j1 = out.jobs.find((j: any) => j.run_id === "j1");
  const j2 = out.jobs.find((j: any) => j.run_id === "j2");
  assert.equal(j1.pos, 1); // older → next up
  assert.equal(j2.pos, 2);
});

test("rm refuses an active job without --force, removes it with --force, leaves others intact", () => {
  const { env } = freshEnv();
  initForeach(env, "doomed");
  initForeach(env, "survivor");

  // Active job, no --force → refused (exit non-zero).
  assert.throws(() => run(RUNS, env, ["rm", "doomed"]));
  assert.ok(existsSync(statePathOf(env, "foreach", "doomed")));

  const res = lastJson(run(RUNS, env, ["rm", "doomed", "--force"]));
  assert.deepEqual(res.removed, ["foreach/doomed"]);
  assert.ok(!existsSync(statePathOf(env, "foreach", "doomed")));
  assert.ok(existsSync(statePathOf(env, "foreach", "survivor"))); // untouched
});

test("clean removes finished jobs only, leaving active ones in place", () => {
  const { env } = freshEnv();
  initForeach(env, "finished", 1);
  initForeach(env, "busy", 1);
  // Drive 'finished' to completion: claim + complete its single item.
  const claimed = lastJson(run(FOREACH, env, ["claim", "finished", "--count", "1"]));
  run(FOREACH, env, ["complete", "finished", claimed[0].id]);

  const dry = lastJson(run(RUNS, env, ["clean", "--dry-run"]));
  assert.deepEqual(dry.cleaned_jobs, ["foreach/finished (done)"]);
  assert.ok(existsSync(statePathOf(env, "foreach", "finished"))); // dry-run kept it

  const res = lastJson(run(RUNS, env, ["clean"]));
  assert.equal(res.runs_removed, 1);
  assert.ok(!existsSync(statePathOf(env, "foreach", "finished")));
  assert.ok(existsSync(statePathOf(env, "foreach", "busy"))); // active job survives GC
});

test("a pipe's child sub-run is NOT listed as a top-level job", () => {
  const { env } = freshEnv();
  initForeach(env, "standalone");
  // Hand-craft a pipe whose stage references a foreach child run-id.
  initForeach(env, "child-fe");
  const pipeDir = join(env["PIPE_STATE_DIR"]!, "wf");
  const pipeState = {
    run_id: "wf", cmd: "pipe", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    config: { auto_continue: true }, auto_continues: 0, status: "in_progress", stage_index: 0,
    stages: [{ index: 0, name: "s0", type: "primitive", status: "in_progress", child_cmd: "foreach", child_run_id: "child-fe" }],
    budget: {},
  };
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(join(pipeDir, "state.json"), JSON.stringify(pipeState), "utf8");

  const out = JSON.parse(run(RUNS, env, ["list", "--all", "--json"]));
  const ids = out.jobs.map((j: any) => `${j.cmd}/${j.run_id}`);
  assert.ok(ids.includes("foreach/standalone"));
  assert.ok(ids.includes("pipe/wf"));
  assert.ok(!ids.includes("foreach/child-fe")); // it's a sub-run of pipe/wf
});
