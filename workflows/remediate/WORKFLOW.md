---
name: remediate
description: >
  Close the loop after a review/checklist: take a list of findings (or an open `- [ ]` checklist), apply a
  fix for EACH one, then re-run a verify command in a loop until it's green. The "fix every item, then keep
  going until it builds/tests pass" workflow — the development-cycle complement to pr-review. Self-contained.
params:
  findings:     { default: "", description: "Findings JSON array ({file, rule_id?, severity?, note?, suggestion?})" }
  checklist:    { default: "", description: "Markdown `- [ ]` checklist path (alternative source)" }
  min_severity: { default: "major", description: "Only fix findings at/above this severity: info|minor|major|critical" }
  verify_cmd:   { default: "npm test", description: "Command that must pass; the loop runs until it exits 0" }
  max_rounds:   { default: "5", description: "Max verify/fix rounds" }
config: { context_policy: summary, max_auto_continues: 60, max_stages: 20, stop_on_failure: true }
---

# remediate

Three stages: load the fixes (deterministic), apply each (one LLM edit per item), then loop verify→fix until
green. Exhaustive over the findings; the loop guarantees we don't stop until the verify command passes.

## 1. load · bash
Normalize the findings/checklist into one fix item per issue (filtered by severity).
```sh
REMEDIATE_FINDINGS={{params.findings|shell}} REMEDIATE_CHECKLIST={{params.checklist|shell}} REMEDIATE_MIN_SEVERITY={{params.min_severity|shell}} node "{{workflow.dir}}/load.mjs" > "$PIPE_OUTPUT_PATH"
```
- output_path: {{run.dir}}/fixes.json

## 2. fix · foreach
Apply each fix with a minimal, correct edit (serialized so edits to the same file don't collide).
- items: {{stages.load.result_pointer}}
- task-prompt: "Apply the fix for this item. Edit the file at `data.file` to resolve `data.instruction` (rule `data.rule_id`, severity `data.severity`). Make the smallest correct change; don't refactor unrelated code. If `data.file` is null, infer the file from the instruction. Return JSON {\"file\":\"<path>\",\"applied\":true|false,\"note\":\"<what you changed or why not>\"}."
- serial: true
- max-retries: 1
- max-auto-continues: 30

## 3. verify · iterate
Run the verify command; if it fails, fix the remaining issues and repeat — until it passes or max rounds.
- stage: "Run the project's verify command (`{{params.verify_cmd}}`). If it FAILS, read the failure output and make the minimal edits needed to fix the remaining issues, then it will be re-checked. If it PASSES, stop — do nothing."
- stop: {{params.verify_cmd}}
- mode: until
- max-iterations: {{params.max_rounds}}
- max-auto-continues: 30
