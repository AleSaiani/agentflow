/**
 * Source / View seam (workflow-layer amendment).
 *
 * A **Source** produces `Item[]` from some artifact; a **View** reprojects authoritative
 * state back onto a human-readable artifact. v1 adapters: `inline | file | run | checkbox`.
 * New adapters (folder-kanban, nested checklist fan-out) slot in here without touching the
 * primitives. Authoritative state always lives in `state.json`; a View is optional and lossy
 * by design (it only toggles what it can map back).
 *
 * Checkbox grammar (Forma C):
 *   - [ ] do the thing {model:opus, subagent:code-reviewer}
 *   - [x] already done
 * `[x]` = done, `[ ]` = pending. The trailing `{...}` is parsed into a per-item `task`
 * override (`model`, `subagent`/`subagent_type` → subagentType, `prompt`); unknown keys
 * land in `data`. Indentation depth is recorded in `data.level` (nested fan-out is v1.1).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Item,
  type SourceSpec,
  STATUS_DONE,
  STATUS_PENDING,
  die,
} from "./common.js";

const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;
const ANNOTATION_RE = /\{([^}]*)\}\s*$/;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}

interface ParsedLine {
  text: string;
  task?: Item["task"];
  extra: Record<string, string>;
}

/** Split a checkbox line's payload into clean text + parsed `{...}` annotations. */
function parseLinePayload(payload: string): ParsedLine {
  const m = payload.match(ANNOTATION_RE);
  const text = (m ? payload.slice(0, m.index).trimEnd() : payload).trim();
  const task: NonNullable<Item["task"]> = {};
  const extra: Record<string, string> = {};
  if (m && m[1]) {
    for (const pair of m[1].split(",")) {
      const idx = pair.search(/[:=]/);
      if (idx < 0) continue;
      const key = pair.slice(0, idx).trim().toLowerCase();
      const value = pair.slice(idx + 1).trim();
      if (!key || !value) continue;
      if (key === "model") task.model = value;
      else if (key === "subagent" || key === "subagent_type" || key === "subagenttype") task.subagentType = value;
      else if (key === "prompt") task.prompt = value;
      else extra[key] = value;
    }
  }
  const result: ParsedLine = { text, extra };
  if (Object.keys(task).length > 0) result.task = task;
  return result;
}

/** Parse a markdown checklist into `Item[]`. Each checkbox line becomes one item. */
export function parseChecklist(markdown: string): Item[] {
  const items: Item[] = [];
  const seen = new Map<string, number>();
  const lines = markdown.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] ?? "";
    const m = line.match(CHECKBOX_RE);
    if (!m) continue;
    const indent = (m[1] ?? "").replace(/\t/g, "  ");
    const checked = (m[2] ?? " ").toLowerCase() === "x";
    const { text, task, extra } = parseLinePayload(m[3] ?? "");

    let id = slugify(text);
    const dup = seen.get(id);
    if (dup !== undefined) {
      seen.set(id, dup + 1);
      id = `${id}-${dup + 1}`;
    } else {
      seen.set(id, 1);
    }

    const item: Item = {
      id,
      data: { text, level: Math.floor(indent.length / 2), line: lineNo, ...extra },
      status: checked ? STATUS_DONE : STATUS_PENDING,
    };
    if (task) item.task = task;
    items.push(item);
  }
  return items;
}

/** Resolve a `SourceSpec` (or a checkbox/file path) into `Item[]`. */
export function loadSource(spec: SourceSpec): Item[] {
  switch (spec.source) {
    case "inline":
      return spec.items;
    case "checkbox": {
      if (!existsSync(spec.path)) die(`error: checkbox source not found at ${spec.path}`);
      return parseChecklist(readFileSync(spec.path, "utf8"));
    }
    case "file": {
      if (!existsSync(spec.path)) die(`error: items file not found at ${spec.path}`);
      const raw = JSON.parse(readFileSync(spec.path, "utf8"));
      if (!Array.isArray(raw)) die("error: items file must contain a JSON array");
      return raw as Item[];
    }
    case "run":
      // A `run` source is resolved by the orchestrator (it reads a sibling run's state and
      // feeds its items/output here). Kept as an explicit branch for the seam; impl lives
      // with the consuming primitive (e.g. /reduce --from-run).
      die("error: 'run' source must be resolved by the orchestrator, not loadSource()");
      break;
  }
  return [];
}

/**
 * Checkbox write-back View: re-read the markdown and toggle each checkbox to reflect the
 * authoritative item statuses (done → `[x]`, otherwise `[ ]`). Surrounding prose is
 * preserved; only the box characters change. Items are matched to lines by slug of text.
 */
export function writeChecklistView(path: string, items: Item[]): number {
  if (!existsSync(path)) die(`error: checkbox view target not found at ${path}`);
  const statusBySlug = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const it of items) {
    // Recompute the same id slugging used by parseChecklist so we match the right line.
    const text = String((it.data as Record<string, unknown>)?.["text"] ?? "");
    let id = slugify(text);
    const dup = seen.get(id);
    if (dup !== undefined) {
      seen.set(id, dup + 1);
      id = `${id}-${dup + 1}`;
    } else {
      seen.set(id, 1);
    }
    statusBySlug.set(id, it.status);
  }

  const lineSeen = new Map<string, number>();
  let changed = 0;
  const out = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(CHECKBOX_RE);
      if (!m) return line;
      const { text } = parseLinePayload(m[3] ?? "");
      let id = slugify(text);
      const dup = lineSeen.get(id);
      if (dup !== undefined) {
        lineSeen.set(id, dup + 1);
        id = `${id}-${dup + 1}`;
      } else {
        lineSeen.set(id, 1);
      }
      const status = statusBySlug.get(id);
      if (status === undefined) return line;
      const box = status === STATUS_DONE ? "x" : " ";
      const next = line.replace(/\[[ xX]\]/, `[${box}]`);
      if (next !== line) changed++;
      return next;
    })
    .join("\n");
  writeFileSync(path, out, "utf8");
  return changed;
}
