/**
 * State manager for /step — run ONE prompt once and capture its structured output. The missing unit
 * between `reduce` (one agent over N inputs) and `foreach` (one agent per item): a single LLM/work
 * step. It's the keystone for "a workflow step is an arbitrary agent/skill/model".
 *
 * `--runtime` chooses who runs it:
 *   - `main`     — the orchestrator does it inline (this CLI only tracks state: start → complete).
 *   - `subagent` — the orchestrator dispatches one Agent (start → complete).
 *   - `claude-cli` — the ENGINE runs it sessionlessly: `claude -p <prompt> --output-format json`.
 *   - `codex-cli`  — the ENGINE runs it sessionlessly: `codex exec <prompt> --json`.
 * For the two CLI runtimes, `step run <id>` spawns the binary, captures stdout, extracts the result,
 * and marks the run done/failed — no orchestrator agent needed (like a bash stage, but an LLM).
 *
 * Binaries are overridable for testing/portability via $STEP_CLAUDE_BIN / $STEP_CODEX_BIN. Inspired by
 * the sessionless CLI providers in a local workspace (claude-cli-stream / codex-cli-stream); validate the
 * exact flags against your installed `claude`/`codex` before relying on the CLI runtimes in production.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  Primitive,
  type ResidualWork,
  type StateDict,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_IN_PROGRESS,
  STATUS_PENDING,
  die, isHelp, printUsage,
  loadState,
  makeBaseState,
  markDone,
  markFailed,
  markInProgress,
  now,
  print,
  saveAtomic,
  statePath,
} from "../common.js";

const CMD = "step";
const RUNTIMES = ["main", "subagent", "claude-cli", "codex-cli"];

function pathFor(runId: string): string {
  return statePath(CMD, runId);
}
function load(runId: string): StateDict {
  return loadState(pathFor(runId));
}
function save(runId: string, state: StateDict): void {
  state["updated_at"] = now();
  saveAtomic(pathFor(runId), state);
}

function cmdInit(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      runtime: { type: "string", default: "subagent" },
      model: { type: "string", default: "inherit" },
      "subagent-type": { type: "string", default: "general-purpose" },
      input: { type: "string" },
      "auto-continue": { type: "boolean" },
      "no-auto-continue": { type: "boolean" },
      "max-auto-continues": { type: "string", default: "5" },
      force: { type: "boolean", default: false },
      "validate-only": { type: "boolean", default: false },
    },
  });
  const runId = positionals[0];
  if (!runId) die("error: init requires a run_id");
  const runtime = values["runtime"] as string;
  if (!RUNTIMES.includes(runtime)) die(`error: --runtime must be one of ${RUNTIMES.join(",")}, got '${runtime}'`);

  const promptFile = values["prompt-file"] as string | undefined;
  if (promptFile && values["prompt"] !== undefined) die("error: --prompt and --prompt-file are mutually exclusive");
  let prompt = (values["prompt"] as string) ?? "";
  if (promptFile) {
    if (!existsSync(promptFile)) die(`error: --prompt-file not found at ${promptFile}`);
    prompt = readFileSync(promptFile, "utf8").trim();
  }
  if (values["validate-only"]) return print({ valid: true, runtime });
  if (!prompt) die("error: --prompt or --prompt-file is required");

  const p = pathFor(runId);
  if (existsSync(p) && !values["force"]) die(`error: state already exists at ${p}; use --force to overwrite`);
  const state = makeBaseState(
    CMD,
    runId,
    {
      runtime,
      model: values["model"],
      subagent_type: values["subagent-type"],
      input: (values["input"] as string) ?? null,
      auto_continue: values["no-auto-continue"] ? false : true,
      max_auto_continues: parseInt(values["max-auto-continues"] as string, 10),
    },
    { prompt, output: null },
  );
  save(runId, state);
  print({ run_id: runId, runtime, engine_runnable: runtime.endsWith("-cli"), path: p });
}

/** Build the sessionless CLI argv for a `claude-cli` / `codex-cli` runtime. */
function buildArgv(runtime: string, prompt: string, model: string): [string, string[]] {
  if (runtime === "claude-cli") {
    const bin = process.env["STEP_CLAUDE_BIN"] || "claude";
    const args = ["-p", prompt, "--output-format", "json"];
    if (model && model !== "inherit") args.push("--model", model);
    return [bin, args];
  }
  const bin = process.env["STEP_CODEX_BIN"] || "codex"; // codex-cli
  const args = ["exec", prompt, "--json"];
  if (model && model !== "inherit") args.push("--model", model);
  return [bin, args];
}

/** Extract a result string from a CLI's stdout: Claude `--output-format json` → .result; codex jsonl
 *  → the last event's text; otherwise the raw stdout. */
function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && typeof (obj as Record<string, unknown>)["result"] === "string")
      return (obj as Record<string, unknown>)["result"] as string;
  } catch {
    /* not a single JSON object — maybe jsonl */
  }
  let last = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const msg = (e["message"] as Record<string, unknown>) ?? {};
      const content = msg["content"] ?? e["content"] ?? e["text"];
      if (typeof content === "string") last = content;
      else if (Array.isArray(content)) {
        const t = content.map((b) => (typeof b === "string" ? b : ((b as Record<string, unknown>)?.["text"] as string) ?? "")).filter(Boolean).join("\n");
        if (t) last = t;
      }
    } catch {
      /* non-JSON line */
    }
  }
  return last || trimmed;
}

/** Engine-driven execution for the CLI runtimes: spawn the binary, capture + extract, mark terminal. */
function cmdRun(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die("error: run requires a run_id");
  const state = load(runId);
  const cfg = state["config"] as StateDict;
  const runtime = String(cfg["runtime"]);
  if (!runtime.endsWith("-cli"))
    die(`error: runtime '${runtime}' is orchestrator-driven; use start + complete, not run`);
  if (state["status"] === STATUS_DONE) return print({ run_id: runId, status: STATUS_DONE, already: true });

  let prompt = String(state["prompt"] ?? "");
  const input = cfg["input"] as string | null;
  if (input && existsSync(input)) prompt += `\n\n<input>\n${readFileSync(input, "utf8")}\n</input>`;

  markInProgress(state);
  save(runId, state);

  const [bin, argv] = buildArgv(runtime, prompt, String(cfg["model"] ?? "inherit"));
  const r = spawnSync(bin, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const err = (r.error?.message || r.stderr || `${bin} exited ${r.status}`).slice(0, 500);
    markFailed(state, err);
    save(runId, state);
    return print({ run_id: runId, status: STATUS_FAILED, error: err });
  }
  const result = extractResult(r.stdout ?? "");
  const outPath = join(dirname(pathFor(runId)), "output.txt");
  writeFileSync(outPath, result, "utf8");
  state["output"] = result;
  markDone(state, outPath);
  save(runId, state);
  print({ run_id: runId, status: STATUS_DONE, runtime, output_pointer: outPath, bytes: result.length });
}

/** Orchestrator path (main/subagent): mark the step in-progress. */
function cmdStart(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die("error: start requires a run_id");
  const state = load(runId);
  markInProgress(state);
  save(runId, state);
  print({ run_id: runId, status: STATUS_IN_PROGRESS, prompt: state["prompt"], config: state["config"] });
}

/** Orchestrator path: record the step's result (inline text or a file the agent wrote). */
function cmdComplete(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { output: { type: "string" }, "output-path": { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) die("error: complete requires a run_id");
  const state = load(runId);
  const outputPath = values["output-path"] as string | undefined;
  let result: string;
  let pointer: string;
  if (outputPath) {
    if (!existsSync(outputPath)) die(`error: --output-path ${outputPath} does not exist`);
    result = readFileSync(outputPath, "utf8");
    pointer = outputPath;
  } else {
    result = (values["output"] as string) ?? "";
    pointer = join(dirname(pathFor(runId)), "output.txt");
    writeFileSync(pointer, result, "utf8");
  }
  state["output"] = result;
  markDone(state, pointer);
  save(runId, state);
  print({ run_id: runId, status: STATUS_DONE, output_pointer: pointer, bytes: result.length });
}

function cmdFail(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { error: { type: "string", default: "" } } });
  const runId = positionals[0];
  if (!runId) die("error: fail requires a run_id");
  const state = load(runId);
  markFailed(state, values["error"] as string);
  save(runId, state);
  print({ run_id: runId, status: STATUS_FAILED, error: values["error"] });
}

function cmdStatus(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die("error: status requires a run_id");
  const state = load(runId);
  print({
    run_id: runId,
    run_status: state["status"],
    runtime: (state["config"] as StateDict)["runtime"],
    output_pointer: state["result_pointer"] ?? null,
    config: state["config"],
  });
}

// ---------- primitive registration ----------

function isDone(state: StateDict): boolean {
  return state["status"] === STATUS_DONE || state["status"] === STATUS_FAILED;
}
function hasResidualWork(state: StateDict): ResidualWork | null {
  if (state["status"] === STATUS_DONE || state["status"] === STATUS_FAILED) return null;
  return [state["status"] === STATUS_IN_PROGRESS ? 0 : 1, state["status"] === STATUS_IN_PROGRESS ? 1 : 0];
}
function resumeMsg(runId: string, _work: ResidualWork): string {
  return (
    `/agentflow:step run '${runId}' is not complete. If runtime is claude-cli/codex-cli, run ` +
    `\`step run ${runId}\` (the engine executes it). Otherwise dispatch the prompt (subagent) or do it ` +
    `inline (main), then \`step complete ${runId} (--output "<text>" | --output-path <file>)\`.`
  );
}

const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg, resultPointer: (s) => (s["result_pointer"] ?? null) as string | null });

function main(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (isHelp(sub)) return printUsage(CMD, ["init", "run", "start", "complete", "fail", "status", "runs", "budget-add", "increment-continues"]);
  switch (sub) {
    case "init":
      return cmdInit(rest);
    case "run":
      return cmdRun(rest);
    case "start":
      return cmdStart(rest);
    case "complete":
      return cmdComplete(rest);
    case "fail":
      return cmdFail(rest);
    case "status":
      return cmdStatus(rest);
    case "runs":
      return PRIM.cliRuns();
    case "budget-add":
      return PRIM.cliBudgetAdd(rest[0] ?? "", {});
    case "increment-continues":
      return PRIM.cliIncrementContinues(rest[0] ?? "");
    default:
      die(`error: unknown subcommand '${sub ?? ""}'`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}

export { PRIM, buildArgv, extractResult };
