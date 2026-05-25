#!/usr/bin/env node
/**
 * Stage-2 deterministic evaluator for the gdpr-repo workflow. Reads scan.json + checklist.json and
 * decides every `decision_mode:"auto"` check with pure rules over the repo scan — no LLM, no network,
 * fully reproducible. Emits a JSON array of verdicts that report.mjs merges with the LLM judgments.
 *
 * A verdict: { id, status, decided_by:"code", evidence:[...], rationale }.
 * status ∈ pass | fail | warn | not_observable.
 *
 * Env: GDPR_SCAN (scan.json), GDPR_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const s = JSON.parse(readFileSync(process.env.GDPR_SCAN, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.GDPR_CHECKLIST, "utf8"));
const autoIds = new Set(checklist.checks.filter((c) => c.decision_mode === "auto").map((c) => c.id));

const hasPII = (s.pii_fields || []).length > 0;
const processors = [...new Set([...(s.deps.processors || []), ...(s.deps.trackers || [])])];
const v = (status, rationale, evidence = []) => ({ status, decided_by: "code", rationale, evidence });
const refs = (arr, n = 8) => (arr || []).slice(0, n);

const RULES = {
  "GDPR-PRIVACY_DOCS-01": () =>
    s.docs.privacy ? v("pass", "A privacy notice document is present in the repo.", [s.docs.privacy.path || s.docs.privacy]) : v("fail", "No privacy notice document was found in the repo."),

  "GDPR-PRIVACY_DOCS-03": () =>
    s.docs.ropa ? v("pass", "A records-of-processing / data-inventory artefact is present (adequacy requires manual review).", [s.docs.ropa]) : v("warn", "No records-of-processing (Art. 30) artefact found in the repo."),

  "GDPR-PRIVACY_DOCS-04": () => {
    if (s.docs.dpa) return v("pass", "A DPA / subprocessor artefact is present (signed contracts require manual review).", [s.docs.dpa]);
    if (processors.length) return v("warn", "Third-party processors are in use but no DPA / subprocessor list was found.", refs(processors));
    return v("not_observable", "No DPA artefact and no third-party processors detected — likely not applicable.");
  },

  "GDPR-PRIVACY_DOCS-05": () => {
    if (s.docs.dpia) return v("pass", "A DPIA artefact is present (necessity requires manual judgement).", [s.docs.dpia]);
    if ((s.special_category || []).length) return v("warn", "Special-category data terms were detected but no DPIA artefact was found.", refs((s.special_category || []).map((x) => x.token)));
    return v("not_observable", "No DPIA artefact; high-risk processing not evident from the repo.");
  },

  "GDPR-CONSENT-01": () => {
    const tr = s.deps.trackers || [];
    if (!tr.length) return v("not_observable", "No analytics/marketing SDKs detected in dependencies — consent tooling not required here.");
    if ((s.deps.cmp || []).length) return v("pass", "A consent-management library is present alongside the trackers.", [`trackers: ${tr.join(", ")}`, `cmp: ${s.deps.cmp.join(", ")}`]);
    return v("fail", "Analytics/marketing SDKs are present but no consent-management library was found in dependencies.", tr);
  },

  "GDPR-SEC-01": () =>
    (s.secrets || []).length ? v("fail", "Secret material appears to be committed to the repo.", s.secrets.map((x) => `${x.kind}: ${x.file}${x.line ? ":" + x.line : ""}`)) : v("pass", "No committed secrets, private keys or hardcoded credentials were detected."),

  "GDPR-SEC-02": () => {
    if ((s.weak_hashing || []).length) return v("fail", "Weak/legacy hashing (md5/sha1) appears in password-related code.", s.weak_hashing.map((x) => `${x.file}:${x.line}`));
    if (s.strong_hashing_present) return v("pass", "A strong password-hashing library (bcrypt/scrypt/argon2) is present and no weak hashing was found.");
    return v("not_observable", "No password-hashing code detected (the project may not store credentials).");
  },

  "GDPR-SEC-03": () =>
    (s.pii_in_logs || []).length ? v("fail", "Log statements appear to emit personal data or secrets.", s.pii_in_logs.map((x) => `${x.file}:${x.line} ${x.snippet}`).slice(0, 8)) : v("pass", "No log statements emitting personal data/secrets were detected."),

  "GDPR-SEC-04": () => {
    const c = s.cookies || { setting_files: [] };
    if (!c.setting_files.length) return v("not_observable", "No cookie-setting code detected.");
    const miss = ["httpOnly", "secure", "sameSite"].filter((k) => !c[k]);
    if (!miss.length) return v("pass", "Cookie-setting code uses HttpOnly, Secure and SameSite.", refs(c.setting_files));
    return v("warn", `Cookie-setting code is present but these attributes were not clearly found: ${miss.join(", ")}.`, refs(c.setting_files));
  },

  "GDPR-SEC-05": () => {
    if ((s.deps.manifests || []).length && (s.deps.lockfiles || []).length) return v("pass", "A dependency manifest and a committed lockfile are present.", [...s.deps.manifests, ...s.deps.lockfiles]);
    if ((s.deps.manifests || []).length) return v("warn", "Dependencies are declared but no lockfile is committed (reproducibility/vuln-management gap).", s.deps.manifests);
    return v("not_observable", "No dependency manifest detected.");
  },

  "GDPR-PII-01": () => {
    if (!hasPII) return v("pass", "No personal-data fields were detected in models/schemas.");
    return v("warn", `Personal-data fields detected (inventory) — review against minimisation and retention.`, (s.pii_fields || []).map((x) => `${x.token} (${x.file})`).slice(0, 12));
  },

  "GDPR-PII-03": () => {
    const sc = s.special_category || [];
    if (!sc.length) return v("pass", "No special-category (Art. 9) data terms detected.");
    return v("warn", "Special-category data terms detected — confirm an Art. 9 lawful condition and a DPIA.", sc.map((x) => `${x.token} (${x.file})`).slice(0, 10));
  },

  "GDPR-DSR-01": () => {
    if ((s.dsr.export || []).length) return v("pass", "A data export/portability mechanism appears to be implemented.", s.dsr.export.map((x) => `${x.file}:${x.line}`).slice(0, 6));
    if (hasPII) return v("fail", "Personal data is stored but no data export/access mechanism (Art. 15/20) was found.");
    return v("not_observable", "No export mechanism and no personal-data storage clearly detected.");
  },

  "GDPR-DSR-02": () => {
    if ((s.dsr.delete || []).length) return v("pass", "A data erasure / account-deletion mechanism appears to be implemented.", s.dsr.delete.map((x) => `${x.file}:${x.line}`).slice(0, 6));
    if (hasPII) return v("fail", "Personal data is stored but no erasure/deletion mechanism (Art. 17) was found.");
    return v("not_observable", "No erasure mechanism and no personal-data storage clearly detected.");
  },

  "GDPR-XFER-01": () => {
    const reg = s.cloud_regions || [];
    if (!reg.length) return v("pass", "No non-EEA storage/region configuration detected.");
    return v("warn", "Non-EEA cloud regions are configured — confirm a transfer mechanism (adequacy/SCCs) for any personal data stored there.", reg.map((x) => `${x.token} (${x.file})`).slice(0, 8));
  },

  "GDPR-XFER-02": () => {
    if (!processors.length) return v("pass", "No third-party processor/tracker SDKs detected in dependencies.");
    return v("warn", "Third-party (likely non-EEA) SDKs are in dependencies — ensure transfer mechanisms + disclosure.", refs(processors));
  },

  "GDPR-RET-01": () => {
    if ((s.retention || []).length) return v("pass", "Retention/TTL/purge logic appears to be present.", s.retention.map((x) => `${x.file}:${x.line}`).slice(0, 6));
    if (hasPII) return v("warn", "Personal data is stored but no retention/expiry/purge logic was detected (Art. 5(1)(e)).");
    return v("not_observable", "No retention logic and no personal-data storage clearly detected.");
  },

  "GDPR-PROC-01": () => {
    if (!processors.length) return v("pass", "No third-party processors detected in dependencies.");
    return v("warn", "Third-party processors detected (inventory) — confirm each is covered by an Art. 28 DPA.", refs(processors));
  },

  "GDPR-CHILD-01": () => {
    if ((s.age_gate || []).length) return v("pass", "Age-gate / parental-consent handling appears to be present.", s.age_gate.map((x) => `${x.file}:${x.line}`).slice(0, 5));
    return v("not_observable", "No age-gate logic detected; Art. 8 applies only if the service targets children.");
  },

  "GDPR-GOV-01": () => {
    if ((s.dpo_contact || []).length) return v("pass", "A privacy/DPO contact is documented in the repo.", s.dpo_contact.map((x) => `${x.file}:${x.line}`).slice(0, 5));
    if (s.docs.security) return v("warn", "A SECURITY file exists but no explicit privacy/DPO contact was found.", [s.docs.security]);
    return v("warn", "No privacy/DPO contact found in the repo.");
  },
};

const verdicts = [];
for (const id of autoIds) {
  const fn = RULES[id];
  verdicts.push({ id, ...(fn ? fn() : v("not_observable", "No deterministic rule implemented for this auto check.")) });
}

process.stdout.write(JSON.stringify(verdicts, null, 2));
