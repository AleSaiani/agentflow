#!/usr/bin/env node
/**
 * Stage-2 deterministic evaluator for the gdpr-domain workflow. Reads the collected evidence.json and
 * checklist.json and decides every `decision_mode:"auto"` check with pure, reproducible rules — no
 * LLM, no network. This is the determinism half of the workflow: the same evidence always yields the
 * same verdicts. Emits a JSON array of verdicts that report.mjs merges with the LLM judgments.
 *
 * A verdict: { id, status, decided_by:"code", evidence:[...], rationale }.
 * status ∈ pass | fail | warn | not_observable. (severity/confidence/articles come from checklist.json.)
 *
 * Env: GDPR_EVIDENCE (path to evidence.json), GDPR_CHECKLIST (path to checklist.json).
 */
import { readFileSync } from "node:fs";

const ev = JSON.parse(readFileSync(process.env.GDPR_EVIDENCE, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));
const autoIds = new Set(checklist.checks.filter((c) => c.decision_mode === "auto").map((c) => c.id));

const reachable = ev.homepage && ev.homepage.ok;
const sec = (reachable && ev.homepage.security_headers) || {};
const trackers = ev.trackers || [];
const nonEssentialCookies = (ev.pre_consent_cookies || []).filter((c) => c.classification === "non_essential_tracker");

function v(status, rationale, evidence = []) {
  return { status, decided_by: "code", rationale, evidence };
}
function protoRank(p) {
  return { "TLSv1.3": 4, "TLSv1.2": 3, "TLSv1.1": 2, "TLSv1": 1, SSLv3: 0 }[p] ?? -1;
}

// id → (evidence) → verdict. Only auto checks are handled here.
const RULES = {
  "GDPR-CONSENT_COOKIES-01": () => {
    if (!reachable) return v("not_observable", "Homepage was not reachable, so pre-consent cookies could not be read.");
    if (nonEssentialCookies.length)
      return v(
        "fail",
        `Non-essential tracking cookies were set on the first server response, before any consent could be given.`,
        nonEssentialCookies.map((c) => `Set-Cookie '${c.name}' (${c.provider}) present pre-consent`),
      );
    const adAnalytics = trackers.filter((t) => ["analytics", "advertising"].includes(t.category));
    if (adAnalytics.length && !ev.cmp?.detected)
      return v(
        "warn",
        "Analytics/advertising trackers are referenced on the landing page and no consent platform was detected — they likely execute before consent (confirm with an interactive pass).",
        adAnalytics.map((t) => `${t.host} (${t.provider || t.category})`),
      );
    if (adAnalytics.length)
      return v(
        "warn",
        "Analytics/advertising trackers are present; a CMP was detected, but static observation cannot prove they are consent-gated. Verify they do not fire before consent.",
        adAnalytics.map((t) => `${t.host} (${t.provider || t.category})`),
      );
    return v("pass", "No non-essential cookies on the first response and no analytics/advertising trackers referenced on the landing page.");
  },

  "GDPR-CONSENT_COOKIES-02": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (ev.cmp?.detected)
      return v("pass", `A consent platform was detected on first load.`, [
        ev.cmp.vendors.length ? `CMP vendor(s): ${ev.cmp.vendors.join(", ")}` : null,
        ev.cmp.tcf_api ? "IAB TCF consent API present" : null,
      ].filter(Boolean));
    if (nonEssentialCookies.length || trackers.some((t) => ["analytics", "advertising"].includes(t.category)))
      return v("fail", "Non-essential trackers/cookies are present but no consent banner/CMP was detected on first load.", trackers.map((t) => t.host).slice(0, 8));
    return v("warn", "No consent platform detected statically. If non-essential cookies are used, a banner is required (it may be JS-rendered — confirm with an interactive pass).");
  },

  "GDPR-TRANSPARENCY_PRIVACY_NOTICE-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (ev.privacy?.policy_url && ev.privacy.policy_status && ev.privacy.policy_status < 400)
      return v("pass", "A privacy notice is linked from the homepage and loads successfully.", [`${ev.privacy.policy_url} (HTTP ${ev.privacy.policy_status})`]);
    if ((ev.privacy?.links || []).length)
      return v("warn", "Privacy/cookie links were found but the privacy notice could not be fetched successfully.", (ev.privacy.links || []).map((l) => l.url).slice(0, 5));
    return v("fail", "No privacy-policy link could be found on the homepage.");
  },

  "GDPR-SECURITY_TRANSPORT-01": () => {
    const t = ev.tls || {};
    if (!t.reachable) return v("fail", `TLS handshake on port 443 failed: ${t.error || "unreachable"}.`);
    const out = [`protocol ${t.protocol}`, `cert valid_to ${t.valid_to} (${t.days_to_expiry} days)`, `issuer ${t.issuer_o || "?"}`];
    if (!t.authorized) return v("fail", `The TLS certificate is not trusted/valid: ${t.auth_error}.`, out);
    if (protoRank(t.protocol) < protoRank("TLSv1.2")) return v("fail", `Deprecated TLS protocol negotiated (${t.protocol}); TLS 1.2+ is required.`, out);
    if (t.days_to_expiry !== null && t.days_to_expiry < 0) return v("fail", "The TLS certificate has expired.", out);
    if (t.days_to_expiry !== null && t.days_to_expiry < 15) return v("warn", `Valid TLS, but the certificate expires in ${t.days_to_expiry} days.`, out);
    return v("pass", `Served over ${t.protocol} with a valid, trusted certificate.`, out);
  },

  "GDPR-SECURITY_TRANSPORT-02": () => {
    const r = ev.http_redirect || {};
    const hsts = sec.strict_transport_security;
    const out = [`HTTP→ status ${r.status ?? "?"}${r.location ? " → " + r.location : ""}`, hsts ? `HSTS: ${hsts}` : "no HSTS header"];
    if (r.redirects_to_https && hsts) return v("pass", "HTTP redirects to HTTPS and HSTS is set.", out);
    if (r.redirects_to_https) return v("warn", "HTTP redirects to HTTPS but no Strict-Transport-Security header is set.", out);
    if (hsts) return v("warn", "HSTS is set but a plain-HTTP request did not redirect to HTTPS.", out);
    return v("fail", "Plain HTTP is not redirected to HTTPS and no HSTS header is present.", out);
  },

  "GDPR-SECURITY_TRANSPORT-03": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const f = ev.forms || { count: 0, actions: [] };
    if (!f.count) return v("not_observable", "No HTML forms were found on the landing page to evaluate.");
    const insecure = f.actions.filter((a) => a.insecure);
    if (insecure.length) return v("fail", "A form submits over plain HTTP.", insecure.map((a) => `${a.method.toUpperCase()} ${a.action}`));
    const crossOrigin = f.actions.filter((a) => a.cross_origin);
    if ((f.has_password_input || f.has_email_input) && crossOrigin.length)
      return v("warn", "A form collecting personal data posts to a third-party endpoint — confirm it is a disclosed processor.", crossOrigin.map((a) => a.action));
    return v("pass", `${f.count} form(s) submit over HTTPS; no insecure form actions found.`);
  },

  "GDPR-SECURITY_TRANSPORT-04": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const present = [];
    if (sec.content_security_policy) present.push("Content-Security-Policy");
    if (sec.x_content_type_options) present.push("X-Content-Type-Options");
    if (sec.referrer_policy) present.push("Referrer-Policy");
    if (sec.x_frame_options) present.push("X-Frame-Options");
    if (sec.permissions_policy) present.push("Permissions-Policy");
    const leak = [sec.server && /\d/.test(sec.server) ? `Server: ${sec.server}` : null, sec.x_powered_by ? `X-Powered-By: ${sec.x_powered_by}` : null].filter(Boolean);
    const out = [present.length ? `present: ${present.join(", ")}` : "none present", ...leak];
    if (present.length >= 3 && !leak.length) return v("pass", "A reasonable set of hardening headers is present.", out);
    if (present.length >= 1) return v("warn", "Some hardening headers are present but coverage is incomplete (or versions are leaked).", out);
    return v("fail", "No security-hardening response headers were observed.", out);
  },

  "GDPR-THIRD_PARTY_TRACKING-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (!trackers.length) return v("pass", "No known third-party trackers were referenced on the landing page.");
    return v(
      "warn",
      `${trackers.length} known third-party tracker host(s) referenced — ensure each is consent-gated and disclosed in the notice (see disclosure checks).`,
      trackers.map((t) => `${t.host} — ${t.provider || t.category} [${t.country}]`),
    );
  },

  "GDPR-THIRD_PARTY_TRACKING-02": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const embeds = ev.social_embeds || [];
    if (!embeds.length) return v("pass", "No third-party social embeds detected on the landing page.");
    return v(
      "warn",
      "Third-party social embeds are present; they create joint-controllership (Fashion ID) and must not transmit data before consent — confirm click-to-load / consent-gating.",
      embeds.map((e) => `${e.host} (${e.provider})`),
    );
  },

  "GDPR-THIRD_PARTY_TRACKING-03": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const fp = ev.fingerprinting || [];
    if (!fp.length) return v("pass", "No known device-fingerprinting library detected on the landing page.");
    return v("fail", "A device-fingerprinting library is loaded — fingerprinting requires consent under Art. 5(3) ePrivacy.", fp.map((f) => f.lib));
  },

  "GDPR-INTERNATIONAL_TRANSFERS-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const nonEea = trackers.filter((t) => t.country && !/^(EU|EEA|IT|DE|FR|ES|NL|IE|EU\/)/.test(t.country));
    if (!nonEea.length) return v("pass", "No third-party trackers resolving to non-EEA providers were detected.");
    return v(
      "warn",
      "Personal data is likely transferred to non-EEA recipients via these trackers — a valid transfer mechanism (adequacy/DPF/SCCs) must exist and be disclosed (see transfer-disclosure check).",
      nonEea.map((t) => `${t.host} — ${t.provider || t.category} [${t.country}]`),
    );
  },
};

const verdicts = [];
for (const id of autoIds) {
  const fn = RULES[id];
  verdicts.push({ id, ...(fn ? fn() : v("not_observable", "No deterministic rule implemented for this auto check.")) });
}

process.stdout.write(JSON.stringify(verdicts, null, 2));
