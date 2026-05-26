---
name: pr-review
description: >
  Adaptive, diff-scoped code review. Discover what a PR/branch changes (plus the files that reference
  it), detect each file's stack, apply the matching lenses through a cascade (shipped → org → project,
  additive + override), review every file against its resolved rules, then a deterministic rollup + gate
  and a PR-comment-ready report. The set is exhaustive (every changed + related file); the verdict is
  decided by code over the findings' severities. Self-contained; scripts live alongside via {{workflow.dir}}.
params:
  repo:       { default: ".",   description: "Path to the repository to review" }
  base:       { default: "",    description: "Base ref to diff against (default: auto — origin/main, main, …)" }
  head:       { default: "HEAD", description: "Head ref (default HEAD)" }
  related:    { default: "1",   description: "Also review files that reference the changed ones (0 to disable)" }
  rules:      { default: "",    description: "Team-rules JSON path (default: <repo>/.agentflow/review-rules.json)" }
  gate:       { default: "major", description: "Block at/above this severity: info | minor | major | critical" }
  report_out: { default: "./pr-review-report.md", description: "Markdown report path" }
config: { context_policy: summary, max_auto_continues: 50, max_stages: 20, stop_on_failure: true }
---

# PR review (adaptive, diff-scoped)

Four stages. Enumeration is deterministic (git + grep); the LLM judges each file against its resolved
rules; the gate is code over the structured severities. Copy this folder to customize, or drop team rules
in `<repo>/.agentflow/review-rules.json` (and stack overrides in `<repo>/.agentflow/lenses/<key>.json`).

## 1. discover · bash
Diff the base ref against head for changed files, then add files that reference them (importers/call-sites).
```sh
PRREVIEW_DIR={{params.repo|shell}} PRREVIEW_BASE={{params.base|shell}} PRREVIEW_HEAD={{params.head|shell}} PRREVIEW_RELATED={{params.related|shell}} node "{{workflow.dir}}/discover.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/changed.json

## 2. classify · bash
For each file: detect stack → resolve lenses through the cascade + always `security` + team rules; attach
the merged rule set. The output is the review items array (the materialized "census").
```sh
PRREVIEW_ITEMS="{{stages.discover.result_pointer}}" PRREVIEW_PROJECT={{params.repo|shell}} PRREVIEW_RULES={{params.rules|shell}} node "{{workflow.dir}}/classify.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/census.json

## 3. review · foreach
Review each file against its own `data.rules` (cached, so unchanged files are skipped on re-runs).
- items: {{stages.classify.result_pointer}}
- task-prompt: "Review the file at `data.path` for violations of the rules in `data.rules` (each rule has id, severity, guidance). Read the file. Report ONLY real, located violations — no style nits outside the rules. Output JSON exactly as {\"findings\":[{\"rule_id\":\"<rule id>\",\"severity\":\"<the rule's severity>\",\"line\":<line number or null>,\"note\":\"<what is wrong and why>\",\"suggestion\":\"<concrete fix or null>\"}]}. Empty findings array if the file is clean."
- cache: true
- model: sonnet
- concurrency: 4
- chunk-size: auto
- max-retries: 1
- max-auto-continues: 20

## 4. report · bash
Flatten findings, roll up by severity, decide the gate (block at/above `gate`), write the PR-comment report.
```sh
PRREVIEW_REVIEW_RUN="{{stages.review.run_id}}" PRREVIEW_CENSUS="{{stages.classify.result_pointer}}" PRREVIEW_GATE={{params.gate|shell}} PRREVIEW_OUT={{params.report_out|shell}} node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
