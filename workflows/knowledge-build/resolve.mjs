#!/usr/bin/env node
/**
 * Stage-1 resolve for knowledge-build. Decides the run mode and (for git repos) the reference commit:
 *  - bootstrap: full pass; the current HEAD becomes the reference the manifest will record.
 *  - update:    read the manifest's recorded ref, diff it against HEAD → only the new/changed code files.
 * Emits a run config the later stages read. Node builtins only.
 *
 * Env: KB_DIR (repo, default cwd), KB_MODE (bootstrap|update, default bootstrap), KB_OUT (docs out dir,
 *   default ./docs/knowledge), KB_REF (override the base ref for update).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.env.KB_DIR || process.cwd();
const MODE = (process.env.KB_MODE || "bootstrap").toLowerCase();
const OUT = process.env.KB_OUT || join("docs", "knowledge");
const MANIFEST = join(OUT, "manifest.json");
const CODE_EXT = new Set([".cs", ".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".vue", ".svelte"]);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const head = git(["rev-parse", "HEAD"]); // null when not a git repo
let prevRef = null;
let changed = null; // null = full (bootstrap); array = only these files (update)

if (MODE === "update") {
  if (!existsSync(MANIFEST)) {
    process.stderr.write(`resolve: update mode but no manifest at ${MANIFEST}; run bootstrap first.\n`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    process.stderr.write(`resolve: manifest at ${MANIFEST} is malformed.\n`);
    process.exit(1);
  }
  prevRef = process.env.KB_REF || manifest.ref || null;
  if (head && prevRef) {
    let raw = git(["diff", "--name-only", "--diff-filter=ACMR", `${prevRef}...HEAD`]);
    if (raw === null) raw = git(["diff", "--name-only", "--diff-filter=ACMR", prevRef, "HEAD"]);
    changed = (raw ?? "").split(/\r?\n/).map((s) => s.trim()).filter((p) => p && CODE_EXT.has(extname(p).toLowerCase()));
  } else {
    changed = []; // no git / no ref → nothing to update deterministically
  }
}

process.stdout.write(
  JSON.stringify(
    {
      mode: MODE === "update" ? "update" : "bootstrap",
      repo: ROOT,
      out_dir: OUT,
      manifest_path: MANIFEST,
      ref: head, // the commit this run documents (recorded by finalize)
      prev_ref: prevRef, // the ref update diffed from
      changed, // null = full pass; [] or list = update scope
      git: head !== null,
    },
    null,
    2,
  ),
);
