import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ENUM = resolve("dist/state/foreach.js");
const INSPECT = resolve("dist/inspect.js");
const HOOK = resolve("dist/hook/continue.js");

/** Build an env where all primitive state dirs live under one temp base (repo stays clean). */
function freshEnv(): { env: Record<string, string>; base: string } {
  const base = mkdtempSync(join(tmpdir(), "ih-"));
  return {
    base,
    env: {
      FOREACH_STATE_DIR: join(base, "foreach"),
      GROUP_STATE_DIR: join(base, "group"),
      ITERATE_STATE_DIR: join(base, "iterate"),
      PIPE_STATE_DIR: join(base, "pipe"),
      REDUCE_STATE_DIR: join(base, "reduce"),
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

test("Stop hook blocks on an active foreach run and pre-increments auto_continues", () => {
  const { env } = freshEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf8");
  run(ENUM, env, ["init", "r1", "--items", items]); // pending items, auto_continue default true

  const out = run(HOOK, env, [], "{}");
  const decision = lastJson(out);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /agentflow:foreach run 'r1'/);

  // pre-increment persisted
  const state = JSON.parse(readFileSync(join(env["FOREACH_STATE_DIR"]!, "r1", "state.json"), "utf8"));
  assert.equal(state.auto_continues, 1);
});

test("Stop hook is silent when no run has residual work", () => {
  const { env } = freshEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }]), "utf8");
  run(ENUM, env, ["init", "r2", "--items", items]);
  // claim + complete the only item → no residual work
  const claimed = lastJson(run(ENUM, env, ["claim", "r2", "--count", "1"]));
  run(ENUM, env, ["complete", "r2", claimed[0].id]);

  const out = run(HOOK, env, [], "{}");
  assert.equal(out.trim(), ""); // no decision emitted
});

test("Stop hook respects the max_auto_continues cap", () => {
  const { env } = freshEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }]), "utf8");
  run(ENUM, env, ["init", "r3", "--items", items, "--max-auto-continues", "1"]);
  // first hook fire blocks and increments to 1 (== cap)
  assert.equal(lastJson(run(HOOK, env, [], "{}")).decision, "block");
  // second fire: auto_continues (1) >= cap (1) → silent
  assert.equal(run(HOOK, env, [], "{}").trim(), "");
});

test("inspect runs/board surface the active run", () => {
  const { env } = freshEnv();
  const items = join(env["FOREACH_STATE_DIR"]!, "..", "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf8");
  run(ENUM, env, ["init", "rb", "--items", items]);

  // inspect --json emits multi-line pretty JSON → parse the whole output
  const runs = JSON.parse(run(INSPECT, env, ["runs", "--json"]));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cmd, "foreach");
  assert.equal(runs[0].run_id, "rb");
  assert.equal(runs[0].is_done, false);

  const board = JSON.parse(run(INSPECT, env, ["board", "--json"]));
  assert.equal(board.active.length, 1);
  assert.equal(board.active[0].progress, "0/2");

  const show = JSON.parse(run(INSPECT, env, ["show", "rb"]));
  assert.equal(show.cmd, "foreach");
  assert.equal(show.items.total, 2);
  assert.equal(show.items.pending, 2);

  const history = JSON.parse(run(INSPECT, env, ["history", "--json"]));
  assert.equal(history.length, 1);
  assert.equal(history[0].cmd, "foreach");
  assert.equal(history[0].run_id, "rb");
  assert.ok(history[0].updated_at);
});
