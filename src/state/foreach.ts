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
import { resolve } from "node:path";
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
import { loadSource, moveKanbanItem, writeChecklistView, writeFolderView } from "../source.js";

const CMD = "foreach";

// Valid kinds for --kind. Mirrors `skills/foreach/task-kinds.md`. "unknown" has no
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
  const folder = values["folder"] as string | undefined;
  const sourceJson = values["source"] as string | undefined;
  const provided = [itemsPath, checkbox, folder, sourceJson].filter(Boolean).length;
  if (provided !== 1) die("error: provide exactly one of --items, --checkbox, --folder, --source");

  if (checkbox) return loadSource({ source: "checkbox", path: checkbox });
  if (folder) return loadSource({ source: "folder", path: folder });
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

/**
 * Resolve the kanban folder base if this run is folder-backed (via `--folder` or a folder
 * SourceSpec). Stored in config so claim/complete/fail can auto-move files without a `view` step.
 */
function folderBaseFromValues(values: Record<string, unknown>): string | null {
  const folder = values["folder"] as string | undefined;
  if (folder) return resolve(folder);
  const sourceJson = values["source"] as string | undefined;
  if (sourceJson) {
    try {
      const spec = JSON.parse(sourceJson);
      if (spec && spec.source === "folder" && typeof spec.path === "string") return resolve(spec.path);
    } catch {
      /* resolveItems re-parses and surfaces the real error */
    }
  }
  return null;
}

/** Folder-backed runs: move the item's file into the folder matching its current status. No-op otherwise. */
function syncKanban(state: StateDict, item: StateDict): void {
  const base = (state["config"] as StateDict)?.["folder"];
  if (!base) return;
  moveKanbanItem(String(base), String(item["id"]), item["data"], String(item["status"]));
}

function cmdInit(args: string[]): void {
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
      "prompt-file": { type: "string" },
      serial: { type: "boolean", default: false },
      carry: { type: "boolean", default: false },
      shard: { type: "string" },
      "stop-file": { type: "string" },
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
  if (!runId) die("error: init requires a run_id positional");
  const model = values["model"] as string;

  const kind = ((values["kind"] as string) || "").trim().toLowerCase() || null;
  if (kind && !KNOWN_KINDS.includes(kind))
    die(`error: --kind must be one of ${KNOWN_KINDS.join(",")}, got '${kind}'`);
  if (kind && kind !== "unknown" && loadTaskKindTemplate(kind, "foreach") === null)
    die(`error: no template found for kind '${kind}' in skills/foreach/task-kinds.md`);

  // Sharding: --shard k/N keeps only items at positions where index % N == k. Run N terminals
  // with k=0..N-1 (distinct run-ids) to split one list across processes — each is its own state
  // file, so there are no concurrent writers (read-partition model, no locks).
  const shardStr = values["shard"] as string | undefined;
  let shard: { k: number; n: number } | null = null;
  if (shardStr) {
    const m = shardStr.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) die(`error: --shard must be k/N (e.g. 0/2), got '${shardStr}'`);
    const k = parseInt(m[1] as string, 10);
    const n = parseInt(m[2] as string, 10);
    if (n < 1 || k < 0 || k >= n) die(`error: --shard requires 1<=N and 0<=k<N, got ${k}/${n}`);
    shard = { k, n };
  }

  if (values["validate-only"]) {
    print({ valid: true, kind, model, shard: shardStr ?? null });
    return;
  }

  let sourceItems = resolveItems(values);
  if (shard) sourceItems = sourceItems.filter((_, idx) => idx % shard.n === shard.k);
  const items: StateDict = {};
  for (const it of sourceItems) {
    if (items[it.id]) die(`error: duplicate item id '${it.id}'`);
    items[it.id] = toStateItem(it);
  }

  // `--prompt` is the primary operation config; `--task-prompt` is an alias; `--prompt-file`
  // reads the operation from an external file (handy for long/multi-line prompts).
  const promptFile = values["prompt-file"] as string | undefined;
  if (promptFile && (values["prompt"] !== undefined || (values["task-prompt"] as string)))
    die("error: --prompt-file is mutually exclusive with --prompt/--task-prompt");
  let effectiveTaskPrompt: string;
  if (promptFile) {
    if (!existsSync(promptFile)) die(`error: --prompt-file not found at ${promptFile}`);
    effectiveTaskPrompt = readFileSync(promptFile, "utf8").trim();
  } else {
    effectiveTaskPrompt = ((values["prompt"] ?? values["task-prompt"]) as string) || "";
  }
  if (kind && kind !== "unknown") {
    const template = loadTaskKindTemplate(kind, "foreach") ?? "";
    const sep = effectiveTaskPrompt ? "\n\n" : "";
    effectiveTaskPrompt = template.replace(/\s+$/, "") + sep + effectiveTaskPrompt;
  }

  const autoContinue = values["no-auto-continue"] ? false : true;
  // Execution mode: subagent fan-out (default) or process items inline in the main thread.
  const execution = values["execution"] as string;
  if (!["main-thread", "subagent"].includes(execution))
    die(`error: --execution must be main-thread|subagent, got '${execution}'`);
  // Serial mode: one item at a time, in list order. `--carry` (each item sees the previous
  // item's output) implies serial. Both force concurrency=1 / chunk_size=1 so the dispatch
  // loop never fans out — the orchestrator reads these flags and uses `claim-serial`.
  const carry = Boolean(values["carry"]);
  const serial = Boolean(values["serial"]) || carry;
  const concurrency = serial ? 1 : parseInt(values["concurrency"] as string, 10);
  const chunkSize = serial ? "1" : (values["chunk-size"] as string);
  const state = makeBaseState(
    CMD,
    runId,
    {
      concurrency,
      chunk_size: chunkSize,
      max_retries: parseInt(values["max-retries"] as string, 10),
      auto_continue: autoContinue,
      max_auto_continues: parseInt(values["max-auto-continues"] as string, 10),
      model,
      subagent_type: values["subagent-type"],
      execution,
      serial,
      carry,
      shard: shardStr ?? null,
      // Pause gate: while this file exists, the orchestrator stops claiming and the Stop hook
      // does not auto-resume. Remove it (and send a message) to continue. Resolved to absolute
      // so the check is cwd-independent.
      stop_file: values["stop-file"] ? resolve(values["stop-file"] as string) : null,
      kind,
      cache: Boolean(values["cache"]),
      folder: folderBaseFromValues(values),
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
  // Folder-backed: project any pre-completed (cache-hit) items onto the board now.
  if ((state["config"] as StateDict)["folder"])
    for (const it of Object.values(state["items"]) as StateDict[]) syncKanban(state, it);

  const p = pathFor(runId);
  if (existsSync(p) && !values["force"]) die(`error: state already exists at ${p}; use --force to overwrite`);
  save(runId, state);
  print({ run_id: runId, total: Object.keys(items).length, kind, serial, carry, shard: shardStr ?? null, cache_hits: cacheHits, path: p });
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
  for (const item of claimed) syncKanban(state, item); // todo/ → in-progress/
  save(runId, state);
  print(claimed);
}

/**
 * Serial claim: take the NEXT item in list order (the first pending, or an already-claimed
 * in_progress one on resume) and return it together with `prev_result` — the result of the
 * last `done` item that precedes it. Used by `--serial`/`--carry` runs: deterministic and
 * resume-safe (the carry is reconstructed from disk, not the conversation). Returns
 * `{item: null}` when nothing is left to do.
 */
function cmdClaimSerial(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die("error: claim-serial requires a run_id");
  const state = load(runId);
  let prevId: string | null = null;
  let prevResult: unknown = null;
  let claimed: StateDict | null = null;
  for (const item of Object.values(state["items"]) as StateDict[]) {
    if (item["status"] === STATUS_DONE) {
      prevId = item["id"];
      prevResult = item["result"];
      continue;
    }
    if (item["status"] === STATUS_IN_PROGRESS) {
      // Resume: this item was already claimed in a prior turn — hand it back, don't re-count.
      claimed = item;
      break;
    }
    if (item["status"] === STATUS_PENDING) {
      item["status"] = STATUS_IN_PROGRESS;
      item["started_at"] = now();
      item["attempts"] = (item["attempts"] ?? 0) + 1;
      claimed = item;
      break;
    }
    // failed: skip over it (terminal), keep scanning for the next workable item.
  }
  if (claimed) {
    if (state["status"] === STATUS_PENDING) markInProgress(state);
    syncKanban(state, claimed); // todo/ → in-progress/
  }
  save(runId, state);
  print({ item: claimed, prev_id: prevId, prev_result: prevResult });
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
  syncKanban(state, item); // in-progress/ → done/
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
  syncKanban(state, item); // failed → done/ (terminal); retry → back to todo/
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
  const stopFile = (state["config"] as StateDict)?.["stop_file"];
  const paused = Boolean(stopFile && existsSync(String(stopFile)));
  print({
    run_id: runId,
    run_status: state["status"],
    paused,
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
    syncKanban(state, item); // project each item's new status onto the board
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
    options: { checkbox: { type: "string" }, folder: { type: "string" } },
  });
  const runId = positionals[0];
  const checkbox = values["checkbox"] as string | undefined;
  const folder = values["folder"] as string | undefined;
  if (!runId || (!checkbox && !folder)) die("error: view requires run_id and --checkbox <path> or --folder <path>");
  const state = load(runId);
  const items: Item[] = (Object.values(state["items"]) as StateDict[]).map((i) => ({
    id: i["id"],
    data: i["data"],
    status: i["status"],
  }));
  if (folder) {
    const moved = writeFolderView(folder, items);
    print({ run_id: runId, view: folder, moved });
    return;
  }
  const changed = writeChecklistView(checkbox as string, items);
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
  // Pause gate: a present stop-file suspends auto-resume (the Stop hook sees no residual work).
  const stopFile = (state["config"] as StateDict)?.["stop_file"];
  if (stopFile && existsSync(String(stopFile))) return null;
  const items = Object.values(state["items"] ?? {}) as StateDict[];
  const pending = items.filter((i) => i["status"] === STATUS_PENDING).length;
  const inProgress = items.filter((i) => i["status"] === STATUS_IN_PROGRESS).length;
  if (pending === 0 && inProgress === 0) return null;
  return [pending, inProgress];
}

function resumeMsg(runId: string, residual: ResidualWork): string {
  const [pending, inProgress] = residual as [number, number];
  return (
    `/agentflow:foreach run '${runId}' is not complete: ${pending} pending, ${inProgress} in_progress. ` +
    `Resume the foreach loop for this run-id (do NOT re-init; read the state and process the next batch, ` +
    `dispatching subagents or processing inline per config.execution). ` +
    `If items are stuck in 'in_progress' from a prior session, reset them with the foreach \`reset ${runId} --in-progress-to-pending\` subcommand.`
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
    case "claim-serial":
      return cmdClaimSerial(rest);
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
