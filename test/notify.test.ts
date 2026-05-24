import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const NOTIFY = resolve("dist/notify.js");

function run(args: string[]): any {
  const out = execFileSync("node", [NOTIFY, ...args], { encoding: "utf8" });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null");
}

test("notify: returns structured output and never throws (no channels configured)", () => {
  const r = run(["--message", "hello", "--no-desktop"]);
  assert.equal(r.message, "hello");
  assert.equal(r.title, "Agent Flow");
  assert.deepEqual(r.sent, []); // no webhook, desktop suppressed → nothing sent, but no throw
});

test("notify: an unreachable webhook fails gracefully (sent stays empty)", () => {
  const r = run(["--message", "x", "--webhook", "http://127.0.0.1:9/none", "--no-desktop"]);
  assert.ok(Array.isArray(r.sent));
  assert.ok(!r.sent.includes("webhook"));
});
