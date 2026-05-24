/**
 * State manager for /enumerate.
 *
 * Single-writer model: the orchestrator (Claude main agent) is the only writer. Subagents
 * process items and write result files; the orchestrator commits state via this CLI. No
 * locking needed as long as the contract is honored.
 *
 * Faithful port of `enumerate_state.py`, plus two amendment features implemented in v1:
 * - **checkbox Source** (`--checkbox <md>`): a markdown checklist becomes the item list,
 *   with `[x]` items pre-marked done and inline `{model:…, subagent:…}` annotations parsed
 *   into per-item `task` overrides.
 * - **per-item override**: items may carry `task` (prompt/model/subagentType); dispatch
 *   resolves `item.task?.X ?? config.X` (the resolution happens in the skill orchestration).
 *
 * State schema (extends base): config{concurrency, chunk_size, max_retries, auto_continue,
 * max_auto_continues, model, subagent_type, kind, cache}, task_prompt, items{<id>: {...}}.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Primitive, STATUS_DONE, STATUS_FAILED, STATUS_IN_PROGRESS, STATUS_PENDING, cacheKey, cacheLookup, cacheStore, die, loadState, loadTaskKindTemplate, makeBaseState, markDone, markInProgress, now, print, saveAtomic, statePath, } from "../common.js";
import { loadSource, writeChecklistView, writeFolderView } from "../source.js";
const CMD = "foreach";
// Valid kinds for --kind. Mirrors `skills/foreach/task-kinds.md`. "unknown" has no
// template and is treated as a no-op (no enrichment).
const KNOWN_KINDS = ["code-review", "transformation", "extraction", "validation", "audit", "unknown"];
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
/** Transition the run's top-level status to `done` when every item is terminal. */
function finalizeStatusIfTerminal(state) {
    const items = state["items"] ?? {};
    const values = Object.values(items);
    if (values.length === 0)
        return;
    if (values.some((i) => i["status"] === STATUS_PENDING || i["status"] === STATUS_IN_PROGRESS))
        return;
    if (state["status"] !== STATUS_DONE)
        markDone(state, state["result_pointer"] ?? null);
}
/** Build the per-item state dict from a resolved Source item. */
function toStateItem(it) {
    const entry = {
        id: it.id,
        data: it.data ?? {},
        status: it.status === STATUS_DONE ? STATUS_DONE : STATUS_PENDING,
        attempts: 0,
        result: it.result ?? null,
        error: it.error ?? null,
        started_at: null,
        completed_at: it.status === STATUS_DONE ? now() : null,
        cache_hit: false,
    };
    if (it.task)
        entry["task"] = it.task;
    return entry;
}
/** Resolve the init item list from exactly one of: --items | --checkbox | --source. */
function resolveItems(values) {
    const itemsPath = values["items"];
    const checkbox = values["checkbox"];
    const folder = values["folder"];
    const sourceJson = values["source"];
    const provided = [itemsPath, checkbox, folder, sourceJson].filter(Boolean).length;
    if (provided !== 1)
        die("error: provide exactly one of --items, --checkbox, --folder, --source");
    if (checkbox)
        return loadSource({ source: "checkbox", path: checkbox });
    if (folder)
        return loadSource({ source: "folder", path: folder });
    if (sourceJson)
        return loadSource(JSON.parse(sourceJson));
    // --items: JSON array in the legacy enumerate shape ({id?, data?, task?, ...}).
    const raw = JSON.parse(readFileSync(itemsPath, "utf8"));
    if (!Array.isArray(raw))
        die("error: items file must contain a JSON array");
    return raw.map((r, idx) => {
        if (typeof r !== "object" || r === null)
            die(`error: item at index ${idx} is not an object`);
        const id = String(r["id"] ?? idx);
        const data = r["data"] !== undefined
            ? r["data"]
            : Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id"));
        const item = { id, data, status: STATUS_PENDING };
        if (r["task"])
            item.task = r["task"];
        return item;
    });
}
function cmdInit(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            items: { type: "string" },
            checkbox: { type: "string" },
            folder: { type: "string" },
            source: { type: "string" },
            "task-prompt": { type: "string", default: "" },
            prompt: { type: "string" },
            execution: { type: "string", default: "subagent" },
            concurrency: { type: "string", default: "4" },
            "chunk-size": { type: "string", default: "auto" },
            "max-retries": { type: "string", default: "1" },
            "auto-continue": { type: "boolean" },
            "no-auto-continue": { type: "boolean" },
            "max-auto-continues": { type: "string", default: "20" },
            model: { type: "string", default: "inherit" },
            kind: { type: "string", default: "" },
            cache: { type: "boolean", default: false },
            "subagent-type": { type: "string", default: "general-purpose" },
            force: { type: "boolean", default: false },
            "validate-only": { type: "boolean", default: false },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: init requires a run_id positional");
    const model = values["model"];
    const kind = (values["kind"] || "").trim().toLowerCase() || null;
    if (kind && !KNOWN_KINDS.includes(kind))
        die(`error: --kind must be one of ${KNOWN_KINDS.join(",")}, got '${kind}'`);
    if (kind && kind !== "unknown" && loadTaskKindTemplate(kind, "foreach") === null)
        die(`error: no template found for kind '${kind}' in skills/foreach/task-kinds.md`);
    if (values["validate-only"]) {
        print({ valid: true, kind, model });
        return;
    }
    const sourceItems = resolveItems(values);
    const items = {};
    for (const it of sourceItems) {
        if (items[it.id])
            die(`error: duplicate item id '${it.id}'`);
        items[it.id] = toStateItem(it);
    }
    // `--prompt` is the primary operation config; `--task-prompt` kept as an alias.
    let effectiveTaskPrompt = (values["prompt"] ?? values["task-prompt"]) || "";
    if (kind && kind !== "unknown") {
        const template = loadTaskKindTemplate(kind, "foreach") ?? "";
        const sep = effectiveTaskPrompt ? "\n\n" : "";
        effectiveTaskPrompt = template.replace(/\s+$/, "") + sep + effectiveTaskPrompt;
    }
    const autoContinue = values["no-auto-continue"] ? false : true;
    // Execution mode: subagent fan-out (default) or process items inline in the main thread.
    const execution = values["execution"];
    if (!["main-thread", "subagent"].includes(execution))
        die(`error: --execution must be main-thread|subagent, got '${execution}'`);
    const state = makeBaseState(CMD, runId, {
        concurrency: parseInt(values["concurrency"], 10),
        chunk_size: values["chunk-size"],
        max_retries: parseInt(values["max-retries"], 10),
        auto_continue: autoContinue,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
        model,
        subagent_type: values["subagent-type"],
        execution,
        kind,
        cache: Boolean(values["cache"]),
    }, { task_prompt: effectiveTaskPrompt, items });
    // Cache lookup: items with a `data.content_hash` get pre-completed on a cache hit.
    let cacheHits = 0;
    if (values["cache"]) {
        const ns = `enumerate-${kind || "nokind"}`;
        for (const it of Object.values(state["items"])) {
            const ch = it["data"]?.["content_hash"];
            if (!ch)
                continue;
            const key = cacheKey(effectiveTaskPrompt, model || "", String(ch));
            const hit = cacheLookup(ns, key);
            if (hit === null)
                continue;
            it["status"] = STATUS_DONE;
            it["result"] = hit["value"];
            it["completed_at"] = now();
            it["cache_hit"] = true;
            cacheHits++;
        }
    }
    finalizeStatusIfTerminal(state);
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: state already exists at ${p}; use --force to overwrite`);
    save(runId, state);
    print({ run_id: runId, total: Object.keys(items).length, kind, cache_hits: cacheHits, path: p });
}
function maybeStoreCache(state, item) {
    const cfg = state["config"] ?? {};
    if (!cfg["cache"])
        return;
    if (item["cache_hit"])
        return;
    if (item["status"] !== STATUS_DONE)
        return;
    const ch = item["data"]?.["content_hash"];
    if (!ch)
        return;
    const kind = cfg["kind"] || "nokind";
    const model = cfg["model"] || "";
    cacheStore(`enumerate-${kind}`, cacheKey(state["task_prompt"] ?? "", model, String(ch)), item["result"]);
}
function cmdClaim(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { count: { type: "string" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: claim requires a run_id");
    const count = parseInt(values["count"] ?? "", 10);
    if (!Number.isFinite(count))
        die("error: --count is required");
    const state = load(runId);
    const claimed = [];
    for (const item of Object.values(state["items"])) {
        if (claimed.length >= count)
            break;
        if (item["status"] === STATUS_PENDING) {
            item["status"] = STATUS_IN_PROGRESS;
            item["started_at"] = now();
            item["attempts"] = (item["attempts"] ?? 0) + 1;
            claimed.push(item);
        }
    }
    if (claimed.length > 0 && state["status"] === STATUS_PENDING)
        markInProgress(state);
    save(runId, state);
    print(claimed);
}
function cmdComplete(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { result: { type: "string", default: "" } },
    });
    const [runId, itemId] = positionals;
    if (!runId || !itemId)
        die("error: complete requires run_id and item_id");
    const state = load(runId);
    const item = state["items"][itemId];
    if (!item)
        die(`error: unknown item id '${itemId}'`);
    item["status"] = STATUS_DONE;
    item["completed_at"] = now();
    item["result"] = values["result"] ? JSON.parse(values["result"]) : null;
    item["error"] = null;
    maybeStoreCache(state, item);
    finalizeStatusIfTerminal(state);
    save(runId, state);
    print({ id: itemId, status: STATUS_DONE, run_status: state["status"] });
}
function cmdFail(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { error: { type: "string", default: "" }, retry: { type: "boolean", default: false } },
    });
    const [runId, itemId] = positionals;
    if (!runId || !itemId)
        die("error: fail requires run_id and item_id");
    const state = load(runId);
    const item = state["items"][itemId];
    if (!item)
        die(`error: unknown item id '${itemId}'`);
    const maxRetries = state["config"]["max_retries"];
    if (values["retry"] && item["attempts"] <= maxRetries) {
        item["status"] = STATUS_PENDING;
        item["started_at"] = null;
    }
    else {
        item["status"] = STATUS_FAILED;
        item["completed_at"] = now();
    }
    item["error"] = values["error"];
    finalizeStatusIfTerminal(state);
    save(runId, state);
    print({ id: itemId, status: item["status"], attempts: item["attempts"], run_status: state["status"] });
}
function cmdStatus(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die("error: status requires a run_id");
    const state = load(runId);
    const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
    for (const item of Object.values(state["items"])) {
        counts[item["status"]] = (counts[item["status"]] ?? 0) + 1;
    }
    const b = state["budget"] ?? {};
    print({
        run_id: runId,
        run_status: state["status"],
        total: Object.keys(state["items"]).length,
        ...counts,
        budget: {
            tokens_used: b["tokens_used"] ?? 0,
            agents_dispatched: b["agents_dispatched"] ?? 0,
            usd_estimate: Math.round((b["usd_estimate"] ?? 0) * 1e4) / 1e4,
        },
        config: state["config"],
    });
}
function cmdList(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { status: { type: "string" }, limit: { type: "string", default: "0" } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: list requires a run_id");
    const state = load(runId);
    let items = Object.values(state["items"]);
    const status = values["status"];
    if (status) {
        if (!["pending", "in_progress", "done", "failed"].includes(status))
            die(`error: invalid --status '${status}'`);
        items = items.filter((i) => i["status"] === status);
    }
    const limit = parseInt(values["limit"], 10);
    if (limit)
        items = items.slice(0, limit);
    print(items);
}
function cmdReset(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { "failed-to-pending": { type: "boolean", default: false }, "in-progress-to-pending": { type: "boolean", default: false } },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: reset requires a run_id");
    const state = load(runId);
    let changed = 0;
    for (const item of Object.values(state["items"])) {
        if (values["failed-to-pending"] && item["status"] === "failed") {
            item["status"] = "pending";
            item["error"] = null;
            item["started_at"] = null;
            changed++;
        }
        else if (values["in-progress-to-pending"] && item["status"] === "in_progress") {
            item["status"] = "pending";
            item["started_at"] = null;
            changed++;
        }
    }
    save(runId, state);
    print({ reset: changed });
}
function cmdCompleteBatch(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { results: { type: "string" } },
    });
    const runId = positionals[0];
    const resultsPath = values["results"];
    if (!runId || !resultsPath)
        die("error: complete-batch requires run_id and --results");
    const payload = JSON.parse(readFileSync(resultsPath, "utf8"));
    if (!Array.isArray(payload))
        die("error: results file must be a JSON array");
    const state = load(runId);
    const maxRetries = state["config"]["max_retries"] ?? 1;
    const counts = { completed: 0, failed: 0, retried: 0, unknown: 0 };
    for (const r of payload) {
        const itemId = String(r["id"]);
        const item = state["items"][itemId];
        if (!item) {
            counts.unknown++;
            continue;
        }
        // Lenient ok inference: a valid result with no error counts as success even if `ok`
        // is omitted. Explicit ok=false still fails.
        let ok = r["ok"];
        if (ok === undefined || ok === null)
            ok = r["error"] === undefined ? r["result"] != null : r["error"] == null && r["result"] != null;
        if (ok) {
            item["status"] = STATUS_DONE;
            item["completed_at"] = now();
            item["result"] = r["result"];
            item["error"] = null;
            maybeStoreCache(state, item);
            counts.completed++;
        }
        else {
            const err = r["error"] || "unknown";
            if (item["attempts"] <= maxRetries) {
                item["status"] = STATUS_PENDING;
                item["started_at"] = null;
                counts.retried++;
            }
            else {
                item["status"] = STATUS_FAILED;
                item["completed_at"] = now();
                counts.failed++;
            }
            item["error"] = err;
        }
    }
    finalizeStatusIfTerminal(state);
    save(runId, state);
    print({ run_id: runId, ...counts, applied: payload.length, run_status: state["status"] });
}
/** View write-back: reflect current item statuses onto a checkbox markdown file. */
function cmdView(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { checkbox: { type: "string" }, folder: { type: "string" } },
    });
    const runId = positionals[0];
    const checkbox = values["checkbox"];
    const folder = values["folder"];
    if (!runId || (!checkbox && !folder))
        die("error: view requires run_id and --checkbox <path> or --folder <path>");
    const state = load(runId);
    const items = Object.values(state["items"]).map((i) => ({
        id: i["id"],
        data: i["data"],
        status: i["status"],
    }));
    if (folder) {
        const moved = writeFolderView(folder, items);
        print({ run_id: runId, view: folder, moved });
        return;
    }
    const changed = writeChecklistView(checkbox, items);
    print({ run_id: runId, view: checkbox, toggled: changed });
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
// ---------- primitive registration ----------
function isDone(state) {
    const items = Object.values(state["items"] ?? {});
    if (items.length === 0)
        return false;
    return items.every((i) => i["status"] === STATUS_DONE || i["status"] === STATUS_FAILED);
}
function hasResidualWork(state) {
    const items = Object.values(state["items"] ?? {});
    const pending = items.filter((i) => i["status"] === STATUS_PENDING).length;
    const inProgress = items.filter((i) => i["status"] === STATUS_IN_PROGRESS).length;
    if (pending === 0 && inProgress === 0)
        return null;
    return [pending, inProgress];
}
function resumeMsg(runId, residual) {
    const [pending, inProgress] = residual;
    return (`/flow:foreach run '${runId}' is not complete: ${pending} pending, ${inProgress} in_progress. ` +
        `Resume the foreach loop for this run-id (do NOT re-init; read the state and process the next batch, ` +
        `dispatching subagents or processing inline per config.execution). ` +
        `If items are stuck in 'in_progress' from a prior session, reset them with the foreach \`reset ${runId} --in-progress-to-pending\` subcommand.`);
}
const PRIM = new Primitive(CMD, {
    isDone,
    hasResidualWork,
    resumeMsg,
    resultPointer: (s) => (s["result_pointer"] ?? null),
});
function main(argv) {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "init":
            return cmdInit(rest);
        case "claim":
            return cmdClaim(rest);
        case "complete":
            return cmdComplete(rest);
        case "fail":
            return cmdFail(rest);
        case "status":
            return cmdStatus(rest);
        case "list":
            return cmdList(rest);
        case "reset":
            return cmdReset(rest);
        case "complete-batch":
            return cmdCompleteBatch(rest);
        case "view":
            return cmdView(rest);
        case "increment-continues": {
            const runId = rest[0];
            if (!runId)
                die("error: increment-continues requires a run_id");
            return PRIM.cliIncrementContinues(runId);
        }
        case "runs":
            return PRIM.cliRuns();
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
