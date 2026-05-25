#!/usr/bin/env node
/**
 * Stage-1 collector for the security-domain workflow. Given a domain, gathers web-security evidence
 * observable from outside over HTTP(S)/TLS — deterministically, Node builtins + global fetch only.
 * Emits one evidence.json that the deterministic evaluator reads. No browser, no LLM.
 *
 * Env: SECDOM_DOMAIN (required), SECDOM_TIMEOUT_MS (default 12000).
 */
import tls from "node:tls";

const raw = process.env.SECDOM_DOMAIN;
if (!raw) { process.stderr.write("collect: SECDOM_DOMAIN env is required\n"); process.exit(1); }
const TIMEOUT = Number(process.env.SECDOM_TIMEOUT_MS || 12000);
const UA = "Mozilla/5.0 (agentflow-security-audit)";
const host = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
const baseUrl = `https://${host}`;
const errors = [];

function headersToObj(h) { const o = {}; for (const [k, v] of h.entries()) o[k.toLowerCase()] = v; return o; }
function getSetCookie(h) { return typeof h.getSetCookie === "function" ? h.getSetCookie() : (h.get("set-cookie") ? [h.get("set-cookie")] : []); }
async function get(url, { redirect = "follow", method = "GET", headers = {} } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method, redirect, signal: ac.signal, headers: { "user-agent": UA, ...headers } });
    let body = ""; try { body = (await r.text()).slice(0, 4096); } catch { /* */ }
    return { ok: true, status: r.status, url: r.url, headers: headersToObj(r.headers), setCookie: getSetCookie(r.headers), body };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  finally { clearTimeout(t); }
}
function tlsInfo(h) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: h, port: 443, servername: h, timeout: TIMEOUT, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate() || {}; const to = c.valid_to ? new Date(c.valid_to) : null;
      resolve({ reachable: true, protocol: s.getProtocol(), authorized: s.authorized, auth_error: s.authorizationError ? String(s.authorizationError) : null,
        valid_to: c.valid_to || null, days_to_expiry: to ? Math.round((to - Date.now()) / 86400000) : null });
      s.end();
    });
    s.on("error", (e) => resolve({ reachable: false, error: String(e?.message || e) }));
    s.on("timeout", () => { resolve({ reachable: false, error: "timeout" }); s.destroy(); });
  });
}
function toHost(u) { try { return new URL(u, baseUrl).host.toLowerCase(); } catch { return null; } }
function registrable(h) { return (h || "").split(".").slice(-2).join("."); }

const EXPOSURE_PROBES = [
  { path: "/.git/HEAD", id: "git", sniff: /ref:\s|^[0-9a-f]{40}/m },
  { path: "/.env", id: "env", sniff: /^[A-Z0-9_]+\s*=/m },
  { path: "/.svn/entries", id: "svn", sniff: /\d+|svn/ },
  { path: "/backup.zip", id: "backup_zip", sniff: /./ },
  { path: "/backup.sql", id: "backup_sql", sniff: /./ },
  { path: "/.well-known/security.txt", id: "security_txt", sniff: /contact/i },
];

const evidence = { domain: host, target_url: baseUrl, scanned_at: new Date().toISOString() };
const [home, httpProbe, tlsRes, cors, trace, ...probes] = await Promise.all([
  get(baseUrl, { redirect: "follow" }),
  get(`http://${host}`, { redirect: "manual" }),
  tlsInfo(host),
  get(baseUrl, { redirect: "follow", headers: { origin: "https://agentflow-cors-probe.example" } }),
  get(baseUrl, { method: "TRACE", redirect: "manual" }).catch(() => ({ ok: false, error: "method not allowed" })),
  ...EXPOSURE_PROBES.map((p) => get(baseUrl + p.path, { redirect: "manual" })),
]);

evidence.tls = tlsRes;
evidence.http_redirect = httpProbe.ok
  ? { status: httpProbe.status, location: httpProbe.headers["location"] || null, redirects_to_https: [301, 302, 307, 308].includes(httpProbe.status) && /^https:/i.test(httpProbe.headers["location"] || "") }
  : { error: httpProbe.error };

if (!home.ok) { evidence.homepage = { ok: false, error: home.error }; evidence.errors = [`homepage fetch failed: ${home.error}`]; process.stdout.write(JSON.stringify(evidence, null, 2)); process.exit(0); }

const H = home.headers; const html = home.body || ""; const baseHost = registrable(host);
evidence.homepage = {
  ok: true, status: home.status, final_url: home.url,
  headers: {
    strict_transport_security: H["strict-transport-security"] || null,
    content_security_policy: H["content-security-policy"] || null,
    x_content_type_options: H["x-content-type-options"] || null,
    x_frame_options: H["x-frame-options"] || null,
    referrer_policy: H["referrer-policy"] || null,
    permissions_policy: H["permissions-policy"] || null,
    server: H["server"] || null,
    x_powered_by: H["x-powered-by"] || null,
    x_aspnet_version: H["x-aspnet-version"] || null,
  },
};

// Cookies + their flags (note: with redirect:follow these are the final response's cookies).
evidence.cookies = home.setCookie.map((line) => {
  const name = String(line).split("=")[0].trim();
  return { name, secure: /;\s*secure/i.test(line), httponly: /;\s*httponly/i.test(line), samesite: (line.match(/samesite=(\w+)/i) || [])[1] || null };
});

// Mixed content: active http resources referenced by an https page.
const httpResources = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](http:\/\/[^"']+)["']/gi)].map((m) => m[1]).slice(0, 15);
evidence.mixed_content = httpResources;

// Subresource Integrity: cross-origin scripts/styles missing integrity.
const sriMissing = [];
for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
  const tag = m[0];
  const src = (tag.match(/(?:src|href)\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (!src) continue;
  const h = toHost(src);
  if (!h || registrable(h) === baseHost) continue; // same-origin: SRI not required
  if (/\.(js|css)(\?|$)/i.test(src) && !/integrity\s*=/i.test(tag)) sriMissing.push(src);
}
evidence.sri_missing = sriMissing.slice(0, 15);

// CORS reflection with credentials.
const acao = cors.ok ? (cors.headers["access-control-allow-origin"] || null) : null;
const acac = cors.ok ? (cors.headers["access-control-allow-credentials"] || null) : null;
evidence.cors = { allow_origin: acao, allow_credentials: acac, reflects_probe_origin: acao === "https://agentflow-cors-probe.example", wildcard: acao === "*" };

// TRACE method.
evidence.trace = trace.ok ? { status: trace.status, echoed: /TRACE/i.test(trace.body || "") } : { error: trace.error };

// Directory listing on the landing path.
evidence.directory_listing = /<title>\s*Index of\s*\/|<h1>\s*Index of\s*\//i.test(html);

// Exposure probes.
evidence.exposure = EXPOSURE_PROBES.map((p, i) => {
  const r = probes[i];
  const reachable = r.ok && r.status >= 200 && r.status < 300;
  return { id: p.id, path: p.path, status: r.ok ? r.status : null, error: r.ok ? null : r.error, reachable, content_match: reachable && p.sniff.test(r.body || "") };
});

evidence.errors = errors;
process.stdout.write(JSON.stringify(evidence, null, 2));
