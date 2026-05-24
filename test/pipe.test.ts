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
  const init = run(env, ["init", "audit-x", "--workflow", join(repo, "workflows", "audit", "WORKFLOW.md"), "--param", "target=examples/fake-repo"]);
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
  const wf = join(repo, "workflows", "audit", "WORKFLOW.md");
  run(env, ["init", "wfdir", "--workflow", wf, "--param", "target=examples/fake-repo"]);
  const plan = run(env, ["plan", "wfdir"]);
  const discover = plan.plan.find((s: any) => s.name === "discover");
  // {{workflow.dir}} must be resolved to the audit folder's discover.mjs, not left literal
  assert.ok(!discover.command.includes("{{workflow.dir}}"), "workflow.dir should be resolved");
  assert.match(discover.command.replace(/\\/g, "/"), /workflows\/audit\/discover\.mjs/);
});

test("pipe: workflow params — defaults, --param override, required-missing errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const wfDir = mkdtempSync(join(tmpdir(), "wf-"));
  const wf = join(wfDir, "workflow.json");
  writeFileSync(
    wf,
    JSON.stringify({
      name: "p",
      params: { target: { default: "src" }, glob: "**/*", must: { required: true } },
      stages: [{ type: "bash", name: "s", spec: { command: "echo {{params.target}} {{params.glob}} {{params.must}} > $PIPE_OUTPUT_PATH" } }],
    }),
    "utf8",
  );
  const env = { PIPE_STATE_DIR: dir };

  // required 'must' missing → non-zero exit
  assert.throws(() => run(env, ["init", "p1", "--workflow", wf]));

  // defaults + override resolve in the plan
  run(env, ["init", "p2", "--workflow", wf, "--param", "must=hello", "--param", "glob=*.cs"]);
  const cmd = run(env, ["plan", "p2"]).plan[0].command;
  assert.match(cmd, /echo src \*\.cs hello/); // target default, glob overridden, must provided
});

test("pipe: a stage's output_schema gates advancement (fail on mismatch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(dir, "schema.json");
  writeFileSync(
    wf,
    JSON.stringify({
      stages: [
        {
          name: "emit",
          type: "json",
          output_schema: { type: "object", required: ["ok", "n"] },
          spec: { value: { ok: true }, output_path: "{{run.dir}}/o.json" }, // missing 'n'
        },
      ],
    }),
    "utf8",
  );
  run(env, ["init", "sch", "--workflow", wf]);
  const driven = run(env, ["drive", "sch"]);
  assert.equal(driven.action, "failed");
  assert.match(String(driven.error), /output failed schema: \$\.n: required/);
});

test("pipe: conditional `next` branches (fork) route forward and skip the not-taken stage", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const mk = (cond: string) =>
    JSON.stringify({
      stages: [
        { name: "a", type: "bash", next: [{ when: cond, goto: "c" }, { goto: "b" }], spec: { command: 'echo A > "$PIPE_OUTPUT_PATH"' } },
        { name: "b", type: "bash", spec: { command: 'echo B > "$PIPE_OUTPUT_PATH"' } },
        { name: "c", type: "bash", spec: { command: 'echo C > "$PIPE_OUTPUT_PATH"' } },
      ],
    });

  // when=true → jump a→c, b never runs (the not-taken branch)
  const wf1 = join(dir, "t.json");
  writeFileSync(wf1, mk("true"), "utf8");
  run(env, ["init", "ft", "--workflow", wf1]);
  assert.equal(run(env, ["drive", "ft"]).action, "done");
  const s1: Record<string, string> = {};
  for (const s of run(env, ["status", "ft"]).stages) s1[s.name] = s.status;
  assert.deepEqual(s1, { a: "done", b: "pending", c: "done" });

  // when=false → fall through to the default branch (b), then linear to c
  const wf2 = join(dir, "f.json");
  writeFileSync(wf2, mk("false"), "utf8");
  run(env, ["init", "ff", "--workflow", wf2]);
  run(env, ["drive", "ff"]);
  const s2: Record<string, string> = {};
  for (const s of run(env, ["status", "ff"]).stages) s2[s.name] = s.status;
  assert.deepEqual(s2, { a: "done", b: "done", c: "done" });
});

test("pipe: a `step` child stage is a registered primitive (drive→needs_agent, advance resolves)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const sdir = mkdtempSync(join(tmpdir(), "pipe-step-"));
  const env = { PIPE_STATE_DIR: dir, STEP_STATE_DIR: sdir };
  const wf = join(dir, "step.json");
  writeFileSync(wf, JSON.stringify({ stages: [{ name: "ask", type: "primitive", spec: { cmd: "step", init_args: ["--prompt", "hi", "--runtime", "main"] } }] }), "utf8");
  run(env, ["init", "sp", "--workflow", wf]);
  const d = run(env, ["drive", "sp"]);
  assert.equal(d.action, "needs_agent");
  assert.equal(d.cmd, "step");
  // orchestrator does the step, then advance must resolve getPrimitive("step") without error
  const STEP = resolve("dist/state/step.js");
  execFileSync("node", [STEP, "init", d.suggested_child_run_id, "--prompt", "hi", "--runtime", "main", "--force"], { env: { ...process.env, ...env } });
  run(env, ["start-primitive-child", "sp", "--child-cmd", "step", "--child-run-id", d.suggested_child_run_id]);
  execFileSync("node", [STEP, "complete", d.suggested_child_run_id, "--output", "done"], { env: { ...process.env, ...env } });
  const adv = run(env, ["advance", "sp"]);
  assert.equal(adv.pipe_status, "done");
});

test("pipe: shipped release-gate workflow validates + wires retry/approval (dogfood)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const repo = resolve(".");
  const env = { PIPE_STATE_DIR: dir, CLAUDE_PLUGIN_ROOT: repo };
  run(env, ["init", "rg", "--workflow", join(repo, "workflows", "release-gate", "WORKFLOW.md"), "--param", "test_cmd=echo ok"]);
  const st = run(env, ["status", "rg"]);
  assert.deepEqual(st.stages.map((s: any) => `${s.name}:${s.type}`), ["test:bash", "approve:bash", "deploy:bash"]);
  // happy path: test passes → pauses at the approval gate
  assert.equal(run(env, ["drive", "rg"]).action, "needs_approval");
});

test("pipe: a human-approval gate pauses drive until approved", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(dir, "approve.json");
  writeFileSync(
    wf,
    JSON.stringify({
      stages: [
        { name: "build", type: "bash", spec: { command: 'echo built > "$PIPE_OUTPUT_PATH"' } },
        { name: "deploy", type: "bash", approve: true, approve_prompt: "Deploy to prod?", spec: { command: 'echo deployed > "$PIPE_OUTPUT_PATH"' } },
      ],
    }),
    "utf8",
  );
  run(env, ["init", "ap", "--workflow", wf]);
  // drive runs `build`, then stops at the gate
  const paused = run(env, ["drive", "ap"]);
  assert.equal(paused.action, "needs_approval");
  assert.equal(paused.stage, "deploy");
  assert.equal(paused.prompt, "Deploy to prod?");
  // still paused if driven again (no auto-bypass)
  assert.equal(run(env, ["drive", "ap"]).action, "needs_approval");
  // approve → drive completes
  run(env, ["approve", "ap"]);
  assert.equal(run(env, ["drive", "ap"]).action, "done");
});

test("pipe: config.on_failure runs a cleanup/alert command when the pipe fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const flag = join(dir, "failed.txt").replace(/\\/g, "/");
  const wf = join(dir, "of.json");
  writeFileSync(
    wf,
    JSON.stringify({ config: { stop_on_failure: true, on_failure: `echo FAILED:$PIPE_FAIL_REASON > ${flag}` }, stages: [{ name: "boom", type: "bash", spec: { command: "exit 7" } }] }),
    "utf8",
  );
  run(env, ["init", "of", "--workflow", wf]);
  assert.equal(run(env, ["drive", "of"]).action, "failed");
  assert.match(readFileSync(join(dir, "failed.txt"), "utf8"), /FAILED:stage 0 \(bash\) exit 7/);
});

test("pipe: typed params validate + coerce (enum / integer / boolean)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const wf = join(dir, "typed.json");
  writeFileSync(
    wf,
    JSON.stringify({
      params: { env: { enum: ["prod", "staging"], required: true }, retries: { type: "integer", default: 3 }, verbose: { type: "boolean", default: false } },
      stages: [{ name: "s", type: "bash", spec: { command: 'echo {{params.env}} {{params.retries}} {{params.verbose}} > "$PIPE_OUTPUT_PATH"' } }],
    }),
    "utf8",
  );
  // enum / integer / boolean violations all abort init
  assert.throws(() => run(env, ["init", "e1", "--workflow", wf, "--param", "env=dev"]));
  assert.throws(() => run(env, ["init", "e2", "--workflow", wf, "--param", "env=prod", "--param", "retries=abc"]));
  assert.throws(() => run(env, ["init", "e3", "--workflow", wf, "--param", "env=prod", "--param", "verbose=yes"]));
  // valid → coerced and resolved into the plan
  run(env, ["init", "ok", "--workflow", wf, "--param", "env=staging", "--param", "verbose=true"]);
  assert.match(run(env, ["plan", "ok"]).plan[0].command, /echo staging 3 true/);
});

test("pipe: a bash stage retries on failure and a timeout bounds each attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const env = { PIPE_STATE_DIR: dir };
  const counter = join(dir, "n").replace(/\\/g, "/");

  // RETRY: fails while a counter < 3, succeeds on the 3rd attempt → needs retries:2.
  writeFileSync(join(dir, "n"), "0", "utf8");
  const rwf = join(dir, "retry.json");
  writeFileSync(
    rwf,
    JSON.stringify({ stages: [{ name: "flaky", type: "bash", retries: 2, spec: { command: `n=$(cat ${counter}); n=$((n+1)); echo $n > ${counter}; test $n -ge 3` } }] }),
    "utf8",
  );
  run(env, ["init", "rt", "--workflow", rwf]);
  const driven = run(env, ["drive", "rt"]);
  assert.equal(driven.action, "done");
  assert.equal(driven.actions_taken[0].attempts, 3); // 1 + 2 retries

  // TIMEOUT: sleep longer than the timeout → the stage fails (exit 124).
  const twf = join(dir, "to.json");
  writeFileSync(
    twf,
    JSON.stringify({ config: { stop_on_failure: true }, stages: [{ name: "slow", type: "bash", timeout: 1, spec: { command: 'sleep 3; echo done > "$PIPE_OUTPUT_PATH"' } }] }),
    "utf8",
  );
  run(env, ["init", "to", "--workflow", twf]);
  const t = run(env, ["drive", "to"]);
  assert.equal(t.action, "failed");
  assert.equal(t.actions_taken[0].exit_code, 124); // timeout → conventional 124
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
