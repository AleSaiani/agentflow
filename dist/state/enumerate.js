/**
 * State manager for /enumerate — the **unfold** primitive (1 → N).
 *
 * Generates a list of items from a higher-level spec: e.g. expand a book outline into a list
 * of chapters, a feature into a list of tasks, a spec into a checklist. The complement of
 * /reduce (N → 1): a single step that produces an items.json array, which /foreach (map) or
 * /group (partition) then consume. Generation is LLM-driven by default; it can also run in the
 * main thread (no subagent). Single-writer: the orchestrator owns state writes; the generator
 * agent only writes the items file.
 *
 * State schema (extends base): config{ model, subagent_type, execution, output_format,
 * auto_continue, max_auto_continues }, task_prompt (generation instructions), input (optional
 * source material descriptor/path), result_pointer (the produced items.json).
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Primitive, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, die, isHelp, printUsage, loadState, makeBaseState, markDone, markFailed, markInProgress, now, print, saveAtomic, statePath, } from "../common.js";
const CMD = "enumerate";
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
            "task-prompt": { type: "string", default: "" },
            input: { type: "string" },
            model: { type: "string", default: "inherit" },
            execution: { type: "string", default: "subagent" },
            "subagent-type": { type: "string", default: "general-purpose" },
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
    const execution = values["execution"];
    if (!["main-thread", "subagent"].includes(execution))
        die(`error: --execution must be main-thread|subagent, got '${execution}'`);
    if (values["validate-only"]) {
        print({ valid: true, model: values["model"], execution });
        return;
    }
    const taskPrompt = (values["prompt"] ?? values["task-prompt"]) || "";
    if (!taskPrompt)
        die("error: --prompt (the generation instructions) is required");
    const autoContinue = values["no-auto-continue"] ? false : true;
    const state = makeBaseState(CMD, runId, {
        model: values["model"],
        subagent_type: values["subagent-type"],
        execution,
        output_format: "items",
        auto_continue: autoContinue,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
    }, { task_prompt: taskPrompt, input: values["input"] ?? null });
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    saveAtomic(p, state);
    print({ run_id: runId, path: p });
}
function cmdStart(args) {
    const runId = requireRunId(args, "start");
    const state = load(runId);
    if (![STATUS_PENDING, STATUS_FAILED].includes(state["status"]))
        die(`error: cannot start run in status '${state["status"]}'`);
    markInProgress(state);
    save(runId, state);
    print({ run_id: runId, status: STATUS_IN_PROGRESS });
}
/** Record the generated list. The agent/main-thread wrote a JSON array of {id?, data?} items. */
function cmdComplete(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { "items-path": { type: "string" } },
    });
    const runId = positionals[0];
    const itemsPath = values["items-path"];
    if (!runId || !itemsPath)
        die("error: complete requires run_id and --items-path");
    if (!existsSync(itemsPath))
        die(`error: items file does not exist at ${itemsPath}`);
    const parsed = JSON.parse(readFileSync(itemsPath, "utf8"));
    if (!Array.isArray(parsed))
        die("error: the generated items file must be a JSON array");
    const state = load(runId);
    state["items_generated"] = parsed.length;
    markDone(state, itemsPath);
    save(runId, state);
    print({ run_id: runId, status: STATUS_DONE, items: parsed.length, output: itemsPath });
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
    const b = state["budget"] ?? {};
    print({
        run_id: runId,
        cmd: CMD,
        status: state["status"],
        items_generated: state["items_generated"] ?? 0,
        result_pointer: state["result_pointer"] ?? null,
        error: state["error"] ?? null,
        budget: {
            tokens_used: b["tokens_used"] ?? 0,
            agents_dispatched: b["agents_dispatched"] ?? 0,
            usd_estimate: Math.round((b["usd_estimate"] ?? 0) * 1e4) / 1e4,
        },
        config: state["config"],
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
    return state["status"] === STATUS_DONE;
}
function hasResidualWork(state) {
    const status = state["status"];
    if (status === STATUS_PENDING || status === STATUS_IN_PROGRESS)
        return [status];
    return null;
}
function resumeMsg(runId, residual) {
    const [status] = residual;
    return (`/agentflow:enumerate run '${runId}' is not complete (status=${status}). ` +
        `Resume by generating the items list per the run's task_prompt (dispatch the generator agent, ` +
        `or produce it inline if config.execution is main-thread), then call \`complete --items-path <file>\`. Do NOT re-init.`);
}
const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg });
function main(argv) {
    const [sub, ...rest] = argv;
    if (isHelp(sub))
        return printUsage(CMD, ["init", "start", "complete", "fail", "status", "runs", "increment-continues", "budget-add"]);
    switch (sub) {
        case "init":
            return cmdInit(rest);
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
