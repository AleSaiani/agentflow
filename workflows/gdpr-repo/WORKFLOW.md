---
name: gdpr-repo
description: Enterprise GDPR audit of a source repository, from the inside — deterministic repo scan (files, dependencies, code patterns) → code-decided technical checks → one bounded schema-grounded LLM judgment over found documents and code → a self-contained HTML report. Checklist mapped to GDPR and ePrivacy articles (privacy-by-design, Art.32 security, records, DSR mechanisms, transfers). Self-contained; the only input is the repo path.
params:
  repo: { default: ".", description: "Path to the repository to audit (default: current directory)" }
  report_out: { default: "", description: "HTML report path (default ./gdpr-repo-report-<name>-<date>.html in cwd)" }
config: { context_policy: summary, max_auto_continues: 30, max_stages: 12, stop_on_failure: true }
---

# GDPR repo audit

A five-stage pipeline, the internal-observer twin of `gdpr-domain`. Code scans the repo and decides
every code-observable check the same way every time; one LLM step judges only the prose of found
documents and code excerpts (schema-validated); code rolls everything up into the verdict and report.
It sees what is **committed** — not production runtime nor signed contracts (those are `manual` checks).

## 1. scan · bash
Walk the repo: doc presence, dependency processors/trackers/CMP, and code patterns (secrets, hashing,
PII in logs, cookie flags, PII/special-category fields, DSR handlers, retention, non-EEA regions, DPO).
```sh
GDPR_REPO_DIR={{params.repo|shell}} node "{{workflow.dir}}/scan.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/scan.json

## 2. evaluate · bash
Decide every `decision_mode:"auto"` check with pure rules over the scan — no LLM, fully reproducible.
```sh
GDPR_SCAN="{{stages.scan.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/evaluate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/code-verdicts.json

## 3. build-assess · bash
Assemble the LLM input: the found privacy notice + repo signals + the relevant code excerpts + the notice/code-reading checks.
```sh
GDPR_SCAN="{{stages.scan.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/build-assess.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/assess-input.json

## 4. assess · step
One bounded judgment over the found documents/code: classify each `decision_mode:"llm"` check, quoting evidence.
The prompt fixes the output to a strict JSON array (one verdict per check id); report.mjs re-validates it.
- runtime: subagent
- model: sonnet
- subagent-type: general-purpose
- input: {{stages.build-assess.result_pointer}}
- prompt-file: {{workflow.dir}}/assess-prompt.md
- max-auto-continues: 3

## 5. report · bash
Merge code + LLM + manual verdicts, validate completeness (no check may be silently dropped), compute
the rollup verdict, and write the self-contained HTML report + a machine-readable summary.
```sh
GDPR_REPO_DIR={{params.repo|shell}} GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" GDPR_SCAN="{{stages.scan.result_pointer}}" GDPR_CODE_VERDICTS="{{stages.evaluate.result_pointer}}" GDPR_LLM_VERDICTS="{{stages.assess.result_pointer}}" GDPR_REPORT_OUT="{{params.report_out}}" node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
