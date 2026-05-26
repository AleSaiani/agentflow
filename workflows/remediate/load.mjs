#!/usr/bin/env node
/**
 * Stage-1 load for the remediate workflow. Normalizes a fix source into a /foreach items array — one
 * item per thing to fix. Sources (first present wins): a findings JSON array (e.g. from a review), or a
 * markdown `- [ ]` checklist. Deterministic; the LLM only applies the fixes downstream. Node builtins only.
 *
 * Env: REMEDIATE_FINDINGS (json array of {file, rule_id?, severity?, note?, suggestion?}),
 *   REMEDIATE_CHECKLIST (markdown checklist path), REMEDIATE_MIN_SEVERITY (info|minor|major|critical,
 *   default minor — filters findings).
 */
import { existsSync, readFileSync } from "node:fs";

const RANK = { info: 0, minor: 1, major: 2, critical: 3 };
const minSev = (process.env.REMEDIATE_MIN_SEVERITY || "minor").toLowerCase();
const minRank = RANK[minSev] ?? RANK.minor;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "item";

const items = [];

const findingsPath = process.env.REMEDIATE_FINDINGS;
const checklistPath = process.env.REMEDIATE_CHECKLIST;

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
    items.push({ id: `${slug(f.file || "fix")}-${slug(f.rule_id || i)}`, data: { file: f.file ?? null, rule_id: f.rule_id ?? null, severity: sev, instruction } });
    i++;
  }
} else if (checklistPath && existsSync(checklistPath)) {
  const lines = readFileSync(checklistPath, "utf8").split(/\r?\n/);
  let i = 0;
  for (const line of lines) {
    const m = /^\s*-\s*\[\s\]\s+(.*\S)\s*$/.exec(line); // unchecked items only
    if (!m) continue;
    items.push({ id: `task-${i}-${slug(m[1])}`, data: { file: null, rule_id: null, severity: "minor", instruction: m[1] } });
    i++;
  }
} else {
  process.stderr.write("load: provide REMEDIATE_FINDINGS or REMEDIATE_CHECKLIST\n");
}

process.stdout.write(JSON.stringify(items, null, 2));
