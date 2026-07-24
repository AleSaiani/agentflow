import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { buildArgv, extractResult } from "../dist/state/step.js";

const CLI = resolve("dist/state/step.js");

function run(stateDir: string, args: string[], extraEnv: Record<string, string> = {}): any {
  const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, STEP_STATE_DIR: stateDir, ...extraEnv } });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null");
}

test("step: orchestrator runtime (main) — start → complete records output", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-"));
  const init = run(dir, ["init", "m", "--prompt", "summarize X", "--runtime", "main"]);
  assert.equal(init.runtime, "main");
  assert.equal(init.engine_runnable, false);
  run(dir, ["start", "m"]);
  const done = run(dir, ["complete", "m", "--output", "X is a tool."]);
  assert.equal(done.status, "done");
  assert.equal(run(dir, ["status", "m"]).run_status, "done");

  // `run` is only for the CLI runtimes
  assert.throws(() => run(dir, ["run", "m"]));
});

test("step: a CLI runtime with a missing binary fails gracefully (no crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-"));
  run(dir, ["init", "c", "--prompt", "hello", "--runtime", "claude-cli"]);
  const r = run(dir, ["run", "c"], { STEP_CLAUDE_BIN: "agentflow-no-such-binary-xyz" });
  assert.equal(r.status, "failed"); // spawn error → failed, not an exception
  assert.equal(run(dir, ["status", "c"]).run_status, "failed");
});

test("step: buildArgv shapes the sessionless CLI command per runtime", () => {
  const [cbin, cargs, cstdin] = buildArgv("claude-cli", "do it", "opus");
  assert.match(cbin, /claude/);
  assert.deepEqual(cargs, ["-p", "--output-format", "json", "--model", "opus"]);
  assert.equal(cstdin, "do it");
  const [xbin, xargs, xstdin] = buildArgv("codex-cli", "do it", "inherit");
  assert.match(xbin, /codex/);
  assert.deepEqual(xargs, ["exec", "--json", "--skip-git-repo-check"]); // inherit → no --model
  // codex takes the prompt on stdin: it blocks waiting for stdin anyway, and keeping the prompt out of
  // argv is what makes the `shell: true` fallback for Windows' .cmd shim safe.
  assert.equal(xstdin, "do it");
  // Both runtimes send the prompt on stdin: argv has an OS length limit (~32 KB on Windows) and a
  // real step prompt carries its <input> — a ~100 KB privacy notice died with ENAMETOOLONG.
  assert.equal(buildArgv("claude-cli", "do it", "inherit")[2], "do it");
});

test("step: extractResult parses claude json (.result), codex jsonl, and raw fallback", () => {
  assert.equal(extractResult('{"type":"result","result":"hi there"}'), "hi there");
  const jsonl = [
    JSON.stringify({ type: "item", message: { content: [{ type: "text", text: "first" }] } }),
    JSON.stringify({ type: "item", message: { content: [{ type: "text", text: "final answer" }] } }),
  ].join("\n");
  assert.equal(extractResult(jsonl), "final answer");
  assert.equal(extractResult("just plain text"), "just plain text");
});

test("step: extractResult handles the REAL `codex exec --json` event stream", () => {
  // Captured verbatim from codex-cli 0.144.6 on 2026-07-24. The previous test above asserted an
  // invented shape, which is why this never failed while the real thing returned the whole blob.
  const real = [
    '{"type":"thread.started","thread_id":"019f9434-b440-7d30-a2ba-8995824f6635"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":17007,"output_tokens":6}}',
  ].join("\n");
  assert.equal(extractResult(real), "PONG");
});

test("step: --validate-only short-circuits before reading a (still-templated) prompt-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-"));
  // Regression: pipe's preflight (validatePrimitiveStage) calls `step init --validate-only` with
  // dummy-resolved templates, so a `{{workflow.dir}}`-based prompt-file path does not exist yet.
  // Validation must be shape-only and NOT touch the filesystem — it must return {valid:true}, not die.
  const r = run(dir, ["init", "v", "--prompt-file", join(dir, "__unresolved__/assess-prompt.md"), "--validate-only"]);
  assert.equal(r.valid, true);
  assert.equal(r.runtime, "subagent");
  // Sanity: without --validate-only, a real init still fails loudly on a missing prompt-file.
  assert.throws(() => run(dir, ["init", "v2", "--prompt-file", join(dir, "nope.md")]));
});
