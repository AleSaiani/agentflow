#!/usr/bin/env node
/**
 * Stage-2 classify for pr-review (the materialized "census"). For each discovered file: detect its
 * stack (by extension), resolve the applicable lenses through the cascade (shipped → org → project),
 * always add the `security` lens and any team rules, and attach the merged rule set to the item. The
 * output IS the /foreach items array the review stage consumes — each item carries its own resolved
 * `data.rules`, so the review prompt is uniform while the rules adapt per file. Node builtins only.
 *
 * Env: PRREVIEW_ITEMS (required — discover output), PRREVIEW_PROJECT (repo dir, default cwd),
 *   PRREVIEW_RULES (optional team-rules file path; else <project>/.agentflow/review-rules.json),
 *   AGENTFLOW_LENSES (optional org lens dir).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectStack, resolveLens, loadRuleFile } from "./lenses.mjs";

const itemsPath = process.env.PRREVIEW_ITEMS;
if (!itemsPath || !existsSync(itemsPath)) {
  process.stderr.write("classify: PRREVIEW_ITEMS (discover output) is required\n");
  process.exit(1);
}
const project = process.env.PRREVIEW_PROJECT || process.cwd();

// Cascade layers, lowest→highest precedence.
const shippedDir = join(dirname(fileURLToPath(import.meta.url)), "lenses");
const layerDirs = [shippedDir, process.env.AGENTFLOW_LENSES || null, join(project, ".agentflow", "lenses")];

// Team rules (always applied as the `team` lens): an explicit --param path, else the project default.
const teamRules = [];
for (const cand of [process.env.PRREVIEW_RULES, join(project, ".agentflow", "review-rules.json")]) {
  if (cand && existsSync(cand)) {
    teamRules.push(...loadRuleFile(cand));
    break;
  }
}

// Resolve concern lenses once (same for every file).
const securityRules = resolveLens("security", layerDirs);
const lensCache = new Map();
function stackRules(key) {
  if (!lensCache.has(key)) lensCache.set(key, resolveLens(key, layerDirs));
  return lensCache.get(key);
}

const items = JSON.parse(readFileSync(itemsPath, "utf8"));
const out = items.map((it) => {
  const rel = it.data?.rel_path || it.id;
  const stack = detectStack(rel);
  const lenses = [];
  const rules = [];
  if (stack) {
    const r = stackRules(stack);
    if (r.length) {
      lenses.push(stack);
      rules.push(...r);
    }
  }
  if (securityRules.length) {
    lenses.push("security");
    rules.push(...securityRules);
  }
  if (teamRules.length) {
    lenses.push("team");
    rules.push(...teamRules);
  }
  return { ...it, data: { ...it.data, stack: stack || "unknown", lenses, rules } };
});

process.stdout.write(JSON.stringify(out, null, 2));
