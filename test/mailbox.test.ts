import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = resolve("dist/mailbox.js");

function run(stateDir: string, args: string[]): any {
  const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, MAILBOX_STATE_DIR: stateDir } });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null");
}

test("mailbox: send → recv is directed, atomic, and FIFO; empties cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbox-"));
  run(dir, ["send", "conv", "--to", "bob", "--from", "alice", "--message", "first"]);
  run(dir, ["send", "conv", "--to", "bob", "--json", '{"round":2}']);
  run(dir, ["send", "conv", "--to", "alice", "--message", "for alice only"]);

  assert.equal(run(dir, ["peek", "conv", "--box", "bob"]).length, 2);

  const m1 = run(dir, ["recv", "conv", "--box", "bob"]);
  assert.equal(m1.message.body, "first"); // FIFO
  assert.equal(m1.message.from, "alice");
  const m2 = run(dir, ["recv", "conv", "--box", "bob"]);
  assert.deepEqual(m2.message.body, { round: 2 });
  assert.equal(run(dir, ["recv", "conv", "--box", "bob"]).message, null); // drained

  // the other box is independent (directed)
  assert.equal(run(dir, ["recv", "conv", "--box", "alice"]).message.body, "for alice only");

  const st = run(dir, ["status", "conv"]);
  assert.equal(st.boxes.bob.pending, 0);
  assert.equal(st.boxes.bob.read, 2);
});
