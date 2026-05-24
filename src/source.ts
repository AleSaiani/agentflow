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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Item,
  type SourceSpec,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_IN_PROGRESS,
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
    case "folder":
      return loadFolder(spec.path);
    case "run":
      // A `run` source is resolved by the orchestrator (it reads a sibling run's state and
      // feeds its items/output here). Kept as an explicit branch for the seam; impl lives
      // with the consuming primitive (e.g. /reduce from a run).
      die("error: 'run' source must be resolved by the orchestrator, not loadSource()");
      break;
  }
  return [];
}

// ---------- folder-kanban source/view: todo/ → in-progress/ → done/ ----------

const KANBAN = [
  ["todo", STATUS_PENDING],
  ["in-progress", STATUS_IN_PROGRESS],
  ["done", STATUS_DONE],
] as const;

/** Map an item status to its kanban folder. */
function kanbanFolder(status: string): string {
  if (status === STATUS_DONE || status === STATUS_FAILED) return "done";
  if (status === STATUS_IN_PROGRESS) return "in-progress";
  return "todo";
}

/**
 * Folder-kanban Source: one file = one item. If `<base>/{todo,in-progress,done}/` exist, items
 * take their status from the folder they sit in; otherwise every file under `<base>` is a pending
 * todo. The file's contents are the task — the orchestrator reads `data.path` when processing.
 */
export function loadFolder(base: string): Item[] {
  if (!existsSync(base)) die(`error: folder source not found at ${base}`);
  const items: Item[] = [];
  let usedSubfolders = false;
  for (const [name, status] of KANBAN) {
    const dir = join(base, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    usedSubfolders = true;
    for (const f of readdirSync(dir).sort()) {
      const full = join(dir, f);
      if (!statSync(full).isFile()) continue;
      items.push({ id: f, data: { file: f, path: full, folder: name }, status });
    }
  }
  if (!usedSubfolders) {
    for (const f of readdirSync(base).sort()) {
      const full = join(base, f);
      if (!statSync(full).isFile()) continue;
      items.push({ id: f, data: { file: f, path: full, folder: "todo" }, status: STATUS_PENDING });
    }
  }
  return items;
}

/**
 * Folder-kanban write-back View: move each item's file into the folder matching its authoritative
 * status (pending→todo, in_progress→in-progress, done/failed→done). The visible board reflects state.
 */
export function writeFolderView(base: string, items: Item[]): number {
  let moved = 0;
  for (const it of items) if (moveKanbanItem(base, it.id, it.data, it.status)) moved++;
  return moved;
}

/**
 * Move ONE kanban file (by its `data.file`, falling back to `id`) into the folder matching `status`
 * (pending→todo, in_progress→in-progress, done/failed→done). Returns true if it actually moved.
 * Called automatically by /flow:foreach on claim/complete so the board stays live without an extra step.
 */
export function moveKanbanItem(base: string, id: string, data: unknown, status: string): boolean {
  const file = String((data as Record<string, unknown>)?.["file"] ?? id);
  let curr: string | null = null;
  for (const [name] of KANBAN) {
    const p = join(base, name, file);
    if (existsSync(p)) {
      curr = p;
      break;
    }
  }
  if (!curr && existsSync(join(base, file))) curr = join(base, file);
  if (!curr) return false;
  const dest = join(base, kanbanFolder(status));
  mkdirSync(dest, { recursive: true });
  const destPath = join(dest, file);
  if (resolve(curr) === resolve(destPath)) return false;
  renameSync(curr, destPath);
  return true;
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
