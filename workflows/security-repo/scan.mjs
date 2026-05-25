#!/usr/bin/env node
/**
 * Stage-1 scanner for the security-repo workflow (deterministic SAST-lite). Walks a repository and
 * grep-detects insecure code patterns, committed secrets, dependency hygiene and container hardening.
 * Node builtins only, zero deps. Emits scan.json that the deterministic evaluator reads. No LLM.
 *
 * Static source analysis: it sees committed code/config, not runtime behaviour. Heuristic pattern
 * matches are signals for review, not proof of exploitability.
 *
 * Env: SECREPO_DIR (default cwd), SECREPO_MAX_FILE_KB (default 512), SECREPO_MAX_FILES (default 8000).
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, extname, basename } from "node:path";

const ROOT = process.env.SECREPO_DIR || process.cwd();
const MAX_FILE = Number(process.env.SECREPO_MAX_FILE_KB || 512) * 1024;
const MAX_FILES = Number(process.env.SECREPO_MAX_FILES || 8000);
const errors = [];
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".cache", ".turbo", "bin", "obj"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rb", ".php", ".java", ".kt", ".cs", ".rs", ".sql", ".json", ".yaml", ".yml", ".toml", ".env", ".ini", ".cfg", ".conf", ".sh", ".html", ".vue", ".svelte", ".tf", ".xml", ".gradle", ".properties", ""]);

const files = [];
function isTexty(name) {
  const e = extname(name).toLowerCase();
  if (TEXT_EXT.has(e)) return true;
  return e === "" && /^(\.env|dockerfile|gemfile|procfile|makefile)/i.test(name);
}
function walk(dir) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { errors.push(`readdir ${dir}: ${e.message}`); return; }
  for (const ent of entries) {
    if (files.length >= MAX_FILES) return;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      if (ent.name.startsWith(".") && !/^\.(github|gitlab)$/i.test(ent.name)) continue;
      walk(abs);
    } else if (ent.isFile()) {
      if (!isTexty(ent.name)) continue;
      const rel = relative(ROOT, abs).split(sep).join("/");
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE) { files.push({ rel, text: "" }); continue; }
      let text = ""; try { text = readFileSync(abs, "utf8"); } catch { continue; }
      if (text.includes(String.fromCharCode(0))) continue; // binary file (NUL byte present)
      files.push({ rel, text });
    }
  }
}
walk(ROOT);

function grep(re, cap = 25) {
  const out = [];
  for (const f of files) {
    if (!f.text) continue;
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) && !/(example|sample|placeholder|TODO|test fixture|@ts-expect|eslint-disable)/i.test(lines[i])) {
        out.push({ file: f.rel, line: i + 1, snippet: lines[i].trim().slice(0, 160) });
        if (out.length >= cap) return out;
      }
      re.lastIndex = 0;
    }
  }
  return out;
}
function present(re) { return files.some((f) => f.text && re.test(f.text)); }

// committed secret material
const envFiles = files.filter((f) => /(^|\/)\.env(\.\w+)?$/.test(f.rel) && !/\.(example|sample|template|dist)$/i.test(f.rel)).map((f) => f.rel);
const secrets = envFiles.map((e) => ({ file: e, line: 0, kind: "committed .env" }));
for (const m of grep(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 10)) secrets.push({ ...m, kind: "private key block" });
for (const m of grep(/AKIA[0-9A-Z]{16}/, 10)) secrets.push({ ...m, kind: "AWS access key id" });
for (const m of grep(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"\n]{12,}['"]/i, 20))
  if (!/process\.env|os\.environ|getenv|import\.meta|<.*>|your[_-]?|xxxx/i.test(m.snippet)) secrets.push({ ...m, kind: "hardcoded credential" });
for (const f of files) if (/\.(pem|key)$/i.test(f.rel) && !/public/i.test(f.rel)) secrets.push({ file: f.rel, line: 0, kind: "key file" });

// dependency lockfiles / manifests
const lockfiles = files.filter((f) => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum|gemfile\.lock|composer\.lock)$/i.test(basename(f.rel))).map((f) => f.rel);
const manifests = files.filter((f) => /^(package\.json|requirements\.txt|pyproject\.toml|go\.mod|composer\.json|gemfile)$/i.test(basename(f.rel))).map((f) => f.rel);

// Dockerfiles
const dockerfiles = files.filter((f) => /(^|\/)dockerfile(\.\w+)?$/i.test(f.rel));
const docker = dockerfiles.map((f) => {
  const t = f.text || "";
  const froms = [...t.matchAll(/^\s*FROM\s+(\S+)/gim)].map((m) => m[1]);
  return {
    file: f.rel,
    has_user: /^\s*USER\s+(?!root\b)\S+/im.test(t),
    runs_root: /^\s*USER\s+root\b/im.test(t) || !/^\s*USER\s+/im.test(t),
    unpinned: froms.filter((x) => /:latest$/i.test(x) || !/:/.test(x.replace(/@sha256:.*/, "@"))),
    froms,
  };
});

const scan = {
  repo_dir: ROOT,
  scanned_at: new Date().toISOString(),
  files_scanned: files.length,
  secrets: secrets.slice(0, 40),
  weak_hashing: grep(/createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\s*\(|MessageDigest\.getInstance\(\s*['"](MD5|SHA-1)['"]/i, 20),
  strong_hashing_present: present(/\b(bcrypt|argon2|scrypt|pbkdf2)\b/i),
  insecure_random: grep(/(Math\.random|random\.random|rand\(\)).{0,40}(token|password|secret|otp|nonce|salt|session|api[_-]?key)|(token|password|secret|otp|nonce|salt|session).{0,20}(Math\.random|random\.random)/i, 15),
  sql_injection: grep(/(query|execute|raw)\s*\(\s*[`"'][^`"']*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`"']*(\$\{|["'`]\s*\+|%s|%d|f["'])/i, 20),
  command_injection: grep(/(child_process|exec|execSync|spawnSync?|os\.system|subprocess\.(call|run|Popen)|popen|Runtime\.getRuntime\(\)\.exec)\s*\([^)\n]*(\$\{|`|["']\s*\+|%s|f["'])/i, 20),
  dynamic_eval: grep(/\beval\s*\(|new Function\s*\(|\bexec\s*\(\s*[a-z_]/i, 15),
  insecure_deserialization: grep(/pickle\.loads|yaml\.load\s*\((?![^)]*Loader)|Marshal\.load|ObjectInputStream|unserialize\s*\(|cPickle/i, 15),
  xss_sinks: grep(/\.innerHTML\s*=|dangerouslySetInnerHTML|v-html|render_template_string|document\.write\s*\(|\|\s*safe\b/i, 20),
  tls_verification_disabled: grep(/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)/i, 15),
  permissive_cors: grep(/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|cors\(\s*\{[^}]*origin\s*:\s*(true|['"]\*)|cors\(\s*\)/i, 15),
  debug_mode: grep(/DEBUG\s*=\s*True\b|app\.debug\s*=\s*True|FLASK_DEBUG\s*=\s*1|app\.run\([^)]*debug\s*=\s*True|["']?debug["']?\s*[:=]\s*true/i, 15),
  default_credentials: grep(/(password|passwd|pwd)\s*[:=]\s*['"](admin|password|123456|changeme|root|test|secret|letmein)['"]/i, 15),
  sensitive_in_logs: grep(/(console\.(log|info|warn|error|debug)|logger\.\w+|print|System\.out\.print\w*)\s*\([^)\n]*\b(password|passwd|ssn|credit.?card|cvv|api[_-]?key|secret|token)\b/i, 20),
  deps: { manifests, lockfiles },
  docker,
  errors,
};

process.stdout.write(JSON.stringify(scan, null, 2));
