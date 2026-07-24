---
name: gdpr-domain
description: Enterprise GDPR/ePrivacy external audit of a public domain — deterministic evidence collection (HTTP, TLS, cookies, trackers, privacy notice) → code-decided technical checks → one bounded schema-grounded LLM judgment over the notice text → a self-contained HTML report. Checklist mapped to GDPR and ePrivacy Art.5(3) articles plus EDPB guidance. Self-contained; the only input is the domain.
params:
  domain: { required: true, description: "Domain to audit, e.g. example.com" }
  report_out: { default: "", description: "HTML report path (default ./gdpr-report-<domain>-<date>.html in cwd)" }
  browser: { default: "auto", description: "Live-browser pass for runtime banner checks: auto (use a Vercel/Playwright-MCP browser tool if available, else stay manual) | none (skip)" }
  dual: { default: "auto", description: "Adversarial second opinion on the LLM-judged checks: auto (use codex if installed, else skip) | none (skip) | codex-cli | claude-cli" }
config: { context_policy: summary, max_auto_continues: 30, max_stages: 12, stop_on_failure: true }
---

# GDPR domain audit

A five-stage pipeline. The determinism is the point: code gathers the evidence and decides every
technically-observable check the same way every time; a single LLM step judges only the prose of the
privacy notice (schema-validated, evidence-quoted); code rolls everything up into the verdict and
report. Copy this folder to reuse it anywhere.

## 1. collect · bash
Observe the domain from outside: first server response + headers, TLS, HTTP→HTTPS, landing HTML
(trackers, CMP, embeds, forms) and the linked privacy/cookie notice. Deterministic, Node builtins only.
```sh
GDPR_DOMAIN={{params.domain|shell}} node "{{workflow.dir}}/collect.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/evidence.json

## 2. evaluate · bash
Decide every `decision_mode:"auto"` check with pure rules over the evidence — no LLM, fully reproducible.
```sh
GDPR_EVIDENCE="{{stages.collect.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/evaluate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/code-verdicts.json

## 3. build-assess · bash
Assemble the input for the LLM step: the privacy-notice text + observed signals + the notice-reading checks.
```sh
GDPR_EVIDENCE="{{stages.collect.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/build-assess.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/assess-input.json

## 4. assess · step
One bounded judgment over the notice text: classify each `decision_mode:"llm"` check, quoting evidence.
The prompt fixes the output to a strict JSON array (one verdict per check id); report.mjs re-validates it.
- runtime: subagent
- model: sonnet
- subagent-type: general-purpose
- input: {{stages.build-assess.result_pointer}}
- prompt-file: {{workflow.dir}}/assess-prompt.md
- max-auto-continues: 3

## 5. build-dual-assess · bash
Assemble the input for the optional adversarial second opinion: the same evidence plus the first
model's verdicts, so a second model can dispute them. Skipped when `dual=none` or codex is absent.
- when: test {{params.dual|shell}} != none && { test {{params.dual|shell}} != auto || command -v codex >/dev/null 2>&1; }
```sh
GDPR_EVIDENCE="{{stages.collect.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" GDPR_LLM_VERDICTS="{{stages.assess.result_pointer}}" node "{{workflow.dir}}/build-dual-assess.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/dual-input.json

## 6. dual-assess · step
An INDEPENDENT model re-judges the same checks and agrees or disputes each first verdict. Runs
sessionlessly through the engine, so it is genuinely a different model — not the same one grading
itself. Skipped when `dual=none` or codex is absent.
- when: test {{params.dual|shell}} != none && { test {{params.dual|shell}} != auto || command -v codex >/dev/null 2>&1; }
- runtime: codex-cli
- input: {{stages.build-dual-assess.result_pointer}}
- prompt-file: {{workflow.dir}}/dual-prompt.md
- max-auto-continues: 3

## 7. build-browser-assess · bash
Assemble the input for the optional live-browser pass: the runtime banner/dark-pattern checks a static
fetch can't judge. Skipped when `browser=none`.
- when: test {{params.browser|shell}} != none
```sh
GDPR_EVIDENCE="{{stages.collect.result_pointer}}" GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/build-browser-assess.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/browser-input.json

## 8. browser-assess · step
Drive a real browser to decide the runtime checks. The agent prefers a Vercel/agent browser CLI, falls
back to Playwright MCP, and degrades to manual_review if neither is available. Skipped when `browser=none`.
- when: test {{params.browser|shell}} != none
- runtime: subagent
- model: sonnet
- subagent-type: general-purpose
- input: {{stages.build-browser-assess.result_pointer}}
- prompt-file: {{workflow.dir}}/browser-prompt.md
- max-auto-continues: 3

## 9. report · bash
Merge code + LLM + browser + manual verdicts, validate completeness (no check may be silently dropped),
compute the rollup verdict, and write the self-contained HTML report + a machine-readable summary.
```sh
GDPR_DOMAIN={{params.domain|shell}} GDPR_CHECKLIST="{{workflow.dir}}/checklist.json" GDPR_EVIDENCE="{{stages.collect.result_pointer}}" GDPR_CODE_VERDICTS="{{stages.evaluate.result_pointer}}" GDPR_LLM_VERDICTS="{{stages.assess.result_pointer}}" GDPR_DUAL_VERDICTS="{{stages.dual-assess.result_pointer}}" GDPR_BROWSER_VERDICTS="{{stages.browser-assess.result_pointer}}" GDPR_REPORT_OUT="{{params.report_out}}" node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
