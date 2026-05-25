#!/usr/bin/env node
/**
 * Stage-5 reporter for the gdpr-repo workflow. Merges the three verdict sources into one complete,
 * validated result and renders a self-contained HTML report (zero deps, inline CSS):
 *   - code verdicts  (evaluate.mjs)            → decision_mode "auto"
 *   - LLM verdicts   (the assess step output)  → decision_mode "llm"
 *   - manual checks  (auto-emitted here)       → decision_mode "manual"
 *
 * Deterministic backstop: validates that every checklist id has a legal verdict, backfills gaps with
 * not_observable (a flaky LLM step can never silently drop a check), computes the rollup in code,
 * writes the report, and exits non-zero on a structural failure.
 *
 * Env: GDPR_CHECKLIST, GDPR_SCAN, GDPR_CODE_VERDICTS, GDPR_LLM_VERDICTS (step output, optional),
 *      GDPR_REPO_DIR, GDPR_REPORT_OUT (optional; default ./gdpr-repo-report-<name>-<date>.html).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));
const scan = JSON.parse(readFileSync(process.env.GDPR_SCAN, "utf8"));
const repoDir = process.env.GDPR_REPO_DIR || scan.repo_dir || ".";
const repoName = basename(resolve(repoDir)) || "repo";
const STATUSES = new Set(["pass", "fail", "warn", "not_observable", "manual_review"]);

function readJsonArray(path, { stripFences = false } = {}) {
  if (!path || !existsSync(path)) return null;
  let t = readFileSync(path, "utf8").trim();
  if (!t) return null;
  if (stripFences) {
    const a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
  }
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

const codeVerdicts = readJsonArray(process.env.GDPR_CODE_VERDICTS) || [];
const llmVerdicts = readJsonArray(process.env.GDPR_LLM_VERDICTS, { stripFences: true });
const byId = new Map();
for (const v of codeVerdicts) byId.set(v.id, { ...v, decided_by: "code" });
if (llmVerdicts) for (const v of llmVerdicts) byId.set(v.id, { ...v, decided_by: "llm" });

const results = [];
const gaps = [];
for (const c of checklist.checks) {
  let v = byId.get(c.id);
  if (c.decision_mode === "manual" && !v) v = { status: "manual_review", decided_by: "manual", rationale: c.repo_observable, evidence: [] };
  if (!v || !STATUSES.has(v.status)) {
    gaps.push(c.id);
    v = { status: "not_observable", decided_by: v?.decided_by || c.decision_mode, rationale: v ? `Verdict had an invalid status ('${v.status}')` : "No verdict produced (assessment step incomplete or invalid).", evidence: [] };
  }
  results.push({
    id: c.id, title: c.title, category: c.category, severity: c.severity, confidence: v.confidence || c.confidence,
    gdpr_articles: c.gdpr_articles, obligation: c.obligation, decision_mode: c.decision_mode, decided_by: v.decided_by,
    status: v.status, rationale: v.rationale || "", evidence: Array.isArray(v.evidence) ? v.evidence : v.evidence ? [String(v.evidence)] : [], references: c.references || [],
  });
}

const count = (p) => results.filter(p).length;
const byStatus = { pass: count((r) => r.status === "pass"), fail: count((r) => r.status === "fail"), warn: count((r) => r.status === "warn"), not_observable: count((r) => r.status === "not_observable"), manual_review: count((r) => r.status === "manual_review") };
const failsCritical = count((r) => r.status === "fail" && r.severity === "critical");
const failsMajor = count((r) => r.status === "fail" && r.severity === "major");
const warnsBlocking = count((r) => r.status === "warn" && (r.severity === "critical" || r.severity === "major"));
const observable = byStatus.pass + byStatus.fail + byStatus.warn;
const score = observable ? Math.round(((byStatus.pass + 0.5 * byStatus.warn) / observable) * 100) : null;

let verdict, verdictClass;
if (failsCritical) [verdict, verdictClass] = ["NON-COMPLIANT — critical issues observed", "v-crit"];
else if (failsMajor) [verdict, verdictClass] = ["SIGNIFICANT GAPS — major issues observed", "v-major"];
else if (byStatus.fail || warnsBlocking) [verdict, verdictClass] = ["NEEDS ATTENTION", "v-attn"];
else if (byStatus.warn) [verdict, verdictClass] = ["MOSTLY OK — review warnings", "v-warn"];
else [verdict, verdictClass] = ["NO BLOCKING ISSUES OBSERVED", "v-ok"];

const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS_META = { pass: ["PASS", "s-pass"], fail: ["FAIL", "s-fail"], warn: ["WARN", "s-warn"], not_observable: ["NOT OBSERVABLE", "s-na"], manual_review: ["MANUAL REVIEW", "s-man"] };
const CAT_LABEL = {
  privacy_docs: "Privacy Documentation", consent_cookies: "Consent & Cookies", security_art32: "Security (Art. 32)",
  pii_data_mapping: "PII & Data Mapping", data_subject_rights: "Data Subject Rights", international_transfers: "International Transfers",
  retention: "Retention", third_party_processors: "Third-Party Processors", children: "Children", governance: "Governance & Contact",
};
const SEV_ORDER = { critical: 0, major: 1, minor: 2 };

const cats = [...new Set(results.map((r) => r.category))];
const catSections = cats.map((cat) => {
  const rows = results.filter((r) => r.category === cat).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]).map((r) => {
    const [label, cls] = STATUS_META[r.status];
    const ev = r.evidence.length ? `<ul class="ev">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "";
    return `<tr class="row-${cls}">
      <td><span class="badge ${cls}">${label}</span></td>
      <td><span class="sev sev-${r.severity}">${r.severity}</span></td>
      <td><div class="title">${esc(r.title)}</div>
        <div class="meta">${esc(r.id)} · ${esc(r.gdpr_articles.join(", "))} · <span class="by">${esc(r.decided_by)}</span> · confidence: ${esc(r.confidence)}</div>
        <div class="rationale">${esc(r.rationale)}</div>${ev}</td></tr>`;
  }).join("\n");
  return `<section><h3>${esc(CAT_LABEL[cat] || cat)}</h3><table class="checks"><tbody>${rows}</tbody></table></section>`;
}).join("\n");

const docsFound = Object.entries({ privacy: scan.docs.privacy, ropa: scan.docs.ropa, dpa: scan.docs.dpa, dpia: scan.docs.dpia, security: scan.docs.security }).filter(([, v]) => v).map(([k]) => k);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GDPR repo audit — ${esc(repoName)}</title>
<style>
  :root{--ink:#1a1d24;--mut:#5c6470;--line:#e4e7ec;--bg:#f7f8fa;--card:#fff}
  *{box-sizing:border-box} body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);margin:0}
  .wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px}
  header.top{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin-bottom:20px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);font-size:13px;margin-bottom:18px}
  .verdict{display:inline-block;font-weight:700;font-size:15px;padding:10px 16px;border-radius:10px}
  .v-crit{background:#fde8e8;color:#b42318;border:1px solid #f5b5b0}.v-major{background:#fdeede;color:#b54708;border:1px solid #f3c79a}
  .v-attn{background:#fef6e0;color:#a16207;border:1px solid #f0d68a}.v-warn{background:#fffbeb;color:#92740a;border:1px solid #f3e6a8}.v-ok{background:#e6f6ec;color:#067647;border:1px solid #a6e0bd}
  .score{float:right;text-align:center;border:1px solid var(--line);border-radius:12px;padding:10px 18px;min-width:96px}
  .score b{font-size:30px;display:block;line-height:1} .score span{font-size:11px;color:var(--mut);text-transform:uppercase}
  .cards{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 8px}
  .c{flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-align:center}
  .c b{font-size:24px;display:block} .c span{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.4px}
  .c-pass b{color:#067647}.c-fail b{color:#b42318}.c-warn b{color:#a16207}.c-na b{color:#667085}.c-man b{color:#3538cd}
  .note{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:18px 0;font-size:13px;color:var(--mut)}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 20px 16px;margin:16px 0}
  h3{font-size:15px;margin:16px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  table.checks{width:100%;border-collapse:collapse} table.checks td{padding:12px 8px;border-top:1px solid var(--line);vertical-align:top}
  table.checks td:first-child{width:120px}table.checks td:nth-child(2){width:74px}
  .badge{display:inline-block;font-size:11px;font-weight:700;padding:4px 8px;border-radius:6px;white-space:nowrap}
  .s-pass{background:#e6f6ec;color:#067647}.s-fail{background:#fde8e8;color:#b42318}.s-warn{background:#fef6e0;color:#a16207}.s-na{background:#eef1f4;color:#667085}.s-man{background:#eaeafe;color:#3538cd}
  .row-s-fail{background:#fffafa}.row-s-warn{background:#fffdf6}
  .sev{font-size:11px;font-weight:600;text-transform:uppercase} .sev-critical{color:#b42318}.sev-major{color:#b54708}.sev-minor{color:#667085}
  .title{font-weight:600} .meta{font-size:12px;color:var(--mut);margin:2px 0 4px} .by{font-variant:small-caps;font-weight:600}
  .rationale{font-size:13.5px} ul.ev{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:#3a4250} ul.ev li{font-family:ui-monospace,Menlo,monospace;margin:2px 0}
  footer{color:var(--mut);font-size:12px;margin-top:24px;line-height:1.6} a{color:#155eef;text-decoration:none}
</style></head>
<body><div class="wrap">
  <header class="top">
    <div class="score"><b>${score ?? "—"}${score !== null ? "%" : ""}</b><span>indicative score</span></div>
    <h1>GDPR source-repository audit</h1>
    <div class="sub">Repo <b>${esc(repoName)}</b> · ${esc(repoDir)} · generated ${esc(new Date().toISOString())} · ${results.length} checks · ${scan.files_scanned} files scanned</div>
    <div class="verdict ${verdictClass}">${esc(verdict)}</div>
    <div class="cards">
      <div class="c c-pass"><b>${byStatus.pass}</b><span>Pass</span></div>
      <div class="c c-fail"><b>${byStatus.fail}</b><span>Fail</span></div>
      <div class="c c-warn"><b>${byStatus.warn}</b><span>Warn</span></div>
      <div class="c c-man"><b>${byStatus.manual_review}</b><span>Manual review</span></div>
      <div class="c c-na"><b>${byStatus.not_observable}</b><span>Not observable</span></div>
    </div>
  </header>
  <div class="note">
    <b>Methodology &amp; scope.</b> ${checklist.counts.auto} checks are decided deterministically by code from the repo scan
    (files, dependencies, code patterns); ${checklist.counts.llm} require bounded LLM judgment over found documents/code
    (schema-validated, evidence-quoted); ${checklist.counts.manual} are organizational facts not derivable from source
    (signed contracts, exercised procedures) and are flagged for manual review — never auto-passed.
    Privacy docs found: ${docsFound.length ? esc(docsFound.join(", ")) : "none"}. Dependencies scanned: ${scan.deps.count}.
    This is an automated indicator, <b>not legal advice</b>; it reflects what is committed, not production reality. Legal basis: ${esc(checklist.regulation)}.
  </div>
  ${catSections}
  <footer>Generated by Agent Flow · workflows/gdpr-repo. Checklist mapped to GDPR / ePrivacy articles. The "by" tag shows whether a check was decided by <b>code</b>, <b>llm</b>, or flagged for <b>manual</b> review.</footer>
</div></body></html>`;

const stamp = new Date().toISOString().slice(0, 10);
const outPath = resolve(process.env.GDPR_REPORT_OUT || `./gdpr-repo-report-${repoName.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.html`);
writeFileSync(outPath, html, "utf8");
const summary = { repo: repoName, repo_dir: repoDir, generated_at: new Date().toISOString(), verdict, score, counts: byStatus, fails_critical: failsCritical, fails_major: failsMajor, report_html: outPath, results };
const summaryPath = outPath.replace(/\.html$/, ".summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

process.stdout.write(JSON.stringify({ repo: repoName, verdict, score, counts: byStatus, gaps_backfilled: gaps, report_html: outPath, summary_json: summaryPath }, null, 2));
if (results.length !== checklist.checks.length) {
  process.stderr.write(`\nreport: integrity error — ${results.length} verdicts for ${checklist.checks.length} checks\n`);
  process.exit(1);
}
