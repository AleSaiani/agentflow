---
name: run-workflow
description: |
  Run a declarative workflow-file end to end: init a `/agentflow:pipe` from a JSON `WorkflowSpec`, then drive it to completion — auto-running every bash/json/deterministic stage and dispatching agents only where genuinely needed. Use `--dry-run` to preview the resolved plan without executing anything. The one-command way to execute a reusable, versioned workflow.

  USE when the user points at a workflow file ("run this workflow", "run workflows/audit/WORKFLOW.md", "run my pipeline") or wants to run a saved `WorkflowSpec`. Workflows are normally self-contained folders (`workflows/<name>/WORKFLOW.md` + sibling scripts), but a bare `.json` path also works.
allowed-tools: Bash, Read, Write, Agent
argument-hint: <WORKFLOW.md | workflow.json> [--param name=value ...] [--run-id NAME] [--dry-run]
---

# /agentflow:run-workflow — execute a workflow-file

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

A thin wrapper over `/agentflow:pipe`: it inits from a workflow-file and drives. The workflow-file is
typically `workflows/<name>/WORKFLOW.md` — a self-contained folder whose `bash` stages call sibling
scripts via `{{workflow.dir}}`, so it runs unchanged wherever the folder is. Pick a stable `<run-id>`
(default: derive from the workflow name) so re-runs resume.

## 1. Init the pipe from the workflow

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> --workflow <workflow.md> \
  [--param name=value ...] [--force]
```

`init` runs preflight validation on every primitive stage (catches bad flags before anything runs).
If the workflow declares `params`, pass each with `--param name=value` (a **required** param with no
value aborts init; declared defaults apply otherwise). Map the user's natural-language inputs to the
right params — e.g. *"audit src for bugs"* → `--param target=src`.

## 2a. `--dry-run` — preview only

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" plan <run-id>
```

Surface the resolved plan (stage order, commands, init_args, `when` guards) and **stop** — nothing
executes. Later stages' forward references remain as literal `{{...}}` until they resolve at run time.

## 2b. Drive to completion

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" drive <run-id>
```

Loop on the JSON result:
- `action: "needs_agent"` → init the child, `start-primitive-child`, run the dispatch per the child's
  SKILL.md (`/agentflow:foreach`, `/agentflow:reduce`, `/agentflow:enumerate`, or `/agentflow:group --method llm-classify`),
  then call `drive` again.
- `action: "needs_approval"` → a human-approval gate. **Stop and ask the user** with `AskUserQuestion`
  (use the returned `prompt`). If approved: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" approve <run-id>`
  then `drive` again. If rejected: `… pipe.js fail <run-id> --error "rejected at <stage>"`.
- `action: "done"` → surface `result_pointer`.
- `action: "failed"` → surface the error.

## 3. Show progress every turn (so "where are we" is always clear)

A long workflow runs across many resumes; the user must always be able to see the position at a glance.
**At the start of each turn (and on every resume), run and show the progress block:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" progress <run-id>
```

It prints one compact view: overall `N/total` stages + %, the **current phase** and (for a foreach/group
stage) its **item progress** with a bar, the cumulative **scale** (agents · $ · resume k/max), and the
**next** stages. Echo it verbatim — don't paraphrase the numbers. Example mid-run:

```
my-run  ▸ 20%  (2/10 stages)
  ██░░░░░░░░  stage 3/10 · review (foreach) · in_progress
  └─ this phase: 1180/2411 done · 12 running   █████░░░░░
  scale: 84 agents · ~$77.40 · resume 7/60
  next: review → module-quality → build-group-input → …
```

This makes both the **phase** ("which of N stages") and the **within-phase countdown** ("X/Y items")
visible together — not just one or the other. `progress --json` is available for tooling.

The Stop hook resumes an in-flight run across turns automatically — lead each resumed turn with the
progress block above.
