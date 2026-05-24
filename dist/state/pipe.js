/**
 * State manager for /pipe.
 *
 * Composer primitive: runs a sequence of stages, each one a bash command, a `json` write,
 * or an invocation of another primitive (/enumerate, /group, /reduce, /iterate). /pipe holds
 * NO loop semantics — loops compose by using /iterate as a stage. Single-writer: /pipe never
 * mutates a child's state; it only reads it (via getPrimitive(cmd).isDone) to decide advance.
 *
 * Faithful port of `pipe_state.py`, plus the workflow-layer amendment:
 * - **stage.when** (Predicate): a per-stage guard run at tick time; exit 0 → run the stage,
 *   non-zero → mark it `skipped` and advance. This is the "do only if" conditional step.
 * - **stage.next** (string|number|null): graph wiring carried in the schema so branches and
 *   back-edges are expressible. v1 traversal stays linear (+1); branch/back-edge *runtime* is
 *   v1.1. The field is validated and preserved so no schema migration is needed later.
 * - **workflow-file Source** (`init --workflow <json>`): a declarative WorkflowSpec compiles
 *   into `stages[]` (no new engine), enabling reusable, versioned workflows.
 *
 * Declarative wiring templates resolved at tick time: {{stages.<name>.result_pointer}},
 * {{stages.<name>.run_id}}, {{run.id}}, {{run.dir}}, with |json / |shell / |raw filters.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Primitive, STATUS_ABORTED, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, die, findWorkspaceRoot, getPrimitive, loadState, makeBaseState, markDone, markFailed, markInProgress, now, parseBudgetCaps, print, saveAtomic, stateDir, statePath, } from "../common.js";
import { runBash } from "../shell.js";
import { parseWorkflowMd } from "../workflow_md.js";
// Side-effect imports: register child primitives so getPrimitive() works in tick/advance.
import "./enumerate.js";
import "./foreach.js";
import "./group.js";
import "./iterate.js";
import "./reduce.js";
const CMD = "pipe";
const SUPPORTED_CHILD_CMDS = ["enumerate", "foreach", "group", "iterate", "reduce"];
const PREVIEW_CHARS = 500;
const STATUS_SKIPPED = "skipped";
const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(THIS_FILE);
function childScript(cmd) {
    return join(SCRIPT_DIR, `${cmd}.js`);
}
function nodeRun(args) {
    const p = spawnSync("node", args, { encoding: "utf8", env: { ...process.env } });
    return { status: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}
// ---------- declarative stage wiring (template resolution) ----------
const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.\-]+)(?:\s*\|\s*([a-zA-Z0-9_\-]+))?\s*\}\}/g;
const STAGE_FIELD_ALIASES = { run_id: "child_run_id", cmd: "child_cmd" };
function applyFilter(value, name) {
    if (!name || name === "raw")
        return value;
    if (name === "json")
        return JSON.stringify(value);
    if (name === "shell")
        return "'" + value.replace(/'/g, "'\\''") + "'";
    return value; // unknown filter: leave untouched
}
function resolveTemplate(value, state) {
    if (typeof value !== "string" || !value.includes("{{"))
        return value;
    const stagesByName = {};
    for (const s of state["stages"] ?? [])
        if (s["name"])
            stagesByName[s["name"]] = s;
    return value.replace(TEMPLATE_RE, (whole, path, filterName) => {
        const parts = path.split(".");
        if (parts[0] === "run") {
            if (parts.length === 2 && parts[1] === "id")
                return applyFilter(state["run_id"] ?? "", filterName);
            if (parts.length === 2 && parts[1] === "dir")
                return applyFilter(join(stateDir(CMD), state["run_id"] ?? ""), filterName);
            return whole;
        }
        if (parts[0] === "params" && parts.length === 2) {
            // {{params.<name>}} → the resolved parameter value (workflow default or --param override).
            const p = state["params"]?.[parts[1]];
            if (p === undefined)
                return whole;
            return applyFilter(String(p), filterName);
        }
        if (parts[0] === "workflow" && parts.length === 2 && parts[1] === "dir") {
            // The directory the workflow-file lives in — lets a workflow reference its own scripts
            // relatively (`{{workflow.dir}}/discover.mjs`), so the folder is self-contained and movable.
            if (!state["workflow_dir"])
                return whole; // run inited from raw --stages: no workflow dir
            return applyFilter(state["workflow_dir"], filterName);
        }
        if (parts[0] === "stages" && parts.length >= 3) {
            const name = parts[1];
            const field = parts.slice(2).join(".");
            const stage = stagesByName[name];
            if (!stage)
                return whole;
            const actualField = STAGE_FIELD_ALIASES[field] ?? field;
            const v = stage[actualField];
            if (v == null) {
                const spec = stage["spec"] ?? {};
                if (field in spec)
                    return applyFilter(String(spec[field]), filterName);
                return whole;
            }
            return applyFilter(String(v), filterName);
        }
        return whole;
    });
}
function resolveInList(values, state) {
    return values.map((v) => resolveTemplate(v, state));
}
function resolveValueTemplates(value, state) {
    if (typeof value === "string")
        return resolveTemplate(value, state);
    if (Array.isArray(value))
        return value.map((v) => resolveValueTemplates(v, state));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = resolveValueTemplates(v, state);
        return out;
    }
    return value;
}
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
function stageDefaultOutput(runId, idx) {
    return join(stateDir(CMD), runId, `stage-${idx}.out`);
}
function validateStages(stagesRaw) {
    if (!Array.isArray(stagesRaw) || stagesRaw.length === 0)
        die("error: stages must be a non-empty JSON array");
    const names = new Set();
    const out = [];
    stagesRaw.forEach((raw, i) => {
        if (typeof raw !== "object" || raw === null)
            die(`error: stage ${i} is not an object`);
        const stype = raw["type"];
        if (!["bash", "primitive", "json"].includes(stype))
            die(`error: stage ${i}: type must be 'bash', 'primitive', or 'json'`);
        const name = raw["name"];
        if (name) {
            if (names.has(name))
                die(`error: stage ${i}: duplicate name '${name}' (names must be unique for wiring templates)`);
            names.add(name);
        }
        const spec = raw["spec"] ?? {};
        if (stype === "bash") {
            if (!spec["command"])
                die(`error: stage ${i} (bash): spec.command is required`);
        }
        else if (stype === "json") {
            if (!("value" in spec))
                die(`error: stage ${i} (json): spec.value is required`);
        }
        else {
            if (!SUPPORTED_CHILD_CMDS.includes(spec["cmd"]))
                die(`error: stage ${i} (primitive): spec.cmd must be one of ${SUPPORTED_CHILD_CMDS.join(",")}`);
            if (spec["init_args"] !== undefined && !Array.isArray(spec["init_args"]))
                die(`error: stage ${i} (primitive): spec.init_args must be a JSON array`);
        }
        // Amendment seams: validate optional `when` guard and `next` graph edge.
        const when = raw["when"];
        if (when !== undefined && when !== null) {
            const w = when;
            if (w["type"] !== "bash" || !w["command"])
                die(`error: stage ${i}: when must be {type:"bash", command:"..."}`);
        }
        const next = raw["next"];
        if (next !== undefined && next !== null && typeof next !== "string" && typeof next !== "number")
            die(`error: stage ${i}: next must be a stage name (string), index (number), or null`);
        out.push({
            index: i,
            name: raw["name"] ?? null,
            type: stype,
            spec,
            when: when ?? null,
            when_result: null,
            next: next ?? null,
            status: STATUS_PENDING,
            child_cmd: null,
            child_run_id: null,
            result_pointer: null,
            started_at: null,
            completed_at: null,
            exit_code: null,
            error: null,
        });
    });
    return out;
}
// ---------- CLI commands ----------
const TEMPLATE_DUMMY = "__UNRESOLVED_TEMPLATE__";
function dummyResolveTemplates(initArgs) {
    return initArgs.map((a) => typeof a === "string" && a.includes("{{") ? a.replace(/\{\{[^}]+\}\}/g, TEMPLATE_DUMMY) : String(a));
}
function validatePrimitiveStage(stage) {
    const spec = stage["spec"] ?? {};
    const childCmd = spec["cmd"];
    if (!childCmd)
        return [false, "missing spec.cmd"];
    const script = childScript(childCmd);
    if (!existsSync(script))
        return [false, `unknown primitive '${childCmd}' (no ${childCmd}.js)`];
    const initArgs = dummyResolveTemplates(spec["init_args"] ?? []);
    const r = nodeRun([script, "init", "__pipe-validate__", ...initArgs, "--validate-only", "--force"]);
    if (r.status !== 0)
        return [false, (r.stderr || r.stdout).trim()];
    return [true, null];
}
function cmdInit(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            stages: { type: "string" },
            workflow: { type: "string" },
            "context-policy": { type: "string", default: "summary" },
            "auto-continue": { type: "boolean" },
            "no-auto-continue": { type: "boolean" },
            "max-auto-continues": { type: "string", default: "50" },
            "max-stages": { type: "string", default: "20" },
            "stop-on-failure": { type: "boolean" },
            "no-stop-on-failure": { type: "boolean" },
            param: { type: "string", multiple: true },
            "max-usd": { type: "string" },
            "max-tokens": { type: "string" },
            "max-agents": { type: "string" },
            force: { type: "boolean", default: false },
            "skip-validate-stages": { type: "boolean", default: false },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: init requires a run_id");
    const stagesPath = values["stages"];
    const workflowPath = values["workflow"];
    if (Number(Boolean(stagesPath)) + Number(Boolean(workflowPath)) !== 1)
        die("error: provide exactly one of --stages or --workflow");
    // Workflow-file Source: a declarative WorkflowSpec {name?, description?, config?, stages[]}
    // compiles into the pipe's stages[]. Its optional config provides defaults for the run.
    let stagesRaw;
    let workflowConfig = {};
    let workflowDir = null;
    let paramSpec = {};
    if (workflowPath) {
        // WORKFLOW.md (human-authored markdown) compiles to the same WorkflowSpec object as a .json file.
        const raw = readFileSync(workflowPath, "utf8");
        const wf = workflowPath.toLowerCase().endsWith(".md") ? parseWorkflowMd(raw) : JSON.parse(raw);
        if (typeof wf !== "object" || wf === null || !Array.isArray(wf.stages))
            die("error: workflow file must be an object with a 'stages' array");
        stagesRaw = wf.stages;
        workflowConfig = wf.config ?? {};
        paramSpec = wf.params ?? {};
        workflowDir = dirname(resolve(workflowPath)); // for {{workflow.dir}} — self-contained workflows
    }
    else {
        stagesRaw = JSON.parse(readFileSync(stagesPath, "utf8"));
    }
    // Parameters: the workflow's `params` declares defaults (bare value, or {default, required,
    // description}); `--param k=v` overrides. Resolved values are exposed as {{params.<name>}}.
    const paramOverrides = {};
    for (const kv of values["param"] ?? []) {
        const eq = kv.indexOf("=");
        if (eq < 0)
            die(`error: --param must be name=value, got '${kv}'`);
        paramOverrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const params = {};
    for (const [name, decl] of Object.entries(paramSpec)) {
        const obj = decl && typeof decl === "object" && !Array.isArray(decl) ? decl : null;
        const def = obj && "default" in obj ? obj["default"] : obj ? undefined : decl;
        const val = name in paramOverrides ? paramOverrides[name] : def;
        if (val === undefined) {
            if (obj && obj["required"])
                die(`error: required workflow param '${name}' was not provided (--param ${name}=...)`);
            continue;
        }
        params[name] = val;
    }
    // Undeclared --param values still pass through (handy for --stages runs and ad-hoc params).
    for (const [k, v] of Object.entries(paramOverrides))
        if (!(k in params))
            params[k] = v;
    const stages = validateStages(stagesRaw);
    const maxStages = parseInt(values["max-stages"], 10);
    if (stages.length > maxStages)
        die(`error: ${stages.length} stages exceeds max_stages=${maxStages}`);
    if (!values["skip-validate-stages"]) {
        const errors = [];
        for (const s of stages) {
            if (s["type"] === "primitive") {
                const [ok, err] = validatePrimitiveStage(s);
                if (!ok)
                    errors.push(`stage ${s["index"]} (${s["name"] ?? s["type"]}, cmd=${s["spec"]?.cmd}): ${err}`);
            }
        }
        if (errors.length)
            die("error: stage validation failed:\n  - " + errors.join("\n  - "));
    }
    const pick = (key, cliVal) => (workflowConfig[key] !== undefined ? workflowConfig[key] : cliVal);
    const autoContinue = values["no-auto-continue"] ? false : true;
    const stopOnFailure = values["no-stop-on-failure"] ? false : true;
    const state = makeBaseState(CMD, runId, {
        context_policy: pick("context_policy", values["context-policy"]),
        auto_continue: pick("auto_continue", autoContinue),
        max_auto_continues: pick("max_auto_continues", parseInt(values["max-auto-continues"], 10)),
        max_stages: maxStages,
        stop_on_failure: pick("stop_on_failure", stopOnFailure),
        budget_caps: parseBudgetCaps(values),
    }, { stages, stage_index: 0, stop_reason: null, workflow_dir: workflowDir, params });
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    saveAtomic(p, state);
    print({ run_id: runId, stages: stages.length, path: p });
}
function currentStage(state) {
    const idx = state["stage_index"];
    if (idx >= state["stages"].length)
        return null;
    return state["stages"][idx];
}
/**
 * Compute the next stage index. v1 traversal is linear (+1); the `next` field is carried in
 * the schema but graph traversal (named jumps / back-edges) is a v1.1 runtime feature. This
 * single helper is the seam where that resolution will live.
 */
function nextIndex(state, _cur) {
    return state["stage_index"] + 1;
}
/** Run a stage's `when` guard. exit 0 → run the stage; non-zero → skip. */
function evalWhenGuard(when, state, stageIndex) {
    const env = {
        ...process.env,
        PIPE_RUN_ID: state["run_id"],
        STAGE_INDEX: String(stageIndex),
    };
    const cmd = resolveTemplate(when["command"], state);
    try {
        return runBash(cmd, findWorkspaceRoot(), env).status;
    }
    catch {
        return 1; // guard failed to run → treat as "skip" (do not run the stage)
    }
}
function cmdTick(args) {
    const runId = requireRunId(args, "tick");
    const state = load(runId);
    if ([STATUS_FAILED, STATUS_ABORTED].includes(state["status"])) {
        print({ action: "failed", status: state["status"], error: state["error"] ?? null });
        return;
    }
    if (state["status"] === STATUS_DONE) {
        print({ action: "done", stages: state["stages"].length, result_pointer: state["result_pointer"] ?? null });
        return;
    }
    if (state["status"] === STATUS_PENDING) {
        markInProgress(state);
        save(runId, state);
    }
    const cur = currentStage(state);
    if (cur === null) {
        state["stop_reason"] = "all_done";
        let lastPtr = null;
        for (let i = state["stages"].length - 1; i >= 0; i--) {
            if (state["stages"][i]["result_pointer"]) {
                lastPtr = state["stages"][i]["result_pointer"];
                break;
            }
        }
        markDone(state, lastPtr);
        save(runId, state);
        print({ action: "done", stages: state["stages"].length, result_pointer: lastPtr });
        return;
    }
    if (cur["status"] === STATUS_PENDING) {
        // Amendment: evaluate the per-stage `when` guard once, before running the stage.
        if (cur["when"] && cur["when_result"] === null) {
            const ec = evalWhenGuard(cur["when"], state, cur["index"]);
            cur["when_result"] = ec;
            if (ec !== 0) {
                cur["status"] = STATUS_SKIPPED;
                cur["completed_at"] = now();
                state["stage_index"] = nextIndex(state, cur);
                save(runId, state);
                return cmdTick(args); // re-tick at the next stage
            }
            save(runId, state); // record the guard passed
        }
        if (cur["type"] === "bash") {
            const rawOut = cur["spec"]["output_path"] || stageDefaultOutput(runId, cur["index"]);
            print({
                action: "run_bash",
                stage_index: cur["index"],
                command: resolveTemplate(cur["spec"]["command"], state),
                output_path: resolveTemplate(rawOut, state),
            });
            return;
        }
        if (cur["type"] === "json") {
            const rawOut = cur["spec"]["output_path"] || stageDefaultOutput(runId, cur["index"]);
            print({
                action: "write_json",
                stage_index: cur["index"],
                value: resolveValueTemplates(cur["spec"]["value"], state),
                output_path: resolveTemplate(rawOut, state),
            });
            return;
        }
        // primitive
        const childCmd = cur["spec"]["cmd"];
        print({
            action: "spawn_primitive",
            stage_index: cur["index"],
            cmd: childCmd,
            suggested_child_run_id: `${runId}-s${cur["index"]}-${childCmd}`,
            init_args: resolveInList(cur["spec"]["init_args"] ?? [], state),
        });
        return;
    }
    if (cur["status"] === STATUS_IN_PROGRESS) {
        if (cur["type"] === "primitive") {
            const childCmd = cur["child_cmd"];
            const childRunId = cur["child_run_id"];
            if (!childCmd || !childRunId) {
                print({ action: "failed", stage_index: cur["index"], error: "primitive stage in_progress but child_cmd/run_id not recorded" });
                return;
            }
            const childPath = statePath(childCmd, childRunId);
            if (!existsSync(childPath)) {
                print({ action: "failed", stage_index: cur["index"], error: `child state missing at ${childPath}` });
                return;
            }
            const childState = loadState(childPath);
            const spec = getPrimitive(childCmd);
            if (!spec) {
                print({ action: "failed", stage_index: cur["index"], error: `unknown child primitive '${childCmd}'` });
                return;
            }
            if (childState["status"] === STATUS_FAILED) {
                print({
                    action: "advance_after_child", stage_index: cur["index"], child_cmd: childCmd,
                    child_run_id: childRunId, child_status: STATUS_FAILED, result_pointer: childState["result_pointer"] ?? null,
                });
                return;
            }
            if (spec.isDone(childState)) {
                print({
                    action: "advance_after_child", stage_index: cur["index"], child_cmd: childCmd,
                    child_run_id: childRunId, child_status: childState["status"], result_pointer: spec.resultPointer(childState),
                });
                return;
            }
            print({ action: "await_primitive", stage_index: cur["index"], child_cmd: childCmd, child_run_id: childRunId });
            return;
        }
        print({ action: "failed", stage_index: cur["index"], error: "bash stage stuck in_progress (orchestrator did not call complete-bash-stage)" });
        return;
    }
    // done/failed/skipped but cursor not advanced — auto-advance and re-tick.
    state["stage_index"] = nextIndex(state, cur);
    save(runId, state);
    return cmdTick(args);
}
function cmdCompleteJsonStage(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true,
        options: { "output-path": { type: "string" } },
    });
    const runId = positionals[0];
    const outputPath = values["output-path"];
    if (!runId || !outputPath)
        die("error: complete-json-stage requires run_id and --output-path");
    const state = load(runId);
    const cur = currentStage(state);
    if (cur === null || cur["type"] !== "json")
        die("error: current stage is not a json stage");
    if (cur["status"] === STATUS_DONE)
        die("error: json stage already complete");
    mkdirSync(dirname(outputPath), { recursive: true });
    const resolved = resolveValueTemplates(cur["spec"]["value"], state);
    writeFileSync(outputPath, JSON.stringify(resolved), "utf8");
    cur["status"] = STATUS_DONE;
    cur["completed_at"] = now();
    cur["result_pointer"] = outputPath;
    state["stage_index"] = nextIndex(state, cur);
    save(runId, state);
    print({ recorded: true, advanced: true, next_stage: state["stage_index"], wrote: outputPath, bytes: statSync(outputPath).size });
}
function cmdCompleteBashStage(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true,
        options: { "exit-code": { type: "string" }, "output-path": { type: "string" }, error: { type: "string", default: "" } },
    });
    const runId = positionals[0];
    const exitCode = parseInt(values["exit-code"], 10);
    const outputPath = values["output-path"];
    if (!runId || !outputPath || Number.isNaN(exitCode))
        die("error: complete-bash-stage requires run_id, --exit-code, --output-path");
    const state = load(runId);
    const cur = currentStage(state);
    if (cur === null || cur["type"] !== "bash")
        die("error: current stage is not a bash stage");
    if (cur["status"] === STATUS_DONE)
        die("error: bash stage already complete");
    cur["status"] = exitCode === 0 ? STATUS_DONE : STATUS_FAILED;
    cur["exit_code"] = exitCode;
    cur["completed_at"] = now();
    cur["result_pointer"] = outputPath;
    if (values["error"])
        cur["error"] = values["error"].slice(0, PREVIEW_CHARS);
    if (exitCode !== 0 && (state["config"]["stop_on_failure"] ?? true)) {
        state["stop_reason"] = "stage_failed";
        markFailed(state, `stage ${cur["index"]} (bash) failed: exit=${exitCode}`);
        save(runId, state);
        print({ recorded: true, advanced: false, pipe_status: STATUS_FAILED });
        return;
    }
    state["stage_index"] = nextIndex(state, cur);
    save(runId, state);
    print({ recorded: true, advanced: true, next_stage: state["stage_index"] });
}
function cmdStartPrimitiveChild(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true,
        options: { "child-cmd": { type: "string" }, "child-run-id": { type: "string" } },
    });
    const runId = positionals[0];
    const childCmd = values["child-cmd"];
    const childRunId = values["child-run-id"];
    if (!runId || !childCmd || !childRunId)
        die("error: start-primitive-child requires run_id, --child-cmd, --child-run-id");
    if (!SUPPORTED_CHILD_CMDS.includes(childCmd))
        die(`error: --child-cmd must be one of ${SUPPORTED_CHILD_CMDS.join(",")}`);
    const state = load(runId);
    const cur = currentStage(state);
    if (cur === null || cur["type"] !== "primitive")
        die("error: current stage is not a primitive stage");
    if (cur["status"] !== STATUS_PENDING)
        die(`error: current stage status is '${cur["status"]}', expected 'pending'`);
    cur["status"] = STATUS_IN_PROGRESS;
    cur["child_cmd"] = childCmd;
    cur["child_run_id"] = childRunId;
    cur["started_at"] = now();
    save(runId, state);
    print({ stage_index: cur["index"], child_cmd: childCmd, child_run_id: childRunId });
}
function cmdAdvance(args) {
    const runId = requireRunId(args, "advance");
    const state = load(runId);
    const cur = currentStage(state);
    if (cur === null)
        die("error: no current stage to advance");
    if (cur["type"] === "primitive" && cur["status"] === STATUS_IN_PROGRESS) {
        const childCmd = cur["child_cmd"];
        const child = loadState(statePath(childCmd, cur["child_run_id"]));
        const spec = getPrimitive(childCmd);
        if (!spec || !spec.isDone(child)) {
            if (child["status"] === STATUS_FAILED) {
                cur["status"] = STATUS_FAILED;
                cur["error"] = child["error"];
            }
            else {
                die(`error: child ${childCmd}/${cur["child_run_id"]} is not done; cannot advance`);
            }
        }
        else {
            cur["status"] = STATUS_DONE;
            cur["result_pointer"] = spec.resultPointer(child);
        }
        cur["completed_at"] = now();
    }
    if (cur["status"] === STATUS_FAILED && (state["config"]["stop_on_failure"] ?? true)) {
        state["stop_reason"] = "stage_failed";
        markFailed(state, `stage ${cur["index"]} (${cur["type"]}) failed`);
        save(runId, state);
        print({ advanced: false, pipe_status: STATUS_FAILED, stage_index: cur["index"] });
        return;
    }
    state["stage_index"] = nextIndex(state, cur);
    save(runId, state);
    if (state["stage_index"] >= state["stages"].length) {
        const lastPtr = cur["result_pointer"] ?? null;
        state["stop_reason"] = "all_done";
        markDone(state, lastPtr);
        save(runId, state);
        print({ advanced: true, pipe_status: STATUS_DONE, stages: state["stages"].length, result_pointer: lastPtr });
        return;
    }
    print({ advanced: true, next_stage: state["stage_index"] });
}
function cmdFail(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true, options: { error: { type: "string", default: "" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: fail requires a run_id");
    const state = load(runId);
    markFailed(state, values["error"]);
    save(runId, state);
    print({ run_id: runId, status: STATUS_FAILED, error: values["error"] });
}
// ---------- drive: auto-run as many stages as possible without agent dispatch ----------
const DETERMINISTIC_GROUP_METHODS = ["path-prefix", "regex", "jsonpath"];
function runBashSynchronously(command, outputPath, runId, stageIndex) {
    mkdirSync(dirname(outputPath), { recursive: true });
    const errP = outputPath + ".err";
    const env = {
        ...process.env,
        PIPE_RUN_ID: runId,
        STAGE_INDEX: String(stageIndex),
        PIPE_OUTPUT_PATH: outputPath,
        PIPE_PREV_RESULT_POINTER: process.env["PIPE_PREV_RESULT_POINTER"] ?? "",
    };
    const proc = runBash(command, findWorkspaceRoot(), env);
    writeFileSync(errP, proc.stderr, "utf8");
    // Fallback only: bash didn't redirect AND captured stdout is non-empty.
    if ((!existsSync(outputPath) || statSync(outputPath).size === 0) && proc.stdout) {
        writeFileSync(outputPath, proc.stdout, "utf8");
    }
    return [proc.status, proc.stderr.slice(0, PREVIEW_CHARS)];
}
function driveCanAutoHandlePrimitive(spawn) {
    if (spawn["cmd"] === "group") {
        const ia = spawn["init_args"] ?? [];
        for (let i = 0; i < ia.length; i++) {
            if (ia[i] === "--method" && i + 1 < ia.length)
                return DETERMINISTIC_GROUP_METHODS.includes(ia[i + 1]);
        }
        return false;
    }
    return false;
}
function autoInitChild(childCmd, childRunId, initArgs) {
    const r = nodeRun([childScript(childCmd), "init", childRunId, ...initArgs, "--force"]);
    if (r.status !== 0)
        process.stderr.write(`[drive] child init failed for ${childCmd}/${childRunId}: ${r.stderr}\n`);
    return r.status;
}
function autoRunGroupDeterministic(childRunId) {
    const r = nodeRun([childScript("group"), "run-deterministic", childRunId]);
    if (r.status !== 0)
        process.stderr.write(`[drive] group run-deterministic failed for ${childRunId}: ${r.stderr}\n`);
    return r.status;
}
function cmdDrive(args) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, strict: true, options: { "max-steps": { type: "string", default: "100" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: drive requires a run_id");
    const maxSteps = parseInt(values["max-steps"], 10);
    let stepsTaken = 0;
    const actionsTaken = [];
    while (stepsTaken < maxSteps) {
        const tick = nodeRun([THIS_FILE, "tick", runId]);
        if (tick.status !== 0) {
            print({ action: "error", stage: "tick", stderr: tick.stderr.slice(0, PREVIEW_CHARS) });
            return;
        }
        const t = JSON.parse(tick.stdout.trim().split(/\r?\n/).at(-1) ?? "null");
        const action = t["action"];
        stepsTaken++;
        if (action === "done" || action === "failed") {
            t["steps_taken"] = stepsTaken;
            t["actions_taken"] = actionsTaken;
            print(t);
            return;
        }
        if (action === "run_bash") {
            const [ec, err] = runBashSynchronously(t["command"], t["output_path"], runId, t["stage_index"]);
            nodeRun([THIS_FILE, "complete-bash-stage", runId, "--exit-code", String(ec), "--output-path", t["output_path"], "--error", ec !== 0 ? err : ""]);
            actionsTaken.push({ step: stepsTaken, action: "run_bash", stage: t["stage_index"], exit_code: ec });
            continue;
        }
        if (action === "write_json") {
            const r = nodeRun([THIS_FILE, "complete-json-stage", runId, "--output-path", t["output_path"]]);
            if (r.status !== 0) {
                print({ action: "error", stage: "complete_json_stage", stderr: r.stderr.slice(0, PREVIEW_CHARS) });
                return;
            }
            actionsTaken.push({ step: stepsTaken, action: "write_json", stage: t["stage_index"] });
            continue;
        }
        if (action === "spawn_primitive") {
            if (driveCanAutoHandlePrimitive(t)) {
                const childCmd = t["cmd"];
                const childRunId = t["suggested_child_run_id"];
                if (autoInitChild(childCmd, childRunId, t["init_args"]) !== 0) {
                    print({ action: "error", stage: "child_init", cmd: childCmd, run_id: childRunId });
                    return;
                }
                nodeRun([THIS_FILE, "start-primitive-child", runId, "--child-cmd", childCmd, "--child-run-id", childRunId]);
                if (childCmd === "group")
                    autoRunGroupDeterministic(childRunId);
                actionsTaken.push({ step: stepsTaken, action: "auto_primitive", cmd: childCmd, run_id: childRunId });
                continue;
            }
            t["steps_taken"] = stepsTaken;
            t["actions_taken"] = actionsTaken;
            t["action"] = "needs_agent";
            t["next_step"] =
                `Init the child (${t["cmd"]}) for run '${t["suggested_child_run_id"]}', then \`start-primitive-child ${runId} ` +
                    `--child-cmd ${t["cmd"]} --child-run-id ${t["suggested_child_run_id"]}\`, run the agent dispatch per the child's SKILL.md, then call \`drive\` again.`;
            print(t);
            return;
        }
        if (action === "advance_after_child") {
            nodeRun([THIS_FILE, "advance", runId]);
            actionsTaken.push({ step: stepsTaken, action: "advance", stage: t["stage_index"] });
            continue;
        }
        if (action === "await_primitive") {
            t["steps_taken"] = stepsTaken;
            t["actions_taken"] = actionsTaken;
            t["action"] = "waiting";
            print(t);
            return;
        }
        t["steps_taken"] = stepsTaken;
        t["actions_taken"] = actionsTaken;
        print(t);
        return;
    }
    print({ action: "max_steps_reached", steps_taken: stepsTaken, actions_taken: actionsTaken, hint: "increase --max-steps or inspect the run" });
}
/** Dry-run: show the resolved execution plan without running or dispatching anything. */
function cmdPlan(args) {
    const runId = requireRunId(args, "plan");
    const state = load(runId);
    const plan = state["stages"].map((s) => {
        const entry = { index: s["index"], name: s["name"], type: s["type"], status: s["status"] };
        if (s["when"])
            entry["when"] = s["when"]["command"]; // evaluated at runtime
        const outPath = s["spec"]["output_path"] || stageDefaultOutput(runId, s["index"]);
        if (s["type"] === "bash") {
            entry["command"] = resolveTemplate(s["spec"]["command"], state);
            entry["output_path"] = resolveTemplate(outPath, state);
        }
        else if (s["type"] === "json") {
            entry["value"] = resolveValueTemplates(s["spec"]["value"], state);
            entry["output_path"] = resolveTemplate(outPath, state);
        }
        else {
            entry["cmd"] = s["spec"]["cmd"];
            entry["init_args"] = resolveInList(s["spec"]["init_args"] ?? [], state);
        }
        return entry;
    });
    // Unresolved forward references (later stages' result_pointers) remain as literal {{...}}.
    print({ run_id: runId, dry_run: true, stages: plan.length, plan });
}
function cmdStatus(args) {
    const runId = requireRunId(args, "status");
    const state = load(runId);
    const b = state["budget"] ?? {};
    print({
        run_id: runId,
        cmd: CMD,
        status: state["status"],
        stage_index: state["stage_index"],
        total_stages: state["stages"].length,
        stages: state["stages"].map((s) => ({
            index: s["index"], name: s["name"], type: s["type"], status: s["status"],
            child_cmd: s["child_cmd"], child_run_id: s["child_run_id"], result_pointer: s["result_pointer"], error: s["error"],
        })),
        stop_reason: state["stop_reason"] ?? null,
        result_pointer: state["result_pointer"] ?? null,
        error: state["error"] ?? null,
        budget: {
            tokens_used: b["tokens_used"] ?? 0,
            agents_dispatched: b["agents_dispatched"] ?? 0,
            usd_estimate: Math.round((b["usd_estimate"] ?? 0) * 1e4) / 1e4,
        },
    });
}
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
    if ([STATUS_DONE, STATUS_FAILED, STATUS_ABORTED].includes(state["status"]))
        return null;
    const stages = state["stages"] ?? [];
    const idx = state["stage_index"] ?? 0;
    if (idx >= stages.length)
        return ["finalize"];
    const cur = stages[idx];
    const curStatus = cur["status"];
    if (curStatus === STATUS_PENDING)
        return ["start_stage", idx, cur["type"]];
    if (curStatus === STATUS_IN_PROGRESS && cur["type"] === "primitive") {
        const childCmd = cur["child_cmd"];
        const childRunId = cur["child_run_id"];
        if (!childCmd || !childRunId)
            return ["primitive_unrecorded", idx];
        const childPath = statePath(childCmd, childRunId);
        if (!existsSync(childPath))
            return ["child_missing", idx];
        const child = loadState(childPath);
        const spec = getPrimitive(childCmd);
        if (!spec)
            return ["unknown_child_primitive", idx];
        if (spec.isDone(child) || child["status"] === STATUS_FAILED)
            return ["advance_after_child", idx, child["status"]];
        return null; // child still working — yield to child's checker
    }
    if (curStatus === STATUS_IN_PROGRESS && cur["type"] === "bash")
        return ["bash_inconsistent", idx];
    return ["advance", idx, curStatus];
}
function resumeMsg(runId, residual) {
    const tag = residual[0];
    const extras = {
        start_stage: "the next stage is pending — call `tick` to learn what to do",
        advance_after_child: "the current primitive stage's child has finished — call `tick` to advance, then continue",
        finalize: "all stages have run but the pipe status has not been finalized — call `tick`",
        advance: "the current stage is no longer pending/in_progress but stage_index has not advanced — call `tick`",
        primitive_unrecorded: "BUG: primitive stage is in_progress without child_cmd/run_id; fail this run or fix the stage record",
        child_missing: "BUG: primitive stage's child state file is missing on disk",
        unknown_child_primitive: "BUG: primitive stage references an unknown child primitive",
        bash_inconsistent: "BUG: bash stage stuck in_progress; orchestrator did not call complete-bash-stage",
    };
    const detail = extras[tag] ?? `unhandled residual tag '${tag}'`;
    return `/pipe run '${runId}' needs orchestrator attention: ${detail}. Run the pipe \`tick ${runId}\` subcommand and act on the returned JSON.`;
}
const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg });
function main(argv) {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "init":
            return cmdInit(rest);
        case "tick":
            return cmdTick(rest);
        case "drive":
            return cmdDrive(rest);
        case "plan":
            return cmdPlan(rest);
        case "complete-bash-stage":
            return cmdCompleteBashStage(rest);
        case "complete-json-stage":
            return cmdCompleteJsonStage(rest);
        case "start-primitive-child":
            return cmdStartPrimitiveChild(rest);
        case "advance":
            return cmdAdvance(rest);
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
