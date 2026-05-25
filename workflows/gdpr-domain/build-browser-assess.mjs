#!/usr/bin/env node
/**
 * Optional stage for the gdpr-domain workflow: assembles the input for the LIVE-BROWSER step. Selects
 * the runtime-observable checks that a static fetch cannot judge — the `decision_mode:"manual"` checks
 * in the consent_cookies and dark_patterns categories (banner reject-parity, pre-ticked toggles, cookie
 * wall, withdrawal, granularity, choice-honoured-after-reject, visual nudging, confusing copy, nagging).
 * A browser agent drives a real browser to decide them; report.mjs then promotes them from
 * manual_review to pass/fail.
 *
 * Env: GDPR_EVIDENCE (evidence.json), GDPR_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const ev = JSON.parse(readFileSync(process.env.GDPR_EVIDENCE, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));

const checks = checklist.checks
  .filter((c) => c.decision_mode === "manual" && (c.category === "consent_cookies" || c.category === "dark_patterns"))
  .map((c) => ({ id: c.id, title: c.title, category: c.category, gdpr_articles: c.gdpr_articles, obligation: c.obligation, external_observable: c.external_observable, signals: c.signals, pass_criteria: c.pass_criteria, fail_indicators: c.fail_indicators }));

const out = {
  domain: ev.domain,
  target_url: ev.target_url,
  static_signals: {
    consent_platform: ev.cmp || { detected: false },
    trackers: (ev.trackers || []).map((t) => t.host),
  },
  checks,
};

process.stdout.write(JSON.stringify(out, null, 2));
