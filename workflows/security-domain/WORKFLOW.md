---
name: security-domain
description: Fully-deterministic web-security posture audit of a public domain (OWASP Secure Headers + Mozilla guidelines + RFC 9116) — collect HTTP/TLS evidence, decide every check in code, then a self-contained HTML report. No LLM in the loop, so the same domain state always yields the same verdicts. Self-contained; the only input is the domain. Run only against domains you are authorized to assess.
params:
  domain: { required: true, description: "Domain to audit, e.g. example.com" }
  report_out: { default: "", description: "HTML report path (default ./security-report-<domain>-<date>.html in cwd)" }
config: { context_policy: summary, max_auto_continues: 20, max_stages: 8, stop_on_failure: true }
---

# Web security posture audit

Three deterministic stages — no LLM. Code observes the domain (TLS, headers, cookies, exposure, CORS,
SRI), code decides every check, code renders the report. The purest determinism showcase: re-running on
an unchanged target reproduces the verdict exactly. Pairs with `gdpr-domain` in a compliance/security pack.

## 1. collect · bash
Gather web-security evidence: TLS, HTTP→HTTPS, security headers, cookie flags, mixed content, CORS,
Subresource Integrity, TRACE, and exposure probes (/.git, /.env, backups, directory listing).
```sh
SECDOM_DOMAIN={{params.domain|shell}} node "{{workflow.dir}}/collect.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/evidence.json

## 2. evaluate · bash
Decide every check with pure rules over the evidence.
```sh
SECDOM_EVIDENCE="{{stages.collect.result_pointer}}" SECDOM_CHECKLIST="{{workflow.dir}}/checklist.json" node "{{workflow.dir}}/evaluate.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/code-verdicts.json

## 3. report · bash
Merge + validate completeness + compute the rollup + write the self-contained HTML report and summary.
```sh
SECDOM_DOMAIN={{params.domain|shell}} SECDOM_CHECKLIST="{{workflow.dir}}/checklist.json" SECDOM_EVIDENCE="{{stages.collect.result_pointer}}" SECDOM_CODE_VERDICTS="{{stages.evaluate.result_pointer}}" SECDOM_REPORT_OUT="{{params.report_out}}" node "{{workflow.dir}}/report.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/report-summary.json
