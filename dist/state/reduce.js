/**
 * State manager for /reduce.
 *
 * A /reduce run is a single-step primitive: gather N inputs, dispatch ONE agent that
 * produces 1 digest (markdown or JSON), persist the output pointer. Single-writer: the
 * orchestrator owns state writes; the digest agent only writes the output file.
 *
 * Faithful port of `reduce_state.py`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Primitive, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, die, isHelp, printUsage, loadState, makeBaseState, markDone, markFailed, markInProgress, now, print, saveAtomic, statePath, } from "../common.js";
const CMD = "reduce";
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
            inputs: { type: "string" },
            prompt: { type: "string" },
            "task-prompt": { type: "string", default: "" },
            model: { type: "string", default: "sonnet" },
            "output-format": { type: "string", default: "markdown" },
            "auto-continue": { type: "boolean" },
            "no-auto-continue": { type: "boolean" },
            "max-auto-continues": { type: "string", default: "5" },
            "subagent-type": { type: "string", default: "general-purpose" },
            force: { type: "boolean", default: false },
            "validate-only": { type: "boolean", default: false },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: init requires a run_id");
    const outputFormat = values["output-format"];
    if (values["validate-only"]) {
        if (!["markdown", "json"].includes(outputFormat))
            die(`error: --output-format must be markdown|json, got '${outputFormat}'`);
        print({ valid: true, model: values["model"], output_format: outputFormat });
        return;
    }
    const inputsPath = values["inputs"];
    if (!inputsPath)
        die("error: init requires --inputs");
    const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
    if (!Array.isArray(inputs))
        die("error: inputs file must contain a JSON array of input descriptors");
    inputs.forEach((inp, i) => {
        if (typeof inp !== "object" || inp === null || !("source" in inp))
            die(`error: input at index ${i} must be an object with 'source'`);
        if (!["run", "file", "inline"].includes(inp["source"]))
            die(`error: input at index ${i}: source must be run|file|inline`);
    });
    const autoContinue = values["no-auto-continue"] ? false : true;
    const state = makeBaseState(CMD, runId, {
        model: values["model"],
        output_format: outputFormat,
        auto_continue: autoContinue,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
        subagent_type: values["subagent-type"],
    }, { task_prompt: (values["prompt"] ?? values["task-prompt"]), inputs });
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    saveAtomic(p, state);
    print({ run_id: runId, inputs: inputs.length, path: p });
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
function cmdComplete(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { "output-path": { type: "string" } },
    });
    const runId = positionals[0];
    const outputPath = values["output-path"];
    if (!runId || !outputPath)
        die("error: complete requires run_id and --output-path");
    if (!existsSync(outputPath))
        die(`error: output file does not exist at ${outputPath}`);
    const state = load(runId);
    markDone(state, outputPath);
    save(runId, state);
    print({ run_id: runId, status: STATUS_DONE, output: outputPath });
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
        inputs_count: (state["inputs"] ?? []).length,
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
/** Resolve every input descriptor into a single JSON file the digest agent reads. */
function cmdMaterialize(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { out: { type: "string" } },
    });
    const runId = positionals[0];
    const outArg = values["out"];
    if (!runId || !outArg)
        die("error: materialize requires run_id and --out");
    const state = load(runId);
    const out = { inputs: [] };
    for (const inp of state["inputs"]) {
        const src = inp["source"];
        if (src === "run") {
            const otherCmd = inp["cmd"] ?? "foreach";
            const otherRun = inp["run_id"];
            const otherState = loadState(statePath(otherCmd, otherRun));
            const entry = { source: "run", cmd: otherCmd, run_id: otherRun, items: [] };
            for (const item of Object.values(otherState["items"] ?? {})) {
                entry["items"].push({
                    id: item["id"],
                    status: item["status"],
                    result: item["status"] === STATUS_DONE ? item["result"] : null,
                    error: item["error"],
                });
            }
            out["inputs"].push(entry);
        }
        else if (src === "file") {
            const data = JSON.parse(readFileSync(inp["path"], "utf8"));
            out["inputs"].push({ source: "file", path: inp["path"], data });
        }
        else if (src === "inline") {
            out["inputs"].push({ source: "inline", data: inp["data"] });
        }
    }
    mkdirSync(dirname(outArg), { recursive: true });
    writeFileSync(outArg, JSON.stringify(out, null, 2), "utf8");
    const totalItems = out["inputs"]
        .filter((e) => e["source"] === "run")
        .reduce((n, e) => n + (e["items"]?.length ?? 0), 0);
    print({ materialized: outArg, input_blocks: out["inputs"].length, total_run_items: totalItems });
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
    return (`/reduce run '${runId}' is not complete (status=${status}). ` +
        `Resume by reading the state and re-dispatching the digest agent if the output file is absent, ` +
        `or by calling \`complete\` if the output file exists. Do NOT re-init.`);
}
const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg });
function main(argv) {
    const [sub, ...rest] = argv;
    if (isHelp(sub))
        return printUsage(CMD, ["init", "start", "complete", "fail", "status", "materialize", "runs", "increment-continues", "budget-add"]);
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
        case "materialize":
            return cmdMaterialize(rest);
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
