#!/usr/bin/env node
/**
 * Stage-3 builder for the gdpr-domain workflow. Assembles the input for the single bounded LLM step:
 * the fetched privacy/cookie notice text + the observed technical signals + the `decision_mode:"llm"`
 * checks (the ones that require reading and judging the notice prose, which code cannot do reliably).
 * Emits one compact JSON object that the step appends to its prompt as <input>.
 *
 * Env: GDPR_EVIDENCE (evidence.json), GDPR_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const ev = JSON.parse(readFileSync(process.env.GDPR_EVIDENCE, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));

const llmChecks = checklist.checks
  .filter((c) => c.decision_mode === "llm")
  .map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    gdpr_articles: c.gdpr_articles,
    obligation: c.obligation,
    pass_criteria: c.pass_criteria,
    fail_indicators: c.fail_indicators,
  }));

const privacy = ev.privacy || {};
const out = {
  domain: ev.domain,
  notice_available: !!privacy.policy_text,
  privacy_notice_url: privacy.policy_url || null,
  privacy_notice_text: privacy.policy_text || "(no privacy notice text could be fetched)",
  privacy_notice_truncated: !!privacy.policy_truncated,
  cookie_policy_text: ev.cookie_policy?.text || null,
  observed_signals: {
    consent_platform: ev.cmp || { detected: false },
    pre_consent_cookies: ev.pre_consent_cookies || [],
    trackers: (ev.trackers || []).map((t) => ({ host: t.host, provider: t.provider, category: t.category, country: t.country })),
    social_embeds: (ev.social_embeds || []).map((t) => t.host),
    forms_collect_pii: !!(ev.forms && (ev.forms.has_password_input || ev.forms.has_email_input)),
  },
  checks: llmChecks,
};

process.stdout.write(JSON.stringify(out, null, 2));
