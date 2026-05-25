#!/usr/bin/env node
/**
 * Stage-3 builder for the gdpr-repo workflow. Assembles the input for the single bounded LLM step:
 * the found privacy-notice text + a digest of the repo scan + the relevant code excerpts, plus the
 * `decision_mode:"llm"` checks (the ones requiring judgment over prose/code). Emits one compact JSON
 * object the step appends to its prompt as <input>.
 *
 * Env: GDPR_SCAN (scan.json), GDPR_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const s = JSON.parse(readFileSync(process.env.GDPR_SCAN, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));

const snippets = (arr, n = 12) => (arr || []).slice(0, n).map((x) => `${x.file}:${x.line} ${x.snippet}`);

const llmChecks = checklist.checks
  .filter((c) => c.decision_mode === "llm")
  .map((c) => ({ id: c.id, title: c.title, category: c.category, gdpr_articles: c.gdpr_articles, obligation: c.obligation, pass_criteria: c.pass_criteria, fail_indicators: c.fail_indicators }));

const out = {
  repo_dir: s.repo_dir,
  privacy_notice: {
    available: !!s.docs.privacy,
    path: s.docs.privacy?.path || null,
    text: s.docs.privacy?.text || "(no privacy notice document found in the repo)",
  },
  repo_signals: {
    pii_fields: (s.pii_fields || []).map((x) => x.token),
    special_category: (s.special_category || []).map((x) => x.token),
    dependencies: { trackers: s.deps.trackers, cmp: s.deps.cmp, processors: s.deps.processors, strong_hashing: s.deps.strong_hashing },
    docs_present: { privacy: !!s.docs.privacy, ropa: !!s.docs.ropa, dpa: !!s.docs.dpa, dpia: !!s.docs.dpia, security: !!s.docs.security },
    consent: { cookie_setting_files: (s.cookies?.setting_files || []).slice(0, 10), trackers: s.deps.trackers, cmp: s.deps.cmp },
    tls_excerpts: snippets(s.tls_enforcement),
    dsr_export_excerpts: snippets(s.dsr?.export),
    dsr_delete_excerpts: snippets(s.dsr?.delete),
    retention_excerpts: snippets(s.retention),
  },
  checks: llmChecks,
};

process.stdout.write(JSON.stringify(out, null, 2));
