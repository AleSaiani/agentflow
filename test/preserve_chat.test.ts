import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const HOOK = resolve("dist/hook/preserve_chat.js");

test("preserve_chat: snapshots transcript to .agentflow/chat and renders markdown", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const tp = join(ws, "t.jsonl");
  writeFileSync(
    tp,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello there" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi! working on it" }] } }),
    ].join("\n"),
    "utf8",
  );

  execFileSync("node", [HOOK], { input: JSON.stringify({ transcript_path: tp, session_id: "sess-1", cwd: ws }), encoding: "utf8" });

  const jsonl = join(ws, ".agentflow", "chat", "sess-1.jsonl");
  const md = join(ws, ".agentflow", "chat", "sess-1.md");
  assert.ok(existsSync(jsonl), "raw transcript copied");
  assert.ok(existsSync(md), "markdown rendered");
  const text = readFileSync(md, "utf8");
  assert.match(text, /hello there/);
  assert.match(text, /hi! working on it/);
});

test("preserve_chat: no/empty payload is a no-op and exits cleanly", () => {
  // must not throw (exit 0) even with no transcript_path
  execFileSync("node", [HOOK], { input: "{}", encoding: "utf8" });
});
