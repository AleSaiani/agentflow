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
const changedArr = [...changed].map(norm);

// Optional ignore list: prefix (`docs/`), exact (`Makefile`), or extension glob (`*.xlsx`). Filters
// scope-creep + scope leash so untracked docs/marketplace/etc. don't pollute the integrity signal.
const ignorePatterns = (process.env.RECONCILE_IGNORE_PATHS || "").split(",").map((s) => s.trim()).filter(Boolean);
function ignored(f) {
  return ignorePatterns.some((p) => (p.endsWith("/") ? f.startsWith(p) : p.startsWith("*.") ? f.endsWith(p.slice(1)) : f === p || f.startsWith(p + "/")));
}
const changedArrFiltered = changedArr.filter((f) => !ignored(f));

// Match item.file against git's changed paths: exact OR git path ends with `/` + item.file —
// covers the common case where a report says `src/X/Y.cs` but git shows `Module/src/X/Y.cs`.
function matchesChanged(itemFile) {
  const n = norm(itemFile);
  if (!n) return false;
  if (changed.has(n)) return true;
  return changedArr.some((c) => c === n || c.endsWith("/" + n));
}

// Items claimed fixed whose file was NOT actually changed → ticked-but-not-changed / reverted.
const suspectNoChange = fixed.filter((d) => d.file && !matchesChanged(d.file)).map((d) => d.id);

// Build the referenced set as git-path-normalized so scope-creep computation aligns with the
// suffix match above (the git path is the source of truth, not the report path).
const referenced = new Set();
for (const d of fixed) {
  if (!d.file) continue;
  const n = norm(d.file);
  const hit = changedArr.find((c) => c === n || c.endsWith("/" + n));
  if (hit) referenced.add(hit);
}
const scopeCreepFiles = changedArrFiltered.filter((f) => !referenced.has(f));

// Coarse per-fix leash on the (filtered) changed set.
const scopeOk = maxFiles <= 0 || fixed.length === 0 ? true : changedArrFiltered.length <= fixed.length * maxFiles;

const ok = gitAvailable && suspectNoChange.length === 0 && scopeOk && scopeCreepFiles.length === 0;

mkdirSync(outDir, { recursive: true });
const report = {
  git_available: gitAvailable,
  base,
  changed_files: changedArrFiltered.length,
  changed_files_total: changed.size,
  ignored_paths: ignorePatterns,
  fixed_claimed: fixed.length,
  fixed_without_change: suspectNoChange,
  scope_ok: scopeOk,
  scope_creep_files: scopeCreepFiles,
  reconciled: ok,
};
writeFileSync(join(outDir, "reconcile.json"), JSON.stringify(report, null, 2), "utf8");

// De-tick the report (the real correction, not just a flag): downgrade fixed→reverted where git
// disagrees, and write the corrected, TRUTHFUL report. This is the version to trust.
const suspect = new Set(suspectNoChange);
const counts = { fixed: 0, deferred: 0, skipped: 0, failed: 0, reverted: 0 };
const corrected = dispositions.map((d) => {
  if (d.disposition === "fixed" && suspect.has(d.id)) {
    counts.reverted++;
    return { ...d, disposition: "reverted", reason: `${d.reason ? d.reason + " — " : ""}reconcile: claimed fixed but ${norm(d.file)} was not changed`, bare: false };
  }
  counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
  return d;
});
writeFileSync(join(outDir, "reconciled.json"), JSON.stringify({ total: corrected.length, counts, reconciled: ok, corrected_from_fixed: suspectNoChange.length, dispositions: corrected }, null, 2), "utf8");
const md = ["# Reconciled dispositions (verified against git)", "", `Total ${corrected.length} · fixed ${counts.fixed} · reverted ${counts.reverted} · deferred ${counts.deferred} · skipped ${counts.skipped} · failed ${counts.failed}`, "", "| Item | Disposition | Reason |", "|---|---|---|"];
for (const d of corrected) md.push(`| ${d.id} | ${d.disposition}${d.disposition === "reverted" ? " ⟲" : ""} | ${String(d.reason ?? "").replace(/\|/g, "\\|").slice(0, 120)} |`);
writeFileSync(join(outDir, "reconciled.md"), md.join("\n") + "\n", "utf8");
report.corrected_from_fixed = suspectNoChange.length;
report.reconciled_report = join(outDir, "reconciled.md").split("\\").join("/");

if (!gitAvailable) process.stderr.write("reconcile: not a git repo — cannot verify against ground truth\n");
if (suspectNoChange.length) process.stderr.write(`reconcile: ⚠ ${suspectNoChange.length} item(s) marked fixed but their file was not changed (ticked-but-not-changed / reverted): ${suspectNoChange.slice(0, 10).join(", ")}\n`);
if (!scopeOk) process.stderr.write(`reconcile: ⚠ scope — ${changed.size} files changed for ${fixed.length} fixes (> ${maxFiles}/fix)\n`);
if (scopeCreepFiles.length) process.stderr.write(`reconcile: ⚠ ${scopeCreepFiles.length} changed file(s) not referenced by any fix (possible scope creep)\n`);
process.stdout.write(JSON.stringify(report, null, 2));
