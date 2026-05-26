#!/usr/bin/env node
/**
 * Stage-4 validate for knowledge-build. Takes the LLM plan ({schema, entities}) and the deterministic
 * file census, and GUARANTEES coverage: every walked code file must belong to ≥1 entity — any the model
 * missed are swept into an `_unclassified` entity, so nothing is silently dropped (the determinism the
 * workflow adds). Materializes schema.json + the entities census (the /foreach items the document stage
 * consumes). In update mode, only entities touching a changed file are emitted for re-documentation.
 * Node builtins only.
 *
 * Env: KB_CONFIG (resolve output), KB_PLAN (LLM plan step output), KB_FILES (walk output).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const cfg = JSON.parse(readFileSync(process.env.KB_CONFIG, "utf8"));
const walk = JSON.parse(readFileSync(process.env.KB_FILES, "utf8"));
let plan = {};
try {
  plan = JSON.parse(readFileSync(process.env.KB_PLAN, "utf8"));
} catch {
  process.stderr.write("validate: plan output is not valid JSON; using an empty plan (all files → _unclassified)\n");
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "entity";
const hashOf = (parts) => createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16);

const fileMeta = new Map(walk.files.map((f) => [f.rel, f]));
const assigned = new Set();
const entitiesRaw = Array.isArray(plan.entities) ? plan.entities : [];
const entities = [];

for (const e of entitiesRaw) {
  const files = (Array.isArray(e.files) ? e.files : []).filter((f) => fileMeta.has(f));
  for (const f of files) assigned.add(f);
  const area = slug(e.area || (e.kind === "domain" ? "domains" : "code"));
  const id = slug(e.id || e.name || "entity");
  entities.push({
    id,
    kind: e.kind === "domain" ? "domain" : "code",
    area,
    summary: typeof e.summary === "string" ? e.summary : "",
    files,
  });
}

// Coverage guarantee: sweep any unassigned code file into a catch-all entity.
const leftover = walk.files.map((f) => f.rel).filter((r) => !assigned.has(r));
if (leftover.length) {
  entities.push({ id: "unclassified", kind: "code", area: "_unclassified", summary: "Files the plan did not assign — review and reclassify.", files: leftover });
}

const outDir = cfg.out_dir;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "schema.json"), JSON.stringify(plan.schema ?? { note: "no schema proposed", sections: ["Purpose", "Public API", "Key invariants", "Dependencies", "Risks"] }, null, 2), "utf8");

// Build the /foreach items; in update mode keep only entities that touch a changed file.
const items = [];
for (const e of entities) {
  const hashes = e.files.map((f) => fileMeta.get(f)?.hash ?? "0");
  const changed = e.files.some((f) => fileMeta.get(f)?.changed);
  if (cfg.mode === "update" && !changed) continue;
  const docPath = join(outDir, e.area, `${e.id}.md`).split("\\").join("/");
  items.push({ id: `${e.area}/${e.id}`, data: { entity_id: e.id, kind: e.kind, area: e.area, summary: e.summary, files: e.files, content_hash: hashOf(hashes), doc_path: docPath } });
}

// The stdout IS the /foreach items array (becomes this stage's result_pointer); also kept as an artifact.
writeFileSync(join(outDir, "entities.json"), JSON.stringify(items, null, 2), "utf8");
process.stderr.write(`validate: ${walk.files.length} files covered · ${entities.length} entities · ${leftover.length} unclassified · ${items.length} to document (${cfg.mode})\n`);
process.stdout.write(JSON.stringify(items, null, 2));
