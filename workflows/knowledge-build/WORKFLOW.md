---
name: knowledge-build
description: >
  Turn a repository into structured markdown documentation (a folder tree of md files) the team owns.
  What it adds over "ask an LLM to document the code" is the determinism of covering EVERYTHING — every
  code file is accounted for (code enforces it; the LLM only groups/names) plus every domain concept —
  and LLM-derived relationships materialized as a deterministic list (the seed for a future graph DB).
  Two modes: `bootstrap` (full pass; records the git HEAD in a manifest) and `update` (diff since the
  recorded ref → re-document only the new/changed entities). Self-contained via {{workflow.dir}}.
params:
  repo:    { default: ".",            description: "Repository to document" }
  out_dir: { default: "docs/knowledge", description: "Output dir for the md tree + manifest" }
  mode:    { default: "bootstrap", enum: ["bootstrap", "update"], description: "Full pass vs incremental since the recorded ref" }
  ref:     { default: "",          description: "Override the base ref for update (default: the manifest's recorded ref)" }
config: { context_policy: summary, max_auto_continues: 80, max_stages: 20, stop_on_failure: true }
---

# knowledge-build

Seven stages. Enumeration of files is deterministic (a code walk is the source of truth for coverage); the
LLM proposes the schema, groups entities, writes the docs, and derives relations — every fuzzy output is
materialized to disk. `update` re-documents only what changed since the recorded commit.

## 1. resolve · bash
Decide mode; for git repos compute HEAD (bootstrap) or read the manifest ref + the changed file set (update).
```sh
KB_DIR={{params.repo|shell}} KB_MODE={{params.mode|shell}} KB_OUT={{params.out_dir|shell}} KB_REF={{params.ref|shell}} node "{{workflow.dir}}/resolve.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/config.json

## 2. walk · bash
Enumerate every code file (with a content hash) + the folder tree — the deterministic coverage baseline.
```sh
KB_CONFIG="{{stages.resolve.result_pointer}}" node "{{workflow.dir}}/walk.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/files.json

## 3. plan · step
Propose the documentation schema for THIS repo and group every file into entities (code + domain).
- runtime: subagent
- model: opus
- prompt: "Read the code-file census (with the folder tree) at the JSON file `{{stages.walk.result_pointer}}`. Design documentation for THIS repository. Output ONLY JSON: {\"schema\":{\"sections\":[\"<per-entity section names suited to this repo, e.g. Purpose, Public API, Key invariants, Dependencies, Risks>\"]},\"entities\":[{\"id\":\"<kebab id>\",\"kind\":\"code|domain\",\"area\":\"<top-level grouping/folder>\",\"summary\":\"<one line>\",\"files\":[\"<rel path>\"...]}]}. Rules: assign EVERY file in the census to at least one entity (code entities); ALSO add `domain` entities for cross-cutting features/concepts (their `files` are the code that implements them). Keep ids stable and kebab-case. Write the JSON to your output."

## 4. validate · bash
Guarantee coverage (sweep any unassigned file into `_unclassified`), materialize schema.json + the entities
census. The output IS the document stage's items array. In `update` mode, only changed entities are emitted.
```sh
KB_CONFIG="{{stages.resolve.result_pointer}}" KB_PLAN="{{stages.plan.result_pointer}}" KB_FILES="{{stages.walk.result_pointer}}" node "{{workflow.dir}}/validate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/entities.json

## 5. document · foreach
Write one structured md doc per entity into the tree (cached by entity content hash → unchanged entities skip).
- items: {{stages.validate.result_pointer}}
- task-prompt: "Document the entity described by this item's `data` (entity_id, kind, area, summary, files). Read its `data.files`. Following the section list in the schema at `{{params.out_dir}}/schema.json`, write a clear, structured markdown document to the path in `data.doc_path` (create parent dirs). Be specific and grounded in the code — no padding. Return JSON {\"doc_path\":\"<the path you wrote>\",\"title\":\"<short title>\"}."
- cache: true
- model: sonnet
- concurrency: 3
- chunk-size: auto
- max-retries: 1
- max-auto-continues: 30

## 6. relate · step
Derive relationships between entities, using a fixed vocabulary so the list stays deterministic + graph-ready.
- runtime: subagent
- model: sonnet
- prompt: "Read the entities census at `{{stages.validate.result_pointer}}` (each item's `id` is `area/entity_id`, with `data.files`). Derive relationships between entities using ONLY these kinds: depends-on, used-by, part-of, implements. Base them on imports/usages across `data.files`. Output ONLY JSON: {\"relations\":[{\"from\":\"<item id>\",\"to\":\"<item id>\",\"kind\":\"<one of the four>\"}]}. Write the JSON to your output."

## 7. finalize · bash
Build index.md (architecture map + links), render relations.md, write/advance the manifest (ref + hashes).
```sh
KB_CONFIG="{{stages.resolve.result_pointer}}" KB_ENTITIES="{{stages.validate.result_pointer}}" KB_RELATIONS="{{stages.relate.result_pointer}}" node "{{workflow.dir}}/finalize.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/build-summary.json
