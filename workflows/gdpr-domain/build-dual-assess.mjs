#!/usr/bin/env node
/**
 * Optional dual-model stage builder. Assembles the input for an ADVERSARIAL second opinion on the
 * `decision_mode:"llm"` checks — the only ones a second model can add anything to (the `auto` checks
 * are decided by code and are already reproducible; a second opinion on them would be noise).
 *
 * It feeds the second model the same evidence as the first PLUS the first model's verdicts, and asks
 * it to agree or dispute each one. The output is not "a better answer": it is a map of where two
 * independent judges disagree, which is what deserves human attention.
 *
 * Env: GDPR_EVIDENCE (evidence.json), GDPR_CHECKLIST (checklist.json), GDPR_LLM_VERDICTS (assess output).
 */
import { readFileSync } from "node:fs";

function readJsonArray(path) {
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const m = raw.match(/\[[\s\S]*\]/); // tolerate markdown fences / surrounding prose
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

const ev = JSON.parse(readFileSync(process.env.GDPR_EVIDENCE, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));
const first = readJsonArray(process.env.GDPR_LLM_VERDICTS) || [];
const firstById = new Map(first.map((v) => [v.id, v]));

const checks = checklist.checks
  .filter((c) => c.decision_mode === "llm")
  .map((c) => {
    const v = firstById.get(c.id);
    return {
      id: c.id,
      title: c.title,
      gdpr_articles: c.gdpr_articles,
      obligation: c.obligation,
      pass_criteria: c.pass_criteria,
      fail_indicators: c.fail_indicators,
      first_verdict: v ? { status: v.status, rationale: v.rationale || "", evidence: v.evidence || [] } : null,
    };
  });

const privacy = ev.privacy || {};
process.stdout.write(
  JSON.stringify(
    {
      domain: ev.domain,
      privacy_notice_url: privacy.policy_url || null,
      privacy_notice_text: privacy.policy_text || "(no privacy notice text could be fetched)",
      privacy_notice_truncated: !!privacy.policy_truncated,
      cookie_policy_text: ev.cookie_policy?.text || null,
      observed_signals: {
        consent_platform: ev.cmp || { detected: false },
        pre_consent_cookies: ev.pre_consent_cookies || [],
        trackers: (ev.trackers || []).map((t) => ({ host: t.host, provider: t.provider, category: t.category, country: t.country })),
      },
      checks,
    },
    null,
    2,
  ),
);
