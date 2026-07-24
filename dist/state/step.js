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
 * Binaries are overridable for testing/portability via $STEP_CLAUDE_BIN / $STEP_CODEX_BIN. Modeled on
 * sessionless CLI provider patterns (a streaming claude-cli / codex-cli); validate the exact flags
 * against your installed `claude`/`codex` before relying on the CLI runtimes in production.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Primitive, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, die, isHelp, printUsage, loadState, makeBaseState, markDone, markFailed, markInProgress, now, print, saveAtomic, statePath, } from "../common.js";
const CMD = "step";
const RUNTIMES = ["main", "subagent", "claude-cli", "codex-cli"];
function pathFor(runId) {
    return statePath(CMD, runId);
}
function load(runId) {
    return loadState(pathFor(runId));
}
function save(runId, state) {
    state["updated_at"] = now();
    saveAtomic(pathFor(runId), state);
}
function cmdInit(args) {
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
    if (!runId)
        die("error: init requires a run_id");
    const runtime = values["runtime"];
    if (!RUNTIMES.includes(runtime))
        die(`error: --runtime must be one of ${RUNTIMES.join(",")}, got '${runtime}'`);
    const promptFile = values["prompt-file"];
    if (promptFile && values["prompt"] !== undefined)
        die("error: --prompt and --prompt-file are mutually exclusive");
    // Shape-only preflight: the prompt-file path may still be a dummy-resolved {{template}} at validate
    // time (validatePrimitiveStage passes dummy-resolved init_args), so short-circuit BEFORE touching the
    // filesystem — mirrors pipe's --validate-only. Real path resolution happens at dispatch (pipe tick).
    if (values["validate-only"])
        return print({ valid: true, runtime });
    let prompt = values["prompt"] ?? "";
    if (promptFile) {
        if (!existsSync(promptFile))
            die(`error: --prompt-file not found at ${promptFile}`);
        prompt = readFileSync(promptFile, "utf8").trim();
    }
    if (!prompt)
        die("error: --prompt or --prompt-file is required");
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    const state = makeBaseState(CMD, runId, {
        runtime,
        model: values["model"],
        subagent_type: values["subagent-type"],
        input: values["input"] ?? null,
        auto_continue: values["no-auto-continue"] ? false : true,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
    }, { prompt, output: null });
    save(runId, state);
    print({ run_id: runId, runtime, engine_runnable: runtime.endsWith("-cli"), path: p });
}
/**
 * Build the sessionless CLI invocation for a `claude-cli` / `codex-cli` runtime.
 * Returns `[bin, argv, stdin]` — the prompt always travels on **stdin**, never in argv, for both
 * runtimes. Three reasons, each learned the hard way:
 *   1. argv has an OS length limit (~32 KB on Windows). A workflow step's prompt carries its `<input>`
 *      — a privacy notice is ~100 KB — so an argv prompt dies with ENAMETOOLONG on any real input.
 *   2. it keeps the prompt out of the shell we need for the Windows `.cmd` shim (see spawnCli).
 *   3. `codex exec` blocks waiting on stdin regardless.
 */
function buildArgv(runtime, prompt, model) {
    if (runtime === "claude-cli") {
        const bin = process.env["STEP_CLAUDE_BIN"] || "claude";
        const args = ["-p", "--output-format", "json"];
        if (model && model !== "inherit")
            args.push("--model", model);
        return [bin, args, prompt];
    }
    const bin = process.env["STEP_CODEX_BIN"] || "codex"; // codex-cli
    // `--skip-git-repo-check`: without it codex aborts with "Not inside a trusted directory" whenever the
    // cwd isn't a git repo, so the runtime would silently work only inside repos. A `step` is an
    // explicitly requested, engine-driven invocation, so we opt out of codex's own workspace guard —
    // the caller chose to run it here.
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (model && model !== "inherit")
        args.push("--model", model);
    return [bin, args, prompt];
}
/** Extract a result string from a CLI's stdout: Claude `--output-format json` → .result; codex jsonl
 *  → the last event's text; otherwise the raw stdout. */
function extractResult(stdout) {
    const trimmed = stdout.trim();
    try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && typeof obj["result"] === "string")
            return obj["result"];
    }
    catch {
        /* not a single JSON object — maybe jsonl */
    }
    let last = "";
    for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            const e = JSON.parse(line);
            // codex exec --json: {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
            const item = e["item"];
            if (item && item["type"] === "agent_message" && typeof item["text"] === "string" && item["text"]) {
                last = item["text"];
                continue;
            }
            const msg = e["message"] ?? {};
            const content = msg["content"] ?? e["content"] ?? e["text"];
            if (typeof content === "string")
                last = content;
            else if (Array.isArray(content)) {
                const t = content.map((b) => (typeof b === "string" ? b : b?.["text"] ?? "")).filter(Boolean).join("\n");
                if (t)
                    last = t;
            }
        }
        catch {
            /* non-JSON line */
        }
    }
    return last || trimmed;
}
/**
 * Spawn a CLI, tolerating Windows' npm shims. `codex`/`claude` installed via npm are `<bin>.cmd` on
 * Windows, and Node's spawn does NOT apply PATHEXT — a bare name ENOENTs. We retry with the usual
 * extensions rather than using `shell: true`, which would send the prompt through a shell.
 */
function spawnCli(bin, argv, opts) {
    const win = process.platform === "win32";
    const candidates = win && !/\.(cmd|bat|exe)$/i.test(bin) ? [bin, `${bin}.cmd`, `${bin}.exe`] : [bin];
    // Node refuses to exec a .cmd/.bat without a shell (CVE-2024-27980), so those need `shell: true`.
    // That is only safe because the prompt travels on stdin, never through argv — see buildArgv.
    const optsFor = (c) => /\.(cmd|bat)$/i.test(c) ? { ...opts, shell: true } : opts;
    let r = spawnSync(candidates[0], argv, optsFor(candidates[0]));
    for (let i = 1; i < candidates.length; i++) {
        if (!(r.error && r.error.code === "ENOENT"))
            return r;
        r = spawnSync(candidates[i], argv, optsFor(candidates[i]));
    }
    return r;
}
/** Engine-driven execution for the CLI runtimes: spawn the binary, capture + extract, mark terminal. */
function cmdRun(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die("error: run requires a run_id");
    const state = load(runId);
    const cfg = state["config"];
    const runtime = String(cfg["runtime"]);
    if (!runtime.endsWith("-cli"))
        die(`error: runtime '${runtime}' is orchestrator-driven; use start + complete, not run`);
    if (state["status"] === STATUS_DONE)
        return print({ run_id: runId, status: STATUS_DONE, already: true });
    let prompt = String(state["prompt"] ?? "");
    const input = cfg["input"];
    if (input && existsSync(input))
        prompt += `\n\n<input>\n${readFileSync(input, "utf8")}\n</input>`;
    markInProgress(state);
    save(runId, state);
    const [bin, argv, stdinPrompt] = buildArgv(runtime, prompt, String(cfg["model"] ?? "inherit"));
    // Isolate the child session: it inherits our environment and (plugin installed globally) our hooks,
    // so it must not be able to see — or drive — the very run that spawned it. AGENTFLOW_CHILD makes the
    // Stop hook a no-op there; dropping the *_STATE_DIR overrides keeps it out of our state entirely.
    const childEnv = { ...process.env, AGENTFLOW_CHILD: "1" };
    for (const k of Object.keys(childEnv))
        if (k.endsWith("_STATE_DIR"))
            delete childEnv[k];
    // `input: ""` closes the child's stdin immediately. `codex exec` otherwise prints "Reading additional
    // input from stdin..." and blocks forever even though the prompt came in as an argument.
    const r = spawnCli(bin, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: childEnv, input: stdinPrompt });
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
function cmdStart(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die("error: start requires a run_id");
    const state = load(runId);
    markInProgress(state);
    save(runId, state);
    print({ run_id: runId, status: STATUS_IN_PROGRESS, prompt: state["prompt"], config: state["config"] });
}
/** Orchestrator path: record the step's result (inline text or a file the agent wrote). */
function cmdComplete(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { output: { type: "string" }, "output-path": { type: "string" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: complete requires a run_id");
    const state = load(runId);
    const outputPath = values["output-path"];
    let result;
    let pointer;
    if (outputPath) {
        if (!existsSync(outputPath))
            die(`error: --output-path ${outputPath} does not exist`);
        result = readFileSync(outputPath, "utf8");
        pointer = outputPath;
    }
    else {
        result = values["output"] ?? "";
        pointer = join(dirname(pathFor(runId)), "output.txt");
        writeFileSync(pointer, result, "utf8");
    }
    state["output"] = result;
    markDone(state, pointer);
    save(runId, state);
    print({ run_id: runId, status: STATUS_DONE, output_pointer: pointer, bytes: result.length });
}
function cmdFail(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { error: { type: "string", default: "" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: fail requires a run_id");
    const state = load(runId);
    markFailed(state, values["error"]);
    save(runId, state);
    print({ run_id: runId, status: STATUS_FAILED, error: values["error"] });
}
function cmdStatus(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die("error: status requires a run_id");
    const state = load(runId);
    print({
        run_id: runId,
        run_status: state["status"],
        runtime: state["config"]["runtime"],
        output_pointer: state["result_pointer"] ?? null,
        config: state["config"],
    });
}
// ---------- primitive registration ----------
function isDone(state) {
    return state["status"] === STATUS_DONE || state["status"] === STATUS_FAILED;
}
function hasResidualWork(state) {
    if (state["status"] === STATUS_DONE || state["status"] === STATUS_FAILED)
        return null;
    return [state["status"] === STATUS_IN_PROGRESS ? 0 : 1, state["status"] === STATUS_IN_PROGRESS ? 1 : 0];
}
function resumeMsg(runId, _work) {
    return (`/agentflow:step run '${runId}' is not complete. If runtime is claude-cli/codex-cli, run ` +
        `\`step run ${runId}\` (the engine executes it). Otherwise dispatch the prompt (subagent) or do it ` +
        `inline (main), then \`step complete ${runId} (--output "<text>" | --output-path <file>)\`.`);
}
const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg, resultPointer: (s) => (s["result_pointer"] ?? null) });
function cmdBudgetAdd(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true,
        options: {
            tokens: { type: "string", default: "0" },
            usd: { type: "string" },
            "event-type": { type: "string", default: "agent_dispatch" },
            model: { type: "string" },
            meta: { type: "string" },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: budget-add requires a run_id");
    PRIM.cliBudgetAdd(runId, {
        tokens: parseInt(values["tokens"], 10),
        usd: values["usd"] !== undefined ? parseFloat(values["usd"]) : null,
        eventType: values["event-type"],
        model: values["model"] ?? null,
        metaJson: values["meta"] ?? null,
    });
}
function main(argv) {
    const [sub, ...rest] = argv;
    if (isHelp(sub))
        return printUsage(CMD, ["init", "run", "start", "complete", "fail", "status", "runs", "budget-add", "increment-continues"]);
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
            return cmdBudgetAdd(rest);
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
