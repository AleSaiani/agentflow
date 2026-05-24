/**
 * Shared utilities for orchestration primitives (`/enumerate`, `/group`, `/reduce`,
 * `/iterate`, `/pipe`).
 *
 * Node builtins only. No domain logic here — only:
 * - workspace root resolution (portable, no hardcoded paths)
 * - runtime state dir per primitive (`.enumerate/`, `.iterate/`, `.pipe/`, ...)
 * - atomic JSON write (tempfile + rename)
 * - ISO UTC timestamp
 * - knowledge journal append (`.knowledge/<domain>/<entity>.md`)
 * - base state schema + primitive registry (the framework's "type system" for stages)
 * - the workflow-layer seam types (Source/View, Predicate, WorkflowSpec) — types only in v1
 *
 * All primitives import from here to keep paths and I/O uniform. This is a faithful
 * TypeScript port of the validated Python prototype (`_common.py`); state-file JSON keys
 * are kept snake_case to preserve the on-disk contract exactly.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------- shared type contracts ----------

/** Canonical run status, uniform across primitives. */
export type Status = "pending" | "in_progress" | "done" | "failed" | "aborted";

/** Model name (free-form; pricing matches by substring haiku/sonnet/opus). */
export type Model = string;

/**
 * Loosely-typed state dict. Mirrors the Python `dict[str, Any]`: state is JSON read
 * from disk and extended per-primitive, so dynamic access is intentional here. The
 * strongly-typed contracts below document the *shape*; this alias is the runtime surface.
 */
export type StateDict = Record<string, any>;

export interface BudgetEvent {
  at: string;
  type: string;
  tokens: number;
  usd: number;
  model: string | null;
  meta: Record<string, unknown>;
}

export interface Budget {
  tokens_used: number;
  agents_dispatched: number;
  usd_estimate: number;
  last_event_at: string | null;
  events: BudgetEvent[];
}

/** Base fields every primitive's state.json carries (extended per-primitive). */
export interface BaseState {
  run_id: string;
  cmd: string;
  created_at: string;
  updated_at: string;
  config: Record<string, any>;
  auto_continues: number;
  status: Status;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result_pointer: string | null;
  parent_run_id: string | null;
  stage_index: number | null;
  followups: unknown[];
  budget: Budget;
}

/**
 * Per-item unit of work. The rich-items seam: per-item override of prompt/model/subagent,
 * nested subtasks (schema only in v1), and item-level status carried in the parent state.
 */
export interface Item {
  id: string;
  data: unknown;
  task?: { prompt?: string; subagentType?: string; model?: Model };
  subtasks?: unknown; // SubtaskSpec — nested enumeration; schema-only seam in v1
  status: Status;
  result?: unknown;
  error?: string | null;
}

/**
 * Source seam — produces `Item[]` from some artifact. v1 adapters: inline | file | run |
 * checkbox. New adapters (folder-kanban, nested checklist) slot in without touching core.
 */
export type SourceSpec =
  | { source: "inline"; items: Item[] }
  | { source: "file"; path: string }
  | { source: "run"; cmd: string; run_id: string }
  | { source: "checkbox"; path: string }
  | { source: "folder"; path: string };

/** View seam — reprojects authoritative state back onto a human-readable artifact. */
export interface ViewSpec {
  view: "checkbox" | "folder";
  path: string;
}

/**
 * Deterministic predicate. The determinism boundary: an LLM may *produce* the structured
 * data a predicate reads, but the branch itself is always evaluated by code. v1 form is a
 * bash command judged by exit code (`until`: exit 0 = stop; `while`: inverted).
 */
export interface Predicate {
  type: "bash";
  command: string;
  mode?: "until" | "while";
}

/**
 * Declarative workflow front-end (v1: JSON; YAML is a v1.1 front-end). A WorkflowSpec
 * *compiles* into `pipe.stages[]` — no new engine. `when` is a per-stage guard; `next`
 * makes `/pipe` a graph (default = advance by one) so branches/back-edges are expressible.
 */
export interface WorkflowStage {
  name?: string;
  type: "bash" | "primitive";
  spec: Record<string, unknown>;
  when?: Predicate;
  next?: string | number | null;
}

export interface WorkflowSpec {
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  stages: WorkflowStage[];
}

/** Opaque payload handed from `hasResidualWork` to `resumeMsg` (Python: a tuple). */
export type ResidualWork = readonly unknown[];

// ---------- stdio helpers ----------

/** Write a JSON line to stdout (the primitive CLI protocol consumed by skills). */
export function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Print an error to stderr and exit non-zero (mirrors Python's `sys.exit(msg)`). */
export function die(msg: string): never {
  process.stderr.write((msg.endsWith("\n") ? msg : msg + "\n"));
  process.exit(1);
}

// cmd-name -> env var that overrides the runtime dir for that primitive.
// Add an entry here when a new primitive is introduced.
const OVERRIDE_ENV: Record<string, string> = {
  enumerate: "ENUMERATE_STATE_DIR",
  foreach: "FOREACH_STATE_DIR",
  group: "GROUP_STATE_DIR",
  iterate: "ITERATE_STATE_DIR",
  pipe: "PIPE_STATE_DIR",
  queue: "QUEUE_STATE_DIR",
  reduce: "REDUCE_STATE_DIR",
  step: "STEP_STATE_DIR",
};

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from cwd looking for `.claude/` or `.git/`. Fallback: cwd. */
export function findWorkspaceRoot(): string {
  let cur = resolve(process.cwd());
  for (;;) {
    if (isDir(join(cur, ".claude")) || existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return resolve(process.cwd());
    cur = parent;
  }
}

/** This plugin's install root, derived from the compiled module: `<root>/dist/common.js` → `<root>`.
 * Reliable regardless of cwd or env — used to find bundled assets (skills/, workflows/). */
export function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Runtime dir for a primitive: `<workspace>/.agentflow/<cmd>/`. Override via env (e.g. FOREACH_STATE_DIR). */
export function stateDir(cmd: string): string {
  const env = OVERRIDE_ENV[cmd];
  const override = env ? process.env[env] : undefined;
  if (override) return resolve(override);
  return join(findWorkspaceRoot(), ".agentflow", cmd);
}

export function statePath(cmd: string, runId: string): string {
  return join(stateDir(cmd), runId, "state.json");
}

/** ISO-8601 UTC timestamp at seconds precision (e.g. `2026-05-23T10:00:00Z`). */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function loadState(path: string): StateDict {
  if (!existsSync(path)) die(`error: no state at ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as StateDict;
}

/** Atomic swap: an interrupted write never leaves a half-written state file. */
export function saveAtomic(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state-${randomBytes(6).toString("hex")}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

export function listRuns(cmd: string): string[] {
  const d = stateDir(cmd);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((name) => existsSync(join(d, name, "state.json")))
    .sort();
}

// ---------- knowledge journals (L3 of the persistence stack) ----------
//
// Convention: `.knowledge/<domain>/<entity>.md`, append-only markdown. Skills opt-in to
// read this as preflight context and to write entries when they produce salient findings.
// The framework itself does NOT read it autonomously — it just provides a uniform append
// helper so every recipe formats entries the same way.

const UNSAFE_CHARS = new Set('<>:"|?* '.split(""));

function sanitizeEntity(entity: string): string {
  const out = entity.replace(/\//g, "__").replace(/\\/g, "__");
  let result = "";
  for (const ch of out) {
    result += UNSAFE_CHARS.has(ch) || ch.charCodeAt(0) < 32 ? "_" : ch;
  }
  return result;
}

/** Root of the knowledge journals tree. Override via $KNOWLEDGE_DIR. */
export function knowledgeDir(): string {
  const override = process.env["KNOWLEDGE_DIR"];
  if (override) return resolve(override);
  return join(findWorkspaceRoot(), ".agentflow", "knowledge");
}

export function journalPath(domain: string, entity: string): string {
  return join(knowledgeDir(), domain, `${sanitizeEntity(entity)}.md`);
}

/**
 * Read the template for `kind` from the skill's `task-kinds.md` (the body of the first
 * fenced code block following `### <kind>`), or null if not found. Plugin-aware: resolves
 * under `$CLAUDE_PLUGIN_ROOT/skills/<skill>/` when set, else the workspace `.claude/skills/`.
 */
export function loadTaskKindTemplate(kind: string, skill = "foreach"): string | null {
  // Resolve the plugin's skills dir robustly — do NOT rely on $CLAUDE_PLUGIN_ROOT being in the env
  // (it is substituted into skill *content*, but is not exported to the Bash tool that spawns this
  // CLI). Derive the plugin root from this compiled module's own location: dist/common.js → <root>.
  const candidates = [
    process.env["CLAUDE_PLUGIN_ROOT"] ? join(process.env["CLAUDE_PLUGIN_ROOT"], "skills", skill, "task-kinds.md") : null,
    join(pluginRoot(), "skills", skill, "task-kinds.md"),
    join(findWorkspaceRoot(), ".claude", "skills", skill, "task-kinds.md"),
  ].filter((p): p is string => p !== null);
  const candidate = candidates.find((p) => existsSync(p));
  if (!candidate) return null;
  const lines = readFileSync(candidate, "utf8").split(/\r?\n/);
  const header = `### ${kind}`.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim().toLowerCase() === header) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trimStart().startsWith("```")) j++;
      if (j >= lines.length) return null;
      j += 1; // past opening fence
      const start = j;
      while (j < lines.length && !(lines[j] ?? "").trimStart().startsWith("```")) j++;
      return lines.slice(start, j).join("\n").replace(/\s+$/, "") + "\n";
    }
  }
  return null;
}

/**
 * Append a dated entry to the journal for `<domain>/<entity>`. The header for an entity is
 * created on first write and includes the original (unsanitized) name so the mapping back
 * from filename is unambiguous.
 */
export function appendJournal(
  domain: string,
  entity: string,
  body: string,
  sourceRunId: string | null = null,
): string {
  const path = journalPath(domain, entity);
  mkdirSync(dirname(path), { recursive: true });
  const newFile = !existsSync(path);
  const header = newFile ? `# ${entity}\n\n` : "";
  const src = sourceRunId || "manual";
  const entry = `## ${now()} — ${src}\n${body.replace(/\s+$/, "")}\n\n`;
  appendFileSync(path, header + entry, "utf8");
  return path;
}

// ---------- base state schema (the framework's "type system" for stages) ----------

export const STATUS_PENDING: Status = "pending";
export const STATUS_IN_PROGRESS: Status = "in_progress";
export const STATUS_DONE: Status = "done";
export const STATUS_FAILED: Status = "failed";
export const STATUS_ABORTED: Status = "aborted";

export const ALL_STATUSES: readonly Status[] = [
  STATUS_PENDING,
  STATUS_IN_PROGRESS,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_ABORTED,
];

/**
 * Construct the common base fields every primitive's state must have. Primitives extend
 * this with their own fields via `extra` or by mutating the returned dict. Reserved base
 * fields must not be overwritten.
 */
export function makeBaseState(
  cmd: string,
  runId: string,
  config: Record<string, any>,
  extra: Record<string, any> = {},
): StateDict {
  const ts = now();
  const state: StateDict = {
    run_id: runId,
    cmd,
    created_at: ts,
    updated_at: ts,
    config: { ...config },
    auto_continues: 0,
    status: STATUS_PENDING,
    started_at: null,
    completed_at: null,
    error: null,
    result_pointer: null, // path to a single canonical artifact, when applicable
    parent_run_id: null, // set by /pipe when this run is a stage of a parent pipeline
    stage_index: null, // set by /pipe
    followups: [], // reserved for dynamic task graph (subagents append here)
    budget: {
      tokens_used: 0,
      agents_dispatched: 0,
      usd_estimate: 0.0,
      last_event_at: null,
      events: [], // list of {at, type, tokens, usd, meta} — last 50 retained
    },
  };
  Object.assign(state, extra);
  return state;
}

// ---------- budget tracking ----------
//
// Per-1M-token pricing defaults (USD). `estimateUsd` accepts a single token count + model
// name and uses a blended rate assuming an input:output ratio (the common review/digest shape).

const DEFAULT_PRICING: Record<string, readonly [number, number]> = {
  // model_prefix: [input_per_million_usd, output_per_million_usd]
  haiku: [0.8, 4.0],
  sonnet: [3.0, 15.0],
  opus: [15.0, 75.0],
};

const BUDGET_EVENTS_RETAINED = 50;

function pricingFor(model: string | null): readonly [number, number] {
  const sonnet = DEFAULT_PRICING["sonnet"] as readonly [number, number];
  if (!model) return sonnet;
  const m = model.toLowerCase();
  for (const key of Object.keys(DEFAULT_PRICING)) {
    if (m.includes(key)) return DEFAULT_PRICING[key] as readonly [number, number];
  }
  return sonnet;
}

/**
 * Rough USD estimate from a token count + model name. `inputOutputRatio` is the fraction
 * of tokens assumed to be INPUT (the rest output). Default 1/3 input + 2/3 output is a
 * defensible blend for review/digest workloads where the model's output dominates.
 */
export function estimateUsd(model: string | null, tokens: number, inputOutputRatio = 1 / 3): number {
  if (tokens <= 0) return 0.0;
  const [inRate, outRate] = pricingFor(model);
  const inTokens = tokens * inputOutputRatio;
  const outTokens = tokens * (1 - inputOutputRatio);
  return (inTokens * inRate + outTokens * outRate) / 1_000_000;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Append a budget event to the run's state; returns the updated budget block. If `usd` is
 * null and `tokens` > 0, USD is estimated via `estimateUsd(model, tokens)`.
 */
export function addBudgetEvent(
  state: StateDict,
  opts: {
    tokens?: number;
    usd?: number | null;
    eventType?: string;
    model?: string | null;
    meta?: Record<string, unknown> | null;
  } = {},
): Budget {
  const { tokens = 0, eventType = "agent_dispatch", model = null, meta = null } = opts;
  let usd = opts.usd ?? null;
  const b: Budget =
    state["budget"] ??
    (state["budget"] = {
      tokens_used: 0,
      agents_dispatched: 0,
      usd_estimate: 0.0,
      last_event_at: null,
      events: [],
    });
  if (usd === null && tokens > 0) usd = estimateUsd(model, tokens);
  usd = Number(usd || 0.0);

  b.tokens_used = Math.trunc(b.tokens_used || 0) + Math.max(0, Math.trunc(tokens));
  b.usd_estimate = (b.usd_estimate || 0.0) + usd;
  if (eventType === "agent_dispatch") b.agents_dispatched = Math.trunc(b.agents_dispatched || 0) + 1;
  b.last_event_at = now();

  b.events.push({
    at: now(),
    type: eventType,
    tokens: Math.trunc(tokens),
    usd: round(usd, 6),
    model,
    meta: meta || {},
  });
  // Trim to the last N events to keep state files small.
  if (b.events.length > BUDGET_EVENTS_RETAINED) {
    b.events.splice(0, b.events.length - BUDGET_EVENTS_RETAINED);
  }
  state["updated_at"] = now();
  return b;
}

/**
 * Return `[overCap, reason]` — true if any configured cap is exceeded. Caps live in
 * `state.config.budget_caps` as `{max_tokens, max_usd, max_agents}`; missing = no cap.
 */
export function checkBudgetCaps(state: StateDict): [boolean, string | null] {
  const caps = (state["config"]?.budget_caps as Record<string, number>) || {};
  const b = (state["budget"] as Budget) || {};
  const maxTokens = caps["max_tokens"];
  if (maxTokens && (b.tokens_used || 0) > maxTokens)
    return [true, `tokens_used ${b.tokens_used} > cap ${maxTokens}`];
  const maxUsd = caps["max_usd"];
  if (maxUsd !== undefined && maxUsd !== null && (b.usd_estimate || 0.0) > maxUsd)
    return [true, `usd_estimate ${(b.usd_estimate || 0).toFixed(4)} > cap ${maxUsd}`];
  const maxAgents = caps["max_agents"];
  if (maxAgents && (b.agents_dispatched || 0) >= maxAgents)
    return [true, `agents_dispatched ${b.agents_dispatched} >= cap ${maxAgents}`];
  return [false, null];
}

/**
 * A run is *paused* (not failed, not done) when its `config.stop_file` exists on disk, or a budget
 * cap is exceeded. The Stop hook skips paused runs (no auto-resume); `status` surfaces it. Remove the
 * stop-file / raise the cap to resume. Centralizes the pause contract across every primitive.
 */
export function isPaused(state: StateDict): [boolean, string | null] {
  const stopFile = (state["config"] as StateDict | undefined)?.["stop_file"];
  if (stopFile && existsSync(String(stopFile))) return [true, `stop-file present: ${stopFile}`];
  return checkBudgetCaps(state);
}

/** Parse `--max-usd` / `--max-tokens` / `--max-agents` CLI flags into a `budget_caps` object (or null). */
export function parseBudgetCaps(values: Record<string, unknown>): Record<string, number> | null {
  const caps: Record<string, number> = {};
  const usd = values["max-usd"];
  const tokens = values["max-tokens"];
  const agents = values["max-agents"];
  if (usd !== undefined) caps["max_usd"] = parseFloat(String(usd));
  if (tokens !== undefined) caps["max_tokens"] = parseInt(String(tokens), 10);
  if (agents !== undefined) caps["max_agents"] = parseInt(String(agents), 10);
  return Object.keys(caps).length ? caps : null;
}

// ---------- cache: skip-if-unchanged for per-item primitives ----------
//
// Storage: `.cache/<namespace>/<sha256>.json` at workspace root. Override with $CACHE_DIR.
// Safe to delete at any time — the cache is regenerated as runs complete.

export function cacheRoot(): string {
  const override = process.env["CACHE_DIR"];
  if (override) return resolve(override);
  return join(findWorkspaceRoot(), ".agentflow", "cache");
}

/** SHA-256 of the joined parts. Stable across runs as long as inputs are stable. */
export function cacheKey(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(Buffer.from(p || "", "utf8"));
    h.update(Buffer.from([0x1f])); // ASCII unit separator between parts
  }
  return h.digest("hex");
}

export function cachePath(namespace: string, key: string): string {
  return join(cacheRoot(), namespace, `${key}.json`);
}

export function cacheLookup(namespace: string, key: string): StateDict | null {
  const p = cachePath(namespace, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StateDict;
  } catch {
    return null;
  }
}

/** Atomic write — concurrent stores for the same key are safe. */
export function cacheStore(namespace: string, key: string, value: unknown): string {
  const p = cachePath(namespace, key);
  mkdirSync(dirname(p), { recursive: true });
  saveAtomic(p, { key, stored_at: now(), value });
  return p;
}

// ---------- primitive registry (the framework's composition contract) ----------

/**
 * Contract every primitive registers so the framework can compose it. The framework calls
 * these to decide: Stop hook → resume? (hasResidualWork + resumeMsg); /pipe → stage done?
 * where's its output? (isDone + resultPointer); dynamic task graph → follow-ups (nextActions).
 */
export interface PrimitiveSpec {
  cmd: string;
  isDone: (s: StateDict) => boolean;
  hasResidualWork: (s: StateDict) => ResidualWork | null;
  resumeMsg: (runId: string, work: ResidualWork) => string;
  resultPointer: (s: StateDict) => string | null;
  nextActions: (s: StateDict) => unknown[];
}

/** Registry populated at import time by each `<cmd>` state module. */
export const PRIMITIVES: Map<string, PrimitiveSpec> = new Map();

export function registerPrimitive(spec: PrimitiveSpec): void {
  PRIMITIVES.set(spec.cmd, spec);
}

export function getPrimitive(cmd: string): PrimitiveSpec | undefined {
  return PRIMITIVES.get(cmd);
}

// ---------- generic state mutation helpers (apply the base contract uniformly) ----------

export function markInProgress(state: StateDict): void {
  state["status"] = STATUS_IN_PROGRESS;
  state["started_at"] = state["started_at"] || now();
  state["error"] = null;
  state["updated_at"] = now();
}

export function markDone(state: StateDict, resultPointer: string | null = null): void {
  state["status"] = STATUS_DONE;
  state["completed_at"] = now();
  state["error"] = null;
  if (resultPointer !== null) state["result_pointer"] = resultPointer;
  state["updated_at"] = now();
}

export function markFailed(state: StateDict, error: string): void {
  state["status"] = STATUS_FAILED;
  state["completed_at"] = now();
  state["error"] = error;
  state["updated_at"] = now();
}

/** Increment counter; return `{value, cap, overCap}`. */
export function incrementAutoContinues(state: StateDict): { value: number; cap: number; overCap: boolean } {
  state["auto_continues"] = (state["auto_continues"] || 0) + 1;
  const cap = state["config"]?.max_auto_continues ?? 20;
  state["updated_at"] = now();
  const value = state["auto_continues"] as number;
  return { value, cap, overCap: value > cap };
}

/**
 * Encapsulates per-primitive boilerplate (paths, load/save, registry hook). Each `<cmd>`
 * state module constructs one `Primitive` at import time, which also registers the spec.
 */
export class Primitive {
  readonly cmd: string;

  constructor(
    cmd: string,
    spec: {
      isDone: (s: StateDict) => boolean;
      hasResidualWork: (s: StateDict) => ResidualWork | null;
      resumeMsg: (runId: string, work: ResidualWork) => string;
      resultPointer?: (s: StateDict) => string | null;
      nextActions?: (s: StateDict) => unknown[];
    },
  ) {
    this.cmd = cmd;
    registerPrimitive({
      cmd,
      isDone: spec.isDone,
      hasResidualWork: spec.hasResidualWork,
      resumeMsg: spec.resumeMsg,
      resultPointer: spec.resultPointer ?? ((s) => (s["result_pointer"] ?? null) as string | null),
      nextActions: spec.nextActions ?? ((s) => [...((s["followups"] as unknown[]) ?? [])]),
    });
  }

  // ---- paths & I/O ----

  path(runId: string): string {
    return statePath(this.cmd, runId);
  }

  stateDir(): string {
    return stateDir(this.cmd);
  }

  load(runId: string): StateDict {
    return loadState(this.path(runId));
  }

  save(runId: string, state: StateDict): void {
    state["updated_at"] = now();
    saveAtomic(this.path(runId), state);
  }

  makeState(runId: string, config: Record<string, any>, extra: Record<string, any> = {}): StateDict {
    return makeBaseState(this.cmd, runId, config, extra);
  }

  // ---- list/inspect ----

  listRuns(): string[] {
    return listRuns(this.cmd);
  }

  cliRuns(): void {
    print(this.listRuns());
  }

  cliIncrementContinues(runId: string): void {
    const state = this.load(runId);
    const { value, cap, overCap } = incrementAutoContinues(state);
    saveAtomic(this.path(runId), state);
    print({ auto_continues: value, max: cap, over_cap: overCap });
  }

  /** Common base fields for a `<cmd> status` output. Primitives extend with their own. */
  statusBase(state: StateDict): Record<string, unknown> {
    const b = (state["budget"] as Budget) || ({} as Budget);
    return {
      run_id: state["run_id"],
      cmd: state["cmd"],
      status: state["status"],
      result_pointer: state["result_pointer"],
      error: state["error"],
      auto_continues: state["auto_continues"] ?? 0,
      created_at: state["created_at"],
      updated_at: state["updated_at"],
      started_at: state["started_at"],
      completed_at: state["completed_at"],
      budget: {
        tokens_used: b.tokens_used ?? 0,
        agents_dispatched: b.agents_dispatched ?? 0,
        usd_estimate: round(b.usd_estimate ?? 0.0, 4),
      },
    };
  }

  cliBudgetAdd(
    runId: string,
    opts: { tokens?: number; usd?: number | null; eventType?: string; model?: string | null; metaJson?: string | null } = {},
  ): void {
    const state = this.load(runId);
    const meta = opts.metaJson ? (JSON.parse(opts.metaJson) as Record<string, unknown>) : null;
    const b = addBudgetEvent(state, {
      tokens: opts.tokens,
      usd: opts.usd,
      eventType: opts.eventType,
      model: opts.model,
      meta,
    });
    const [over, reason] = checkBudgetCaps(state);
    saveAtomic(this.path(runId), state);
    print({
      run_id: runId,
      tokens_used: b.tokens_used,
      agents_dispatched: b.agents_dispatched,
      usd_estimate: round(b.usd_estimate, 4),
      over_cap: over,
      cap_reason: reason,
    });
  }
}

/**
 * Append a follow-up request to the run's followups queue. Follow-ups are claimed by the
 * orchestrator at iteration boundaries. Single-writer is preserved: this is meant to be
 * called by the orchestrator after reading subagent-emitted requests from a separate file.
 */
export function appendFollowup(state: StateDict, action: unknown): void {
  if (!Array.isArray(state["followups"])) state["followups"] = [];
  (state["followups"] as unknown[]).push(action);
  state["updated_at"] = now();
}
