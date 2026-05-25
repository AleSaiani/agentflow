/**
 * State manager for /group.
 *
 * Partition N items into K groups by key. Deterministic methods (path-prefix, regex,
 * jsonpath) and an LLM-classify method (dispatch ONE agent that returns the
 * {item_id -> group_id} mapping). Single-writer: the orchestrator owns state writes.
 *
 * Output `.agentflow/group/<run-id>/groups.json` is items.json-compatible: a JSON array of group
 * items `{id, data:{group_id, items, size}}` — feed directly to /agentflow:foreach. Faithful port
 * of `group_state.py`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  Primitive,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_IN_PROGRESS,
  STATUS_PENDING,
  type ResidualWork,
  type StateDict,
  die, isHelp, printUsage,
  loadState,
  makeBaseState,
  markDone,
  markFailed,
  markInProgress,
  now,
  print,
  saveAtomic,
  stateDir,
  statePath,
} from "../common.js";

const CMD = "group";

const DETERMINISTIC_METHODS = ["path-prefix", "regex", "jsonpath"];
const LLM_METHODS = ["llm-classify"];
const ALL_METHODS = [...DETERMINISTIC_METHODS, ...LLM_METHODS];

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

// ---------- input resolution ----------

function resolveInput(inputSource: StateDict): StateDict[] {
  const src = inputSource["source"];
  if (src === "file") {
    const data = JSON.parse(readFileSync(inputSource["path"], "utf8"));
    if (!Array.isArray(data)) die("error: input file must contain a JSON array");
    return data;
  }
  if (src === "run") {
    const fromCmd = inputSource["cmd"] ?? "foreach";
    const other = loadState(statePath(fromCmd, inputSource["run_id"]));
    const items: StateDict[] = [];
    for (const it of Object.values(other["items"] ?? {}) as StateDict[]) {
      if (it["status"] === STATUS_DONE) items.push({ id: it["id"], data: it["data"] ?? {}, result: it["result"] });
    }
    return items;
  }
  if (src === "inline") return inputSource["data"];
  die(`error: unknown input source '${src}'`);
}

// ---------- deterministic grouping methods ----------

function groupByPathPrefix(items: StateDict[], depth: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const it of items) {
    const data = it["data"] ?? {};
    const path = data["rel_path"] || data["path"] || it["id"];
    const parts = String(path)
      .split(/[/\\]/)
      .filter(Boolean);
    const key = parts.length ? parts.slice(0, depth).join("/") : "<root>";
    (out[key] ??= []).push(String(it["id"]));
  }
  return out;
}

function groupByRegex(items: StateDict[], pattern: string, field: string): Record<string, string[]> {
  const rx = new RegExp(pattern);
  const out: Record<string, string[]> = {};
  for (const it of items) {
    let text: string;
    if (field === "id") {
      text = String(it["id"]);
    } else {
      let cur: unknown = it["data"] ?? {};
      for (const part of field.split(".")) {
        if (part === "data") continue;
        if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[part];
        else {
          cur = null;
          break;
        }
      }
      text = cur == null ? "" : String(cur);
    }
    const m = rx.exec(text);
    const key = m ? (m[1] !== undefined ? m[1] : m[0]) : "<no-match>";
    (out[key] ??= []).push(String(it["id"]));
  }
  return out;
}

function groupByJsonpath(items: StateDict[], path: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const it of items) {
    let cur: unknown = it;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        cur = (cur as Record<string, unknown>)[part];
      } else if (Array.isArray(cur)) {
        const idx = parseInt(part, 10);
        cur = Number.isNaN(idx) ? undefined : cur[idx];
        if (cur === undefined) {
          cur = null;
          break;
        }
      } else {
        cur = null;
        break;
      }
    }
    const key = cur == null ? "<missing>" : String(cur);
    (out[key] ??= []).push(String(it["id"]));
  }
  return out;
}

function materializeOutput(
  state: StateDict,
  itemsById: Record<string, StateDict>,
  groupsIndex: Record<string, string[]>,
  outPath: string,
): void {
  const payload: StateDict[] = [];
  const enriched: Record<string, StateDict> = {};
  for (const gid of Object.keys(groupsIndex).sort()) {
    const ids = groupsIndex[gid] as string[];
    const groupItems = ids.filter((i) => i in itemsById).map((i) => itemsById[i]);
    payload.push({ id: gid, data: { group_id: gid, items: groupItems, size: groupItems.length } });
    enriched[gid] = { item_ids: ids, size: groupItems.length };
  }
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  state["groups"] = enriched;
  state["groups_count"] = Object.keys(enriched).length;
}

// ---------- CLI commands ----------

function cmdInit(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      method: { type: "string" },
      "input-source": { type: "string" },
      "method-config": { type: "string", default: "" },
      model: { type: "string", default: "sonnet" },
      "auto-continue": { type: "boolean" },
      "no-auto-continue": { type: "boolean" },
      "max-auto-continues": { type: "string", default: "5" },
      "min-items": { type: "string", default: "10" },
      "subagent-type": { type: "string", default: "general-purpose" },
      force: { type: "boolean", default: false },
      "validate-only": { type: "boolean", default: false },
    },
  });
  const runId = positionals[0];
  if (!runId) die("error: init requires a run_id");
  const method = values["method"] as string;
  if (!ALL_METHODS.includes(method)) die(`error: method must be one of ${ALL_METHODS.join(",")}`);
  const methodConfig = values["method-config"] ? JSON.parse(values["method-config"] as string) : {};
  if (method === "regex" && !("pattern" in methodConfig)) die("error: method=regex requires method_config.pattern");
  if (method === "jsonpath" && !("path" in methodConfig)) die("error: method=jsonpath requires method_config.path");

  if (values["validate-only"]) {
    print({ valid: true, method });
    return;
  }

  const inputSourcePath = values["input-source"] as string | undefined;
  if (!inputSourcePath) die("error: init requires --input-source");
  const inputSource = JSON.parse(readFileSync(inputSourcePath, "utf8"));

  const autoContinue = values["no-auto-continue"] ? false : true;
  const state = makeBaseState(
    CMD,
    runId,
    {
      method,
      model: values["model"],
      auto_continue: autoContinue,
      max_auto_continues: parseInt(values["max-auto-continues"] as string, 10),
      min_items: parseInt(values["min-items"] as string, 10),
      subagent_type: values["subagent-type"],
    },
    { method_config: methodConfig, input_source: inputSource, items_total: 0, groups: {}, groups_count: 0 },
  );

  const p = pathFor(runId);
  if (existsSync(p) && !values["force"]) die(`error: state already exists at ${p}; use --force to overwrite`);
  saveAtomic(p, state);
  print({ run_id: runId, method, path: p });
}

function cmdRunDeterministic(args: string[]): void {
  const runId = requireRunId(args, "run-deterministic");
  const state = load(runId);
  const method = state["config"]["method"];
  if (!DETERMINISTIC_METHODS.includes(method))
    die(`error: method '${method}' is not deterministic; use 'classify' subcommands instead`);

  markInProgress(state);
  save(runId, state);

  const items = resolveInput(state["input_source"]);
  if (!items || items.length === 0) {
    markFailed(state, "no input items");
    save(runId, state);
    die("error: no input items");
  }

  state["items_total"] = items.length;
  const itemsById: Record<string, StateDict> = {};
  for (const it of items) itemsById[String(it["id"])] = it;

  const cfg = state["method_config"];
  let groups: Record<string, string[]>;
  if (method === "path-prefix") groups = groupByPathPrefix(items, parseInt(cfg["depth"] ?? 2, 10));
  else if (method === "regex") groups = groupByRegex(items, cfg["pattern"], cfg["field"] ?? "id");
  else if (method === "jsonpath") groups = groupByJsonpath(items, cfg["path"]);
  else die(`error: unhandled deterministic method '${method}'`);

  const outPath = join(stateDir(CMD), runId, "groups.json");
  materializeOutput(state, itemsById, groups, outPath);
  markDone(state, outPath);
  save(runId, state);
  print({
    run_id: runId,
    status: STATUS_DONE,
    items_total: state["items_total"],
    groups_count: state["groups_count"],
    output: outPath,
  });
}

function cmdPrepareClassify(args: string[]): void {
  const runId = requireRunId(args, "prepare-classify");
  const state = load(runId);
  if (!LLM_METHODS.includes(state["config"]["method"]))
    die(`error: method '${state["config"]["method"]}' is not LLM-based`);
  const items = resolveInput(state["input_source"]);
  if (!items || items.length === 0) die("error: no input items");

  state["items_total"] = items.length;
  markInProgress(state);
  save(runId, state);

  const out = join(stateDir(CMD), runId, "items-to-classify.json");
  mkdirSync(join(stateDir(CMD), runId), { recursive: true });
  writeFileSync(out, JSON.stringify(items, null, 2), "utf8");
  print({ run_id: runId, items_to_classify: out, items_total: items.length });
}

function cmdApplyClassification(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { mapping: { type: "string" } },
  });
  const runId = positionals[0];
  const mappingPath = values["mapping"] as string | undefined;
  if (!runId || !mappingPath) die("error: apply-classification requires run_id and --mapping");
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping))
    die("error: mapping file must be a JSON object {item_id: group_id}");

  const state = load(runId);
  const items = resolveInput(state["input_source"]);
  const itemsById: Record<string, StateDict> = {};
  for (const it of items) itemsById[String(it["id"])] = it;

  const groups: Record<string, string[]> = {};
  for (const itemId of Object.keys(itemsById)) {
    const gid = String(mapping[itemId] ?? "<unclassified>");
    (groups[gid] ??= []).push(itemId);
  }

  const outPath = join(stateDir(CMD), runId, "groups.json");
  materializeOutput(state, itemsById, groups, outPath);
  markDone(state, outPath);
  save(runId, state);
  print({
    run_id: runId,
    status: STATUS_DONE,
    items_total: state["items_total"],
    groups_count: state["groups_count"],
    output: outPath,
  });
}

function cmdFail(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { error: { type: "string", default: "" } },
  });
  const runId = positionals[0];
  if (!runId) die("error: fail requires a run_id");
  const state = load(runId);
  markFailed(state, values["error"] as string);
  save(runId, state);
  print({ run_id: runId, status: STATUS_FAILED, error: values["error"] });
}

function cmdStatus(args: string[]): void {
  const runId = requireRunId(args, "status");
  const state = load(runId);
  const b = state["budget"] ?? {};
  print({
    run_id: runId,
    cmd: CMD,
    status: state["status"],
    method: state["config"]["method"],
    items_total: state["items_total"] ?? 0,
    groups_count: state["groups_count"] ?? 0,
    result_pointer: state["result_pointer"] ?? null,
    error: state["error"] ?? null,
    budget: {
      tokens_used: b["tokens_used"] ?? 0,
      agents_dispatched: b["agents_dispatched"] ?? 0,
      usd_estimate: Math.round((b["usd_estimate"] ?? 0) * 1e4) / 1e4,
    },
  });
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

function requireRunId(args: string[], sub: string): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  const runId = positionals[0];
  if (!runId) die(`error: ${sub} requires a run_id`);
  return runId;
}

// ---------- primitive registration ----------

function isDone(state: StateDict): boolean {
  return state["status"] === STATUS_DONE;
}
function hasResidualWork(state: StateDict): ResidualWork | null {
  const status = state["status"];
  if (status === STATUS_PENDING || status === STATUS_IN_PROGRESS) return [status];
  return null;
}
function resumeMsg(runId: string, residual: ResidualWork): string {
  const [status] = residual as [string];
  return (
    `/group run '${runId}' is not complete (status=${status}). ` +
    `Resume by re-running the grouping step for this run-id. Do NOT re-init.`
  );
}

const PRIM = new Primitive(CMD, { isDone, hasResidualWork, resumeMsg });

function main(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (isHelp(sub)) return printUsage(CMD, ["init", "run-deterministic", "prepare-classify", "apply-classification", "fail", "status", "runs", "increment-continues", "budget-add"]);
  switch (sub) {
    case "init":
      return cmdInit(rest);
    case "run-deterministic":
      return cmdRunDeterministic(rest);
    case "prepare-classify":
      return cmdPrepareClassify(rest);
    case "apply-classification":
      return cmdApplyClassification(rest);
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
