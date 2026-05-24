---
name: audit
description: Deep code audit — discover files → per-file LLM review (cached) → partition by component → executive digest. Self-contained (discover.mjs lives alongside, called via {{workflow.dir}}); per-invocation inputs are params. Compiles 1:1 into pipe stages — no new engine.
params:
  target: { required: true, description: Directory to audit }
  glob: { default: "**/*", description: Comma-separated globs to include }
  exclude: { default: "", description: Comma-separated globs to exclude }
config: { context_policy: summary, max_auto_continues: 50, max_stages: 20, stop_on_failure: true }
---

# Audit

A six-stage pipeline. Edit a model or the group depth below and re-run; copy this whole folder to
reuse it in another project.

## 1. discover · bash
Walk the target, match the globs, emit a foreach-compatible items array (each with a content_hash).
```sh
AUDIT_TARGET={{params.target|shell}} AUDIT_GLOB={{params.glob|shell}} AUDIT_EXCLUDE={{params.exclude|shell}} node "{{workflow.dir}}/discover.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/files.json

## 2. review · foreach
Review each file (cached, so unchanged files are skipped on re-runs).
- items: {{stages.discover.result_pointer}}
- task-prompt: Code review of the file at `data.path`. Per-file rules and the output schema are applied via --kind code-review.
- kind: code-review
- cache: true
- model: sonnet
- concurrency: 4
- chunk-size: auto
- max-retries: 1
- max-auto-continues: 20

## 3. build-group-input · json
Materialize a run-reference the partition stage can read.
- value: { "source": "run", "cmd": "foreach", "run_id": "{{stages.review.run_id}}" }
- output_path: {{run.dir}}/group-input.json

## 4. partition · group
Group the reviewed files by top-level component (path prefix, depth 1).
- method: path-prefix
- method-config: {"depth": 1}
- input-source: {{stages.build-group-input.result_pointer}}
- max-auto-continues: 5

## 5. build-digest-inputs · json
Bundle the per-file reviews + the partition for the digest agent.
```json
[ { "source": "run", "cmd": "foreach", "run_id": "{{stages.review.run_id}}" },
  { "source": "file", "path": "{{stages.partition.result_pointer}}" } ]
```
- output_path: {{run.dir}}/digest-inputs.json

## 6. digest · reduce
Synthesize one executive digest.
- inputs: {{stages.build-digest-inputs.result_pointer}}
- task-prompt: Synthesize an executive code-audit digest. Sections: (1) Severity rollup, (2) Per-component breakdown using the groups partition, (3) Top-5 hotspot files, (4) Recurring patterns (3-5 named), (5) Clean files. Output: markdown.
- model: opus
- output-format: markdown
- max-auto-continues: 5
