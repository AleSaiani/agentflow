#!/usr/bin/env node
/**
 * Stage-1 load for the remediate workflow. Normalizes a fix source into a /foreach items array — one
 * item per thing to fix — and **types** each finding (code | test | sample | doc) so a code-fix run
 * doesn't pay tokens to read items it would skip. Sources (first present wins): a findings JSON array,
 * or a markdown `- [ ]` checklist. Deterministic; the LLM only applies the fixes downstream. Node only.
 *
 * Env: REMEDIATE_FINDINGS (json array of {file, rule_id?, severity?, note?, suggestion?, type?}),
 *   REMEDIATE_CHECKLIST (markdown checklist path), REMEDIATE_MIN_SEVERITY (info|minor|major|critical,
 *   default minor), REMEDIATE_TYPES (comma list to keep; default "code" — set "" to keep all).
 */
import { existsSync, readFileSync } from "node:fs";

const RANK = { info: 0, minor: 1, major: 2, critical: 3 };
const minSev = (process.env.REMEDIATE_MIN_SEVERITY || "minor").toLowerCase();
const minRank = RANK[minSev] ?? RANK.minor;
const typesRaw = process.env.REMEDIATE_TYPES ?? "code";
const keepTypes = typesRaw.trim() ? new Set(typesRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) : null; // null = keep all
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "item";

/** Classify a finding by its file path: test | sample | doc | code (the default). */
function classifyType(file) {
  if (!file) return "code";
  const f = String(file).toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f) || /tests?\.[a-z]+$/.test(f)) return "test";
  if (/(^|\/)(samples?|examples?|demos?|playground)\//.test(f)) return "sample";
  if (/\.(md|mdx|rst|txt|adoc)$/.test(f) || /(^|\/)docs?\//.test(f)) return "doc";
  return "code";
}

const items = [];
const findingsPath = process.env.REMEDIATE_FINDINGS;
const checklistPath = process.env.REMEDIATE_CHECKLIST;
let skippedByType = 0;

function push(id, data) {
  const type = data.type || classifyType(data.file);
  if (keepTypes && !keepTypes.has(type)) {
    skippedByType++;
    return;
  }
  items.push({ id, data: { ...data, type, disposition: "open" } });
}

if (findingsPath && existsSync(findingsPath)) {
  let arr = [];
  try {
    const parsed = JSON.parse(readFileSync(findingsPath, "utf8"));
    arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    process.stderr.write("load: findings file is not valid JSON\n");
  }
  let i = 0;
  for (const f of arr) {
    const sev = (f.severity || "minor").toLowerCase();
    if ((RANK[sev] ?? RANK.minor) < minRank) continue;
    const instruction = [f.note || f.message || "", f.suggestion ? `Suggested fix: ${f.suggestion}` : ""].filter(Boolean).join(" ");
    push(`${slug(f.file || "fix")}-${slug(f.rule_id || i)}`, { file: f.file ?? null, rule_id: f.rule_id ?? null, severity: sev, type: f.type, instruction });
    i++;
  }
} else if (checklistPath && existsSync(checklistPath)) {
  const lines = readFileSync(checklistPath, "utf8").split(/\r?\n/);
  // Typed-marker mode: if ANY line carries a `<!-- deferred: <type> -->` or `<!-- skipped: ... -->`
  // comment (the disposition annotations a reconciliation pass writes), treat the file as typed —
  // only keep `- [ ]` lines that have `<!-- deferred: <type> -->` whose <type> is in keepTypes.
  // Untyped checklists (no markers anywhere) keep the legacy "every `- [ ]` is fair game" behavior.
  const hasTypedMarkers = lines.some((l) => /<!--\s*(deferred|skipped):/i.test(l));
  let i = 0;
  for (const line of lines) {
    const m = /^\s*-\s*\[\s\]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    let explicitType = null;
    if (hasTypedMarkers) {
      const tag = /<!--\s*deferred:\s*([a-z]+)/i.exec(line);
      if (!tag) continue; // skip "- [ ]" without a deferred marker (skipped/reconcile/no-marker)
      explicitType = tag[1].toLowerCase();
    }
    const text = m[1].replace(/<!--.*?-->/g, "").trim();
    const fileGuess = (text.match(/[\w./-]+\.[a-z]{1,5}\b/i) || [])[0] || null;
    push(`task-${i}-${slug(text)}`, { file: fileGuess, rule_id: null, severity: "minor", type: explicitType, instruction: text });
    i++;
  }
} else {
  process.stderr.write("load: provide REMEDIATE_FINDINGS or REMEDIATE_CHECKLIST\n");
}

if (skippedByType) process.stderr.write(`load: ${skippedByType} item(s) filtered out by type (keeping: ${[...(keepTypes ?? [])].join(",") || "all"})\n`);
process.stdout.write(JSON.stringify(items, null, 2));
