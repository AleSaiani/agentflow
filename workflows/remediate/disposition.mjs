#!/usr/bin/env node
/**
 * Stage-3 disposition for remediate — the coverage-integrity guarantee. Every INPUT item must end with a
 * recorded disposition: fixed | deferred | skipped | failed, each with a reason. An item the fix agent
 * left without one (a "bare" item — the exact failure this defends against) is DETECTED and counted, not
 * silently dropped. Reads the fix foreach state from disk (no plugin-root needed). Node builtins only.
 *
 * Env: REMEDIATE_ITEMS (load output — the full input set), REMEDIATE_FIX_RUN (fix foreach run-id),
 *   REMEDIATE_OUT_DIR (artifacts dir, default .agentflow/remediate), FOREACH_STATE_DIR /
 *   REMEDIATE_FOREACH_DIR (state dir override), REMEDIATE_STRICT ("1" → exit non-zero if any bare item).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const items = JSON.parse(readFileSync(process.env.REMEDIATE_ITEMS, "utf8"));
const runId = process.env.REMEDIATE_FIX_RUN;
const feDir = process.env.FOREACH_STATE_DIR || process.env.REMEDIATE_FOREACH_DIR || join(".agentflow", "foreach");
const outDir = process.env.REMEDIATE_OUT_DIR || join(".agentflow", "remediate");

let results = {};
if (runId) {
  const sp = join(feDir, runId, "state.json");
  if (existsSync(sp)) {
    try {
      results = JSON.parse(readFileSync(sp, "utf8")).items ?? {};
    } catch {
      /* leave empty → everything counts as not-processed */
    }
  }
}

const CANON = new Set(["fixed", "deferred", "skipped", "failed"]);
function parseResult(res) {
  // Returns { disposition, reason, bare } from the agent's claim (tolerant of shape).
  let r = res;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return { disposition: "skipped", reason: "(unparseable agent result)", bare: true };
    }
  }
  if (r && typeof r === "object") {
    if (typeof r.disposition === "string" && CANON.has(r.disposition.toLowerCase())) {
      return { disposition: r.disposition.toLowerCase(), reason: r.reason || r.note || "", bare: false };
    }
    if (r.applied === true) return { disposition: "fixed", reason: r.note || r.reason || "", bare: false };
    if (r.applied === false) return { disposition: "skipped", reason: r.note || r.reason || "(agent reported not applied, no reason)", bare: !(r.note || r.reason) };
  }
  return { disposition: "skipped", reason: "(no disposition reported)", bare: true };
}

const counts = { fixed: 0, deferred: 0, skipped: 0, failed: 0 };
let bare = 0;
const dispositions = items.map((it) => {
  const entry = results[it.id];
  let disposition, reason, isBare = false;
  if (!entry || entry.status !== "done") {
    disposition = "failed";
    reason = entry ? `not completed (status=${entry.status})` : "no agent result (item not processed)";
  } else {
    const p = parseResult(entry.result);
    disposition = p.disposition;
    reason = p.reason;
    isBare = p.bare;
  }
  if (isBare) bare++;
  counts[disposition] = (counts[disposition] ?? 0) + 1;
  return { id: it.id, file: it.data?.file ?? null, type: it.data?.type ?? null, severity: it.data?.severity ?? null, disposition, reason, bare: isBare };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "dispositions.json"), JSON.stringify({ total: items.length, counts, bare, dispositions }, null, 2), "utf8");
const md = ["# Remediation dispositions", "", `Total ${items.length} · fixed ${counts.fixed} · deferred ${counts.deferred} · skipped ${counts.skipped} · failed ${counts.failed}${bare ? ` · ⚠ ${bare} BARE (no reason)` : ""}`, "", "| Item | Type | Disposition | Reason |", "|---|---|---|---|"];
for (const d of dispositions) md.push(`| ${d.id} | ${d.type ?? ""} | ${d.disposition}${d.bare ? " ⚠" : ""} | ${String(d.reason).replace(/\|/g, "\\|").slice(0, 120)} |`);
writeFileSync(join(outDir, "dispositions.md"), md.join("\n") + "\n", "utf8");

if (bare) process.stderr.write(`disposition: ⚠ ${bare} item(s) left WITHOUT a recorded reason (bare) — coverage integrity violated\n`);
process.stdout.write(JSON.stringify({ total: items.length, counts, bare, dispositions_path: join(outDir, "dispositions.json").split("\\").join("/") }, null, 2));
if (bare && process.env.REMEDIATE_STRICT === "1") process.exit(3);
