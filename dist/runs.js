/**
 * /runs — observe and CONTROL the engine's top-level jobs.
 *
 * A *job* is a run you launched directly (a workflow/`pipe`, a `do`, or a standalone primitive).
 * `pipe` sub-runs (its stages) belong to their parent pipeline and are not listed as jobs.
 *
 * Unlike /inspect and /board (read-only), /runs MUTATES state:
 *   runs [list] [--all] [--json]      list top-level jobs in scheduling order (the queue)
 *   runs stop <id>                    pause one job (and its whole subtree)
 *   runs resume <id>                  resume one paused job
 *   runs rm <id> [--force]            delete a run and its subtree
 *   runs clean [--failed|--all] [--older-than <dur>] [--dry-run]   GC finished runs
 *   runs pause                        pause the WHOLE engine (global stop button)
 *   runs resume                       resume the whole engine     (no id → global)
 *   runs priority <id> <n>            set a job's scheduling priority (higher runs sooner)
 *
 * The two pause levels are independent and composable: `pause` (global, the `.agentflow/PAUSED`
 * sentinel) freezes everything; `stop <id>` pauses just one job. The Stop hook honors both.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { PRIMITIVES, childToParent, die, getPrimitive, isGloballyPaused, isPaused, isHelp, loadState, now, print, printUsage, saveAtomic, setGlobalPause, splitRunKey, statePath, topLevelRunKeys, } from "./common.js";
// Ensure every primitive self-registers (PRIMITIVES populated, same set the hook schedules over).
import "./state/enumerate.js";
import "./state/foreach.js";
import "./state/group.js";
import "./state/iterate.js";
import "./state/reduce.js";
import "./state/queue.js";
import "./state/step.js";
import "./state/pipe.js";
const TERMINAL = new Set(["done", "failed", "aborted"]);
function round4(n) {
    return Math.round((n ?? 0) * 1e4) / 1e4;
}
// ---------- resolution & tree helpers ----------
/** Resolve a bare run-id to its [cmd, run_id] across all primitives; `<cmd>/<id>` or --cmd disambiguate. */
function resolveRun(idArg, cmdFilter) {
    if (idArg.includes("/")) {
        const [c, r] = splitRunKey(idArg);
        if (!existsSync(statePath(c, r)))
            die(`error: no run at ${c}/${r}`);
        return [c, r];
    }
    if (cmdFilter) {
        if (!existsSync(statePath(cmdFilter, idArg)))
            die(`error: no run '${idArg}' under ${cmdFilter}`);
        return [cmdFilter, idArg];
    }
    const matches = [...PRIMITIVES.keys()].filter((c) => existsSync(statePath(c, idArg)));
    if (matches.length === 0)
        die(`error: no run found with id '${idArg}'`);
    if (matches.length > 1)
        die(`error: run-id '${idArg}' is ambiguous (matches ${matches.join(", ")}); use <cmd>/${idArg}`);
    return [matches[0], idArg];
}
/** Invert childToParent into parent→[children] for subtree walks. */
function parentToChildren(childMap) {
    const inv = new Map();
    for (const [child, parent] of childMap) {
        const arr = inv.get(parent) ?? [];
        arr.push(child);
        inv.set(parent, arr);
    }
    return inv;
}
/** A run key plus every descendant sub-run, depth-first (self first). */
function subtreeKeys(key, inv) {
    const out = [];
    const seen = new Set();
    const walk = (k) => {
        if (seen.has(k))
            return;
        seen.add(k);
        out.push(k);
        for (const c of inv.get(k) ?? [])
            walk(c);
    };
    walk(key);
    return out;
}
function runDir(cmd, runId) {
    return dirname(statePath(cmd, runId));
}
// ---------- presentation helpers ----------
function progressOf(cmd, s) {
    if (cmd === "foreach") {
        const items = Object.values(s["items"] ?? {});
        const done = items.filter((i) => i["status"] === "done").length;
        return `${done}/${items.length} items`;
    }
    if (cmd === "pipe") {
        const stages = (s["stages"] ?? []);
        const done = stages.filter((x) => x["status"] === "done").length;
        return `${done}/${stages.length} stages`;
    }
    if (cmd === "iterate")
        return `${s["iteration_count"] ?? 0}/${s["config"]?.max_iterations ?? "?"} iters`;
    if (cmd === "group")
        return `${s["groups_count"] ?? 0} groups`;
    return "—";
}
/** Effective status for display: global pause and per-job pause take precedence over the raw status. */
function effectiveStatus(cmd, s, globally) {
    const spec = getPrimitive(cmd);
    const raw = String(s["status"] ?? "?");
    if (TERMINAL.has(raw))
        return raw;
    if (spec && spec.isDone(s))
        return "done";
    if (globally)
        return "paused (engine)";
    const [paused, reason] = isPaused(s);
    if (paused)
        return s["paused"] === true ? "paused" : `paused (${reason})`;
    return raw;
}
function parseDuration(spec) {
    const m = /^(\d+)\s*([smhdw])$/.exec(spec.trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
    return n * mult[unit];
}
function ageMs(s) {
    const t = Date.parse(String(s["updated_at"] ?? s["created_at"] ?? ""));
    return Number.isFinite(t) ? Date.now() - t : 0;
}
function loadTopLevelJobs() {
    const childMap = childToParent();
    const order = [...PRIMITIVES.keys()];
    const rows = [];
    for (const key of topLevelRunKeys(childMap)) {
        const [cmd, runId] = splitRunKey(key);
        let s;
        try {
            s = loadState(statePath(cmd, runId));
        }
        catch {
            continue;
        }
        rows.push({
            key,
            cmd,
            run_id: runId,
            state: s,
            status: String(s["status"] ?? "?"),
            priority: Number(s["priority"] ?? s["config"]?.priority ?? 0) || 0,
            created_at: String(s["created_at"] ?? ""),
            reg: order.indexOf(cmd) < 0 ? 999 : order.indexOf(cmd),
        });
    }
    return rows;
}
function cmdList(args) {
    const { values } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { all: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    });
    const globally = isGloballyPaused();
    let jobs = loadTopLevelJobs();
    // Schedulable jobs (the queue the Stop hook would walk): non-terminal, not paused, engine running.
    const schedulable = jobs.filter((j) => {
        const spec = getPrimitive(j.cmd);
        const done = spec ? spec.isDone(j.state) : TERMINAL.has(j.status);
        return !TERMINAL.has(j.status) && !done && !isPaused(j.state)[0];
    });
    schedulable.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.reg - b.reg || a.run_id.localeCompare(b.run_id));
    const pos = new Map();
    if (!globally)
        schedulable.forEach((j, i) => pos.set(j.key, i + 1));
    if (!values["all"]) {
        jobs = jobs.filter((j) => {
            const spec = getPrimitive(j.cmd);
            const done = spec ? spec.isDone(j.state) : false;
            return !TERMINAL.has(j.status) && !done;
        });
    }
    // Stable display order: queued jobs first (by position), then the rest by recency.
    jobs.sort((a, b) => {
        const pa = pos.get(a.key) ?? 1e9;
        const pb = pos.get(b.key) ?? 1e9;
        return pa - pb || String(b.state["updated_at"]).localeCompare(String(a.state["updated_at"]));
    });
    if (values["json"]) {
        const out = jobs.map((j) => {
            const b = j.state["budget"] ?? {};
            return {
                pos: pos.get(j.key) ?? null,
                cmd: j.cmd,
                run_id: j.run_id,
                status: effectiveStatus(j.cmd, j.state, globally),
                priority: j.priority,
                progress: progressOf(j.cmd, j.state),
                created_at: j.created_at,
                updated_at: j.state["updated_at"] ?? null,
                usd_est: round4(b["usd_estimate"] ?? 0),
            };
        });
        process.stdout.write(JSON.stringify({ global_paused: globally, jobs: out }, null, 2) + "\n");
        return;
    }
    const lines = [];
    if (globally)
        lines.push("⏸  ENGINE PAUSED — no run auto-resumes. `runs resume` to unfreeze.\n");
    if (jobs.length === 0) {
        process.stdout.write((globally ? lines.join("\n") + "\n" : "") + "(no top-level jobs)\n");
        return;
    }
    lines.push(`${"POS".padEnd(4)} ${"CMD".padEnd(10)} ${"RUN_ID".padEnd(34)} ${"STATUS".padEnd(18)} ${"PROGRESS".padEnd(16)} ${"PRIO".padEnd(5)} UPDATED_AT`);
    lines.push("-".repeat(112));
    for (const j of jobs) {
        const p = pos.get(j.key);
        lines.push(`${(p ? `#${p}` : "·").padEnd(4)} ${j.cmd.padEnd(10)} ${j.run_id.slice(0, 34).padEnd(34)} ${effectiveStatus(j.cmd, j.state, globally).padEnd(18)} ${progressOf(j.cmd, j.state).padEnd(16)} ${String(j.priority).padEnd(5)} ${j.state["updated_at"] ?? ""}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
}
function cmdStop(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" } } });
    const idArg = positionals[0];
    if (!idArg)
        die("error: stop requires a run-id (or use `runs pause` to pause the whole engine)");
    const [cmd, runId] = resolveRun(idArg, values["cmd"]);
    const p = statePath(cmd, runId);
    const state = loadState(p);
    state["paused"] = true;
    state["updated_at"] = now();
    saveAtomic(p, state);
    print({ stopped: `${cmd}/${runId}`, paused: true, note: "this job (and its subtree) will not auto-resume until `runs resume`" });
}
function cmdResume(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" } } });
    const idArg = positionals[0];
    // No id → resume the whole engine (counterpart of `runs pause`).
    if (!idArg) {
        const changed = setGlobalPause(false);
        print({ scope: "global", resumed: changed, note: changed ? "engine resumed" : "engine was not paused" });
        return;
    }
    const [cmd, runId] = resolveRun(idArg, values["cmd"]);
    const p = statePath(cmd, runId);
    const state = loadState(p);
    state["paused"] = false;
    state["updated_at"] = now();
    saveAtomic(p, state);
    print({ resumed: `${cmd}/${runId}`, paused: false });
}
function cmdPause(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    if (positionals[0])
        die("error: `runs pause` is global (takes no id). To pause one job use `runs stop <id>`.");
    const changed = setGlobalPause(true);
    print({ scope: "global", paused: changed, note: changed ? "engine paused — no run auto-resumes" : "engine was already paused" });
}
function cmdRm(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { cmd: { type: "string" }, force: { type: "boolean", default: false } },
    });
    const idArg = positionals[0];
    if (!idArg)
        die("error: rm requires a run-id");
    const [cmd, runId] = resolveRun(idArg, values["cmd"]);
    const key = `${cmd}/${runId}`;
    const childMap = childToParent();
    const state = loadState(statePath(cmd, runId));
    const spec = getPrimitive(cmd);
    const terminal = TERMINAL.has(String(state["status"])) || (spec ? spec.isDone(state) : false);
    if (!values["force"]) {
        const parentKey = childMap.get(key);
        if (parentKey) {
            const [pc, pr] = splitRunKey(parentKey);
            const parent = existsSync(statePath(pc, pr)) ? loadState(statePath(pc, pr)) : null;
            const parentTerminal = parent ? TERMINAL.has(String(parent["status"])) : true;
            if (!parentTerminal)
                die(`error: '${key}' is a child of running pipe '${parentKey}'; removing it would break the parent. Stop the parent first, or use --force.`);
        }
        else if (!terminal) {
            die(`error: '${key}' is still active (status=${state["status"]}). Pause it (\`runs stop ${runId}\`) and finish/abort it, or use --force.`);
        }
    }
    const inv = parentToChildren(childMap);
    const keys = subtreeKeys(key, inv);
    const removed = [];
    for (const k of keys) {
        const [c, r] = splitRunKey(k);
        const d = runDir(c, r);
        if (existsSync(d)) {
            rmSync(d, { recursive: true, force: true });
            removed.push(k);
        }
    }
    print({ removed, count: removed.length });
}
function cmdClean(args) {
    const { values } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            failed: { type: "boolean", default: false },
            all: { type: "boolean", default: false },
            "older-than": { type: "string" },
            "dry-run": { type: "boolean", default: false },
        },
    });
    // Which terminal statuses to reclaim. Default: completed only. Additive flags widen the set.
    const wanted = new Set(["done"]);
    if (values["failed"] || values["all"])
        wanted.add("failed");
    if (values["all"])
        wanted.add("aborted");
    let minAge = 0;
    if (values["older-than"]) {
        const parsed = parseDuration(values["older-than"]);
        if (parsed === null)
            die(`error: --older-than must look like 30m, 24h, 7d, 2w (got '${values["older-than"]}')`);
        minAge = parsed;
    }
    const childMap = childToParent();
    const inv = parentToChildren(childMap);
    const selected = [];
    for (const job of loadTopLevelJobs()) {
        const spec = getPrimitive(job.cmd);
        const done = spec ? spec.isDone(job.state) : job.status === "done";
        const status = done ? "done" : job.status; // an isDone foreach may still read in_progress
        if (!wanted.has(status))
            continue;
        if (minAge && ageMs(job.state) < minAge)
            continue;
        selected.push({ key: job.key, status });
    }
    const dry = values["dry-run"];
    const removed = [];
    for (const sel of selected) {
        for (const k of subtreeKeys(sel.key, inv)) {
            const [c, r] = splitRunKey(k);
            const d = runDir(c, r);
            if (!existsSync(d))
                continue;
            if (!dry)
                rmSync(d, { recursive: true, force: true });
            removed.push(k);
        }
    }
    print({
        dry_run: dry,
        cleaned_jobs: selected.map((s) => `${s.key} (${s.status})`),
        runs_removed: removed.length,
        statuses: [...wanted],
        older_than: values["older-than"] ?? null,
    });
}
function cmdPriority(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" } } });
    const idArg = positionals[0];
    const nArg = positionals[1];
    if (!idArg || nArg === undefined)
        die("error: priority requires <run-id> <n> (integer; higher runs sooner)");
    const n = parseInt(nArg, 10);
    if (!Number.isFinite(n))
        die(`error: priority must be an integer, got '${nArg}'`);
    const [cmd, runId] = resolveRun(idArg, values["cmd"]);
    const p = statePath(cmd, runId);
    const state = loadState(p);
    state["priority"] = n;
    state["updated_at"] = now();
    saveAtomic(p, state);
    print({ run: `${cmd}/${runId}`, priority: n });
}
function main(argv) {
    const [sub, ...rest] = argv;
    if (isHelp(sub))
        return printUsage("runs", ["list", "stop", "resume", "pause", "rm", "clean", "priority"]);
    switch (sub) {
        case "list":
        case "ls":
            return cmdList(rest);
        case "stop":
            return cmdStop(rest);
        case "resume":
            return cmdResume(rest);
        case "pause":
            return cmdPause(rest);
        case "rm":
            return cmdRm(rest);
        case "clean":
            return cmdClean(rest);
        case "priority":
            return cmdPriority(rest);
        default:
            // A leading flag and no subcommand (`runs --all`, `runs --json`) → list with those flags.
            if (sub && sub.startsWith("-"))
                return cmdList(argv);
            die(`error: unknown subcommand '${sub}' (list|stop|resume|pause|rm|clean|priority)`);
    }
}
main(process.argv.slice(2));
