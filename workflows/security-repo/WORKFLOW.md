---
name: security-repo
description: Fully-deterministic static security review of a source repository (SAST-lite, OWASP Top 10 / ASVS / CWE) — scan the code for insecure patterns, committed secrets, dependency hygiene and container hardening, decide every check in code, then a self-contained HTML report. No LLM in the loop, so the same source always yields the same verdicts. Self-contained; the only input is the repo path. Reflects committed code, not runtime behaviour; heuristic matches are signals for review.
params:
  repo: { default: ".", description: "Path to the repository to audit (default: current directory)" }
  report_out: { default: "", description: "HTML report path (default ./security-repo-report-<name>-<date>.html in cwd)" }
config: { context_policy: summary, max_auto_continues: 20, max_stages: 8, stop_on_failure: true }
---

# Source-repository security audit

Three deterministic stages — no LLM. Code scans the committed source (insecure patterns, secrets, deps,
containers), code decides every check, code renders the report. The internal-observer twin of
`security-domain`; pairs with `gdpr-repo` for a full repo compliance + security view.

## 1. scan · bash
Walk the repo and grep-detect SAST-lite signals: secrets, weak crypto, SQL/command injection, dynamic
eval, insecure deserialization, XSS sinks, disabled TLS verification, permissive CORS, debug mode,
default credentials, sensitive logging, dependency lockfiles and Dockerfile hardening.
```sh
SECREPO_DIR={{params.repo|shell}} node "{{workflow.dir}}/scan.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/scan.json

## 2. evaluate · bash
Decide every check with pure rules over the scan (high-confidence categories fail, heuristic ones warn).
```sh
SECREPO_SCAN="{{stages.scan.result_pointer}}" SECREPO_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/evaluate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/code-verdicts.json

## 3. report · bash
Merge + validate completeness + compute the rollup + write the self-contained HTML report and summary.
```sh
SECREPO_DIR={{params.repo|shell}} SECREPO_CHECKLIST="{{workflow.dir}}/checklist.json" SECREPO_SCAN="{{stages.scan.result_pointer}}" SECREPO_CODE_VERDICTS="{{stages.evaluate.result_pointer}}" SECREPO_REPORT_OUT="{{params.report_out}}" node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
