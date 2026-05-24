import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const PIPE = resolve("dist/state/pipe.js");

function run(env: Record<string, string>, args: string[]): any {
  const out = execFileSync("node", [PIPE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

test("pipe: workflow-file Source + stage.when guard skips a stage; drive runs to done", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(dir, "workflow.json");
  writeFileSync(
    wf,
    JSON.stringify({
      name: "demo",
      description: "guard demo",
      stages: [
        { name: "a", type: "bash", spec: { command: 'echo hello > "$PIPE_OUTPUT_PATH"' } },
        // guard exits non-zero → this stage is skipped
        { name: "gate", type: "bash", when: { type: "bash", command: "false" }, spec: { command: 'echo NOPE > "$PIPE_OUTPUT_PATH"' } },
        // guard exits zero → this stage runs
        { name: "c", type: "bash", when: { type: "bash", command: "true" }, spec: { command: 'echo world > "$PIPE_OUTPUT_PATH"' } },
      ],
    }),
    "utf8",
  );

  const init = run(env, ["init", "p1", "--workflow", wf]);
  assert.equal(init.stages, 3);

  const driven = run(env, ["drive", "p1", "--max-steps", "50"]);
  assert.equal(driven.action, "done");

  const status = run(env, ["status", "p1"]);
  const byName: Record<string, any> = {};
  for (const s of status.stages) byName[s.name] = s;
  assert.equal(byName["a"].status, "done");
  assert.equal(byName["gate"].status, "skipped"); // when:false → skipped
  assert.equal(byName["c"].status, "done"); // when:true → ran
  assert.equal(status.status, "done");

  // the skipped stage never wrote its output; the others did
  assert.ok(existsSync(byName["a"].result_pointer));
  assert.match(readFileSync(byName["c"].result_pointer, "utf8"), /world/);
});

test("pipe: template wiring resolves {{run.id}} and {{stages.x.result_pointer}}", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(dir, "wf.json");
  writeFileSync(
    wf,
    JSON.stringify({
      stages: [
        { name: "first", type: "bash", spec: { command: 'echo "run=$PIPE_RUN_ID" > "$PIPE_OUTPUT_PATH"' } },
        // reference the first stage's output path via a wiring template
        { name: "second", type: "bash", spec: { command: 'cat {{stages.first.result_pointer|shell}} >> "$PIPE_OUTPUT_PATH"' } },
      ],
    }),
    "utf8",
  );
  run(env, ["init", "p2", "--workflow", wf]);
  const driven = run(env, ["drive", "p2", "--max-steps", "50"]);
  assert.equal(driven.action, "done");
  const status = run(env, ["status", "p2"]);
  const second = status.stages.find((s: any) => s.name === "second");
  assert.match(readFileSync(second.result_pointer, "utf8"), /run=p2/);
});

test("pipe: deterministic group stage is auto-driven without an agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const gdir = mkdtempSync(join(tmpdir(), "pipe-grp-"));
  const env = { PIPE_STATE_DIR: dir, GROUP_STATE_DIR: gdir };
  const srcFile = join(dir, "src.json");
  writeFileSync(srcFile, JSON.stringify({ source: "inline", data: [{ id: "src/a.ts" }, { id: "test/b.ts" }] }), "utf8");
  const stages = join(dir, "stages.json");
  writeFileSync(
    stages,
    JSON.stringify([
      {
        name: "grp",
        type: "primitive",
        spec: { cmd: "group", init_args: ["--method", "path-prefix", "--input-source", srcFile, "--method-config", JSON.stringify({ depth: 1 })] },
      },
    ]),
    "utf8",
  );
  run(env, ["init", "p3", "--stages", stages]);
  const driven = run(env, ["drive", "p3", "--max-steps", "50"]);
  assert.equal(driven.action, "done"); // group is deterministic → fully auto-driven
  const status = run(env, ["status", "p3"]);
  assert.equal(status.stages[0].status, "done");
  assert.equal(status.stages[0].child_cmd, "group");
});

test("pipe: the shipped audit workflow-file validates and inits (dogfood)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const repo = resolve(".");
  const env = { PIPE_STATE_DIR: dir, CLAUDE_PLUGIN_ROOT: repo };
  const init = run(env, ["init", "audit-x", "--workflow", join(repo, "workflows", "audit", "workflow.json")]);
  assert.equal(init.stages, 6);
  const status = run(env, ["status", "audit-x"]);
  assert.deepEqual(
    status.stages.map((s: any) => `${s.name}:${s.type}`),
    ["discover:bash", "review:primitive", "build-group-input:json", "partition:primitive", "build-digest-inputs:json", "digest:primitive"],
  );
});

test("pipe: {{workflow.dir}} resolves to the workflow file's folder (self-contained scripts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const repo = resolve(".");
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(repo, "workflows", "audit", "workflow.json");
  run(env, ["init", "wfdir", "--workflow", wf]);
  const plan = run(env, ["plan", "wfdir"]);
  const discover = plan.plan.find((s: any) => s.name === "discover");
  // {{workflow.dir}} must be resolved to the audit folder's discover.mjs, not left literal
  assert.ok(!discover.command.includes("{{workflow.dir}}"), "workflow.dir should be resolved");
  assert.match(discover.command.replace(/\\/g, "/"), /workflows\/audit\/discover\.mjs/);
});

test("pipe: plan (dry-run) shows the resolved stage plan without executing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const repo = resolve(".");
  run(env, ["init", "p-plan", "--workflow", join(repo, "examples", "workflows", "demo.json")]);
  const plan = run(env, ["plan", "p-plan"]);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.stages, 3);
  assert.equal(plan.plan[0].type, "bash");
  assert.equal(plan.plan[2].cmd, "group");
  // dry-run must not advance or execute anything
  const status = run(env, ["status", "p-plan"]);
  assert.equal(status.stage_index, 0);
  assert.deepEqual(status.stages.map((s: any) => s.status), ["pending", "pending", "pending"]);
});

test("pipe: the README no-LLM demo workflow drives to done (groups src/lib)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const gdir = mkdtempSync(join(tmpdir(), "pipe-grp-"));
  const env = { PIPE_STATE_DIR: dir, GROUP_STATE_DIR: gdir };
  const repo = resolve(".");
  const init = run(env, ["init", "demo", "--workflow", join(repo, "examples", "workflows", "demo.json")]);
  assert.equal(init.stages, 3);
  const driven = run(env, ["drive", "demo", "--max-steps", "50"]);
  assert.equal(driven.action, "done"); // fully deterministic → no agent needed
  const groups = JSON.parse(readFileSync(join(gdir, "demo-s2-group", "groups.json"), "utf8"));
  assert.deepEqual(groups.map((g: any) => `${g.id}:${g.data.size}`).sort(), ["lib:1", "src:2"]);
});

test("pipe: init rejects a primitive stage with a bad flag (preflight validation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const stages = join(dir, "bad.json");
  writeFileSync(stages, JSON.stringify([{ name: "x", type: "primitive", spec: { cmd: "reduce", init_args: ["--output-format", "xml"] } }]), "utf8");
  assert.throws(() => run(env, ["init", "pbad", "--stages", stages]), /stage validation failed|output-format/);
});
