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

import {
  Primitive,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_IN_PROGRESS,
  STATUS_PENDING,
  type Item,
  type ResidualWork,
  type StateDict,
  cacheKey,
  cacheLookup,
  cacheStore,
  die,
  loadState,
  loadTaskKindTemplate,
  makeBaseState,
  markDone,
  markInProgress,
  now,
  print,
  saveAtomic,
  statePath,
} from "../common.js";
import { loadSource, writeChecklistView } from "../source.js";

const CMD = "enumerate";

// Valid kinds for --kind. Mirrors `skills/enumerate/task-kinds.md`. "unknown" has no
// template and is treated as a no-op (no enrichment).
const KNOWN_KINDS = ["code-review", "transformation", "extraction", "validation", "audit", "unknown"];

function pathFor(runId: string): string {
  return statePath(CMD, runId);
}
function load(runId: string): StateDict {
  return loadState(pathFor(runId));
}
function save(runId: string, state: StateDict): void {
  state["updated_at"] = now();
  saveAtomic(pathFor(runId), state);
}

/** Transition the run's top-level status to `done` when every item is terminal. */
function finalizeStatusIfTerminal(state: StateDict): void {
  const items = state["items"] ?? {};
  const values = Object.values(items) as StateDict[];
  if (values.length === 0) return;
  if (values.some((i) => i["status"] === STATUS_PENDING || i["status"] === STATUS_IN_PROGRESS)) return;
  if (state["status"] !== STATUS_DONE) markDone(state, state["result_pointer"] ?? null);
}

/** Build the per-item state dict from a resolved Source item. */
function toStateItem(it: Item): StateDict {
  const entry: StateDict = {
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
  if (it.task) entry["task"] = it.task;
  return entry;
}

/** Resolve the init item list from exactly one of: --items | --checkbox | --source. */
function resolveItems(values: Record<string, unknown>): Item[] {
  const itemsPath = values["items"] as string | undefined;
  const checkbox = values["checkbox"] as string | undefined;
  const sourceJson = values["source"] as string | undefined;
  const provided = [itemsPath, checkbox, sourceJson].filter(Boolean).length;
  if (provided !== 1) die("error: provide exactly one of --items, --checkbox, --source");

  if (checkbox) return loadSource({ source: "checkbox", path: checkbox });
  if (sourceJson) return loadSource(JSON.parse(sourceJson));

  // --items: JSON array in the legacy enumerate shape ({id?, data?, task?, ...}).
  const raw = JSON.parse(readFileSync(itemsPath as string, "utf8"));
  if (!Array.isArray(raw)) die("error: items file must contain a JSON array");
  return raw.map((r: Record<string, unknown>, idx: number): Item => {
    if (typeof r !== "object" || r === null) die(`error: item at index ${idx} is not an object`);
    const id = String(r["id"] ?? idx);
    const data =
      r["data"] !== undefined
        ? r["data"]
        : Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id"));
    const item: Item = { id, data, status: STATUS_PENDING };
    if (r["task"]) item.task = r["task"] as Item["task"];
    return item;
  });
}

function cmdInit(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      items: { type: "string" },
      checkbox: { type: "string" },
      source: { type: "string" },
      "task-prompt": { type: "string", default: "" },
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
  if (!runId) die("error: init requires a run_id positional");
  const model = values["model"] as string;

  const kind = ((values["kind"] as string) || "").trim().toLowerCase() || null;
  if (kind && !KNOWN_KINDS.includes(kind))
    die(`error: --kind must be one of ${KNOWN_KINDS.join(",")}, got '${kind}'`);
  if (kind && kind !== "unknown" && loadTaskKindTemplate(kind) === null)
    die(`error: no template found for kind '${kind}' in skills/enumerate/task-kinds.md`);

  if (values["validate-only"]) {
    print({ valid: true, kind, model });
    return;
  }

  const sourceItems = resolveItems(values);
  const items: StateDict = {};
  for (const it of sourceItems) {
    if (items[it.id]) die(`error: duplicate item id '${it.id}'`);
    items[it.id] = toStateItem(it);
  }

  let effectiveTaskPrompt = (values["task-prompt"] as string) || "";
  if (kind && kind !== "unknown") {
    const template = loadTaskKindTemplate(kind) ?? "";
    const sep = effectiveTaskPrompt ? "\n\n" : "";
    effectiveTaskPrompt = template.replace(/\s+$/, "") + sep + effectiveTaskPrompt;
  }

  const autoContinue = values["no-auto-continue"] ? false : true;
  const state = makeBaseState(
    CMD,
    runId,
    {
      concurrency: parseInt(values["concurrency"] as string, 10),
      chunk_size: values["chunk-size"],
      max_retries: parseInt(values["max-retries"] as string, 10),
      auto_continue: autoContinue,
      max_auto_continues: parseInt(values["max-auto-continues"] as string, 10),
      model,
      subagent_type: values["subagent-type"],
      kind,
      cache: Boolean(values["cache"]),
    },
    { task_prompt: effectiveTaskPrompt, items },
  );

  // Cache lookup: items with a `data.content_hash` get pre-completed on a cache hit.
  let cacheHits = 0;
  if (values["cache"]) {
    const ns = `enumerate-${kind || "nokind"}`;
    for (const it of Object.values(state["items"]) as StateDict[]) {
      const ch = (it["data"] as Record<string, unknown>)?.["content_hash"];
      if (!ch) continue;
      const key = cacheKey(effectiveTaskPrompt, model || "", String(ch));
      const hit = cacheLookup(ns, key);
      if (hit === null) continue;
      it["status"] = STATUS_DONE;
      it["result"] = hit["value"];
      it["completed_at"] = now();
      it["cache_hit"] = true;
      cacheHits++;
    }
  }
  finalizeStatusIfTerminal(state);

  const p = pathFor(runId);
  if (existsSync(p) && !values["force"]) die(`error: state already exists at ${p}; use --force to overwrite`);
  save(runId, state);
  print({ run_id: runId, total: Object.keys(items).length, kind, cache_hits: cacheHits, path: p });
}

function maybeStoreCache(state: StateDict, item: StateDict): void {
  const cfg = state["config"] ?? {};
  if (!cfg["cache"]) return;
  if (item["cache_hit"]) return;
  if (item["status"] !== STATUS_DONE) return;
  const ch = (item["data"] as Record<string, unknown>)?.["content_hash"];
  if (!ch) return;
  const kind = cfg["kind"] || "nokind";
  const model = cfg["model"] || "";
  cacheStore(`enumerate-${kind}`, cacheKey(state["task_prompt"] ?? "", model, String(ch)), item["result"]);
}

function cmdClaim(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { count: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) die("error: claim requires a run_id");
  const count = parseInt((values["count"] as string) ?? "", 10);
  if (!Number.isFinite(count)) die("error: --count is required");
  const state = load(runId);
  const claimed: StateDict[] = [];
  for (const item of Object.values(state["items"]) as StateDict[]) {
    if (claimed.length >= count) break;
    if (item["status"] === STATUS_PENDING) {
      item["status"] = STATUS_IN_PROGRESS;
      item["started_at"] = now();
      item["attempts"] = (item["attempts"] ?? 0) + 1;
      claimed.push(item);
    }
  }
  if (claimed.length > 0 && state["status"] === STATUS_PENDING) markInProgress(state);
  save(runId, state);
  print(claimed);
}

function cmdComplete(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { result: { type: "string", default: "" } },
  });
  const [runId, itemId] = positionals;
  if (!runId || !itemId) die("error: complete requires run_id and item_id");
  const state = load(runId);
  const item = state["items"][itemId];
  if (!item) die(`error: unknown item id '${itemId}'`);
  item["status"] = STATUS_DONE;
  item["completed_at"] = now();
  item["result"] = values["result"] ? JSON.parse(values["result"] as string) : null;
  item["error"] = null;
  maybeStoreCache(state, item);
  finalizeStatusIfTerminal(state);
  save(runId, state);
  print({ id: itemId, status: STATUS_DONE, run_status: state["status"] });
}

function cmdFail(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { error: { type: "string", default: "" }, retry: { type: "boolean", default: false } },
  });
  const [runId, itemId] = positionals;
  if (!runId || !itemId) die("error: fail requires run_id and item_id");
  const state = load(runId);
  const item = state["items"][itemId];
  if (!item) die(`error: unknown item id '${itemId}'`);
  const maxRetries = state["config"]["max_retries"];
  if (values["retry"] && item["attempts"] <= maxRetries) {
    item["status"] = STATUS_PENDING;
    item["started_at"] = null;
  } else {
    item["status"] = STATUS_FAILED;
    item["completed_at"] = now();
  }
  item["error"] = values["error"];
  finalizeStatusIfTerminal(state);
  save(runId, state);
  print({ id: itemId, status: item["status"], attempts: item["attempts"], run_status: state["status"] });
}

function cmdStatus(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die("error: status requires a run_id");
  const state = load(runId);
  const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const item of Object.values(state["items"]) as StateDict[]) {
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

function cmdList(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { status: { type: "string" }, limit: { type: "string", default: "0" } },
  });
  const runId = positionals[0];
  if (!runId) die("error: list requires a run_id");
  const state = load(runId);
  let items = Object.values(state["items"]) as StateDict[];
  const status = values["status"] as string | undefined;
  if (status) {
    if (!["pending", "in_progress", "done", "failed"].includes(status)) die(`error: invalid --status '${status}'`);
    items = items.filter((i) => i["status"] === status);
  }
  const limit = parseInt(values["limit"] as string, 10);
  if (limit) items = items.slice(0, limit);
  print(items);
}

function cmdReset(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { "failed-to-pending": { type: "boolean", default: false }, "in-progress-to-pending": { type: "boolean", default: false } },
  });
  const runId = positionals[0];
  if (!runId) die("error: reset requires a run_id");
  const state = load(runId);
  let changed = 0;
  for (const item of Object.values(state["items"]) as StateDict[]) {
    if (values["failed-to-pending"] && item["status"] === "failed") {
      item["status"] = "pending";
      item["error"] = null;
      item["started_at"] = null;
      changed++;
    } else if (values["in-progress-to-pending"] && item["status"] === "in_progress") {
      item["status"] = "pending";
      item["started_at"] = null;
      changed++;
    }
  }
  save(runId, state);
  print({ reset: changed });
}

function cmdCompleteBatch(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { results: { type: "string" } },
  });
  const runId = positionals[0];
  const resultsPath = values["results"] as string | undefined;
  if (!runId || !resultsPath) die("error: complete-batch requires run_id and --results");
  const payload = JSON.parse(readFileSync(resultsPath, "utf8"));
  if (!Array.isArray(payload)) die("error: results file must be a JSON array");
  const state = load(runId);
  const maxRetries = state["config"]["max_retries"] ?? 1;
  const counts = { completed: 0, failed: 0, retried: 0, unknown: 0 };
  for (const r of payload as Record<string, unknown>[]) {
    const itemId = String(r["id"]);
    const item = state["items"][itemId];
    if (!item) {
      counts.unknown++;
      continue;
    }
    // Lenient ok inference: a valid result with no error counts as success even if `ok`
    // is omitted. Explicit ok=false still fails.
    let ok = r["ok"];
    if (ok === undefined || ok === null) ok = r["error"] === undefined ? r["result"] != null : r["error"] == null && r["result"] != null;
    if (ok) {
      item["status"] = STATUS_DONE;
      item["completed_at"] = now();
      item["result"] = r["result"];
      item["error"] = null;
      maybeStoreCache(state, item);
      counts.completed++;
    } else {
      const err = (r["error"] as string) || "unknown";
      if (item["attempts"] <= maxRetries) {
        item["status"] = STATUS_PENDING;
        item["started_at"] = null;
        counts.retried++;
      } else {
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
function cmdView(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { checkbox: { type: "string" } },
  });
  const runId = positionals[0];
  const checkbox = values["checkbox"] as string | undefined;
  if (!runId || !checkbox) die("error: view requires run_id and --checkbox <path>");
  const state = load(runId);
  const items: Item[] = (Object.values(state["items"]) as StateDict[]).map((i) => ({
    id: i["id"],
    data: i["data"],
    status: i["status"],
  }));
  const changed = writeChecklistView(checkbox, items);
  print({ run_id: runId, view: checkbox, toggled: changed });
}

function cmdBudgetAdd(args: string[]): void {
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
  if (!runId) die("error: budget-add requires a run_id");
  PRIM.cliBudgetAdd(runId, {
    tokens: parseInt(values["tokens"] as string, 10),
    usd: values["usd"] !== undefined ? parseFloat(values["usd"] as string) : null,
    eventType: values["event-type"] as string,
    model: (values["model"] as string) ?? null,
    metaJson: (values["meta"] as string) ?? null,
  });
}

// ---------- primitive registration ----------

function isDone(state: StateDict): boolean {
  const items = Object.values(state["items"] ?? {}) as StateDict[];
  if (items.length === 0) return false;
  return items.every((i) => i["status"] === STATUS_DONE || i["status"] === STATUS_FAILED);
}

function hasResidualWork(state: StateDict): ResidualWork | null {
  const items = Object.values(state["items"] ?? {}) as StateDict[];
  const pending = items.filter((i) => i["status"] === STATUS_PENDING).length;
  const inProgress = items.filter((i) => i["status"] === STATUS_IN_PROGRESS).length;
  if (pending === 0 && inProgress === 0) return null;
  return [pending, inProgress];
}

function resumeMsg(runId: string, residual: ResidualWork): string {
  const [pending, inProgress] = residual as [number, number];
  return (
    `/enumerate run '${runId}' is not complete: ${pending} pending, ${inProgress} in_progress. ` +
    `Resume the /enumerate dispatch loop for this run-id (do NOT re-init; just read the state and process the next batch). ` +
    `If items are stuck in 'in_progress' from a prior session, reset them with the enumerate \`reset ${runId} --in-progress-to-pending\` subcommand.`
  );
}

const PRIM = new Primitive(CMD, {
  isDone,
  hasResidualWork,
  resumeMsg,
  resultPointer: (s) => (s["result_pointer"] ?? null) as string | null,
});

function main(argv: string[]): void {
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
      if (!runId) die("error: increment-continues requires a run_id");
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
