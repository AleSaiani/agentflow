---
name: security-pack
description: A meta-workflow that composes two nested sub-workflows — security-domain (external) and security-repo (internal) — then rolls them up into one combined index linking both reports with an overall verdict. Demonstrates workflow composition via the `· workflow` stage (a pipe nested in a pipe). Fully deterministic; inputs are a domain and a repo path.
params:
  domain: { required: true, description: "Domain to audit externally, e.g. example.com" }
  repo: { default: ".", description: "Repository path to audit internally (default: current directory)" }
  report_out: { default: "", description: "Combined index path (default ./security-pack-<date>.html in cwd)" }
config: { context_policy: summary, max_auto_continues: 30, max_stages: 10, stop_on_failure: true }
---

# Security pack

Composition in action: each of the first two stages is a whole **sub-workflow** nested as a `· workflow`
stage (a `pipe` child). Both sub-workflows are deterministic, so the parent drives them to completion
inline; the roundup then links their reports into one index. Copy this folder and add more
`· workflow` stages to build your own pack.

## 1. domain · workflow
Run the external web-security audit as a nested sub-workflow; its report lands in this run's dir.
- workflow: {{workflow.dir}}/../security-domain/WORKFLOW.md
- param: domain={{params.domain}}
- param: report_out={{run.dir}}/security-domain-report.html

## 2. repo · workflow
Run the internal source-security audit as a nested sub-workflow.
- workflow: {{workflow.dir}}/../security-repo/WORKFLOW.md
- param: repo={{params.repo}}
- param: report_out={{run.dir}}/security-repo-report.html

## 3. roundup · bash
Combine both sub-workflow summaries into one index with an overall verdict (worst of the two).
```sh
PACK_TITLE={{params.domain|shell}} PACK_DOMAIN_SUMMARY="{{stages.domain.result_pointer}}" PACK_REPO_SUMMARY="{{stages.repo.result_pointer}}" PACK_REPORT_OUT="{{params.report_out}}" node "{{workflow.dir}}/roundup.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/pack-summary.json
