import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  now,
  cacheKey,
  cacheStore,
  cacheLookup,
  cacheRoot,
  estimateUsd,
  makeBaseState,
  markInProgress,
  markDone,
  markFailed,
  incrementAutoContinues,
  addBudgetEvent,
  checkBudgetCaps,
  saveAtomic,
  loadState,
  listRuns,
  stateDir,
  appendJournal,
  journalPath,
  Primitive,
  getPrimitive,
  appendFollowup,
  STATUS_PENDING,
  STATUS_IN_PROGRESS,
  STATUS_DONE,
  STATUS_FAILED,
} from "../dist/common.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "enum-test-"));
}

test("now() is ISO-8601 UTC at seconds precision", () => {
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("cacheKey is deterministic and order/value-sensitive", () => {
  assert.equal(cacheKey("a", "b"), cacheKey("a", "b"));
  assert.notEqual(cacheKey("a", "b"), cacheKey("b", "a"));
  // unit-separator prevents ("a","b") colliding with ("ab","")
  assert.notEqual(cacheKey("a", "b"), cacheKey("ab", ""));
  assert.match(cacheKey("x"), /^[0-9a-f]{64}$/);
});

test("estimateUsd: zero tokens, model tiers, default tier", () => {
  assert.equal(estimateUsd("opus", 0), 0);
  // 3M tokens at 1/3 input: 1M*in + 2M*out
  const opus = estimateUsd("claude-opus-4-7", 3_000_000);
  assert.ok(Math.abs(opus - (1 * 15 + 2 * 75)) < 1e-6); // 165 USD
  const haiku = estimateUsd("haiku", 3_000_000);
  assert.ok(Math.abs(haiku - (1 * 0.8 + 2 * 4)) < 1e-6); // 8.8 USD
  // unknown model falls back to sonnet
  assert.equal(estimateUsd("mystery", 3_000_000), estimateUsd("sonnet", 3_000_000));
});

test("makeBaseState has the reserved base contract", () => {
  const s = makeBaseState("enumerate", "r1", { max_auto_continues: 5 }, { items: { x: 1 } });
  assert.equal(s["run_id"], "r1");
  assert.equal(s["cmd"], "enumerate");
  assert.equal(s["status"], STATUS_PENDING);
  assert.equal(s["auto_continues"], 0);
  assert.deepEqual(s["followups"], []);
  assert.equal(s["budget"].tokens_used, 0);
  assert.equal(s["config"].max_auto_continues, 5);
  assert.deepEqual(s["items"], { x: 1 }); // extra merged
  // config is copied, not aliased
  const cfg = { a: 1 };
  const s2 = makeBaseState("pipe", "r2", cfg);
  cfg.a = 99;
  assert.equal(s2["config"].a, 1);
});

test("mark helpers transition status and stamps", () => {
  const s = makeBaseState("iterate", "r", {});
  markInProgress(s);
  assert.equal(s["status"], STATUS_IN_PROGRESS);
  assert.ok(s["started_at"]);
  markDone(s, "/path/out.json");
  assert.equal(s["status"], STATUS_DONE);
  assert.equal(s["result_pointer"], "/path/out.json");
  markFailed(s, "boom");
  assert.equal(s["status"], STATUS_FAILED);
  assert.equal(s["error"], "boom");
});

test("incrementAutoContinues respects cap", () => {
  const s = makeBaseState("iterate", "r", { max_auto_continues: 2 });
  assert.deepEqual(incrementAutoContinues(s), { value: 1, cap: 2, overCap: false });
  assert.deepEqual(incrementAutoContinues(s), { value: 2, cap: 2, overCap: false });
  assert.deepEqual(incrementAutoContinues(s), { value: 3, cap: 2, overCap: true });
});

test("addBudgetEvent estimates USD, counts agents, trims to 50", () => {
  const s = makeBaseState("enumerate", "r", {});
  addBudgetEvent(s, { tokens: 3_000_000, model: "opus" });
  assert.equal(s["budget"].agents_dispatched, 1);
  assert.ok(s["budget"].usd_estimate > 0);
  assert.equal(s["budget"].tokens_used, 3_000_000);
  // non-dispatch event does not bump agent count
  addBudgetEvent(s, { tokens: 0, eventType: "note" });
  assert.equal(s["budget"].agents_dispatched, 1);
  // explicit usd bypasses estimation
  addBudgetEvent(s, { usd: 1.5, eventType: "note" });
  // trimming
  for (let i = 0; i < 60; i++) addBudgetEvent(s, { eventType: "note" });
  assert.equal(s["budget"].events.length, 50);
});

test("checkBudgetCaps flags exceeded caps", () => {
  const s = makeBaseState("enumerate", "r", { budget_caps: { max_agents: 1 } });
  assert.deepEqual(checkBudgetCaps(s), [false, null]);
  addBudgetEvent(s, { tokens: 10, model: "haiku" });
  const [over, reason] = checkBudgetCaps(s);
  assert.equal(over, true);
  assert.match(reason ?? "", /agents_dispatched/);
});

test("saveAtomic + loadState round-trip preserves unicode", () => {
  const dir = tmp();
  const p = join(dir, "sub", "state.json");
  const data = { run_id: "r", note: "✓ — ≈ → café" };
  saveAtomic(p, data);
  assert.ok(existsSync(p));
  assert.deepEqual(loadState(p), data);
  // pretty-printed (indent 2)
  assert.match(readFileSync(p, "utf8"), /\n  "run_id": "r"/);
});

test("stateDir honors env override; listRuns finds runs with state.json", () => {
  const dir = tmp();
  process.env["ENUMERATE_STATE_DIR"] = dir;
  try {
    assert.equal(stateDir("enumerate"), require_resolve(dir));
    mkdirSync(join(dir, "runA"), { recursive: true });
    writeFileSync(join(dir, "runA", "state.json"), "{}");
    mkdirSync(join(dir, "runB_no_state"), { recursive: true });
    assert.deepEqual(listRuns("enumerate"), ["runA"]);
  } finally {
    delete process.env["ENUMERATE_STATE_DIR"];
  }
});

// resolve() normalizes path separators; mirror that for the equality check
function require_resolve(p: string): string {
  return join(p); // join normalizes; stateDir uses resolve() but on an absolute tmp dir these match
}

test("appendJournal creates header once and sanitizes entity", () => {
  const dir = tmp();
  process.env["KNOWLEDGE_DIR"] = dir;
  try {
    const entity = "src/foo/bar.ts";
    const p1 = appendJournal("audit", entity, "first finding", "run-1");
    appendJournal("audit", entity, "second finding", "run-2");
    assert.equal(journalPath("audit", entity), p1);
    assert.ok(!p1.includes("/foo/")); // slashes sanitized to __
    const text = readFileSync(p1, "utf8");
    assert.equal((text.match(/^# /gm) ?? []).length, 1); // header written once
    assert.match(text, /first finding/);
    assert.match(text, /second finding/);
    assert.match(text, /— run-1/);
  } finally {
    delete process.env["KNOWLEDGE_DIR"];
  }
});

test("Primitive registers itself and round-trips state", () => {
  const dir = tmp();
  process.env["REDUCE_STATE_DIR"] = dir;
  try {
    const P = new Primitive("reduce", {
      isDone: (s) => s["status"] === STATUS_DONE,
      hasResidualWork: (s) => (s["status"] === STATUS_DONE ? null : ["resume"]),
      resumeMsg: (runId) => `resume ${runId}`,
    });
    assert.ok(getPrimitive("reduce"));
    const st = P.makeState("run1", { max_auto_continues: 3 });
    P.save("run1", st);
    const loaded = P.load("run1");
    assert.equal(loaded["run_id"], "run1");
    assert.deepEqual(P.listRuns(), ["run1"]);
    // default resultPointer/nextActions wiring
    const spec = getPrimitive("reduce");
    assert.equal(spec?.resultPointer({ result_pointer: "/x" }), "/x");
    assert.deepEqual(spec?.nextActions({ followups: [{ a: 1 }] }), [{ a: 1 }]);
  } finally {
    delete process.env["REDUCE_STATE_DIR"];
  }
});

test("appendFollowup enqueues onto followups", () => {
  const s = makeBaseState("enumerate", "r", {});
  appendFollowup(s, { kind: "spawn" });
  assert.deepEqual(s["followups"], [{ kind: "spawn" }]);
});

test("cache store/lookup round-trip; miss returns null", () => {
  const dir = tmp();
  process.env["CACHE_DIR"] = dir;
  try {
    assert.equal(cacheRoot(), join(dir));
    const k = cacheKey("prompt", "opus", "hash123");
    assert.equal(cacheLookup("ns", k), null);
    cacheStore("ns", k, { ok: true, summary: "done" });
    const hit = cacheLookup("ns", k);
    assert.equal(hit?.["value"].ok, true);
    assert.equal(hit?.["key"], k);
  } finally {
    delete process.env["CACHE_DIR"];
  }
});
