#!/usr/bin/env node
/**
 * Lens cascade resolver for the pr-review workflow. A *lens* is a named, structured rule set for a
 * stack (csharp, typescript-react, …) or a concern (security). Resolution is layered like
 * `eslint extends` / `.editorconfig`, lowest→highest precedence:
 *   1. shipped   — workflows/pr-review/lenses/<key>.json (this folder)
 *   2. org/team  — $AGENTFLOW_LENSES/<key>.json  (a shared dir, optional)
 *   3. project   — <repo>/.agentflow/lenses/<key>.json
 * Merge is **additive by id** (rules accumulate; a later layer's rule with the same `id` overrides the
 * earlier one). A layer can replace the whole lens with `"override": true`.
 *
 * A lens file is JSON (zero-dep parsing): { "lens": "<key>", "override": false,
 *   "rules": [ { "id": "...", "severity": "info|minor|major|critical", "guidance": "..." } ] }
 * A bare array of rules is also accepted. Node builtins only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

/** Severity ranking — the gate blocks on findings at or above a configurable threshold. */
export const SEVERITY_RANK = { info: 0, minor: 1, major: 2, critical: 3 };

// File extension → stack lens key. Detection is deterministic (the LLM judgment happens in the review
// step, not here). Unknown extensions get no stack lens — only `security` + team rules apply.
const EXT_STACK = {
  ".cs": "csharp",
  ".tsx": "typescript-react",
  ".jsx": "typescript-react",
  ".ts": "node", // refined to typescript-react/angular by content (see refineStack)
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".vue": "node",
  ".svelte": "node",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".kt": "kotlin",
  ".rs": "rust",
  ".php": "php",
};

export function detectStack(relPath) {
  return EXT_STACK[extname(relPath).toLowerCase()] ?? null;
}

/** Refine an ambiguous JS/TS-family stack by sniffing the file head: Angular vs React vs plain Node. */
export function refineStack(base, head) {
  if (base !== "node" && base !== "typescript-react") return base;
  if (typeof head !== "string") return base;
  if (/['"]@angular\//.test(head)) return "angular";
  if (/from\s+['"]react['"]|require\(\s*['"]react['"]\s*\)|['"]react-dom['"]/.test(head)) return "typescript-react";
  return base;
}

/** Normalize a parsed lens file into { override, rules[] }. Accepts {rules:[…]} or a bare [ … ]. */
function normalizeLens(parsed) {
  if (Array.isArray(parsed)) return { override: false, rules: parsed };
  const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  return { override: Boolean(parsed?.override), rules };
}

/** Read + parse one lens file, or null if missing/malformed. */
function readLensFile(path) {
  if (!existsSync(path)) return null;
  try {
    return normalizeLens(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Merge a layer onto the accumulated rules: override replaces; otherwise additive, same id wins. */
function applyLayer(rules, layer) {
  if (layer.override) return [...layer.rules];
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const r of layer.rules) byId.set(r.id, r); // later layer wins per id (override), new ids append
  return [...byId.values()];
}

/**
 * Resolve a lens `key` across the given layer dirs (lowest→highest precedence). Returns the merged
 * rule array (possibly empty if no layer defines the key).
 */
export function resolveLens(key, layerDirs) {
  let rules = [];
  for (const dir of layerDirs) {
    if (!dir) continue;
    const layer = readLensFile(join(dir, `${key}.json`));
    if (layer) rules = applyLayer(rules, layer);
  }
  return rules;
}

/** Load a standalone rules file (team rules: review-rules.json or a --param path). Tolerant of shape. */
export function loadRuleFile(path) {
  const layer = readLensFile(path);
  return layer ? layer.rules : [];
}
