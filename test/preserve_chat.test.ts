import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const HOOK = resolve("dist/hook/preserve_chat.js");

test("preserve_chat: snapshots transcript to .agentflow/chat and renders markdown", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(ws, ".agentflow")); // workspace already uses Agent Flow → snapshotting is wanted
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

test("preserve_chat: never creates .agentflow in a workspace that doesn't use Agent Flow", () => {
  // Regression: the plugin is installed globally, so PreCompact/SessionEnd fire in EVERY project.
  // Without an in-use gate the hook littered unrelated repos with multi-MB transcript copies.
  const ws = mkdtempSync(join(tmpdir(), "ws-unused-"));
  const tp = join(ws, "t.jsonl");
  writeFileSync(tp, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), "utf8");

  execFileSync("node", [HOOK], { input: JSON.stringify({ transcript_path: tp, session_id: "s", cwd: ws }), encoding: "utf8" });

  assert.ok(!existsSync(join(ws, ".agentflow")), ".agentflow must NOT be created where it didn't exist");
});

test("preserve_chat: retention keeps only the N most recent sessions", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-keep-"));
  mkdirSync(join(ws, ".agentflow"));
  const tp = join(ws, "t.jsonl");
  writeFileSync(tp, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), "utf8");
  const chat = join(ws, ".agentflow", "chat");
  const snap = (id: string): void => {
    execFileSync("node", [HOOK], {
      input: JSON.stringify({ transcript_path: tp, session_id: id, cwd: ws }),
      encoding: "utf8",
      env: { ...process.env, AGENTFLOW_CHAT_KEEP: "2" },
    });
  };
  const age = (id: string, secondsAgo: number): void => {
    const t = Date.now() / 1000 - secondsAgo;
    for (const ext of [".jsonl", ".md"]) utimesSync(join(chat, id + ext), t, t);
  };

  snap("s1");
  age("s1", 1000); // make ordering unambiguous regardless of filesystem mtime resolution
  snap("s2");
  age("s2", 500);
  snap("s3"); // third session with keep=2 → the oldest must be pruned

  assert.ok(!existsSync(join(chat, "s1.jsonl")), "oldest session pruned");
  assert.ok(!existsSync(join(chat, "s1.md")), "oldest session's markdown pruned too");
  assert.ok(existsSync(join(chat, "s2.jsonl")), "second-newest kept");
  assert.ok(existsSync(join(chat, "s3.jsonl")), "newest (just written) always kept");
});
