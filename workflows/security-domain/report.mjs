#!/usr/bin/env node
/**
 * Stage-3 reporter for the security-domain workflow. Merges the code verdicts with the checklist,
 * validates completeness (every id has a legal verdict; gaps → not_observable), computes the rollup,
 * and renders a self-contained HTML report + summary.json. Fully deterministic — no LLM.
 *
 * Env: SECDOM_CHECKLIST, SECDOM_EVIDENCE, SECDOM_CODE_VERDICTS, SECDOM_DOMAIN, SECDOM_REPORT_OUT.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const checklist = JSON.parse(readFileSync(process.env.SECDOM_CHECKLIST, "utf8"));
const evidence = JSON.parse(readFileSync(process.env.SECDOM_EVIDENCE, "utf8"));
const domain = process.env.SECDOM_DOMAIN || evidence.domain || "unknown";
const STATUSES = new Set(["pass", "fail", "warn", "not_observable", "manual_review"]);

function readArr(p) { if (!p || !existsSync(p)) return []; try { const a = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; } }
const byId = new Map(readArr(process.env.SECDOM_CODE_VERDICTS).map((x) => [x.id, x]));

const results = [];
const gaps = [];
for (const c of checklist.checks) {
  let vv = byId.get(c.id);
  if (!vv || !STATUSES.has(vv.status)) { gaps.push(c.id); vv = { status: "not_observable", rationale: "No verdict produced for this check.", evidence: [] }; }
  results.push({ id: c.id, title: c.title, category: c.category, severity: c.severity, status: vv.status, rationale: vv.rationale || "", evidence: Array.isArray(vv.evidence) ? vv.evidence : [], refs: c.refs || [] });
}

const count = (p) => results.filter(p).length;
const byStatus = { pass: count((r) => r.status === "pass"), fail: count((r) => r.status === "fail"), warn: count((r) => r.status === "warn"), not_observable: count((r) => r.status === "not_observable") };
const failsCritical = count((r) => r.status === "fail" && r.severity === "critical");
const failsMajor = count((r) => r.status === "fail" && r.severity === "major");
const warnsBlocking = count((r) => r.status === "warn" && (r.severity === "critical" || r.severity === "major"));
const observable = byStatus.pass + byStatus.fail + byStatus.warn;
const score = observable ? Math.round(((byStatus.pass + 0.5 * byStatus.warn) / observable) * 100) : null;
let verdict, vc;
if (failsCritical) [verdict, vc] = ["CRITICAL ISSUES OBSERVED", "v-crit"];
else if (failsMajor) [verdict, vc] = ["SIGNIFICANT GAPS", "v-major"];
else if (byStatus.fail || warnsBlocking) [verdict, vc] = ["NEEDS ATTENTION", "v-attn"];
else if (byStatus.warn) [verdict, vc] = ["MOSTLY OK — review warnings", "v-warn"];
else [verdict, vc] = ["NO BLOCKING ISSUES OBSERVED", "v-ok"];

const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SM = { pass: ["PASS", "s-pass"], fail: ["FAIL", "s-fail"], warn: ["WARN", "s-warn"], not_observable: ["NOT OBSERVABLE", "s-na"] };
const CAT = { transport_tls: "Transport & TLS", headers_hardening: "Security Headers", cookies: "Cookies", content_exposure: "Content Exposure", info_disclosure: "Information Disclosure", cors: "CORS", supply_chain_client: "Client Supply-Chain" };
const SEV = { critical: 0, major: 1, minor: 2 };
const cats = [...new Set(results.map((r) => r.category))];
const sections = cats.map((cat) => {
  const rows = results.filter((r) => r.category === cat).sort((a, b) => SEV[a.severity] - SEV[b.severity]).map((r) => {
    const [label, cls] = SM[r.status];
    const ev = r.evidence.length ? `<ul class="ev">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "";
    return `<tr class="row-${cls}"><td><span class="badge ${cls}">${label}</span></td><td><span class="sev sev-${r.severity}">${r.severity}</span></td>
      <td><div class="title">${esc(r.title)}</div><div class="meta">${esc(r.id)} · ${esc(r.refs.join(", "))} · <span class="by">code</span></div>
      <div class="rationale">${esc(r.rationale)}</div>${ev}</td></tr>`;
  }).join("\n");
  return `<section><h3>${esc(CAT[cat] || cat)}</h3><table class="checks"><tbody>${rows}</tbody></table></section>`;
}).join("\n");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web security audit — ${esc(domain)}</title><style>
:root{--ink:#1a1d24;--mut:#5c6470;--line:#e4e7ec;--bg:#f7f8fa;--card:#fff}*{box-sizing:border-box}
body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);margin:0}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px}header.top{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin-bottom:20px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}
.verdict{display:inline-block;font-weight:700;padding:10px 16px;border-radius:10px}
.v-crit{background:#fde8e8;color:#b42318;border:1px solid #f5b5b0}.v-major{background:#fdeede;color:#b54708;border:1px solid #f3c79a}.v-attn{background:#fef6e0;color:#a16207;border:1px solid #f0d68a}.v-warn{background:#fffbeb;color:#92740a;border:1px solid #f3e6a8}.v-ok{background:#e6f6ec;color:#067647;border:1px solid #a6e0bd}
.score{float:right;text-align:center;border:1px solid var(--line);border-radius:12px;padding:10px 18px;min-width:96px}.score b{font-size:30px;display:block;line-height:1}.score span{font-size:11px;color:var(--mut);text-transform:uppercase}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 8px}.c{flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-align:center}.c b{font-size:24px;display:block}.c span{font-size:11px;color:var(--mut);text-transform:uppercase}
.c-pass b{color:#067647}.c-fail b{color:#b42318}.c-warn b{color:#a16207}.c-na b{color:#667085}
.note{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:18px 0;font-size:13px;color:var(--mut)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 20px 16px;margin:16px 0}h3{font-size:15px;margin:16px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--line)}
table.checks{width:100%;border-collapse:collapse}table.checks td{padding:12px 8px;border-top:1px solid var(--line);vertical-align:top}table.checks td:first-child{width:120px}table.checks td:nth-child(2){width:74px}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:4px 8px;border-radius:6px}.s-pass{background:#e6f6ec;color:#067647}.s-fail{background:#fde8e8;color:#b42318}.s-warn{background:#fef6e0;color:#a16207}.s-na{background:#eef1f4;color:#667085}
.row-s-fail{background:#fffafa}.row-s-warn{background:#fffdf6}.sev{font-size:11px;font-weight:600;text-transform:uppercase}.sev-critical{color:#b42318}.sev-major{color:#b54708}.sev-minor{color:#667085}
.title{font-weight:600}.meta{font-size:12px;color:var(--mut);margin:2px 0 4px}.by{font-variant:small-caps;font-weight:600}.rationale{font-size:13.5px}ul.ev{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:#3a4250}ul.ev li{font-family:ui-monospace,Menlo,monospace;margin:2px 0}
footer{color:var(--mut);font-size:12px;margin-top:24px}</style></head><body><div class="wrap">
<header class="top"><div class="score"><b>${score ?? "—"}${score !== null ? "%" : ""}</b><span>score</span></div>
<h1>Web security posture audit</h1><div class="sub">Domain <b>${esc(domain)}</b> · generated ${esc(new Date().toISOString())} · ${results.length} checks · external observation</div>
<div class="verdict ${vc}">${esc(verdict)}</div>
<div class="cards"><div class="c c-pass"><b>${byStatus.pass}</b><span>Pass</span></div><div class="c c-fail"><b>${byStatus.fail}</b><span>Fail</span></div><div class="c c-warn"><b>${byStatus.warn}</b><span>Warn</span></div><div class="c c-na"><b>${byStatus.not_observable}</b><span>Not observable</span></div></div></header>
<div class="note"><b>Methodology.</b> All ${checklist.counts.auto} checks are decided <b>deterministically by code</b> from collected HTTP/TLS evidence — the same domain state yields the same verdicts. Standard: ${esc(checklist.standard)}. This is an automated indicator, not a penetration test; run only against domains you are authorized to assess.</div>
${sections}
<footer>Generated by Agent Flow · workflows/security-domain.</footer></div></body></html>`;

const stamp = new Date().toISOString().slice(0, 10);
const outPath = resolve(process.env.SECDOM_REPORT_OUT || `./security-report-${domain.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.html`);
writeFileSync(outPath, html, "utf8");
const summaryPath = (outPath.endsWith(".html") ? outPath.slice(0, -5) : outPath) + ".summary.json";
writeFileSync(summaryPath, JSON.stringify({ domain, generated_at: new Date().toISOString(), verdict, score, counts: byStatus, fails_critical: failsCritical, fails_major: failsMajor, report_html: outPath, results }, null, 2), "utf8");
process.stdout.write(JSON.stringify({ domain, verdict, score, counts: byStatus, gaps_backfilled: gaps, report_html: outPath, summary_json: summaryPath }, null, 2));
if (results.length !== checklist.checks.length) { process.stderr.write(`\nreport: integrity error\n`); process.exit(1); }
