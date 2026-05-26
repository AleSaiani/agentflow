#!/usr/bin/env node
/**
 * Stage-1 discover for the pr-review workflow. Two parts, both deterministic:
 *  1. the **changed set** — `git diff` between a base ref and head (PR semantics);
 *  2. the **related set** — files that reference a changed file (importers / call-sites by basename),
 *     so the review covers not just what changed but what it impacts.
 * Emits a /foreach-compatible items array; each item carries a sha256 content_hash (for the review
 * stage's --cache) and a `reason` (changed | related). Node builtins only.
 *
 * Env: PRREVIEW_DIR (repo, default cwd), PRREVIEW_BASE (default: first of origin/HEAD, origin/main,
 *   origin/master, main, master, else HEAD~1), PRREVIEW_HEAD (default HEAD), PRREVIEW_RELATED ("0"
 *   disables the related set), PRREVIEW_MAX_FILES (default 4000).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.env.PRREVIEW_DIR || process.cwd();
const HEAD = process.env.PRREVIEW_HEAD || "HEAD";
const WITH_RELATED = process.env.PRREVIEW_RELATED !== "0";
const MAX_FILES = Number(process.env.PRREVIEW_MAX_FILES || 4000);

const CODE_EXT = new Set([".cs", ".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".vue", ".svelte"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".cache", ".turbo", "bin", "obj"]);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function resolveBase() {
  if (process.env.PRREVIEW_BASE) return process.env.PRREVIEW_BASE;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return "HEAD~1";
}

function contentHash(abs) {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  } catch {
    return "0";
  }
}

const base = resolveBase();
// Three-dot = changes introduced since the merge-base (GitHub PR semantics); fall back to two-dot.
let raw = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${HEAD}`]);
if (raw === null) raw = git(["diff", "--name-only", "--diff-filter=ACMR", base, HEAD]);
if (raw === null) {
  process.stderr.write(`discover: could not run git diff against '${base}' in ${ROOT}\n`);
  process.stdout.write("[]");
  process.exit(0);
}

const changedRel = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const changedSet = new Set(changedRel);
const items = [];
const seen = new Set();

function addItem(rel, reason, extra = {}) {
  if (seen.has(rel)) return;
  const abs = join(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return;
  seen.add(rel);
  items.push({ id: rel, data: { path: abs, rel_path: rel, content_hash: contentHash(abs), reason, ...extra } });
}

for (const rel of changedRel) addItem(rel, "changed");

// Related set: walk the repo's code files once; a file that imports/uses a changed file's basename
// (minus extension) on an import-like line is "related" and gets reviewed too. Heuristic, deterministic.
if (WITH_RELATED && changedSet.size) {
  const tokens = new Map(); // basename-no-ext → [changed rel paths]
  for (const rel of changedSet) {
    const t = basename(rel).replace(/\.[^.]+$/, "");
    if (t.length < 3) continue; // skip noisy short names
    (tokens.get(t) ?? tokens.set(t, []).get(t)).push(rel);
  }
  const IMPORT_RE = /\b(import|from|require|using|include|use)\b/;
  let scanned = 0;
  const walk = (dir) => {
    if (scanned >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (scanned >= MAX_FILES) return;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR.has(ent.name) || ent.name.startsWith(".")) continue;
        walk(abs);
      } else if (ent.isFile() && CODE_EXT.has(extname(ent.name).toLowerCase())) {
        const rel = relative(ROOT, abs).split(sep).join("/");
        if (changedSet.has(rel)) continue;
        scanned++;
        let text;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const relatedTo = new Set();
        for (const line of text.split(/\r?\n/)) {
          if (!IMPORT_RE.test(line)) continue;
          for (const [tok, owners] of tokens) {
            if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line)) for (const o of owners) relatedTo.add(o);
          }
        }
        if (relatedTo.size) addItem(rel, "related", { related_to: [...relatedTo] });
      }
    }
  };
  walk(ROOT);
}

process.stdout.write(JSON.stringify(items, null, 2));
