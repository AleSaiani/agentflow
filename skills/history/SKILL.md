---
name: history
description: |
  Chronological history of Flow runs in this workspace — every run across all primitives, most recent
  first, with status, agent count, and cost. The "what have I run, and when" log. Read-only, never
  mutates state.

  USE when the user asks "what did I run", "show history", "recent runs", "what flows have run",
  "did the X run earlier", "list past runs". For a live dashboard of what's *active* use `/flow:board`;
  for one run's details use `/flow:inspect show <id>`.
allowed-tools: Bash, Read
argument-hint: [--limit N] [--cmd enumerate|foreach|group|iterate|reduce|pipe] [--json]
disable-model-invocation: false
---

# /flow:history

> **Make it visible:** this is read-only; just run it and surface the table.

A time-ordered log of every run on disk (newest first). The history *is* the run state — there's no
separate logfile; each run records its own timestamps and budget.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" history [--limit N] [--cmd <name>] [--json]
```

Columns: `UPDATED_AT · CMD · RUN_ID · STATUS · AGENTS · USD$`. Defaults to the 20 most recent;
`--limit 0` for all, `--cmd` to filter to one primitive, `--json` for structured output.

Related: `/flow:board` (active runs + blockers + suggested next action), `/flow:inspect show <id>`
(one run's detail), `/flow:inspect timeline <id>` (a single run's event log).
