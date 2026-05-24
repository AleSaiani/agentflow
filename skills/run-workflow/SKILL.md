---
name: run-workflow
description: |
  Run a declarative workflow-file end to end: init a `/agentflow:pipe` from a JSON `WorkflowSpec`, then drive it to completion — auto-running every bash/json/deterministic stage and dispatching agents only where genuinely needed. Use `--dry-run` to preview the resolved plan without executing anything. The one-command way to execute a reusable, versioned workflow.

  USE when the user points at a workflow JSON ("run this workflow", "run workflows/audit/workflow.json", "run my pipeline") or wants to run a saved `WorkflowSpec`. Workflows are normally self-contained folders (`workflows/<name>/workflow.json` + sibling scripts), but a bare `.json` path also works.
allowed-tools: Bash, Read, Write, Agent
argument-hint: <workflow.json> [--param name=value ...] [--run-id NAME] [--dry-run]
---

# /agentflow:run-workflow — execute a workflow-file

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

A thin wrapper over `/agentflow:pipe`: it inits from a workflow-file and drives. The workflow-file is
typically `workflows/<name>/workflow.json` — a self-contained folder whose `bash` stages call sibling
scripts via `{{workflow.dir}}`, so it runs unchanged wherever the folder is. Pick a stable `<run-id>`
(default: derive from the workflow name) so re-runs resume.

## 1. Init the pipe from the workflow

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> --workflow <workflow.json> \
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
- `action: "done"` → surface `result_pointer`.
- `action: "failed"` → surface the error.

The Stop hook resumes an in-flight run across turns automatically.
