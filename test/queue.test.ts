import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = resolve("dist/state/queue.js");

function run(stateDir: string, args: string[]): any {
  const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, QUEUE_STATE_DIR: stateDir } });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null");
}

test("queue: atomic claims never hand out the same item twice; drains to done", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]), "utf8");

  const init = run(dir, ["init", "q", "--items", items, "--prompt", "do it"]);
  assert.equal(init.enqueued, 5);

  // claim until empty → 5 distinct ids, then null
  const got: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = run(dir, ["claim", "q"]);
    if (r.item) got.push(r.item.id);
    else break;
  }
  assert.equal(got.length, 5);
  assert.equal(new Set(got).size, 5); // all distinct — no double-claim
  assert.equal(run(dir, ["claim", "q"]).item, null); // empty

  // complete 4, fail+retry 1 → 1 back to pending → re-claim + complete → done
  for (const id of got.slice(0, 4)) run(dir, ["complete", "q", id]);
  const retried = run(dir, ["fail", "q", got[4], "--retry"]);
  assert.equal(retried.status, "pending");
  const again = run(dir, ["claim", "q"]);
  assert.equal(again.item.id, got[4]);
  assert.equal(again.item.attempts, 2); // attempt count survived the retry
  run(dir, ["complete", "q", got[4]]);

  const status = run(dir, ["status", "q"]);
  assert.equal(status.run_status, "done");
  assert.equal(status.done, 5);
  assert.equal(status.pending + status.claimed, 0);
});

test("queue: ids that slugify to the same name do NOT collide (no silent work loss)", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const items = join(dir, "items.json");
  // a/b, a:b, a b all slugify to "a-b" — must still enqueue as 3 distinct items
  writeFileSync(items, JSON.stringify([{ id: "a/b" }, { id: "a:b" }, { id: "a b" }]), "utf8");
  const init = run(dir, ["init", "col", "--items", items, "--prompt", "x"]);
  assert.equal(init.enqueued, 3);
  assert.equal(run(dir, ["status", "col"]).pending, 3);
  // each is independently claimable and identifiable by its real id
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) ids.add(run(dir, ["claim", "col"]).item.id);
  assert.deepEqual([...ids].sort(), ["a b", "a/b", "a:b"]);
});

test("queue: --stop-file pauses claiming; reclaim returns stale claims; add enqueues more", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf8");
  const stop = join(dir, "PAUSE");
  run(dir, ["init", "q2", "--items", items, "--stop-file", stop]);

  // pause gate: claim returns nothing while the file exists
  writeFileSync(stop, "", "utf8");
  assert.equal(run(dir, ["claim", "q2"]).item, null);
  assert.equal(run(dir, ["status", "q2"]).paused, true);

  // remove pause, claim one, then reclaim (older-than 0) returns it to pending
  rmSync(stop);
  const claimed = run(dir, ["claim", "q2"]);
  assert.ok(claimed.item);
  assert.equal(run(dir, ["status", "q2"]).claimed, 1);
  const rec = run(dir, ["reclaim", "q2", "--older-than", "0"]);
  assert.equal(rec.reclaimed, 1);
  assert.equal(run(dir, ["status", "q2"]).pending, 2);

  // dynamic add
  const more = join(dir, "more.json");
  writeFileSync(more, JSON.stringify([{ id: "c" }]), "utf8");
  assert.equal(run(dir, ["add", "q2", "--items", more]).added, 1);
  assert.equal(run(dir, ["status", "q2"]).pending, 3);
});

test("queue: budget-add records the --tokens/--usd/--event-type flags (not a silent no-op)", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify([{ id: "a" }]), "utf8");
  run(dir, ["init", "qb", "--items", items, "--prompt", "x"]);

  // A non-"agent_dispatch" event must still record cost but NOT bump the agent counter.
  const r = run(dir, ["budget-add", "qb", "--tokens", "100", "--usd", "1", "--event-type", "custom"]);
  assert.equal(r.tokens_used, 100);
  assert.equal(r.usd_estimate, 1);
  assert.equal(r.agents_dispatched, 0);
});
