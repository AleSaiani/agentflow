---
name: board
description: |
  Workspace dashboard: lists every active framework run across all primitives, highlights blockers (stuck items, exhausted auto-continue caps), shows cumulative cost, and suggests the next action. The natural command to run after re-opening Claude Code in a workspace with in-flight runs, or whenever the user wants a one-shot overview of "what's going on".

  USE this skill when:
  - the user has just (re)opened the workspace and wants to know what is in flight;
  - the user says "what's going on", "show me everything", "any active runs", "where are we", "any pipelines running";
  - the user wants a one-shot health check + suggested next action.

  DON'T use this to inspect a specific run in depth (use `/agentflow:inspect show <id>` or `tree <id>`), or
  to modify state (board is read-only). Explicit: `/agentflow:board` or `/agentflow:board --json`.
allowed-tools: Bash, Read
argument-hint: '[--json] [--no-failed]'
disable-model-invocation: false
---

# /agentflow:board

Surface the workspace's current state in one screen. Read-only, no mutation.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" board [--json] [--no-failed]
```

## What it shows

- **Counts**: `N active, M done, K failed`
- **Cumulative cost**: total tokens + USD recorded across all runs
- **ACTIVE section**: every non-terminal run with its primitive-specific progress (e.g. `foreach: 12/30`, `pipe: 2/4 stages`, `iterate: 3/10 iters`), plus the parent run if it is a /agentflow:pipe child
- **BLOCKERS section**: runs that need manual attention — items stuck `in_progress` from a dead session, `auto_continues` cap exhausted, etc.
- **FAILED section** (top 5; suppress with `--no-failed`): runs that ended in `failed` status, with error preview
- **Suggested next actions**: concrete commands the user can run — `pipe drive`, `inspect tree`, `state/foreach.js reset`, etc.

## Typical usage

After (re)opening Claude Code in this workspace:

```
user: /agentflow:board
assistant: (calls the CLI, surfaces the output)
```

If something is active, sending any next message will trigger the Stop hook at end-of-turn and auto-resume the work. `/agentflow:board` does not resume anything itself — it only reports.

## Important rules

- **Read-only**: never mutates state.
- **Different from `/agentflow:inspect runs`**: `/agentflow:board` is for the "session start" overview with suggestions; `/agentflow:inspect runs` is the bare tabular listing. `/agentflow:board` is opinionated, `/agentflow:inspect` is plumbing.
- **Always safe to run**: no flags, no risk. Use it freely.
