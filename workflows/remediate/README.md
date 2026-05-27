# remediate — fix findings with coverage integrity

Closes the loop after a review/checklist, and **defends the value prop that per-item self-report erodes**:
nothing is dropped without a recorded reason, and the report doesn't lie.

```bash
/agentflow:run-workflow remediate --param findings=findings.json --param verify_cmd="dotnet build"
/agentflow:run-workflow remediate --param checklist=reports/TODO.md
```

## Five stages
1. **load** — normalize + **type** the findings (code | test | sample | doc); `--param types` filters
   (default `code`, so a code-fix run doesn't pay tokens to read tests/samples). Severity-filtered.
2. **fix** (foreach, serial) — apply a **minimal** edit per item and return a **mandatory disposition**
   (`fixed | deferred | skipped | failed` + reason). The prompt forbids refactors/unrelated edits.
3. **disposition** — guarantees coverage: every input item ends with a recorded disposition; an item the
   agent left without a reason (**bare**) is detected and counted, not silently dropped. Writes
   `dispositions.json` / `.md`.
4. **reconcile** — checks the claims against **git ground truth**: flags items marked `fixed` whose file
   was not actually changed (ticked-but-not-changed / reverted) and **scope creep** (files changed that no
   fix asked for, or more files than `--param max_files` per fix). Writes `reconcile.json`.
5. **verify** (iterate/until) — the **integration gate**: runs the FULL verify command (`--param
   verify_cmd`) and loops fixing the rest until it's green or `--param max_rounds`.

## Why these stages (from a real run's failure modes)
A live remediation left **88% of open items bare** (no reason), trusted agent `fixed`-counts that didn't
match the actual checkboxes, reported per-module "green" while the whole solution didn't compile, and kept
items ticked after a revert. The deterministic `disposition` + `reconcile` + full-build `verify` stages
exist so those can't happen silently: the LLM applies fixes, **code guarantees coverage + checks the truth**.

## Params
`findings` / `checklist` (source) · `types` (default `code`) · `min_severity` (default `major`) ·
`verify_cmd` (default `npm test`) · `max_rounds` (default 5) · `max_files` (scope leash, default 3) ·
`base` (git ref to reconcile against, default `HEAD`) · `out_dir` (reports, default `.agentflow/remediate`).
