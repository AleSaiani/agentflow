/**
 * Generalized Stop hook: forces Claude to continue active runs of any primitive.
 *
 * Driven by the `PRIMITIVES` registry in common.ts. Every primitive self-registers at import
 * time. This hook scans the runtime dir of each registered primitive, finds runs with
 * `auto_continue=true` and residual work, and emits `{"decision":"block","reason":"..."}` to
 * block turn termination — the continuity engine that carries loops across turns.
 *
 * Scheduling (one run-step per turn): when several top-level jobs are in flight, they advance in a
 * defined order — by priority (desc) then oldest-job-first (FIFO over the job's created_at), so a
 * batch is processed predictably rather than alphabetically. Within a single job, a `pipe`'s
 * children still advance before the parent (registry order is the tiebreaker). Round-robin
 * fairness across jobs is deferred — FIFO runs the oldest job to completion first.
 *
 * Global pause: if the `.agentflow/PAUSED` sentinel exists, the hook does nothing (every run is
 * frozen, state preserved). A single job is paused via its own `paused` flag / stop-file / cap.
 *
 * Safety cap: per-run `auto_continues`, capped at `max_auto_continues`. Atomic pre-increment
 * guarantees the counter advances even if Claude makes no real progress next turn.
 *
 * Adding a new primitive requires NO changes here — just import a module that calls
 * registerPrimitive() at load. Faithful port of `claude_continue.py`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMITIVES, childToParent, isGloballyPaused, isPaused, rootJobKey, saveAtomic, splitRunKey, stateDir, tryLoadState, } from "../common.js";
// Import every state module so they self-register into PRIMITIVES.
// Order matters: /pipe yields to its primitive children, so children must come FIRST
// (children's residual work is detected before /pipe's "advance" residual).
import "../state/enumerate.js";
import "../state/foreach.js";
import "../state/group.js";
import "../state/iterate.js";
import "../state/reduce.js";
import "../state/queue.js";
import "../state/step.js";
import "../state/pipe.js";
function findActiveRun() {
    // Global pause: the engine "stop button" — freeze ALL auto-continuation, state preserved.
    if (isGloballyPaused())
        return null;
    const childMap = childToParent();
    // Registry order = the import order below (children-first; `pipe` last). Used only as the
    // within-job tiebreaker so a pipe never sorts ahead of its own children.
    const order = [...PRIMITIVES.keys()];
    const regIndex = (cmd) => {
        const i = order.indexOf(cmd);
        return i < 0 ? 999 : i;
    };
    const rootCache = new Map();
    const rootState = (key) => {
        if (!rootCache.has(key)) {
            const [c, r] = splitRunKey(key);
            rootCache.set(key, tryLoadState(c, r));
        }
        return rootCache.get(key) ?? null;
    };
    const candidates = [];
    for (const [cmd, spec] of PRIMITIVES) {
        const d = stateDir(cmd);
        if (!existsSync(d))
            continue;
        for (const name of readdirSync(d)) {
            const sp = join(d, name, "state.json");
            if (!existsSync(sp))
                continue;
            let state;
            try {
                state = JSON.parse(readFileSync(sp, "utf8"));
            }
            catch {
                continue;
            }
            const config = state["config"] ?? {};
            if (!config["auto_continue"])
                continue;
            const cap = config["max_auto_continues"] ?? 20;
            if ((state["auto_continues"] ?? 0) >= cap)
                continue;
            // Paused itself (manual flag, stop-file, or budget cap) → do not auto-resume.
            if (isPaused(state)[0])
                continue;
            const residual = spec.hasResidualWork(state);
            if (residual === null)
                continue;
            // Resolve the top-level job. Pausing a job pauses its whole subtree: skip a child whose
            // root job is paused. Scheduling keys (priority, created_at) come from the job, not the
            // sub-run, so a pipeline advances as one unit in FIFO order.
            const root = rootState(rootJobKey(cmd, name, childMap));
            if (root && isPaused(root)[0])
                continue;
            const keyed = root ?? state;
            const priority = Number(keyed["priority"] ?? keyed["config"]?.priority ?? 0) || 0;
            const createdAt = String(keyed["created_at"] ?? state["created_at"] ?? "");
            candidates.push({ cmd, name, sp, state, spec, residual, priority, createdAt, reg: regIndex(cmd) });
        }
    }
    if (candidates.length === 0)
        return null;
    // Higher priority first, then oldest job first (FIFO), then children before their parent pipe
    // (registry order), then run-id — a total, deterministic order.
    candidates.sort((a, b) => b.priority - a.priority ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.reg - b.reg ||
        a.name.localeCompare(b.name));
    const win = candidates[0];
    // Atomic pre-increment: ensures the cap advances even if Claude makes no real progress next turn.
    win.state["auto_continues"] = (win.state["auto_continues"] ?? 0) + 1;
    saveAtomic(win.sp, win.state);
    return [win.cmd, win.name, win.spec.resumeMsg(win.name, win.residual)];
}
/** Drain stdin (the hook payload) so the caller's write side never blocks. */
function drainStdin() {
    return new Promise((resolve) => {
        let done = false;
        const fin = () => {
            if (!done) {
                done = true;
                resolve();
            }
        };
        try {
            process.stdin.resume();
            process.stdin.on("data", () => { });
            process.stdin.on("end", fin);
            process.stdin.on("error", fin);
        }
        catch {
            fin();
        }
        setTimeout(fin, 200); // safety: never hang the turn waiting on stdin
    });
}
async function main() {
    await drainStdin();
    // A `step --runtime claude-cli/codex-cli` child is itself a Claude Code session, and the plugin is
    // installed globally — so without this guard the child's Stop hook finds the PARENT's in-flight run
    // and starts driving it, burning the parent's auto-continues and returning meta-commentary instead
    // of the prompt's answer. The engine marks its children with AGENTFLOW_CHILD; they never self-drive.
    if (process.env["AGENTFLOW_CHILD"])
        process.exit(0);
    const active = findActiveRun();
    if (active === null) {
        process.exit(0);
    }
    const reason = active[2];
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
    process.exit(0);
}
void main();
