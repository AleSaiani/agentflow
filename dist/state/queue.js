/**
 * State manager for /queue — a lock-free shared work queue that MANY worker instances can drain
 * concurrently and safely, without locks.
 *
 * The trick: each item is a file under the run dir, and a worker claims it with an **atomic rename**
 * (`pending/<id> → claimed/<id>`). On a filesystem, rename is atomic, so if two workers race for the
 * same file exactly one wins and the other gets ENOENT (and simply tries the next item). No locks, no
 * shared-state contention — the opposite of foreach's single-writer `state.json` (use foreach for a
 * single orchestrator; use queue to fan ONE queue across N terminals/processes).
 *
 * Layout: `.agentflow/queue/<id>/{state.json, pending/, claimed/, done/, failed/}`. Items move between
 * the dirs; `state.json` only holds config. Supports dynamic `add`, `--stop-file`/budget pause, and a
 * `reclaim` sweep that returns a dead worker's stale claims to `pending/`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Primitive, die, isHelp, printUsage, isPaused, loadState, makeBaseState, markDone, now, parseBudgetCaps, print, saveAtomic, statePath, } from "../common.js";
import { loadSource } from "../source.js";
const CMD = "queue";
const DIRS = ["pending", "claimed", "done", "failed"];
function pathFor(runId) {
    return statePath(CMD, runId);
}
function runDir(runId) {
    return dirname(pathFor(runId));
}
function sub(runId, name) {
    return join(runDir(runId), name);
}
function load(runId) {
    return loadState(pathFor(runId));
}
function save(runId, state) {
    state["updated_at"] = now();
    saveAtomic(pathFor(runId), state);
}
/**
 * Collision-free, filesystem-safe filename for an item id. A readable slug + a hash of the FULL id,
 * so distinct ids that slug to the same text (`a/b`, `a:b`, `a b`) get distinct files — no silent
 * work loss. Deterministic, so complete/fail recompute the same name from the id.
 */
function sanitize(id) {
    const slug = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "item";
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 10);
    return `${slug}-${hash}.json`;
}
function countDir(runId, name) {
    const d = sub(runId, name);
    if (!existsSync(d))
        return 0;
    return readdirSync(d).filter((f) => f.endsWith(".json")).length;
}
/** Write one item into pending/ (skips if a file with that id already exists anywhere in the queue). */
function enqueue(runId, it) {
    const fname = sanitize(it.id);
    for (const d of DIRS)
        if (existsSync(join(sub(runId, d), fname)))
            return false;
    const payload = { id: it.id, data: it.data ?? {}, task: it.task ?? null, attempts: 0, enqueued_at: now() };
    writeFileSync(join(sub(runId, "pending"), fname), JSON.stringify(payload, null, 2), "utf8");
    return true;
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
            prompt: { type: "string" },
            "stop-file": { type: "string" },
            "max-usd": { type: "string" },
            "max-tokens": { type: "string" },
            "max-agents": { type: "string" },
            "max-retries": { type: "string", default: "1" },
            "auto-continue": { type: "boolean" },
            "no-auto-continue": { type: "boolean" },
            "max-auto-continues": { type: "string", default: "50" },
            force: { type: "boolean", default: false },
            "validate-only": { type: "boolean", default: false },
        },
    });
    const runId = positionals[0];
    if (!runId)
        die("error: init requires a run_id");
    if (values["validate-only"])
        return print({ valid: true });
    const provided = [values["items"], values["checkbox"], values["folder"], values["source"]].filter(Boolean).length;
    if (provided !== 1)
        die("error: provide exactly one of --items, --checkbox, --folder, --source");
    let items;
    if (values["checkbox"])
        items = loadSource({ source: "checkbox", path: values["checkbox"] });
    else if (values["folder"])
        items = loadSource({ source: "folder", path: values["folder"] });
    else if (values["source"])
        items = loadSource(JSON.parse(values["source"]));
    else {
        const raw = JSON.parse(readFileSync(values["items"], "utf8"));
        if (!Array.isArray(raw))
            die("error: items file must contain a JSON array");
        items = raw.map((r, i) => ({
            id: String(r["id"] ?? i),
            data: r["data"] ?? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id")),
            status: "pending",
            ...(r["task"] ? { task: r["task"] } : {}),
        }));
    }
    const p = pathFor(runId);
    if (existsSync(p) && !values["force"])
        die(`error: queue already exists at ${p}; use --force to overwrite`);
    for (const d of DIRS)
        mkdirSync(sub(runId, d), { recursive: true });
    const state = makeBaseState(CMD, runId, {
        task_prompt: values["prompt"] ?? "",
        max_retries: parseInt(values["max-retries"], 10),
        auto_continue: values["no-auto-continue"] ? false : true,
        max_auto_continues: parseInt(values["max-auto-continues"], 10),
        stop_file: values["stop-file"] ? resolve(values["stop-file"]) : null,
        budget_caps: parseBudgetCaps(values),
    }, { total_enqueued: 0 });
    save(runId, state);
    let added = 0;
    for (const it of items)
        if (enqueue(runId, it))
            added++;
    state["total_enqueued"] = added;
    save(runId, state);
    print({ run_id: runId, enqueued: added, path: p });
}
function cmdAdd(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { items: { type: "string" }, source: { type: "string" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: add requires a run_id");
    const state = load(runId);
    let items;
    if (values["source"])
        items = loadSource(JSON.parse(values["source"]));
    else if (values["items"]) {
        const raw = JSON.parse(readFileSync(values["items"], "utf8"));
        if (!Array.isArray(raw))
            die("error: items file must contain a JSON array");
        items = raw.map((r, i) => ({ id: String(r["id"] ?? `${now()}-${i}`), data: r["data"] ?? r, status: "pending" }));
    }
    else {
        die("error: add requires --items or --source");
    }
    let added = 0;
    for (const it of items)
        if (enqueue(runId, it))
            added++;
    state["total_enqueued"] = (state["total_enqueued"] ?? 0) + added;
    if (state["status"] === "done")
        state["status"] = "in_progress"; // reopened by new work
    save(runId, state);
    print({ run_id: runId, added });
}
/** Atomically claim the next pending item (rename pending→claimed). Returns {item:null} when empty/paused. */
function cmdClaim(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { worker: { type: "string" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: claim requires a run_id");
    const state = load(runId);
    const worker = values["worker"] || `${hostname()}-${process.pid}`;
    if (isPaused(state)[0])
        return print({ item: null, paused: true, reason: isPaused(state)[1] });
    const pendingDir = sub(runId, "pending");
    const claimedDir = sub(runId, "claimed");
    for (const fname of readdirSync(pendingDir).filter((f) => f.endsWith(".json")).sort()) {
        const from = join(pendingDir, fname);
        const to = join(claimedDir, fname);
        try {
            renameSync(from, to); // ATOMIC: only one racing worker wins; the loser throws ENOENT below
        }
        catch {
            continue; // another worker grabbed it first — try the next
        }
        const item = JSON.parse(readFileSync(to, "utf8"));
        item["claimed_by"] = worker;
        item["claimed_at"] = now();
        item["attempts"] = (item["attempts"] ?? 0) + 1;
        writeFileSync(to, JSON.stringify(item, null, 2), "utf8");
        if (state["status"] === "pending") {
            state["status"] = "in_progress";
            save(runId, state);
        }
        return print({ item, task_prompt: state["config"]["task_prompt"] ?? "" });
    }
    return print({ item: null });
}
function moveClaimed(runId, itemId, dest, patch) {
    const fname = sanitize(itemId);
    const from = join(sub(runId, "claimed"), fname);
    if (!existsSync(from))
        die(`error: item '${itemId}' is not claimed (no ${fname} in claimed/)`);
    const item = JSON.parse(readFileSync(from, "utf8"));
    Object.assign(item, patch);
    const to = join(sub(runId, dest), fname);
    writeFileSync(from, JSON.stringify(item, null, 2), "utf8");
    renameSync(from, to);
    return item;
}
function cmdComplete(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { result: { type: "string", default: "" } } });
    const [runId, itemId] = positionals;
    if (!runId || !itemId)
        die("error: complete requires run_id and item_id");
    const state = load(runId);
    moveClaimed(runId, itemId, "done", { result: values["result"] ? JSON.parse(values["result"]) : null, completed_at: now(), error: null });
    finalizeIfDrained(runId, state);
    save(runId, state);
    print({ id: itemId, status: "done", remaining: countDir(runId, "pending") + countDir(runId, "claimed") });
}
function cmdFail(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { error: { type: "string", default: "" }, retry: { type: "boolean", default: false } } });
    const [runId, itemId] = positionals;
    if (!runId || !itemId)
        die("error: fail requires run_id and item_id");
    const state = load(runId);
    const fname = sanitize(itemId);
    const cur = JSON.parse(readFileSync(join(sub(runId, "claimed"), fname), "utf8"));
    const maxRetries = state["config"]["max_retries"] ?? 1;
    const retry = values["retry"] && (cur["attempts"] ?? 1) <= maxRetries;
    moveClaimed(runId, itemId, retry ? "pending" : "failed", { error: values["error"], ...(retry ? { claimed_by: null, claimed_at: null } : { completed_at: now() }) });
    finalizeIfDrained(runId, state);
    save(runId, state);
    print({ id: itemId, status: retry ? "pending" : "failed", retried: retry });
}
/** Return claimed items whose claim is older than `--older-than` seconds to pending/ (dead-worker recovery). */
function cmdReclaim(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { "older-than": { type: "string", default: "900" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: reclaim requires a run_id");
    const olderThan = parseInt(values["older-than"], 10) * 1000;
    const claimedDir = sub(runId, "claimed");
    let reclaimed = 0;
    for (const fname of existsSync(claimedDir) ? readdirSync(claimedDir).filter((f) => f.endsWith(".json")) : []) {
        const full = join(claimedDir, fname);
        if (Date.now() - statSync(full).mtimeMs < olderThan)
            continue;
        const item = JSON.parse(readFileSync(full, "utf8"));
        item["claimed_by"] = null;
        item["claimed_at"] = null;
        writeFileSync(full, JSON.stringify(item, null, 2), "utf8");
        renameSync(full, join(sub(runId, "pending"), fname));
        reclaimed++;
    }
    print({ run_id: runId, reclaimed });
}
function counts(runId) {
    return { pending: countDir(runId, "pending"), claimed: countDir(runId, "claimed"), done: countDir(runId, "done"), failed: countDir(runId, "failed") };
}
function finalizeIfDrained(runId, state) {
    const c = counts(runId);
    if (c["pending"] === 0 && c["claimed"] === 0 && state["status"] !== "done")
        markDone(state, runDir(runId));
}
function cmdStatus(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const runId = positionals[0];
    if (!runId)
        die("error: status requires a run_id");
    const state = load(runId);
    const [paused, reason] = isPaused(state);
    print({ run_id: runId, run_status: state["status"], paused, paused_reason: reason, ...counts(runId), config: state["config"] });
}
function cmdList(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { status: { type: "string", default: "pending" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: list requires a run_id");
    const which = values["status"];
    if (!DIRS.includes(which))
        die(`error: --status must be one of ${DIRS.join(",")}`);
    const d = sub(runId, which);
    const out = (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort() : []).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")));
    print(out);
}
// ---------- primitive registration ----------
function isDone(state) {
    return state["status"] === "done";
}
function hasResidualWork(state) {
    const runId = state["run_id"];
    const c = counts(runId);
    if (c["pending"] === 0 && c["claimed"] === 0)
        return null;
    return [c["pending"] ?? 0, c["claimed"] ?? 0];
}
function resumeMsg(runId, work) {
    const [pending, claimed] = work;
    return (`/agentflow:queue run '${runId}' still has work: ${pending} pending, ${claimed} claimed. Resume the ` +
        `drain loop: \`claim ${runId}\` the next item, process it, then \`complete ${runId} <id>\` (or \`fail … --retry\`); ` +
        `repeat until claim returns {item:null}. If items are stuck claimed from a dead worker, run ` +
        `\`reclaim ${runId} --older-than <sec>\` first.`);
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
        return printUsage(CMD, ["init", "add", "claim", "complete", "fail", "reclaim", "status", "list", "runs", "budget-add", "increment-continues"]);
    switch (sub) {
        case "init":
            return cmdInit(rest);
        case "add":
            return cmdAdd(rest);
        case "claim":
            return cmdClaim(rest);
        case "complete":
            return cmdComplete(rest);
        case "fail":
            return cmdFail(rest);
        case "reclaim":
            return cmdReclaim(rest);
        case "status":
            return cmdStatus(rest);
        case "list":
            return cmdList(rest);
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
export { PRIM };
