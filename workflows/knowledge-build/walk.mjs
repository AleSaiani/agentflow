#!/usr/bin/env node
/**
 * Stage-2 walk for knowledge-build. The deterministic source of truth for coverage: every code file in
 * the repo (with a content_hash), plus a compact folder tree. The LLM plan stage groups THESE files into
 * entities — it can't invent or skip files, so "look at everything" is guaranteed by code, not the model.
 * In update mode each file is flagged `changed` so the document stage can skip the rest. Node builtins only.
 *
 * Env: KB_CONFIG (required — resolve output), KB_MAX_FILES (default 8000).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const cfgPath = process.env.KB_CONFIG;
if (!cfgPath) {
  process.stderr.write("walk: KB_CONFIG (resolve output) is required\n");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const ROOT = cfg.repo;
const MAX_FILES = Number(process.env.KB_MAX_FILES || 8000);
const changedSet = Array.isArray(cfg.changed) ? new Set(cfg.changed) : null; // null = full pass

const CODE_EXT = new Set([".cs", ".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".vue", ".svelte"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".cache", ".turbo", "bin", "obj"]);

const files = [];
const dirs = new Set();
function walk(dir) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (files.length >= MAX_FILES) return;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name) || ent.name.startsWith(".")) continue;
      walk(abs);
    } else if (ent.isFile() && CODE_EXT.has(extname(ent.name).toLowerCase())) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      const dir2 = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
      dirs.add(dir2);
      let hash = "0";
      try {
        hash = createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
      } catch {
        /* keep 0 */
      }
      files.push({ rel, hash, changed: changedSet ? changedSet.has(rel) : true });
    }
  }
}
walk(ROOT);

process.stdout.write(
  JSON.stringify({ repo: ROOT, total: files.length, changed_count: files.filter((f) => f.changed).length, dirs: [...dirs].sort(), files }, null, 2),
);
