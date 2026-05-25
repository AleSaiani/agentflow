/**
 * State manager for /iterate.
 *
 * Unbounded loop primitive. Each iteration runs a `stage` (a bash command) and then
 * evaluates a `stop` predicate (also a bash command). The loop terminates when: the
 * predicate is satisfied, OR `max_iterations` is reached, OR the stage output converges
 * (same hash as previous iter), OR the stage fails, OR a kill file appears.
 *
 * The `stop` predicate is the canonical deterministic-condition idiom reused by the
 * workflow layer's `stage.when` guard (exit 0 = satisfied in `until` mode; inverted in
 * `while`). Faithful port of `iterate_state.py`.
 *
 * Env vars exposed to stage/predicate commands: ITER_RUN_ID, ITER_INDEX, ITER_OUTPUT_PATH,
 * ITER_PREV_OUTPUT_PATH.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runBash } from "../shell.js";
import { Primitive, STATUS_ABORTED, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, die, isHelp, printUsage, findWorkspaceRoot, loadState, makeBaseState, markDone, markFailed, markInProgress, now, print, saveAtomic, stateDir, statePath, } from "../common.js";
const CMD = "iterate";
const PREVIEW_CHARS = 500;
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
function killPath(runId) {
    return join(stateDir(CMD), runId, "kill");
}
function iterDir(runId) {
    return join(stateDir(CMD), runId);
}
/** Accept a step as a plain bash command string OR a JSON object `{type, command, mode?}`. */
function coerceStep(raw) {
    const t = raw.trim();
    if (t.startsWith("{")) {
        try {
            const obj = JSON.parse(t);
            if (obj && typeof obj === "object" && !Array.isArray(obj))
                return obj;
        }
        catch {
            /* not JSON — fall through to the plain-string form */
        }
    }
    return { type: "bash", command: raw };
}
function cmdInit(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            stage: { type: "string" },
            stop: { type: "string" },
            mode: { type: "string", default: "until" },
            times: { type: "string" },
            "check-first": { type: "boolean", default: false },
            "max-iterations": { type: "string", default: "10" },
            "convergence-check": { type: "boolean" },
            "no-convergence-check": { type: "boolean" },
            model: { type: "string", default: "sonnet" },
            "auto-continue": { type: "boolean" },
            "no-auto-continue": { type: "boolean" },
            "max-auto-continues": { type: "string", default: "15" },
            "subagent-type": { type: "string", default: "general-purpose" },
            force: { type: "boolean", default: false },
            "validate-only": { type: "boolean", default: false },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: init requires a run_id");
    if (!values["stage"])
        die("error: init requires --stage");
    const times = values["times"] !== undefined ? parseInt(values["times"], 10) : null;
    // --stage / --stop accept a plain bash command string OR a JSON object. A string --stop takes
    // its mode from --mode (default "until"); a JSON --stop carries its own.
    const stage = coerceStep(values["stage"]);
    const mode = values["mode"];
    if (!["until", "while"].includes(mode))
        die("error: --mode must be 'until' or 'while'");
    let stop;
    if (values["stop"]) {
        stop = coerceStep(values["stop"]);
        if (!stop["mode"])
            stop["mode"] = mode;
    }
    else if (times !== null) {
        // a fixed-count repeat uses a never-satisfied predicate so it terminates only at max_iterations
        stop = { type: "bash", command: "false", mode: "until" };
    }
    else {
        die("error: init requires --stop (or --times for a fixed-count repeat)");
    }
    if (stage.type !== "bash")
        die("error: v1 only supports stage type 'bash'");
    if (!("command" in stage))
        die("error: stage must include 'command'");
    if (stop.type !== "bash")
        die("error: v1 only supports stop type 'bash'");
    if (!("command" in stop))
        die("error: stop must include 'command'");
    if (!["until", "while"].includes(stop["mode"]))
        die("error: stop.mode must be 'until' or 'while'");
    const maxIterations = times !== null ? times : parseInt(values["max-iterations"], 10);
    const checkFirst = Boolean(values["check-first"]);
    if (values["validate-only"]) {
        print({ valid: true, max_iterations: maxIterations, check_first: checkFirst });
        return;
    }
    const autoContinue = values["no-auto-continue"] ? false : true;
    // Fixed-count repeats default convergence off (run exactly N times, don't stop early).
    const convergenceCheck = values["no-convergence-check"] ? false : times === null;
    const state = makeBaseState(CMD, runId, {
        max_iterations: maxIterations,
        convergence_check: convergenceCheck,
        check_first: checkFirst,
        model: values["model"],
        auto_continue: autoContinue,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
        subagent_type: values["subagent-type"],
    }, { stage, stop, iterations: [], iteration_count: 0, stop_reason: null });
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    saveAtomic(p, state);
    print({ run_id: runId, max_iterations: maxIterations, path: p });
}
/** Execute exactly ONE iteration. Prints {"action":"continue"|"stop", ...}. */
function cmdRunIteration(args) {
    const runId = requireRunId(args, "run-iteration");
    const state = load(runId);
    if ([STATUS_DONE, STATUS_FAILED, STATUS_ABORTED].includes(state["status"])) {
        print({ action: "stop", reason: `already_${state["status"]}`, iter: state["iteration_count"] });
        return;
    }
    if (state["status"] === STATUS_PENDING)
        markInProgress(state);
    const iterIndex = state["iteration_count"];
    mkdirSync(iterDir(runId), { recursive: true });
    if (existsSync(killPath(runId))) {
        state["stop_reason"] = "killed";
        state["status"] = STATUS_ABORTED;
        state["completed_at"] = now();
        save(runId, state);
        print({ action: "stop", reason: "killed", iter: iterIndex });
        return;
    }
    const maxIter = state["config"]["max_iterations"];
    if (iterIndex >= maxIter) {
        state["stop_reason"] = "max_iterations";
        markDone(state, state["result_pointer"] ?? null);
        save(runId, state);
        print({ action: "stop", reason: "max_iterations", iter: iterIndex });
        return;
    }
    const outPath = join(iterDir(runId), `iter-${iterIndex}.out`);
    const errPath = join(iterDir(runId), `iter-${iterIndex}.err`);
    let prevOut = "";
    if (iterIndex > 0)
        prevOut = state["iterations"].at(-1)?.["stage_output_path"] ?? "";
    const env = {
        ...process.env,
        ITER_RUN_ID: runId,
        ITER_INDEX: String(iterIndex),
        ITER_OUTPUT_PATH: outPath,
        ITER_PREV_OUTPUT_PATH: prevOut,
    };
    const cwd = findWorkspaceRoot();
    // while-do ordering: when check_first, evaluate the predicate BEFORE running the stage; a
    // satisfied predicate terminates the loop without executing the body this iteration.
    if (state["config"]["check_first"]) {
        let pre;
        try {
            pre = runBash(state["stop"]["command"], cwd, env);
        }
        catch (e) {
            markFailed(state, `predicate spawn error (check-first) at iter ${iterIndex}: ${String(e)}`);
            save(runId, state);
            print({ action: "stop", reason: "predicate_spawn_error", iter: iterIndex });
            return;
        }
        const stopNow = state["stop"]["mode"] === "until" ? pre.status === 0 : pre.status !== 0;
        if (stopNow) {
            state["stop_reason"] = "predicate_satisfied";
            markDone(state, state["result_pointer"] ?? null);
            save(runId, state);
            print({ action: "stop", reason: "predicate_satisfied", iter: iterIndex, checked: "before" });
            return;
        }
    }
    const started = now();
    let proc;
    try {
        proc = runBash(state["stage"]["command"], cwd, env);
    }
    catch (e) {
        state["iterations"].push({
            index: iterIndex, started_at: started, completed_at: now(),
            status: STATUS_FAILED, exit_code: -1,
            stage_output_path: null, stage_output_size: 0, stage_output_preview: "",
            convergence_hash: null, predicate_exit: null, predicate_value: null,
            error: `stage spawn error: ${String(e)}`,
        });
        state["iteration_count"] += 1;
        markFailed(state, `stage spawn error at iter ${iterIndex}: ${String(e)}`);
        save(runId, state);
        print({ action: "stop", reason: "stage_spawn_error", iter: iterIndex });
        return;
    }
    writeFileSync(outPath, proc.stdout, "utf8");
    writeFileSync(errPath, proc.stderr, "utf8");
    const completed = now();
    const outputHash = createHash("sha256").update(proc.stdout, "utf8").digest("hex").slice(0, 16);
    const iterRecord = {
        index: iterIndex,
        started_at: started,
        completed_at: completed,
        status: proc.status === 0 ? STATUS_DONE : STATUS_FAILED,
        exit_code: proc.status,
        stage_output_path: outPath,
        stage_output_size: proc.stdout.length,
        stage_output_preview: proc.stdout.slice(0, PREVIEW_CHARS),
        convergence_hash: outputHash,
        predicate_exit: null,
        predicate_value: null,
        error: proc.status !== 0 ? proc.stderr.slice(0, PREVIEW_CHARS) : null,
    };
    if (proc.status !== 0) {
        state["iterations"].push(iterRecord);
        state["iteration_count"] += 1;
        state["stop_reason"] = "stage_failed";
        markFailed(state, `stage failed at iter ${iterIndex} (exit=${proc.status})`);
        save(runId, state);
        print({ action: "stop", reason: "stage_failed", iter: iterIndex, exit_code: proc.status });
        return;
    }
    // Evaluate the post-stage predicate FIRST (check-last / do-until / do-while). The predicate is
    // AUTHORITATIVE; convergence is only a fallback for when the predicate says "keep going" but the
    // output has stopped changing. (In check-first mode the predicate already ran before the stage.)
    let shouldStop = false;
    if (!state["config"]["check_first"]) {
        let predProc;
        try {
            predProc = runBash(state["stop"]["command"], cwd, env);
        }
        catch (e) {
            iterRecord["error"] = `predicate spawn error: ${String(e)}`;
            state["iterations"].push(iterRecord);
            state["iteration_count"] += 1;
            markFailed(state, `predicate spawn error at iter ${iterIndex}: ${String(e)}`);
            save(runId, state);
            print({ action: "stop", reason: "predicate_spawn_error", iter: iterIndex });
            return;
        }
        iterRecord["predicate_exit"] = predProc.status;
        // `until`: exit 0 = satisfied = stop. `while`: exit 0 = still true = continue.
        shouldStop = state["stop"]["mode"] === "until" ? predProc.status === 0 : predProc.status !== 0;
        iterRecord["predicate_value"] = shouldStop;
    }
    // Capture the previous iteration's hash BEFORE pushing this one (convergence fallback).
    const prevHash = state["iterations"].at(-1)?.["convergence_hash"];
    state["iterations"].push(iterRecord);
    state["iteration_count"] += 1;
    state["result_pointer"] = outPath;
    if (shouldStop) {
        state["stop_reason"] = "predicate_satisfied";
        markDone(state, outPath);
        save(runId, state);
        print({ action: "stop", reason: "predicate_satisfied", iter: iterIndex });
        return;
    }
    // Convergence fallback: only after the predicate declined to stop.
    if (state["config"]["convergence_check"] && iterIndex > 0 && prevHash === outputHash) {
        state["stop_reason"] = "convergence";
        markDone(state, outPath);
        save(runId, state);
        print({ action: "stop", reason: "convergence", iter: iterIndex });
        return;
    }
    save(runId, state);
    print({
        action: "continue",
        iter: iterIndex,
        next_iter: iterIndex + 1,
        iterations_remaining: maxIter - state["iteration_count"],
    });
}
function cmdKill(args) {
    const runId = requireRunId(args, "kill");
    const p = killPath(runId);
    mkdirSync(join(stateDir(CMD), runId), { recursive: true });
    writeFileSync(p, now(), "utf8");
    print({ run_id: runId, killed: true, path: p });
}
function cmdFail(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { error: { type: "string", default: "" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: fail requires a run_id");
    const state = load(runId);
    markFailed(state, values["error"]);
    save(runId, state);
    print({ run_id: runId, status: STATUS_FAILED, error: values["error"] });
}
function cmdStatus(args) {
    const runId = requireRunId(args, "status");
    const state = load(runId);
    const last = state["iterations"].length ? state["iterations"].at(-1) : null;
    const b = state["budget"] ?? {};
    print({
        run_id: runId,
        cmd: CMD,
        status: state["status"],
        iteration_count: state["iteration_count"],
        max_iterations: state["config"]["max_iterations"],
        stop_reason: state["stop_reason"] ?? null,
        result_pointer: state["result_pointer"] ?? null,
        error: state["error"] ?? null,
        last_iter_summary: last
            ? {
                index: last["index"],
                exit_code: last["exit_code"],
                predicate_exit: last["predicate_exit"],
                convergence_hash: last["convergence_hash"],
            }
            : null,
        budget: {
            tokens_used: b["tokens_used"] ?? 0,
            agents_dispatched: b["agents_dispatched"] ?? 0,
            usd_estimate: Math.round((b["usd_estimate"] ?? 0) * 1e4) / 1e4,
        },
    });
}
function cmdBudgetAdd(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
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
function requireRunId(args, sub) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die(`error: ${sub} requires a run_id`);
    return runId;
}
// ---------- primitive registration ----------
function isDone(state) {
    return state["status"] === STATUS_DONE || state["status"] === STATUS_ABORTED;
}
function hasResidualWork(state) {
    const status = state["status"];
    if (status === STATUS_PENDING || status === STATUS_IN_PROGRESS)
        return [status, state["iteration_count"] ?? 0];
    return null;
}
function resumeMsg(runId, residual) {
    const [status, iterCount] = residual;
    return (`/iterate run '${runId}' is not complete (status=${status}, iterations so far=${iterCount}). ` +
        `Run the next iteration via the iterate \`run-iteration ${runId}\` subcommand and inspect the JSON output: ` +
        `if action=continue, stop the turn (the Stop hook will fire again); if action=stop, surface the final report. Do NOT re-init.`);
}
const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg });
function main(argv) {
    const [sub, ...rest] = argv;
    if (isHelp(sub))
        return printUsage(CMD, ["init", "run-iteration", "kill", "fail", "status", "runs", "increment-continues", "budget-add"]);
    switch (sub) {
        case "init":
            return cmdInit(rest);
        case "run-iteration":
            return cmdRunIteration(rest);
        case "kill":
            return cmdKill(rest);
        case "fail":
            return cmdFail(rest);
        case "status":
            return cmdStatus(rest);
        case "runs":
            return PRIM.cliRuns();
        case "increment-continues":
            return PRIM.cliIncrementContinues(requireRunId(rest, "increment-continues"));
        case "budget-add":
            return cmdBudgetAdd(rest);
        default:
            die(`error: unknown subcommand '${sub ?? ""}'`);
    }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2));
}
export { PRIM };
