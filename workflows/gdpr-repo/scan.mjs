#!/usr/bin/env node
/**
 * Stage-1 scanner for the gdpr-repo workflow. Walks a repository and gathers GDPR-relevant signals
 * deterministically — file/doc presence, dependency processors/trackers/CMP, and code patterns
 * (committed secrets, weak password hashing, PII in logs, cookie flags, PII fields in models,
 * special-category data, data-subject-rights handlers, retention logic, non-EEA regions, DPO contact).
 * Node builtins only, zero deps. Emits one scan.json that evaluate.mjs and the LLM step both read.
 *
 * It is an INTERNAL static observer over source: it sees what is committed, not what runs in
 * production nor signed contracts (those are the `manual` checks).
 *
 * Env: GDPR_REPO_DIR (default cwd), GDPR_MAX_FILE_KB (default 512), GDPR_MAX_FILES (default 8000),
 *      GDPR_MAX_DOC_CHARS (default 60000).
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep, extname, basename } from "node:path";

const ROOT = process.env.GDPR_REPO_DIR || process.cwd();
const MAX_FILE = Number(process.env.GDPR_MAX_FILE_KB || 512) * 1024;
const MAX_FILES = Number(process.env.GDPR_MAX_FILES || 8000);
const MAX_DOC = Number(process.env.GDPR_MAX_DOC_CHARS || 60000);
const errors = [];

const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".cache", ".turbo", "bin", "obj"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rb", ".php", ".java", ".kt", ".cs", ".rs", ".sql", ".json", ".yaml", ".yml", ".toml", ".env", ".ini", ".cfg", ".conf", ".md", ".txt", ".html", ".vue", ".svelte", ".tf", ".sh", ".xml", ".gradle", ".properties", ".prisma", ""]);

const files = []; // { rel, abs, text }
let scannedDirs = 0;
function isTexty(name) {
  const e = extname(name).toLowerCase();
  if (TEXT_EXT.has(e)) return true;
  return e === "" && /^(\.env|dockerfile|gemfile|procfile|makefile)/i.test(name);
}
function walk(dir) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`readdir ${dir}: ${e.message}`);
    return;
  }
  scannedDirs++;
  for (const ent of entries) {
    if (files.length >= MAX_FILES) return;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      // skip noise dirs and hidden dirs, except a small allowlist (.github/.gitlab CI configs).
      if (SKIP_DIR.has(ent.name)) continue;
      if (ent.name.startsWith(".") && !/^\.(github|gitlab)$/i.test(ent.name)) continue;
      walk(abs);
    } else if (ent.isFile()) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (!isTexty(ent.name)) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE) {
        files.push({ rel, abs, text: "" }); // recorded but not grepped
        continue;
      }
      let text = "";
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (/\u0000/.test(text)) continue; // binary file (NUL byte present)
      files.push({ rel, abs, text });
    }
  }
}
walk(ROOT);

// ---------- doc presence ----------
function findDoc(re) {
  const hit = files.find((f) => re.test(basename(f.rel)) || re.test(f.rel));
  return hit ? hit.rel : null;
}
const docs = {
  privacy: findDoc(/privacy|datenschutz|informativa[-_ ]?privacy/i),
  ropa: findDoc(/ropa|records?[-_ ]of[-_ ]processing|data[-_ ]inventory|data[-_ ]map|processing[-_ ]register/i),
  dpa: findDoc(/\bdpa\b|data[-_ ]processing[-_ ]agreement|sub[-_ ]?processors?/i),
  dpia: findDoc(/\bdpia\b|impact[-_ ]assessment|\bpia\b/i),
  security: findDoc(/^security\.(md|txt)$/i),
  incident: findDoc(/incident|breach.?(response|runbook|plan)/i),
  readme: findDoc(/^readme\.(md|txt|rst)$/i),
};
if (docs.privacy) {
  const f = files.find((x) => x.rel === docs.privacy);
  docs.privacy = { path: docs.privacy, text: (f?.text || "").slice(0, MAX_DOC) };
}

// ---------- dependencies ----------
const deps = new Set();
const manifests = [];
const lockfiles = [];
function rd(p) {
  const f = files.find((x) => x.rel === p || basename(x.rel) === p);
  return f?.text ?? null;
}
function addAll(arr) {
  for (const d of arr) if (d) deps.add(String(d).toLowerCase());
}
for (const f of files) {
  const b = basename(f.rel).toLowerCase();
  if (b === "package.json" && !f.rel.includes("/")) {
    manifests.push(f.rel);
    try {
      const pj = JSON.parse(f.text);
      addAll(Object.keys(pj.dependencies || {}));
      addAll(Object.keys(pj.devDependencies || {}));
      addAll(Object.keys(pj.peerDependencies || {}));
      addAll(Object.keys(pj.optionalDependencies || {}));
    } catch {
      errors.push(`parse ${f.rel}`);
    }
  } else if (b === "requirements.txt") {
    manifests.push(f.rel);
    addAll(f.text.split(/\r?\n/).map((l) => (l.match(/^\s*([A-Za-z0-9_.-]+)/) || [])[1]));
  } else if (b === "pyproject.toml") {
    manifests.push(f.rel);
    addAll([...f.text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]));
  } else if (b === "go.mod") {
    manifests.push(f.rel);
    addAll([...f.text.matchAll(/^\s*([\w.\/-]+)\s+v\d/gm)].map((m) => m[1].split("/").pop()));
  } else if (b === "composer.json") {
    manifests.push(f.rel);
    try {
      const cj = JSON.parse(f.text);
      addAll(Object.keys(cj.require || {}));
      addAll(Object.keys(cj["require-dev"] || {}));
    } catch {
      /* ignore */
    }
  } else if (b === "gemfile") {
    manifests.push(f.rel);
    addAll([...f.text.matchAll(/gem\s+['"]([^'"]+)['"]/g)].map((m) => m[1]));
  }
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum|gemfile\.lock|composer\.lock|requirements\.lock)$/i.test(b)) lockfiles.push(f.rel);
}
const depList = [...deps];
const matchDeps = (re) => depList.filter((d) => re.test(d));
const depClass = {
  manifests,
  lockfiles,
  count: depList.length,
  trackers: matchDeps(/google-?analytics|react-ga|gtag|segment|mixpanel|amplitude|sentry|posthog|hotjar|fullstory|facebook-?pixel|fbq|mouseflow|\bheap\b|matomo|clarity/i),
  cmp: matchDeps(/cookiebot|onetrust|klaro|cookieconsent|cookie-consent|usercentrics|didomi|cookieyes|cookiehub|termly|tarteaucitron/i),
  processors: matchDeps(/stripe|twilio|sendgrid|mailchimp|mailgun|auth0|firebase|intercom|hubspot|datadog|dd-trace|aws-sdk|@aws-sdk|google-cloud|@azure|openai|anthropic|cloudinary|algolia|braze/i),
  strong_hashing: matchDeps(/bcrypt|argon2|scrypt|@node-rs\/(bcrypt|argon2)|passlib/i),
};

// ---------- code pattern grep ----------
function grep(re, { cap = 25, files: subset = files } = {}) {
  const out = [];
  for (const f of subset) {
    if (!f.text) continue;
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ file: f.rel, line: i + 1, snippet: lines[i].trim().slice(0, 160) });
        if (out.length >= cap) return out;
      }
      re.lastIndex = 0;
    }
  }
  return out;
}
function present(re) {
  return files.some((f) => f.text && re.test(f.text));
}
function distinct(re, { cap = 40 } = {}) {
  const seen = new Map();
  for (const f of files) {
    if (!f.text) continue;
    for (const m of f.text.matchAll(re)) {
      const tok = (m[1] || m[0]).toLowerCase();
      if (!seen.has(tok)) seen.set(tok, f.rel);
      if (seen.size >= cap) break;
    }
    if (seen.size >= cap) break;
  }
  return [...seen].map(([token, file]) => ({ token, file }));
}

// committed .env files (not example/sample/template)
const envFiles = files.filter((f) => /(^|\/)\.env(\.\w+)?$/.test(f.rel) && !/\.(example|sample|template|dist|local\.example)$/i.test(f.rel)).map((f) => f.rel);
const secrets = [];
for (const e of envFiles) secrets.push({ file: e, kind: "committed .env file", snippet: "" });
for (const m of grep(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, { cap: 10 })) secrets.push({ ...m, kind: "private key block" });
for (const m of grep(/AKIA[0-9A-Z]{16}/, { cap: 10 })) secrets.push({ ...m, kind: "AWS access key id" });
for (const m of grep(/\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][^'"\n]{12,}['"]/i, { cap: 20 }))
  if (!/process\.env|os\.environ|getenv|example|placeholder|xxxx|<.*>|your[_-]?/i.test(m.snippet)) secrets.push({ ...m, kind: "hardcoded credential" });
for (const f of files) if (/\.(pem|key)$/i.test(f.rel) && !/public/i.test(f.rel)) secrets.push({ file: f.rel, kind: "key file", snippet: "" });

const scan = {
  repo_dir: ROOT,
  scanned_at: new Date().toISOString(),
  files_scanned: files.length,
  dirs_scanned: scannedDirs,
  docs,
  deps: depClass,
  secrets: secrets.slice(0, 40),
  weak_hashing: grep(/createHash\(\s*['"](md5|sha1)['"]|\b(md5|sha1)\s*\(.*pass|password.*\b(md5|sha1)\b/i, { cap: 20 }),
  strong_hashing_present: depClass.strong_hashing.length > 0 || present(/\b(bcrypt|argon2|scrypt)\b/i),
  pii_in_logs: grep(/(console\.(log|info|warn|error|debug)|logger\.(log|info|warn|error|debug)|fmt\.Print\w*|System\.out\.print\w*)\s*\([^)\n]*\b(e?mail|password|passwd|ssn|social.?security|credit.?card|cvv|phone|first.?name|last.?name|api.?key|token|secret)\b/i, { cap: 25 }),
  cookies: (() => {
    const setters = files.filter((f) => f.text && /res\.cookie|setcookie|set_cookie|set-cookie|cookies?\.set|new Cookie\(/i.test(f.text));
    const joined = setters.map((f) => f.text).join("\n");
    return { setting_files: setters.map((f) => f.rel).slice(0, 20), httpOnly: /httponly/i.test(joined), secure: /\bsecure\b\s*[:=]\s*true|secure;|\bSecure\b/i.test(joined), sameSite: /samesite/i.test(joined) };
  })(),
  pii_fields: distinct(/\b(email|e_mail|phone|mobile|first_?name|last_?name|full_?name|address|city|postal_?code|zip|date_?of_?birth|dob|ssn|national_?id|passport|ip_?address|geolocation|latitude|longitude|gender)\b/gi),
  special_category: distinct(/\b(health|medical|diagnosis|biometric|fingerprint|ethnicity|\brace\b|religion|religious|sexual_?orientation|genetic|political_?(opinion|affiliation)|trade_?union)\b/gi),
  dsr: {
    export: grep(/export.?(my)?.?data|data.?export|download.?(my)?.?data|portability|gdpr.?export|takeout/i, { cap: 15 }),
    delete: grep(/delete.?account|account.?deletion|right.?to.?be.?forgotten|gdpr.?(delete|erase)|erase.?(user|data)|purge.?user|forget.?me|anonymi[sz]e.?user/i, { cap: 15 }),
  },
  retention: grep(/\bttl\b|expires?(_?at|_?in)|retention|\bpurge\b|cleanup.?(job|task)|scheduled.?deletion|data.?retention|auto.?delete/i, { cap: 20 }),
  age_gate: grep(/age.?gate|minimum.?age|parental.?consent|\bcoppa\b|verify.?age|under.?(13|16)/i, { cap: 10 }),
  cloud_regions: distinct(/\b(us-east-\d|us-west-\d|ca-central-\d|sa-east-\d|ap-(south|southeast|northeast|east)-\d|us-central\d|northamerica-|asia-|australia-|eastus|westus\d?|centralus|southcentralus)\b/gi),
  dpo_contact: grep(/dpo@|privacy@|data.?protection.?officer/i, { cap: 10 }),
  tls_enforcement: grep(/forcessl|require.?ssl|\bhsts\b|strict-transport-security|helmet\(|https\.createserver|trust.?proxy.*secure|NODE_TLS|sslmode=require/i, { cap: 10 }),
  errors,
};

process.stdout.write(JSON.stringify(scan, null, 2));
