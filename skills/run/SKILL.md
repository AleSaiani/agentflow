---
name: run
description: |
  Run a declarative workflow-file end to end: init a `/flow:pipe` from a JSON `WorkflowSpec`, then drive it to completion — auto-running every bash/json/deterministic stage and dispatching agents only where genuinely needed. Use `--dry-run` to preview the resolved plan without executing anything. The one-command way to execute a reusable, versioned workflow.

  USE when the user points at a workflow JSON ("run this workflow", "execute audit.json", "run my pipeline") or wants to run a saved `WorkflowSpec`.
allowed-tools: Bash, Read, Write, Agent
argument-hint: <workflow.json> [--run-id NAME] [--dry-run]
---

# /flow:run — execute a workflow-file

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear a Flow
> run is happening; `/flow:board` then lists every run on disk — the audit trail.

A thin wrapper over `/flow:pipe`: it inits from a workflow-file and drives. Pick a stable `<run-id>`
(default: derive from the workflow name) so re-runs resume.

## 1. Init the pipe from the workflow

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> --workflow <workflow.json> [--force]
```

`init` runs preflight validation on every primitive stage (catches bad flags before anything runs).

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
  SKILL.md (`/flow:foreach`, `/flow:reduce`, `/flow:enumerate`, or `/flow:group --method llm-classify`),
  then call `drive` again.
- `action: "done"` → surface `result_pointer`.
- `action: "failed"` → surface the error.

The Stop hook resumes an in-flight run across turns automatically.
