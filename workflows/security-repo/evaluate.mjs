#!/usr/bin/env node
/**
 * Stage-2 deterministic evaluator for the security-repo workflow. Reads scan.json + checklist.json and
 * decides every check with pure rules over the SAST-lite scan — no LLM, no network. High-confidence
 * categories fail; heuristic ones (eval, XSS sinks, CORS, debug) warn to bound false positives.
 * status ∈ pass | fail | warn | not_observable.
 *
 * Env: SECREPO_SCAN (scan.json), SECREPO_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const s = JSON.parse(readFileSync(process.env.SECREPO_SCAN, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.SECREPO_CHECKLIST, "utf8"));
const v = (status, rationale, evidence = []) => ({ status, decided_by: "code", rationale, evidence });
const locs = (arr, n = 8) => (arr || []).slice(0, n).map((x) => `${x.file}:${x.line}${x.kind ? " (" + x.kind + ")" : ""}`);
const findings = (key) => s[key] || [];

const RULES = {
  "SECR-SECRETS-01": () => findings("secrets").length ? v("fail", "Secret material appears committed to the repo.", locs(s.secrets)) : v("pass", "No committed secrets, keys or hardcoded credentials detected."),
  "SECR-CRYPTO-01": () => findings("weak_hashing").length ? v("fail", "Weak/legacy hashing (md5/sha1) detected.", locs(s.weak_hashing)) : s.strong_hashing_present ? v("pass", "Strong hashing present and no weak hashing found.") : v("not_observable", "No hashing code detected."),
  "SECR-CRYPTO-02": () => findings("insecure_random").length ? v("warn", "Non-cryptographic randomness appears used for security values — review.", locs(s.insecure_random)) : v("pass", "No insecure randomness tied to security values detected."),
  "SECR-INJECT-01": () => findings("sql_injection").length ? v("fail", "SQL appears built by string concatenation/interpolation (SQLi risk).", locs(s.sql_injection)) : v("pass", "No string-built SQL detected."),
  "SECR-INJECT-02": () => findings("command_injection").length ? v("fail", "OS commands appear built from interpolated input (command-injection risk).", locs(s.command_injection)) : v("pass", "No interpolated command execution detected."),
  "SECR-EXEC-01": () => findings("dynamic_eval").length ? v("warn", "Dynamic code evaluation (eval/Function/exec) present — review each usage.", locs(s.dynamic_eval)) : v("pass", "No dynamic code evaluation detected."),
  "SECR-DESERIAL-01": () => findings("insecure_deserialization").length ? v("fail", "Insecure deserialization detected.", locs(s.insecure_deserialization)) : v("pass", "No insecure deserialization detected."),
  "SECR-XSS-01": () => findings("xss_sinks").length ? v("warn", "Dangerous HTML/DOM sinks present — ensure data is escaped/sanitised.", locs(s.xss_sinks)) : v("pass", "No dangerous HTML/DOM sinks detected."),
  "SECR-TLS-01": () => findings("tls_verification_disabled").length ? v("fail", "TLS certificate verification appears disabled.", locs(s.tls_verification_disabled)) : v("pass", "No disabled TLS verification detected."),
  "SECR-CORS-01": () => findings("permissive_cors").length ? v("warn", "Permissive CORS configuration present — confirm it is not exposed with credentials.", locs(s.permissive_cors)) : v("pass", "No permissive CORS configuration detected."),
  "SECR-DEBUG-01": () => findings("debug_mode").length ? v("warn", "Debug mode appears enabled in committed config.", locs(s.debug_mode)) : v("pass", "No debug mode enabled in committed config."),
  "SECR-AUTH-01": () => findings("default_credentials").length ? v("fail", "Default/hardcoded passwords detected.", locs(s.default_credentials)) : v("pass", "No default/hardcoded passwords detected."),
  "SECR-LOG-01": () => findings("sensitive_in_logs").length ? v("warn", "Log statements appear to emit secrets/PII.", locs(s.sensitive_in_logs)) : v("pass", "No sensitive data in logs detected."),
  "SECR-DEPS-01": () => {
    const m = s.deps?.manifests || [], l = s.deps?.lockfiles || [];
    if (l.length) return v("pass", "A dependency lockfile is committed.", l);
    if (m.length) return v("warn", "Dependencies declared but no lockfile committed.", m);
    return v("not_observable", "No dependency manifest detected.");
  },
  "SECR-CONTAINER-01": () => {
    const d = s.docker || [];
    if (!d.length) return v("not_observable", "No Dockerfile detected.");
    const root = d.filter((x) => x.runs_root);
    return root.length ? v("warn", "A Dockerfile runs as root (no non-root USER directive).", root.map((x) => x.file)) : v("pass", "All Dockerfiles set a non-root USER.");
  },
  "SECR-CONTAINER-02": () => {
    const d = s.docker || [];
    if (!d.length) return v("not_observable", "No Dockerfile detected.");
    const un = d.filter((x) => (x.unpinned || []).length);
    return un.length ? v("warn", "A container base image is unpinned (:latest or no tag).", un.map((x) => `${x.file}: ${x.unpinned.join(", ")}`)) : v("pass", "Container base images are pinned.");
  },
};

const verdicts = [];
for (const c of checklist.checks) {
  const fn = RULES[c.id];
  verdicts.push({ id: c.id, ...(fn ? fn() : v("not_observable", "No rule implemented.")) });
}
process.stdout.write(JSON.stringify(verdicts, null, 2));
