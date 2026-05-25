#!/usr/bin/env node
/**
 * Stage-2 deterministic evaluator for the security-domain workflow. Reads evidence.json + checklist.json
 * and decides every check with pure rules — no LLM, no network. Emits a JSON array of verdicts.
 * status ∈ pass | fail | warn | not_observable.
 *
 * Env: SECDOM_EVIDENCE (evidence.json), SECDOM_CHECKLIST (checklist.json).
 */
import { readFileSync } from "node:fs";

const ev = JSON.parse(readFileSync(process.env.SECDOM_EVIDENCE, "utf8"));
const checklist = JSON.parse(readFileSync(process.env.SECDOM_CHECKLIST, "utf8"));
const reachable = ev.homepage && ev.homepage.ok;
const H = (reachable && ev.homepage.headers) || {};
const v = (status, rationale, evidence = []) => ({ status, decided_by: "code", rationale, evidence });
const protoRank = (p) => ({ "TLSv1.3": 4, "TLSv1.2": 3, "TLSv1.1": 2, TLSv1: 1, SSLv3: 0 }[p] ?? -1);
const expo = (id) => (ev.exposure || []).find((e) => e.id === id) || {};

const RULES = {
  "SEC-TLS-01": () => {
    const t = ev.tls || {};
    if (!t.reachable) return v("fail", `TLS handshake failed: ${t.error || "unreachable"}.`);
    const out = [`protocol ${t.protocol}`, `expires in ${t.days_to_expiry} days`];
    if (!t.authorized) return v("fail", `Certificate not trusted/valid: ${t.auth_error}.`, out);
    if (protoRank(t.protocol) < protoRank("TLSv1.2")) return v("fail", `Deprecated TLS protocol (${t.protocol}).`, out);
    if (t.days_to_expiry !== null && t.days_to_expiry < 0) return v("fail", "Certificate expired.", out);
    if (t.days_to_expiry !== null && t.days_to_expiry < 15) return v("warn", `Cert expires in ${t.days_to_expiry} days.`, out);
    return v("pass", `Valid certificate over ${t.protocol}.`, out);
  },
  "SEC-TLS-02": () => {
    const r = ev.http_redirect || {}; const hsts = H.strict_transport_security;
    const out = [`HTTP status ${r.status ?? "?"}`, hsts ? `HSTS: ${hsts}` : "no HSTS"];
    if (r.redirects_to_https && hsts) return v("pass", "HTTP redirects to HTTPS and HSTS is set.", out);
    if (r.redirects_to_https) return v("warn", "Redirects to HTTPS but no HSTS header.", out);
    if (hsts) return v("warn", "HSTS set but HTTP did not redirect to HTTPS.", out);
    return v("fail", "No HTTP→HTTPS redirect and no HSTS.", out);
  },
  "SEC-TLS-03": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (!(ev.mixed_content || []).length) return v("pass", "No active resources loaded over plain HTTP.");
    return v("fail", "The HTTPS page loads resources over plain HTTP (mixed content).", ev.mixed_content.slice(0, 8));
  },
  "SEC-HDR-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const csp = H.content_security_policy;
    if (!csp) return v("fail", "No Content-Security-Policy header.");
    const unsafe = [];
    if (/unsafe-inline/i.test(csp)) unsafe.push("unsafe-inline");
    if (/unsafe-eval/i.test(csp)) unsafe.push("unsafe-eval");
    if (/default-src[^;]*\*/i.test(csp)) unsafe.push("wildcard default-src");
    if (unsafe.length) return v("warn", `CSP present but weakened by: ${unsafe.join(", ")}.`, [csp.slice(0, 160)]);
    return v("pass", "CSP present without trivially-unsafe directives.", [csp.slice(0, 160)]);
  },
  "SEC-HDR-02": () => !reachable ? v("not_observable", "Homepage not reachable.") : (/nosniff/i.test(H.x_content_type_options || "") ? v("pass", "X-Content-Type-Options: nosniff is set.") : v("fail", "X-Content-Type-Options: nosniff is missing.")),
  "SEC-HDR-03": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (H.x_frame_options || /frame-ancestors/i.test(H.content_security_policy || "")) return v("pass", "Framing is restricted (X-Frame-Options or CSP frame-ancestors).", [H.x_frame_options || "CSP frame-ancestors"]);
    return v("fail", "No anti-clickjacking control (X-Frame-Options / frame-ancestors).");
  },
  "SEC-HDR-04": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const rp = H.referrer_policy;
    if (!rp) return v("warn", "No Referrer-Policy header.");
    if (/unsafe-url/i.test(rp)) return v("warn", `Referrer-Policy is permissive (${rp}).`);
    return v("pass", `Referrer-Policy set (${rp}).`);
  },
  "SEC-HDR-05": () => !reachable ? v("not_observable", "Homepage not reachable.") : (H.permissions_policy ? v("pass", "Permissions-Policy header present.") : v("warn", "No Permissions-Policy header.")),
  "SEC-COOKIE-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const cs = ev.cookies || [];
    if (!cs.length) return v("not_observable", "No cookies set on the landing response.");
    const bad = cs.filter((c) => !c.secure || !c.httponly || !c.samesite);
    if (!bad.length) return v("pass", "All cookies set Secure, HttpOnly and SameSite.", cs.map((c) => c.name));
    return v("warn", "Some cookies miss Secure/HttpOnly/SameSite.", bad.map((c) => `${c.name} (secure=${c.secure},httpOnly=${c.httponly},sameSite=${c.samesite || "none"})`));
  },
  "SEC-EXPOSE-01": () => { const g = expo("git"); return g.content_match ? v("fail", "Git metadata is web-reachable (/.git/HEAD).", [`/.git/HEAD → HTTP ${g.status}`]) : v("pass", "/.git is not exposed."); },
  "SEC-EXPOSE-02": () => {
    const e = expo("env");
    if (e.content_match) return v("fail", "An environment/secret file is web-reachable (/.env).", [`/.env → HTTP ${e.status}`]);
    return v("pass", "No exposed /.env detected.");
  },
  "SEC-EXPOSE-03": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const dumps = (ev.exposure || []).filter((e) => ["backup_zip", "backup_sql", "svn"].includes(e.id) && e.reachable);
    if (ev.directory_listing) return v("fail", "Directory listing (autoindex) is enabled on the landing path.");
    if (dumps.length) return v("fail", "Backup/VCS dump files are web-reachable.", dumps.map((d) => `${d.path} → HTTP ${d.status}`));
    return v("pass", "No directory listing or common backup dumps reachable.");
  },
  "SEC-INFO-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    const leaks = [H.server && /\d/.test(H.server) ? `Server: ${H.server}` : null, H.x_powered_by ? `X-Powered-By: ${H.x_powered_by}` : null, H.x_aspnet_version ? `X-AspNet-Version: ${H.x_aspnet_version}` : null].filter(Boolean);
    return leaks.length ? v("warn", "Server/framework version is disclosed in headers.", leaks) : v("pass", "No verbose version disclosure in headers.");
  },
  "SEC-CORS-01": () => {
    const c = ev.cors || {};
    if ((c.reflects_probe_origin || c.wildcard) && /true/i.test(c.allow_credentials || "")) return v("fail", "Insecure CORS: origin reflected/wildcard together with Allow-Credentials:true.", [`ACAO: ${c.allow_origin}`, `ACAC: ${c.allow_credentials}`]);
    if (c.reflects_probe_origin) return v("warn", "CORS reflects an arbitrary request Origin (no credentials observed).", [`ACAO: ${c.allow_origin}`]);
    return v("pass", "No insecure CORS reflection detected.");
  },
  "SEC-SRI-01": () => {
    if (!reachable) return v("not_observable", "Homepage not reachable.");
    if (!(ev.sri_missing || []).length) return v("pass", "No cross-origin scripts/styles missing Subresource Integrity.");
    return v("warn", "Cross-origin resources are loaded without Subresource Integrity.", ev.sri_missing.slice(0, 8));
  },
  "SEC-METHOD-01": () => {
    const t = ev.trace || {};
    if (t.error) return v("not_observable", `TRACE could not be tested (${t.error}).`);
    if (t.echoed || t.status === 200) return v("fail", "The TRACE method appears enabled.", [`TRACE → HTTP ${t.status}`]);
    return v("pass", "TRACE method is not enabled.");
  },
};

const verdicts = [];
for (const c of checklist.checks) {
  const fn = RULES[c.id];
  verdicts.push({ id: c.id, ...(fn ? fn() : v("not_observable", "No rule implemented.")) });
}
process.stdout.write(JSON.stringify(verdicts, null, 2));
