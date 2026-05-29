---
name: remediate
description: >
  Close the loop after a review/checklist with coverage integrity. Load + TYPE the findings (code-only by
  default), apply a minimal fix for EACH one, then enforce that every item ends with a recorded disposition
  (fixed/deferred/skipped/failed + reason — no bare items), reconcile the claims against git ground truth
  (flagging ticked-but-not-changed and scope creep), and finally loop a verify command until it's green.
  Defends the value prop the per-item-self-report model erodes: nothing dropped without a reason, the report
  doesn't lie. Self-contained.
params:
  findings:     { default: "", description: "Findings JSON array ({file, rule_id?, severity?, note?, suggestion?, type?})" }
  checklist:    { default: "", description: "Markdown `- [ ]` checklist path (alternative source)" }
  types:        { default: "code", description: "Finding types to fix (comma): code,test,sample,doc — '' = all" }
  min_severity: { default: "minor", description: "Only fix findings at/above: info|minor|major|critical" }
  verify_cmd:   { default: "npm test", description: "Verify/build command; the gate loops until it exits 0" }
  gate_every:   { default: "0", description: "Mid-run integration gate: run verify_cmd every N fixes (0 = off, only the final gate)" }
  max_files:    { default: "3", description: "Scope leash: flag if changed files exceed fixes × this" }
  base:         { default: "HEAD", description: "Git ref remediation started from (reconcile diffs against it)" }
  ignore_paths: { default: "", description: "Comma-list of path patterns excluded from reconcile (e.g. `docs/,marketplace/,*.xlsx`)" }
  out_dir:      { default: ".agentflow/remediate", description: "Where disposition + reconcile reports are written" }
config: { context_policy: summary, max_auto_continues: 60, max_stages: 20, stop_on_failure: true }
---

# remediate (coverage-integrity)

Five stages. Enumeration + disposition + reconciliation are deterministic; the LLM only applies fixes. No
item is left bare, and `fixed` is checked against the actual git diff — not the agent's self-report.

## 1. load · bash
Normalize + type the findings/checklist into fix items (filtered by type and severity).
```sh
REMEDIATE_FINDINGS={{params.findings|shell}} REMEDIATE_CHECKLIST={{params.checklist|shell}} REMEDIATE_MIN_SEVERITY={{params.min_severity|shell}} REMEDIATE_TYPES={{params.types|shell}} node "{{workflow.dir}}/load.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/fixes.json

## 2. fix · foreach
Apply each fix with a minimal edit and report a MANDATORY disposition (serialized to avoid same-file collisions).
- items: {{stages.load.result_pointer}}
- task-prompt: "Apply the fix for this item. Edit ONLY the file at `data.file` (or, if null, the single file the instruction clearly points to) with the SMALLEST correct change — do NOT refactor, reformat, or touch unrelated code or other files. Resolve `data.instruction` (rule `data.rule_id`). Return JSON {\"disposition\":\"fixed|deferred|skipped|failed\",\"reason\":\"<why — REQUIRED>\",\"file\":\"<the file you changed>\"}: use `fixed` only if you actually edited the file, `deferred` if it's out of this pass's scope, `skipped` if it should not be changed, `failed` if you tried but couldn't. A disposition AND a reason are mandatory."
- serial: true
- gate-cmd: {{params.verify_cmd}}
- gate-every: {{params.gate_every}}
- max-retries: 1
- max-auto-continues: 30

## 3. disposition · bash
Guarantee coverage: every input item gets a recorded disposition; a bare item (no reason) is detected, not dropped.
```sh
REMEDIATE_ITEMS="{{stages.load.result_pointer}}" REMEDIATE_FIX_RUN="{{stages.fix.run_id}}" REMEDIATE_OUT_DIR={{params.out_dir|shell}} node "{{workflow.dir}}/disposition.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/disposition-summary.json

## 4. reconcile · bash
Check the claims against git ground truth: flag `fixed` items whose file wasn't changed, and scope creep.
```sh
RECONCILE_DISPOSITIONS="{{params.out_dir}}/dispositions.json" RECONCILE_REPO="." RECONCILE_BASE={{params.base|shell}} RECONCILE_MAX_FILES={{params.max_files|shell}} RECONCILE_IGNORE_PATHS={{params.ignore_paths|shell}} RECONCILE_OUT_DIR={{params.out_dir|shell}} node "{{workflow.dir}}/reconcile.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/reconcile-summary.json

## 5. verify · bash
Final gate: run the verify command once. A non-zero exit fails the workflow; the caller fixes any
remaining breaks in a subsequent run (no agent loop here — the foreach `gate-cmd` already catches
integration breaks every N items, mid-flight).
```sh
{{params.verify_cmd}} > "$PIPE_OUTPUT_PATH" 2>&1
```
- output_path: {{run.dir}}/verify.log
