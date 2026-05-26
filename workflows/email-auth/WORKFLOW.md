---
name: email-auth
description: >
  Audit a domain's email-authentication posture — SPF, DMARC, MX, DKIM (common selectors), MTA-STS,
  TLS-RPT, BIMI — entirely from DNS, fully deterministically (same domain → same verdicts, no LLM). Code
  resolves the records, code decides every check against a standards-mapped checklist, code writes the
  report. Self-contained; the only input is the domain. Reflects published DNS, not live mail delivery.
params:
  domain:     { required: true, description: "The domain to audit (e.g. example.com)" }
  selectors:  { default: "", description: "Comma-separated DKIM selectors to probe (default: common ones)" }
  report_out: { default: "", description: "Markdown report path (default ./email-auth-<domain>-<date>.md)" }
config: { context_policy: summary, max_auto_continues: 10, max_stages: 8, stop_on_failure: true }
---

# Email authentication posture

Three deterministic stages — no LLM. The internal-observer twin of the security/gdpr suite, for the email
control plane.

## 1. scan · bash
Resolve the domain's SPF/DMARC/MX/DKIM/MTA-STS/TLS-RPT/BIMI DNS records.
```sh
EMAILAUTH_DOMAIN={{params.domain|shell}} EMAILAUTH_SELECTORS={{params.selectors|shell}} node "{{workflow.dir}}/scan.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/scan.json

## 2. evaluate · bash
Decide every checklist check with pure rules over the scan.
```sh
EMAILAUTH_SCAN="{{stages.scan.result_pointer}}" EMAILAUTH_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/evaluate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/verdicts.json

## 3. report · bash
Validate completeness, compute the rollup + verdict, write the markdown report.
```sh
EMAILAUTH_VERDICTS="{{stages.evaluate.result_pointer}}" EMAILAUTH_CHECKLIST="{{workflow.dir}}/checklist.json" EMAILAUTH_OUT="{{params.report_out}}" node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
