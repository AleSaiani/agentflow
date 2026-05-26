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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { PRIMITIVES, type StateDict, die, isHelp, printUsage, findWorkspaceRoot, getPrimitive, loadState, print, stateDir, statePath } from "./common.js";
import { parseWorkflowMd } from "./workflow_md.js";

// Ensure every primitive self-registers.
import "./state/enumerate.js";
import "./state/foreach.js";
import "./state/group.js";
import "./state/iterate.js";
import "./state/reduce.js";
import "./state/queue.js";
import "./state/step.js";
import "./state/pipe.js";

function round4(n: number): number {
  return Math.round((n ?? 0) * 1e4) / 1e4;
}

/** A node invocation string for advisory output, plugin-root-aware. */
function nodeCmd(script: string): string {
  const root = process.env["CLAUDE_PLUGIN_ROOT"];
  return root ? `node "${root}/dist/${script}"` : `node dist/${script}`;
}

// ---------- discovery ----------

function allRunDirs(cmd: string): string[] {
  const d = stateDir(cmd);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((name) => existsSync(join(d, name, "state.json")))
    .sort();
}

function findAmbiguous(runId: string): string[] {
  const out: string[] = [];
  for (const cmd of PRIMITIVES.keys()) if (existsSync(statePath(cmd, runId))) out.push(cmd);
  return out;
}

function resolveOrExit(runId: string, cmdFilter?: string): [string, StateDict] {
  if (cmdFilter) {
    const p = statePath(cmdFilter, runId);
    if (!existsSync(p)) die(`error: no state at ${p}`);
    return [cmdFilter, loadState(p)];
  }
  const matches = findAmbiguous(runId);
  if (matches.length === 0) die(`error: no run found with id '${runId}'`);
  if (matches.length > 1) die(`error: run-id '${runId}' is ambiguous; matches: ${matches.join(",")}. Pass --cmd to disambiguate.`);
  const cmd = matches[0] as string;
  return [cmd, loadState(statePath(cmd, runId))];
}

// ---------- commands ----------

function cmdRuns(args: string[]): void {
  const { values } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, json: { type: "boolean", default: false } } });
  const cmds = values["cmd"] ? [values["cmd"] as string] : [...PRIMITIVES.keys()];
  const out: StateDict[] = [];
  for (const cmd of cmds) {
    for (const name of allRunDirs(cmd)) {
      let s: StateDict;
      try {
        s = loadState(join(stateDir(cmd), name, "state.json"));
      } catch {
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
    lines.push(
      `${String(e["cmd"]).padEnd(11)} ${String(e["run_id"]).padEnd(42)} ${String(e["status"]).padEnd(13)} ${String(e["is_done"]).padEnd(5)} ${String(e["agents"]).padEnd(7)} ${Number(e["usd_est"]).toFixed(4).padEnd(8)} ${e["updated_at"]}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

/** Chronological history of runs across all primitives — most recent activity first. */
function cmdHistory(args: string[]): void {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { limit: { type: "string", default: "20" }, cmd: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const cmds = values["cmd"] ? [values["cmd"] as string] : [...PRIMITIVES.keys()];
  const rows: StateDict[] = [];
  for (const cmd of cmds) {
    for (const name of allRunDirs(cmd)) {
      let s: StateDict;
      try {
        s = loadState(join(stateDir(cmd), name, "state.json"));
      } catch {
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
  const limit = parseInt(values["limit"] as string, 10);
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
    lines.push(
      `${String(e["updated_at"]).padEnd(21)} ${String(e["cmd"]).padEnd(10)} ${String(e["run_id"]).padEnd(34)} ${String(e["status"]).padEnd(12)} ${String(e["agents"]).padEnd(7)} ${Number(e["usd"]).toFixed(4)}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdShow(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, pretty: { type: "boolean", default: true } } });
  const runId = positionals[0];
  if (!runId) die("error: show requires a run_id");
  const [cmd, state] = resolveOrExit(runId, values["cmd"] as string | undefined);
  const spec = getPrimitive(cmd);
  const b = state["budget"] ?? {};
  const summary: StateDict = {
    cmd, run_id: state["run_id"], status: state["status"], is_done: spec ? spec.isDone(state) : null,
    result_pointer: state["result_pointer"] ?? null, error: state["error"] ?? null, parent_run_id: state["parent_run_id"] ?? null,
    stage_index: state["stage_index"] ?? null, auto_continues: state["auto_continues"] ?? 0,
    created_at: state["created_at"], updated_at: state["updated_at"], started_at: state["started_at"] ?? null, completed_at: state["completed_at"] ?? null,
    budget: { tokens_used: b["tokens_used"] ?? 0, agents_dispatched: b["agents_dispatched"] ?? 0, usd_estimate: round4(b["usd_estimate"] ?? 0) },
    followups_pending: (state["followups"] ?? []).length,
    config_keys: Object.keys(state["config"] ?? {}).sort(),
  };
  if (cmd === "foreach") {
    const items = Object.values(state["items"] ?? {}) as StateDict[];
    const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
    for (const it of items) counts[it["status"] ?? "pending"] = (counts[it["status"] ?? "pending"] ?? 0) + 1;
    summary["items"] = { total: items.length, ...counts };
  } else if (cmd === "pipe") {
    summary["stages"] = (state["stages"] ?? []).map((s: StateDict) => ({
      index: s["index"], name: s["name"], type: s["type"], status: s["status"], child_cmd: s["child_cmd"], child_run_id: s["child_run_id"],
    }));
  } else if (cmd === "iterate") {
    summary["iterations"] = state["iteration_count"] ?? 0;
    summary["max_iterations"] = state["config"]?.max_iterations;
    summary["stop_reason"] = state["stop_reason"] ?? null;
  } else if (cmd === "group") {
    summary["items_total"] = state["items_total"] ?? 0;
    summary["groups_count"] = state["groups_count"] ?? 0;
    summary["method"] = state["config"]?.method;
  } else if (cmd === "enumerate") {
    summary["items_generated"] = state["items_generated"] ?? 0;
  }
  process.stdout.write(JSON.stringify(summary, null, values["pretty"] ? 2 : undefined) + "\n");
}

function tree(cmd: string, runId: string, depth: number, maxDepth: number, lines: string[]): void {
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
      if (s["child_cmd"] && s["child_run_id"]) tree(s["child_cmd"], s["child_run_id"], depth + 2, maxDepth, lines);
    }
  }
}

function cmdTree(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { cmd: { type: "string" }, "max-depth": { type: "string", default: "10" } } });
  const runId = positionals[0];
  if (!runId) die("error: tree requires a run_id");
  const matches = findAmbiguous(runId);
  if (matches.length === 0) die(`error: no run found with id '${runId}'`);
  let cmd: string;
  if (values["cmd"]) cmd = values["cmd"] as string;
  else if (matches.length > 1) die(`error: ambiguous; matches ${matches.join(",")}. Pass --cmd.`);
  else cmd = matches[0] as string;
  const lines: string[] = [];
  tree(cmd, runId, 0, parseInt(values["max-depth"] as string, 10), lines);
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdBudget(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean", default: false } } });
  const runId = positionals[0];
  if (!runId) die("error: budget requires a run_id");
  const [cmd] = resolveOrExit(runId);
  const totals = { tokens: 0, agents: 0, usd: 0 };
  const breakdown: StateDict[] = [];
  const visit = (c: string, rid: string, depth = 0): void => {
    const p = statePath(c, rid);
    if (!existsSync(p)) return;
    const s = loadState(p);
    const b = s["budget"] ?? {};
    breakdown.push({ depth, cmd: c, run_id: rid, tokens: b["tokens_used"] ?? 0, agents: b["agents_dispatched"] ?? 0, usd: round4(b["usd_estimate"] ?? 0) });
    totals.tokens += b["tokens_used"] ?? 0;
    totals.agents += b["agents_dispatched"] ?? 0;
    totals.usd += b["usd_estimate"] ?? 0;
    if (c === "pipe") for (const stage of s["stages"] ?? []) if (stage["child_cmd"] && stage["child_run_id"]) visit(stage["child_cmd"], stage["child_run_id"], depth + 1);
  };
  visit(cmd, runId, 0);
  if (values["json"]) {
    process.stdout.write(JSON.stringify({ run_id: runId, cmd, totals: { tokens: totals.tokens, agents: totals.agents, usd: round4(totals.usd) }, breakdown }, null, 2) + "\n");
    return;
  }
  const lines = [`[${cmd}] ${runId}  total: tokens=${totals.tokens}, agents=${totals.agents}, usd≈${totals.usd.toFixed(4)}`];
  for (const b of breakdown) lines.push(`  ${"  ".repeat(b["depth"])}[${b["cmd"]}] ${b["run_id"]}  tokens=${b["tokens"]} agents=${b["agents"]} usd=${b["usd"]}`);
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdTimeline(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { limit: { type: "string", default: "20" } } });
  const runId = positionals[0];
  if (!runId) die("error: timeline requires a run_id");
  const [cmd, state] = resolveOrExit(runId);
  const b = state["budget"] ?? {};
  const limit = parseInt(values["limit"] as string, 10);
  const events = (b["events"] ?? []) as StateDict[];
  const lines = [
    `[${cmd}] ${state["run_id"]}  status=${state["status"]}`,
    `  created_at:   ${state["created_at"]}`,
    `  started_at:   ${state["started_at"] ?? null}`,
    `  updated_at:   ${state["updated_at"]}`,
    `  completed_at: ${state["completed_at"] ?? null}`,
    `  auto_continues: ${state["auto_continues"] ?? 0}`,
    `  budget events (${events.length}):`,
  ];
  for (const ev of events.slice(-limit)) lines.push(`    ${ev["at"]}  ${ev["type"]}  tokens=${ev["tokens"]} usd=${ev["usd"]} model=${ev["model"]}`);
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdBoard(args: string[]): void {
  const { values } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean", default: false }, "no-failed": { type: "boolean", default: false } } });
  const active: StateDict[] = [];
  const done: StateDict[] = [];
  const failed: StateDict[] = [];
  const stuck: StateDict[] = [];
  let totalUsd = 0;
  let totalTokens = 0;

  for (const cmd of PRIMITIVES.keys()) {
    for (const name of allRunDirs(cmd)) {
      let s: StateDict;
      try {
        s = loadState(join(stateDir(cmd), name, "state.json"));
      } catch {
        continue;
      }
      const spec = getPrimitive(cmd);
      const isDone = spec ? spec.isDone(s) : s["status"] === "done";
      const b = s["budget"] ?? {};
      const usd = round4(b["usd_estimate"] ?? 0);
      const tokens = b["tokens_used"] ?? 0;
      totalUsd += usd;
      totalTokens += tokens;
      const entry: StateDict = {
        cmd, run_id: name, status: s["status"], is_done: isDone, updated_at: s["updated_at"],
        auto_continues: s["auto_continues"] ?? 0, max_auto_continues: s["config"]?.max_auto_continues ?? 0,
        usd, tokens, parent_run_id: s["parent_run_id"] ?? null, error: s["error"] ?? null,
      };
      if (cmd === "foreach") {
        const items = Object.values(s["items"] ?? {}) as StateDict[];
        const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
        for (const it of items) counts[it["status"] ?? "pending"] = (counts[it["status"] ?? "pending"] ?? 0) + 1;
        entry["progress"] = `${counts["done"]}/${items.length}`;
        if ((counts["in_progress"] ?? 0) > 0 && !isDone) stuck.push({ ...entry, reason: `${counts["in_progress"]} items stuck in_progress` });
      } else if (cmd === "pipe") {
        const stages = s["stages"] ?? [];
        const doneStages = stages.filter((x: StateDict) => x["status"] === "done").length;
        entry["progress"] = `${doneStages}/${stages.length} stages`;
      } else if (cmd === "iterate") {
        entry["progress"] = `${s["iteration_count"] ?? 0}/${s["config"]?.max_iterations ?? "?"} iters`;
      } else if (cmd === "group") {
        entry["progress"] = `${s["groups_count"] ?? 0} groups`;
      } else {
        entry["progress"] = "—";
      }

      if (s["status"] === "failed") failed.push(entry);
      else if (isDone) done.push(entry);
      else {
        active.push(entry);
        if (entry["max_auto_continues"] && entry["auto_continues"] >= entry["max_auto_continues"]) stuck.push({ ...entry, reason: "auto_continues cap exhausted" });
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
    for (const e of stuck) lines.push(`  [WARN] [${e["cmd"]}] ${e["run_id"]}: ${e["reason"]}`);
    lines.push("");
  }
  if (failed.length && !values["no-failed"]) {
    lines.push(`FAILED (${failed.length}):`);
    for (const e of failed.slice(0, 5)) lines.push(`  [FAIL] [${e["cmd"]}] ${e["run_id"]}: ${String(e["error"] ?? "").slice(0, 80)}`);
    if (failed.length > 5) lines.push(`  ... and ${failed.length - 5} more — use \`${nodeCmd("inspect.js")} runs\` for the full list`);
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
    const top = pipeRuns[0] as StateDict;
    lines.push(`  - \`${nodeCmd("state/pipe.js")} drive ${top["run_id"]}\` — auto-advance the pipe until an Agent dispatch is needed`);
    lines.push(`  - \`${nodeCmd("inspect.js")} tree ${top["run_id"]}\` — see the full child tree`);
  }
  const enumActive = active.filter((e) => e["cmd"] === "foreach");
  if (enumActive.length && !pipeRuns.length) {
    const top = enumActive[0] as StateDict;
    lines.push(`  - Send any message and the Stop hook will resume /agentflow:foreach '${top["run_id"]}' automatically`);
  }
  for (const e of stuck.slice(0, 2)) {
    if (String(e["reason"]).includes("stuck in_progress")) lines.push(`  - \`${nodeCmd(`state/${e["cmd"]}.js`)} reset ${e["run_id"]} --in-progress-to-pending\``);
    if (String(e["reason"]).includes("cap exhausted")) lines.push(`  - Bump max_auto_continues on '${e["run_id"]}' (edit state.json) or finalize the run`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

/** List authored workflows under <workspace>/workflows/ (format-agnostic: WORKFLOW.md or workflow.json). */
function cmdWorkflows(args: string[]): void {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: { json: { type: "boolean", default: false } } });
  const root = findWorkspaceRoot();
  const wfRoot = join(root, "workflows");
  const found: StateDict[] = [];
  if (existsSync(wfRoot)) {
    for (const name of readdirSync(wfRoot).sort()) {
      const full = join(wfRoot, name);
      const isDir = statSync(full).isDirectory();
      // A workflow is a folder holding WORKFLOW.md (preferred, human-authored) or workflow.json
      // (compiled spec), or a bare workflows/<name>.json.
      let mdPath: string | null = null;
      let jsonPath: string | null = null;
      if (isDir) {
        if (existsSync(join(full, "WORKFLOW.md"))) mdPath = join(full, "WORKFLOW.md");
        if (existsSync(join(full, "workflow.json"))) jsonPath = join(full, "workflow.json");
      } else if (name.endsWith(".json")) {
        jsonPath = full;
      }
      if (!mdPath && !jsonPath) continue;
      const entry: StateDict = {
        name: name.replace(/\.json$/, ""),
        format: mdPath && jsonPath ? "md+json" : mdPath ? "md" : "json",
        path: relative(root, (mdPath ?? jsonPath) as string).split(sep).join("/"),
      };
      if (jsonPath) {
        try {
          const wf = JSON.parse(readFileSync(jsonPath, "utf8"));
          if (wf.name) entry["name"] = wf.name;
          entry["description"] = wf.description ?? "";
          entry["stages"] = Array.isArray(wf.stages) ? wf.stages.length : 0;
          entry["params"] = wf.params && typeof wf.params === "object" ? Object.keys(wf.params) : [];
        } catch {
          entry["error"] = "malformed workflow.json";
        }
      } else if (mdPath) {
        // Most shipped/authored workflows are WORKFLOW.md only — parse the same metadata the
        // catalog promises (stage count, params, description) straight from the markdown.
        try {
          const wf = parseWorkflowMd(readFileSync(mdPath, "utf8"));
          if (typeof wf["name"] === "string") entry["name"] = wf["name"];
          entry["description"] = typeof wf["description"] === "string" ? wf["description"] : "";
          entry["stages"] = Array.isArray(wf["stages"]) ? (wf["stages"] as unknown[]).length : 0;
          entry["params"] = wf["params"] && typeof wf["params"] === "object" ? Object.keys(wf["params"] as object) : [];
        } catch {
          entry["error"] = "malformed WORKFLOW.md";
        }
      }
      found.push(entry);
    }
  }
  if (values["json"]) return print(found);
  if (found.length === 0) {
    process.stdout.write(`No workflows found under ${wfRoot}/. Author one with /agentflow:create-workflow.\n`);
    return;
  }
  const lines = [`=== Workflows (${found.length}) ===`];
  for (const w of found) {
    const params = (w["params"] as string[] | undefined) ?? [];
    const meta = [w["format"], w["stages"] !== undefined ? `${w["stages"]} stages` : null, params.length ? `params: ${params.join(",")}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${w["name"]}  (${meta})`);
    lines.push(`    ${w["path"]}`);
    if (w["description"]) lines.push(`    ${String(w["description"]).slice(0, 100)}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Dump the RESULTS of a completed run for downstream, deterministic reuse — so you operate on outputs
 * WITHOUT re-running. `foreach` → one row per item (id+status+result); `step`/`reduce`/`pipe`/`group`/
 * `iterate` → the produced output (inline or read from its result_pointer file). Modes: `--json` (full,
 * lossless), `--checklist` (a markdown `- [ ]` line per item — one per item so nothing is dropped),
 * `--field a.b` pulls a nested result field as the task text, `--status <s>` filters foreach items.
 */
function cmdResults(args: string[]): void {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: { cmd: { type: "string" }, json: { type: "boolean", default: false }, checklist: { type: "boolean", default: false }, field: { type: "string" }, status: { type: "string" }, limit: { type: "string", default: "0" } },
  });
  const runId = positionals[0];
  if (!runId) die("error: results requires a run_id");
  const [cmd, state] = resolveOrExit(runId, values["cmd"] as string | undefined);
  let rows: StateDict[];
  if (cmd === "foreach") {
    let items = Object.values(state["items"] ?? {}) as StateDict[];
    if (values["status"]) items = items.filter((i) => i["status"] === values["status"]);
    rows = items.map((i) => ({ id: i["id"], status: i["status"], result: i["result"] ?? null }));
  } else {
    let result: unknown = state["output"] ?? null;
    const ptr = state["result_pointer"];
    if (result == null && typeof ptr === "string" && existsSync(ptr)) {
      try {
        result = readFileSync(ptr, "utf8");
      } catch {
        /* leave null */
      }
    }
    rows = [{ id: runId, status: state["status"], result }];
  }
  const limit = parseInt(values["limit"] as string, 10);
  if (limit > 0) rows = rows.slice(0, limit);

  if (values["checklist"]) {
    const field = values["field"] as string | undefined;
    const lines = rows.map((r) => {
      const picked = field ? getPath(r["result"], field) : typeof r["result"] === "string" ? r["result"] : null;
      const txt = picked != null && picked !== "" ? ` — ${String(picked).replace(/\s+/g, " ").slice(0, 160)}` : "";
      return `- [ ] ${r["id"]}${txt}`;
    });
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  if (values["json"]) return print(rows);
  process.stdout.write(`[${cmd}] ${runId} — ${rows.length} result(s)\n`);
  for (const r of rows) process.stdout.write(`  ${String(r["id"]).slice(0, 64).padEnd(64)} ${r["status"] ?? ""}\n`);
}

function main(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (isHelp(sub)) return printUsage("inspect", ["runs", "workflows", "history", "show", "results", "tree", "budget", "timeline", "board"]);
  switch (sub) {
    case "runs":
      return cmdRuns(rest);
    case "workflows":
      return cmdWorkflows(rest);
    case "history":
      return cmdHistory(rest);
    case "show":
      return cmdShow(rest);
    case "results":
      return cmdResults(rest);
    case "tree":
      return cmdTree(rest);
    case "budget":
      return cmdBudget(rest);
    case "timeline":
      return cmdTimeline(rest);
    case "board":
      return cmdBoard(rest);
    default:
      die(`error: unknown subcommand '${sub ?? ""}' (runs|workflows|history|show|results|tree|budget|timeline|board)`);
  }
}

main(process.argv.slice(2));
