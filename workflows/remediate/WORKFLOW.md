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
  min_severity: { default: "major", description: "Only fix findings at/above: info|minor|major|critical" }
  verify_cmd:   { default: "npm test", description: "Verify/build command; the gate loops until it exits 0" }
  max_rounds:   { default: "5", description: "Max verify/fix rounds" }
  max_files:    { default: "3", description: "Scope leash: flag if changed files exceed fixes × this" }
  base:         { default: "HEAD", description: "Git ref remediation started from (reconcile diffs against it)" }
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
RECONCILE_DISPOSITIONS="{{params.out_dir}}/dispositions.json" RECONCILE_REPO="." RECONCILE_BASE={{params.base|shell}} RECONCILE_MAX_FILES={{params.max_files|shell}} RECONCILE_OUT_DIR={{params.out_dir|shell}} node "{{workflow.dir}}/reconcile.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/reconcile-summary.json

## 5. verify · iterate
The integration gate: run the full verify command; if it fails, fix the rest and repeat — until green or max rounds.
- stage: "Run the project's verify command (`{{params.verify_cmd}}`) — the FULL build/test, not a single module. If it FAILS, read the failure output and make the minimal edits needed to fix the remaining issues (including any integration breaks), then it will be re-checked. If it PASSES, stop — do nothing."
- stop: {{params.verify_cmd}}
- mode: until
- max-iterations: {{params.max_rounds}}
- max-auto-continues: 30
