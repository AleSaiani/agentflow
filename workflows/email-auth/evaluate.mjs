#!/usr/bin/env node
/**
 * Stage-2 evaluate for email-auth — fully deterministic: decide every checklist check from the scan with
 * pure rules (same scan → same verdicts, no LLM). Emits verdicts.json {id, title, severity, status, detail}
 * with status ∈ pass | fail | warn | not_observable. Node builtins only.
 *
 * Env: EMAILAUTH_SCAN (scan.json), EMAILAUTH_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const scan = JSON.parse(readFileSync(process.env.EMAILAUTH_SCAN, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.EMAILAUTH_CHECKLIST, "utf8"));

const RULES = {
  "spf-present": () => (scan.spf?.present ? ["pass", scan.spf.record] : ["fail", "no v=spf1 TXT record"]),
  "spf-hardfail": () => {
    if (!scan.spf?.present) return ["not_observable", "no SPF record"];
    const q = scan.spf.qualifier;
    if (q === "-") return ["pass", "-all (hard fail)"];
    if (q === "~") return ["warn", "~all (soft fail) — consider -all"];
    if (q === "+") return ["fail", "+all allows anyone to send"];
    return ["warn", "no explicit all mechanism"];
  },
  "dmarc-present": () => (scan.dmarc?.present ? ["pass", scan.dmarc.record] : ["fail", "no _dmarc TXT record"]),
  "dmarc-enforced": () => {
    if (!scan.dmarc?.present) return ["not_observable", "no DMARC record"];
    const p = scan.dmarc.policy;
    if (p === "reject") return ["pass", "p=reject"];
    if (p === "quarantine") return ["pass", "p=quarantine"];
    return ["fail", `p=${p ?? "none"} — not enforced`];
  },
  "dmarc-rua": () => (scan.dmarc?.present ? (scan.dmarc.rua ? ["pass", "rua configured"] : ["warn", "no rua= aggregate reporting"]) : ["not_observable", "no DMARC record"]),
  "mx-present": () => ((scan.mx?.length ?? 0) > 0 ? ["pass", `${scan.mx.length} MX`] : ["warn", "no MX records (domain may not receive mail)"]),
  "dkim-selector": () => ((scan.dkim?.selectors_found?.length ?? 0) > 0 ? ["pass", `selectors: ${scan.dkim.selectors_found.join(", ")}`] : ["warn", `no DKIM selector resolved among ${(scan.dkim?.selectors_checked ?? []).length} common ones (may use a custom selector)`]),
  "mta-sts": () => (scan.mta_sts?.present ? ["pass", "_mta-sts TXT present"] : ["warn", "no MTA-STS"]),
  "tls-rpt": () => (scan.tls_rpt?.present ? ["pass", "_smtp._tls TXT present"] : ["warn", "no TLS-RPT"]),
  bimi: () => (scan.bimi?.present ? ["pass", "BIMI present"] : ["not_observable", "no BIMI (optional)"]),
};

const verdicts = checklist.checks.map((c) => {
  const [status, detail] = (RULES[c.id] ?? (() => ["not_observable", "no rule"]))();
  return { id: c.id, title: c.title, severity: c.severity, status, detail };
});

process.stdout.write(JSON.stringify({ domain: scan.domain, standard: checklist.standard, verdicts }, null, 2));
