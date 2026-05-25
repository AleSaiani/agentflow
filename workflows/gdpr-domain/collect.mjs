#!/usr/bin/env node
/**
 * Stage-1 collector for the gdpr-domain workflow. Given a domain, gathers everything a GDPR
 * compliance check can observe from OUTSIDE over HTTP(S)/TLS — deterministically, with Node builtins
 * + global fetch only (zero deps). Emits a single evidence.json that the deterministic evaluator
 * (evaluate.mjs) and the bounded LLM step both read.
 *
 * It is a STATIC observer: it reads the first server response, the landing HTML and the linked
 * privacy/cookie notices. It does NOT drive a browser, so JS-rendered banner behaviour and
 * cookies-after-interaction are out of scope (those checks are decision_mode:"manual" in
 * checklist.json and are reported as requiring an interactive pass — never faked).
 *
 * Env: GDPR_DOMAIN (required, e.g. "example.com" or "https://example.com"),
 *      GDPR_TIMEOUT_MS (default 15000), GDPR_MAX_POLICY_CHARS (default 60000).
 */
import tls from "node:tls";

const rawDomain = process.env.GDPR_DOMAIN;
if (!rawDomain) {
  process.stderr.write("collect: GDPR_DOMAIN env is required\n");
  process.exit(1);
}
const TIMEOUT = Number(process.env.GDPR_TIMEOUT_MS || 15000);
const MAX_POLICY = Number(process.env.GDPR_MAX_POLICY_CHARS || 60000);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 agentflow-gdpr-audit";

// Normalize to an https origin + bare host.
const host = rawDomain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
const baseUrl = `https://${host}`;
const errors = [];

// ---------- known-entity tables (deterministic classification) ----------

const TRACKER_HOSTS = [
  { re: /(^|\.)google-analytics\.com|analytics\.google\.com|stats\.g\.doubleclick/, provider: "Google Analytics", category: "analytics", country: "US" },
  { re: /googletagmanager\.com/, provider: "Google Tag Manager", category: "tag_manager", country: "US" },
  { re: /doubleclick\.net|googlesyndication\.com|googleadservices\.com/, provider: "Google Ads / DoubleClick", category: "advertising", country: "US" },
  { re: /(^|\.)facebook\.net/, provider: "Meta Pixel", category: "advertising", country: "US" },
  { re: /hotjar\.com|hotjar\.io/, provider: "Hotjar", category: "analytics", country: "US" },
  { re: /clarity\.ms/, provider: "Microsoft Clarity", category: "analytics", country: "US" },
  { re: /bat\.bing\.com/, provider: "Microsoft Bing Ads", category: "advertising", country: "US" },
  { re: /(^|\.)licdn\.com|px\.ads\.linkedin\.com/, provider: "LinkedIn Insight", category: "advertising", country: "US" },
  { re: /static\.ads-twitter\.com|(^|\.)t\.co$|analytics\.twitter\.com|ads-twitter\.com/, provider: "X/Twitter Ads", category: "advertising", country: "US" },
  { re: /tiktok\.com|tiktokcdn\.com|analytics\.tiktok/, provider: "TikTok Pixel", category: "advertising", country: "CN/US" },
  { re: /youtube\.com|youtube-nocookie\.com|ytimg\.com/, provider: "YouTube", category: "social_embed", country: "US" },
  { re: /player\.vimeo\.com|vimeo\.com/, provider: "Vimeo", category: "social_embed", country: "US" },
  { re: /maps\.google|maps\.gstatic|maps\.googleapis/, provider: "Google Maps", category: "social_embed", country: "US" },
  { re: /platform\.twitter\.com|syndication\.twitter/, provider: "X/Twitter widget", category: "social_embed", country: "US" },
  { re: /platform\.linkedin\.com/, provider: "LinkedIn widget", category: "social_embed", country: "US" },
  { re: /instagram\.com\/embed|cdninstagram/, provider: "Instagram embed", category: "social_embed", country: "US" },
  { re: /cloudflareinsights\.com/, provider: "Cloudflare Web Analytics", category: "analytics", country: "US" },
  { re: /segment\.(com|io)/, provider: "Segment", category: "analytics", country: "US" },
  { re: /amplitude\.com/, provider: "Amplitude", category: "analytics", country: "US" },
  { re: /(cdn\.)?mxpnl\.com|mixpanel\.com/, provider: "Mixpanel", category: "analytics", country: "US" },
  { re: /fullstory\.com/, provider: "FullStory", category: "analytics", country: "US" },
  { re: /intercom\.io|intercomcdn|intercom\.com/, provider: "Intercom", category: "support_chat", country: "US" },
  { re: /hs-scripts\.com|hs-analytics\.net|hubspot\.com|hubapi\.com/, provider: "HubSpot", category: "marketing", country: "US" },
  { re: /pardot\.com|marketo\.(com|net)|mktoresp/, provider: "Marketo/Pardot", category: "marketing", country: "US" },
  { re: /criteo\.(com|net)/, provider: "Criteo", category: "advertising", country: "EU/FR" },
  { re: /taboola\.com|outbrain\.com/, provider: "Taboola/Outbrain", category: "advertising", country: "US/IL" },
];

const CMP_VENDORS = [
  { re: /onetrust|cookielaw\.org|cookiepro|otSDKStub/, name: "OneTrust" },
  { re: /cookiebot|consent\.cookiebot|uc\.cookiebot/, name: "Cookiebot" },
  { re: /usercentrics|app\.usercentrics/, name: "Usercentrics" },
  { re: /didomi/, name: "Didomi" },
  { re: /cookieyes|cookie-law-info/, name: "CookieYes" },
  { re: /quantcast|quantcount|choice\.consensu/, name: "Quantcast Choice" },
  { re: /trustarc|truste\.com|consent\.truste/, name: "TrustArc" },
  { re: /osano\.com/, name: "Osano" },
  { re: /termly\.io/, name: "Termly" },
  { re: /iubenda\.com/, name: "Iubenda" },
  { re: /tarteaucitron/, name: "tarteaucitron" },
  { re: /klaro/, name: "Klaro" },
  { re: /cookieconsent|cookie-consent|civic.{0,8}cookie|orejime/, name: "generic cookie-consent" },
];

const FP_LIBS = [{ re: /fingerprintjs|fpjs|clientjs|@fingerprintjs/, name: "FingerprintJS / ClientJS" }];

// Set-Cookie name → tracker provider (non-essential). Anything matching essential hints is treated as
// strictly-necessary and NOT flagged.
const TRACKER_COOKIE = [
  { re: /^_ga(_[\w]+)?$/, provider: "Google Analytics" },
  { re: /^_gid$/, provider: "Google Analytics" },
  { re: /^_gat/, provider: "Google Analytics" },
  { re: /^_gcl_au$/, provider: "Google Ads" },
  { re: /^_fbp$/, provider: "Meta Pixel" },
  { re: /^fr$/, provider: "Meta" },
  { re: /^IDE$/, provider: "Google DoubleClick" },
  { re: /^test_cookie$/, provider: "DoubleClick" },
  { re: /^NID$|^DSID$|^1P_JAR$/, provider: "Google" },
  { re: /^MUID$|^_uetsid|^_uetvid/, provider: "Microsoft/Bing" },
  { re: /^_hj/, provider: "Hotjar" },
  { re: /^__hstc$|^hubspotutk$|^__hssc$|^__hssrc$/, provider: "HubSpot" },
  { re: /^_clck$|^_clsk$/, provider: "Microsoft Clarity" },
  { re: /^ajs_/, provider: "Segment" },
  { re: /^amplitude_/, provider: "Amplitude" },
  { re: /^mp_/, provider: "Mixpanel" },
];
const ESSENTIAL_COOKIE = /sess|csrf|xsrf|phpsessid|jsessionid|asp\.net|consent|cookie.?consent|__cf|__secure|__host|csrftoken|sid$|token|locale|lang|currency|cart|^_dd_/i;

// ---------- helpers ----------

function classifyHost(h) {
  for (const t of TRACKER_HOSTS) if (t.re.test(h)) return t;
  return null;
}
function registrable(h) {
  const parts = h.split(".");
  return parts.slice(-2).join(".");
}
function classifyCookie(name) {
  for (const t of TRACKER_COOKIE) if (t.re.test(name)) return { classification: "non_essential_tracker", provider: t.provider };
  if (ESSENTIAL_COOKIE.test(name)) return { classification: "likely_essential", provider: null };
  return { classification: "unknown", provider: null };
}
function headersToObj(h) {
  const o = {};
  for (const [k, v] of h.entries()) o[k.toLowerCase()] = v;
  return o;
}
function getSetCookie(h) {
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = h.get("set-cookie");
  return one ? [one] : [];
}
function cookieName(setCookieLine) {
  return String(setCookieLine).split("=")[0].trim();
}
function htmlToText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function get(url, redirect = "follow") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { redirect, signal: ac.signal, headers: { "user-agent": UA, accept: "text/html,*/*" } });
    let body = "";
    try {
      body = await r.text();
    } catch {
      /* non-text */
    }
    return { ok: true, status: r.status, url: r.url, redirected: r.redirected, headers: headersToObj(r.headers), setCookie: getSetCookie(r.headers), body };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}
function tlsInfo(h) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: h, port: 443, servername: h, timeout: TIMEOUT, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate() || {};
      const to = cert.valid_to ? new Date(cert.valid_to) : null;
      resolve({
        reachable: true,
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        auth_error: socket.authorizationError ? String(socket.authorizationError) : null,
        valid_from: cert.valid_from || null,
        valid_to: cert.valid_to || null,
        days_to_expiry: to ? Math.round((to - Date.now()) / 86400000) : null,
        subject_cn: cert.subject?.CN || null,
        issuer_o: cert.issuer?.O || null,
      });
      socket.end();
    });
    socket.on("error", (e) => resolve({ reachable: false, error: String(e?.message || e) }));
    socket.on("timeout", () => {
      resolve({ reachable: false, error: "timeout" });
      socket.destroy();
    });
  });
}

// Extract every resource URL (src/href) and anchors from HTML, regex-only (no DOM dep).
function extractUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) urls.add(m[1]);
  return [...urls];
}
function extractAnchors(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: m[1], text: htmlToText(m[2]).slice(0, 120) });
  }
  return out;
}
function toHost(u) {
  try {
    return new URL(u, baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}
function abs(u) {
  try {
    return new URL(u, baseUrl).href;
  } catch {
    return null;
  }
}

// ---------- run ----------

const evidence = { domain: host, target_url: baseUrl, fetched_at: new Date().toISOString() };

const [home, httpProbe, tlsRes] = await Promise.all([get(baseUrl, "follow"), get(`http://${host}`, "manual"), tlsInfo(host)]);

evidence.tls = tlsRes;
evidence.http_redirect = httpProbe.ok
  ? {
      status: httpProbe.status,
      location: httpProbe.headers["location"] || null,
      redirects_to_https: [301, 302, 307, 308].includes(httpProbe.status) && /^https:/i.test(httpProbe.headers["location"] || ""),
    }
  : { error: httpProbe.error };

if (!home.ok) {
  errors.push(`homepage fetch failed: ${home.error}`);
  evidence.homepage = { ok: false, error: home.error };
  evidence.errors = errors;
  process.stdout.write(JSON.stringify(evidence, null, 2));
  process.exit(0); // emit partial evidence; the evaluator will mark unreachable checks not_observable
}

const html = home.body || "";
const baseHost = registrable(host);
const H = home.headers;

evidence.homepage = {
  ok: true,
  status: home.status,
  final_url: home.url,
  redirected: home.redirected,
  html_bytes: html.length,
  security_headers: {
    strict_transport_security: H["strict-transport-security"] || null,
    content_security_policy: H["content-security-policy"] || null,
    x_content_type_options: H["x-content-type-options"] || null,
    referrer_policy: H["referrer-policy"] || null,
    x_frame_options: H["x-frame-options"] || null,
    permissions_policy: H["permissions-policy"] || null,
    server: H["server"] || null,
    x_powered_by: H["x-powered-by"] || null,
  },
};

// Pre-consent cookies set on the first response (server Set-Cookie).
evidence.pre_consent_cookies = home.setCookie.map((line) => {
  const name = cookieName(line);
  const c = classifyCookie(name);
  return { name, classification: c.classification, provider: c.provider };
});

// Third-party hosts referenced in the landing HTML.
const urls = extractUrls(html);
const tpMap = new Map();
for (const u of urls) {
  const h = toHost(u);
  if (!h || registrable(h) === baseHost) continue;
  const cls = classifyHost(h);
  const key = h;
  if (!tpMap.has(key)) tpMap.set(key, { host: h, provider: cls?.provider || null, category: cls?.category || "other_third_party", country: cls?.country || "unknown", tracker: !!cls, examples: [] });
  const e = tpMap.get(key);
  if (e.examples.length < 2) e.examples.push(abs(u));
}
evidence.third_parties = [...tpMap.values()].sort((a, b) => Number(b.tracker) - Number(a.tracker) || a.host.localeCompare(b.host));
evidence.trackers = evidence.third_parties.filter((t) => t.tracker);

// CMP / consent platform detection (script srcs + inline API references).
const cmpHits = [];
for (const v of CMP_VENDORS) if (v.re.test(html)) cmpHits.push(v.name);
const tcfApi = /__tcfapi|window\.__cmp|__gpp/.test(html);
evidence.cmp = { detected: cmpHits.length > 0 || tcfApi, vendors: [...new Set(cmpHits)], tcf_api: tcfApi };

// Fingerprinting libraries.
evidence.fingerprinting = FP_LIBS.filter((f) => f.re.test(html)).map((f) => ({ lib: f.name }));

// Social embeds (subset of third parties categorized as social_embed).
evidence.social_embeds = evidence.third_parties.filter((t) => t.category === "social_embed");

// Forms + insecure submission / PII inputs.
const forms = [];
for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
  const attrs = m[1];
  const action = (attrs.match(/action\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  const method = ((attrs.match(/method\s*=\s*["']([^"']+)["']/i) || [])[1] || "get").toLowerCase();
  const actionAbs = action ? abs(action) : home.url;
  const actHost = actionAbs ? toHost(actionAbs) : baseHost;
  forms.push({
    action: actionAbs,
    method,
    insecure: /^http:\/\//i.test(actionAbs || ""),
    cross_origin: actHost ? registrable(actHost) !== baseHost : false,
  });
}
evidence.forms = {
  count: forms.length,
  has_password_input: /<input[^>]*type\s*=\s*["']?password/i.test(html),
  has_email_input: /<input[^>]*type\s*=\s*["']?email/i.test(html),
  actions: forms.slice(0, 20),
};

// Privacy / cookie policy links + fetched text.
const anchors = extractAnchors(html);
const linkRe = /privacy|cookie|datenschutz|informativa|gdpr|data.?protection|priv\b/i;
const policyLinks = anchors
  .filter((a) => linkRe.test(a.href) || linkRe.test(a.text))
  .map((a) => ({ url: abs(a.href), text: a.text }))
  .filter((a) => a.url && /^https?:/i.test(a.url));
// de-dupe by url
const seen = new Set();
evidence.privacy = { links: policyLinks.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, 15) };

function pick(links, re) {
  return links.find((l) => re.test(l.url) || re.test(l.text));
}
const privacyLink = pick(evidence.privacy.links, /privacy|datenschutz|informativa|data.?protection|gdpr/i) || evidence.privacy.links[0];
const cookieLink = pick(evidence.privacy.links, /cookie/i);

if (privacyLink) {
  const r = await get(privacyLink.url, "follow");
  if (r.ok && r.status < 400) {
    const text = htmlToText(r.body || "");
    evidence.privacy.policy_url = r.url;
    evidence.privacy.policy_status = r.status;
    evidence.privacy.policy_text_chars = text.length;
    evidence.privacy.policy_text = text.slice(0, MAX_POLICY);
    evidence.privacy.policy_truncated = text.length > MAX_POLICY;
  } else {
    evidence.privacy.policy_url = privacyLink.url;
    evidence.privacy.policy_status = r.ok ? r.status : null;
    evidence.privacy.policy_error = r.ok ? `status ${r.status}` : r.error;
  }
}
if (cookieLink && (!privacyLink || cookieLink.url !== privacyLink.url)) {
  const r = await get(cookieLink.url, "follow");
  if (r.ok && r.status < 400) {
    const text = htmlToText(r.body || "");
    evidence.cookie_policy = { url: r.url, status: r.status, text_chars: text.length, text: text.slice(0, MAX_POLICY) };
  }
}

evidence.errors = errors;
process.stdout.write(JSON.stringify(evidence, null, 2));
