/**
 * Read-only inspection tool over all primitive runs.
 *
 * /inspect is NOT a workflow primitive — no runs, no auto-continue, no state mutation. It
 * queries the state files of every registered primitive, presents them uniformly, and
 * reconstructs cross-primitive provenance (e.g. the child tree of a /pipe run). /board is the
 * session-start dashboard. Faithful port of `inspect_runs.py`.
 *
 * Subcommands: runs | show <id> | tree <id> | budget <id> | timeline <id> | board.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PRIMITIVES, die, getPrimitive, loadState, print, stateDir, statePath } from "./common.js";
// Ensure every primitive self-registers.
import "./state/enumerate.js";
import "./state/foreach.js";
import "./state/group.js";
import "./state/iterate.js";
import "./state/reduce.js";
import "./state/pipe.js";
function round4(n) {
    return Math.round((n ?? 0) * 1e4) / 1e4;
}
/** A node invocation string for advisory output, plugin-root-aware. */
function nodeCmd(script) {
    const root = process.env["CLAUDE_PLUGIN_ROOT"];
    return root ? `node "${root}/dist/${script}"` : `node dist/${script}`;
}
// ---------- discovery ----------
function allRunDirs(cmd) {
    const d = stateDir(cmd);
    if (!existsSync(d))
        return [];
    return readdirSync(d)
        .filter((name) => existsSync(join(d, name, "state.json")))
        .sort();
}
function findAmbiguous(runId) {
    const out = [];
    for (const cmd of PRIMITIVES.keys())
        if (existsSync(statePath(cmd, runId)))
            out.push(cmd);
    return out;
}
function resolveOrExit(runId, cmdFilter) {
    if (cmdFilter) {
        const p = statePath(cmdFilter, runId);
        if (!existsSync(p))
            die(`error: no state at ${p}`);
        return [cmdFilter, loadState(p)];
    }
    const matches = findAmbiguous(runId);
    if (matches.length === 0)
        die(`error: no run found with id '${runId}'`);
    if (matches.length > 1)
        die(`error: run-id '${runId}' is ambiguous; matches: ${matches.join(",")}. Pass --cmd to disambiguate.`);
    const cmd = matches[0];
    return [cmd, loadState(statePath(cmd, runId))];
}
// ---------- commands ----------
function cmdRuns(args) {
    const { values } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, json: { type: "boolean", default: false } } });
    const cmds = values["cmd"] ? [values["cmd"]] : [...PRIMITIVES.keys()];
    const out = [];
    for (const cmd of cmds) {
        for (const name of allRunDirs(cmd)) {
            let s;
            try {
                s = loadState(join(stateDir(cmd), name, "state.json"));
            }
            catch {
                continue;
            }
            const spec = getPrimitive(cmd);
            const done = spec ? spec.isDone(s) : s["status"] === "done";
            const b = s["budget"] ?? {};
            out.push({
                cmd, run_id: name, status: s["status"], is_done: done,
                parent_run_id: s["parent_run_id"] ?? null, created_at: s["created_at"], updated_at: s["updated_at"],
                result_pointer: s["result_pointer"] ?? null, agents: b["agents_dispatched"] ?? 0, usd_est: round4(b["usd_estimate"] ?? 0),
            });
        }
    }
    if (values["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return;
    }
    if (out.length === 0) {
        process.stdout.write("(no runs)\n");
        return;
    }
    const lines = [`${"CMD".padEnd(11)} ${"RUN_ID".padEnd(42)} ${"STATUS".padEnd(13)} ${"DONE".padEnd(5)} ${"AGENTS".padEnd(7)} ${"USD$".padEnd(8)} UPDATED_AT`, "-".repeat(110)];
    for (const e of out) {
        lines.push(`${String(e["cmd"]).padEnd(11)} ${String(e["run_id"]).padEnd(42)} ${String(e["status"]).padEnd(13)} ${String(e["is_done"]).padEnd(5)} ${String(e["agents"]).padEnd(7)} ${Number(e["usd_est"]).toFixed(4).padEnd(8)} ${e["updated_at"]}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
}
/** Chronological history of runs across all primitives — most recent activity first. */
function cmdHistory(args) {
    const { values } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { limit: { type: "string", default: "20" }, cmd: { type: "string" }, json: { type: "boolean", default: false } },
    });
    const cmds = values["cmd"] ? [values["cmd"]] : [...PRIMITIVES.keys()];
    const rows = [];
    for (const cmd of cmds) {
        for (const name of allRunDirs(cmd)) {
            let s;
            try {
                s = loadState(join(stateDir(cmd), name, "state.json"));
            }
            catch {
                continue;
            }
            const spec = getPrimitive(cmd);
            const b = s["budget"] ?? {};
            rows.push({
                updated_at: s["updated_at"] ?? s["created_at"] ?? "",
                cmd,
                run_id: name,
                status: s["status"],
                is_done: spec ? spec.isDone(s) : s["status"] === "done",
                agents: b["agents_dispatched"] ?? 0,
                usd: round4(b["usd_estimate"] ?? 0),
            });
        }
    }
    rows.sort((a, b) => String(b["updated_at"]).localeCompare(String(a["updated_at"]))); // newest first
    const limit = parseInt(values["limit"], 10);
    const out = limit > 0 ? rows.slice(0, limit) : rows;
    if (values["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return;
    }
    if (out.length === 0) {
        process.stdout.write("(no runs yet)\n");
        return;
    }
    const lines = [
        `${"UPDATED_AT".padEnd(21)} ${"CMD".padEnd(10)} ${"RUN_ID".padEnd(34)} ${"STATUS".padEnd(12)} ${"AGENTS".padEnd(7)} USD$`,
        "-".repeat(96),
    ];
    for (const e of out) {
        lines.push(`${String(e["updated_at"]).padEnd(21)} ${String(e["cmd"]).padEnd(10)} ${String(e["run_id"]).padEnd(34)} ${String(e["status"]).padEnd(12)} ${String(e["agents"]).padEnd(7)} ${Number(e["usd"]).toFixed(4)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
}
function cmdShow(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, pretty: { type: "boolean", default: true } } });
    const runId = positionals[0];
    if (!runId)
        die("error: show requires a run_id");
    const [cmd, state] = resolveOrExit(runId, values["cmd"]);
    const spec = getPrimitive(cmd);
    const b = state["budget"] ?? {};
    const summary = {
        cmd, run_id: state["run_id"], status: state["status"], is_done: spec ? spec.isDone(state) : null,
        result_pointer: state["result_pointer"] ?? null, error: state["error"] ?? null, parent_run_id: state["parent_run_id"] ?? null,
        stage_index: state["stage_index"] ?? null, auto_continues: state["auto_continues"] ?? 0,
        created_at: state["created_at"], updated_at: state["updated_at"], started_at: state["started_at"] ?? null, completed_at: state["completed_at"] ?? null,
        budget: { tokens_used: b["tokens_used"] ?? 0, agents_dispatched: b["agents_dispatched"] ?? 0, usd_estimate: round4(b["usd_estimate"] ?? 0) },
        followups_pending: (state["followups"] ?? []).length,
        config_keys: Object.keys(state["config"] ?? {}).sort(),
    };
    if (cmd === "foreach") {
        const items = Object.values(state["items"] ?? {});
        const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
        for (const it of items)
            counts[it["status"] ?? "pending"] = (counts[it["status"] ?? "pending"] ?? 0) + 1;
        summary["items"] = { total: items.length, ...counts };
    }
    else if (cmd === "pipe") {
        summary["stages"] = (state["stages"] ?? []).map((s) => ({
            index: s["index"], name: s["name"], type: s["type"], status: s["status"], child_cmd: s["child_cmd"], child_run_id: s["child_run_id"],
        }));
    }
    else if (cmd === "iterate") {
        summary["iterations"] = state["iteration_count"] ?? 0;
        summary["max_iterations"] = state["config"]?.max_iterations;
        summary["stop_reason"] = state["stop_reason"] ?? null;
    }
    else if (cmd === "group") {
        summary["items_total"] = state["items_total"] ?? 0;
        summary["groups_count"] = state["groups_count"] ?? 0;
        summary["method"] = state["config"]?.method;
    }
    else if (cmd === "enumerate") {
        summary["items_generated"] = state["items_generated"] ?? 0;
    }
    process.stdout.write(JSON.stringify(summary, null, values["pretty"] ? 2 : undefined) + "\n");
}
function tree(cmd, runId, depth, maxDepth, lines) {
    const pad = "  ".repeat(depth);
    if (depth > maxDepth) {
        lines.push(pad + "(depth cap reached)");
        return;
    }
    const p = statePath(cmd, runId);
    if (!existsSync(p)) {
        lines.push(`${pad}[${cmd}] ${runId}  ⚠ state missing`);
        return;
    }
    const state = loadState(p);
    const spec = getPrimitive(cmd);
    const done = spec && spec.isDone(state) ? "✓" : (state["status"] ?? "?");
    const b = state["budget"] ?? {};
    lines.push(`${pad}[${cmd}] ${runId}  status=${done} (agents=${b["agents_dispatched"] ?? 0}, usd≈${(b["usd_estimate"] ?? 0).toFixed(4)})`);
    if (cmd === "pipe") {
        for (const s of state["stages"] ?? []) {
            lines.push("  ".repeat(depth + 1) + `stage[${s["index"]}] ${s["name"]} type=${s["type"]} status=${s["status"]}`);
            if (s["child_cmd"] && s["child_run_id"])
                tree(s["child_cmd"], s["child_run_id"], depth + 2, maxDepth, lines);
        }
    }
}
function cmdTree(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, "max-depth": { type: "string", default: "10" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: tree requires a run_id");
    const matches = findAmbiguous(runId);
    if (matches.length === 0)
        die(`error: no run found with id '${runId}'`);
    let cmd;
    if (values["cmd"])
        cmd = values["cmd"];
    else if (matches.length > 1)
        die(`error: ambiguous; matches ${matches.join(",")}. Pass --cmd.`);
    else
        cmd = matches[0];
    const lines = [];
    tree(cmd, runId, 0, parseInt(values["max-depth"], 10), lines);
    process.stdout.write(lines.join("\n") + "\n");
}
function cmdBudget(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean", default: false } } });
    const runId = positionals[0];
    if (!runId)
        die("error: budget requires a run_id");
    const [cmd] = resolveOrExit(runId);
    const totals = { tokens: 0, agents: 0, usd: 0 };
    const breakdown = [];
    const visit = (c, rid, depth = 0) => {
        const p = statePath(c, rid);
        if (!existsSync(p))
            return;
        const s = loadState(p);
        const b = s["budget"] ?? {};
        breakdown.push({ depth, cmd: c, run_id: rid, tokens: b["tokens_used"] ?? 0, agents: b["agents_dispatched"] ?? 0, usd: round4(b["usd_estimate"] ?? 0) });
        totals.tokens += b["tokens_used"] ?? 0;
        totals.agents += b["agents_dispatched"] ?? 0;
        totals.usd += b["usd_estimate"] ?? 0;
        if (c === "pipe")
            for (const stage of s["stages"] ?? [])
                if (stage["child_cmd"] && stage["child_run_id"])
                    visit(stage["child_cmd"], stage["child_run_id"], depth + 1);
    };
    visit(cmd, runId, 0);
    if (values["json"]) {
        process.stdout.write(JSON.stringify({ run_id: runId, cmd, totals: { tokens: totals.tokens, agents: totals.agents, usd: round4(totals.usd) }, breakdown }, null, 2) + "\n");
        return;
    }
    const lines = [`[${cmd}] ${runId}  total: tokens=${totals.tokens}, agents=${totals.agents}, usd≈${totals.usd.toFixed(4)}`];
    for (const b of breakdown)
        lines.push(`  ${"  ".repeat(b["depth"])}[${b["cmd"]}] ${b["run_id"]}  tokens=${b["tokens"]} agents=${b["agents"]} usd=${b["usd"]}`);
    process.stdout.write(lines.join("\n") + "\n");
}
function cmdTimeline(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { limit: { type: "string", default: "20" } } });
    const runId = positionals[0];
    if (!runId)
        die("error: timeline requires a run_id");
    const [cmd, state] = resolveOrExit(runId);
    const b = state["budget"] ?? {};
    const limit = parseInt(values["limit"], 10);
    const events = (b["events"] ?? []);
    const lines = [
        `[${cmd}] ${state["run_id"]}  status=${state["status"]}`,
        `  created_at:   ${state["created_at"]}`,
        `  started_at:   ${state["started_at"] ?? null}`,
        `  updated_at:   ${state["updated_at"]}`,
        `  completed_at: ${state["completed_at"] ?? null}`,
        `  auto_continues: ${state["auto_continues"] ?? 0}`,
        `  budget events (${events.length}):`,
    ];
    for (const ev of events.slice(-limit))
        lines.push(`    ${ev["at"]}  ${ev["type"]}  tokens=${ev["tokens"]} usd=${ev["usd"]} model=${ev["model"]}`);
    process.stdout.write(lines.join("\n") + "\n");
}
function cmdBoard(args) {
    const { values } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean", default: false }, "no-failed": { type: "boolean", default: false } } });
    const active = [];
    const done = [];
    const failed = [];
    const stuck = [];
    let totalUsd = 0;
    let totalTokens = 0;
    for (const cmd of PRIMITIVES.keys()) {
        for (const name of allRunDirs(cmd)) {
            let s;
            try {
                s = loadState(join(stateDir(cmd), name, "state.json"));
            }
            catch {
                continue;
            }
            const spec = getPrimitive(cmd);
            const isDone = spec ? spec.isDone(s) : s["status"] === "done";
            const b = s["budget"] ?? {};
            const usd = round4(b["usd_estimate"] ?? 0);
            const tokens = b["tokens_used"] ?? 0;
            totalUsd += usd;
            totalTokens += tokens;
            const entry = {
                cmd, run_id: name, status: s["status"], is_done: isDone, updated_at: s["updated_at"],
                auto_continues: s["auto_continues"] ?? 0, max_auto_continues: s["config"]?.max_auto_continues ?? 0,
                usd, tokens, parent_run_id: s["parent_run_id"] ?? null, error: s["error"] ?? null,
            };
            if (cmd === "foreach") {
                const items = Object.values(s["items"] ?? {});
                const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
                for (const it of items)
                    counts[it["status"] ?? "pending"] = (counts[it["status"] ?? "pending"] ?? 0) + 1;
                entry["progress"] = `${counts["done"]}/${items.length}`;
                if ((counts["in_progress"] ?? 0) > 0 && !isDone)
                    stuck.push({ ...entry, reason: `${counts["in_progress"]} items stuck in_progress` });
            }
            else if (cmd === "pipe") {
                const stages = s["stages"] ?? [];
                const doneStages = stages.filter((x) => x["status"] === "done").length;
                entry["progress"] = `${doneStages}/${stages.length} stages`;
            }
            else if (cmd === "iterate") {
                entry["progress"] = `${s["iteration_count"] ?? 0}/${s["config"]?.max_iterations ?? "?"} iters`;
            }
            else if (cmd === "group") {
                entry["progress"] = `${s["groups_count"] ?? 0} groups`;
            }
            else {
                entry["progress"] = "—";
            }
            if (s["status"] === "failed")
                failed.push(entry);
            else if (isDone)
                done.push(entry);
            else {
                active.push(entry);
                if (entry["max_auto_continues"] && entry["auto_continues"] >= entry["max_auto_continues"])
                    stuck.push({ ...entry, reason: "auto_continues cap exhausted" });
            }
        }
    }
    if (values["json"]) {
        process.stdout.write(JSON.stringify({ active, done, failed, stuck, totals: { usd: round4(totalUsd), tokens: totalTokens } }, null, 2) + "\n");
        return;
    }
    const lines = [`=== Workspace board (${active.length} active, ${done.length} done, ${failed.length} failed) ===`, `Cumulative cost: ~$${totalUsd.toFixed(4)}  (${totalTokens} tokens recorded)`, ""];
    if (active.length) {
        lines.push(`ACTIVE (${active.length}):`);
        for (const e of active) {
            const parent = e["parent_run_id"] ? ` [child of ${e["parent_run_id"]}]` : "";
            lines.push(`  [${String(e["cmd"]).padEnd(10)}] ${String(e["run_id"]).padEnd(42)} ${String(e["progress"]).padEnd(22)} updated ${e["updated_at"]}${parent}`);
        }
        lines.push("");
    }
    if (stuck.length) {
        lines.push(`BLOCKERS (${stuck.length}):`);
        for (const e of stuck)
            lines.push(`  [WARN] [${e["cmd"]}] ${e["run_id"]}: ${e["reason"]}`);
        lines.push("");
    }
    if (failed.length && !values["no-failed"]) {
        lines.push(`FAILED (${failed.length}):`);
        for (const e of failed.slice(0, 5))
            lines.push(`  [FAIL] [${e["cmd"]}] ${e["run_id"]}: ${String(e["error"] ?? "").slice(0, 80)}`);
        if (failed.length > 5)
            lines.push(`  ... and ${failed.length - 5} more — use \`${nodeCmd("inspect.js")} runs\` for the full list`);
        lines.push("");
    }
    if (!active.length && !failed.length) {
        lines.push("Nothing active. Clean slate.");
        process.stdout.write(lines.join("\n") + "\n");
        return;
    }
    lines.push("Suggested next actions:");
    const pipeRuns = active.filter((e) => e["cmd"] === "pipe");
    if (pipeRuns.length) {
        const top = pipeRuns[0];
        lines.push(`  - \`${nodeCmd("state/pipe.js")} drive ${top["run_id"]}\` — auto-advance the pipe until an Agent dispatch is needed`);
        lines.push(`  - \`${nodeCmd("inspect.js")} tree ${top["run_id"]}\` — see the full child tree`);
    }
    const enumActive = active.filter((e) => e["cmd"] === "foreach");
    if (enumActive.length && !pipeRuns.length) {
        const top = enumActive[0];
        lines.push(`  - Send any message and the Stop hook will resume /agentflow:foreach '${top["run_id"]}' automatically`);
    }
    for (const e of stuck.slice(0, 2)) {
        if (String(e["reason"]).includes("stuck in_progress"))
            lines.push(`  - \`${nodeCmd(`state/${e["cmd"]}.js`)} reset ${e["run_id"]} --in-progress-to-pending\``);
        if (String(e["reason"]).includes("cap exhausted"))
            lines.push(`  - Bump max_auto_continues on '${e["run_id"]}' (edit state.json) or finalize the run`);
    }
    process.stdout.write(lines.join("\n") + "\n");
}
function main(argv) {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "runs":
            return cmdRuns(rest);
        case "history":
            return cmdHistory(rest);
        case "show":
            return cmdShow(rest);
        case "tree":
            return cmdTree(rest);
        case "budget":
            return cmdBudget(rest);
        case "timeline":
            return cmdTimeline(rest);
        case "board":
            return cmdBoard(rest);
        default:
            die(`error: unknown subcommand '${sub ?? ""}' (runs|history|show|tree|budget|timeline|board)`);
    }
}
main(process.argv.slice(2));
