#!/usr/bin/env node
/**
 * Stage-4 reconcile for remediate — checks the dispositions against GROUND TRUTH (git), never the agent's
 * self-report. Flags: items claimed `fixed` whose file was not actually changed (ticked-but-not-changed /
 * reverted), and scope creep (files changed that no item asked for, or more files than a per-fix leash).
 * This is the defense against "the report lies". Deterministic. Node builtins only.
 *
 * Env: RECONCILE_DISPOSITIONS (disposition.mjs output dispositions.json), RECONCILE_REPO (repo, default
 *   cwd), RECONCILE_BASE (git ref the remediation started from; default HEAD = uncommitted working tree),
 *   RECONCILE_MAX_FILES (per-fix file leash for the scope guard, default 3; 0 = off), RECONCILE_OUT_DIR.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const disp = JSON.parse(readFileSync(process.env.RECONCILE_DISPOSITIONS, "utf8"));
const repo = process.env.RECONCILE_REPO || process.cwd();
const base = process.env.RECONCILE_BASE || "HEAD";
const maxFiles = Number(process.env.RECONCILE_MAX_FILES ?? 3);
const outDir = process.env.RECONCILE_OUT_DIR || join(".agentflow", "remediate");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
const lines = (s) => (s ? s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []);

// Every file changed since `base`: committed-since-base ∪ staged ∪ unstaged ∪ untracked.
const changed = new Set([
  ...lines(git(["diff", "--name-only", base, "HEAD"])),
  ...lines(git(["diff", "--name-only", "HEAD"])),
  ...lines(git(["diff", "--name-only", "--cached", "HEAD"])),
  ...lines(git(["ls-files", "--others", "--exclude-standard"])),
]);
const gitAvailable = git(["rev-parse", "HEAD"]) !== null;

const dispositions = disp.dispositions ?? [];
const fixed = dispositions.filter((d) => d.disposition === "fixed");
const norm = (f) => String(f || "").split("\\").join("/").replace(/^\.\//, "");

// Items claimed fixed whose file was NOT actually changed → ticked-but-not-changed / reverted.
const suspectNoChange = fixed.filter((d) => d.file && !changed.has(norm(d.file))).map((d) => d.id);

// Scope: files changed that no (fixed) item referenced — possible scope creep / collateral edits.
const referenced = new Set(fixed.map((d) => norm(d.file)).filter(Boolean));
const scopeCreepFiles = [...changed].filter((f) => !referenced.has(norm(f)));

// Coarse per-fix leash: more changed files than fixed-items × maxFiles is suspicious.
const scopeOk = maxFiles <= 0 || fixed.length === 0 ? true : changed.size <= fixed.length * maxFiles;

const ok = gitAvailable && suspectNoChange.length === 0 && scopeOk && scopeCreepFiles.length === 0;

mkdirSync(outDir, { recursive: true });
const report = {
  git_available: gitAvailable,
  base,
  changed_files: changed.size,
  fixed_claimed: fixed.length,
  fixed_without_change: suspectNoChange,
  scope_ok: scopeOk,
  scope_creep_files: scopeCreepFiles,
  reconciled: ok,
};
writeFileSync(join(outDir, "reconcile.json"), JSON.stringify(report, null, 2), "utf8");

if (!gitAvailable) process.stderr.write("reconcile: not a git repo — cannot verify against ground truth\n");
if (suspectNoChange.length) process.stderr.write(`reconcile: ⚠ ${suspectNoChange.length} item(s) marked fixed but their file was not changed (ticked-but-not-changed / reverted): ${suspectNoChange.slice(0, 10).join(", ")}\n`);
if (!scopeOk) process.stderr.write(`reconcile: ⚠ scope — ${changed.size} files changed for ${fixed.length} fixes (> ${maxFiles}/fix)\n`);
if (scopeCreepFiles.length) process.stderr.write(`reconcile: ⚠ ${scopeCreepFiles.length} changed file(s) not referenced by any fix (possible scope creep)\n`);
process.stdout.write(JSON.stringify(report, null, 2));
