---
name: workflows
description: |
  List the reusable workflows authored in this workspace — every `workflows/<name>/` folder, with its
  format (WORKFLOW.md / workflow.json), stage count, and declared params. The "what workflows do I have
  to run" catalog. Read-only, never mutates state.

  USE when the user asks "what workflows do I have", "list my workflows", "which flows can I run",
  "show available workflows", or before running one and they don't remember the name/params. To run one
  use `/agentflow:run-workflow <path>`; to author a new one use `/agentflow:create-workflow`.
allowed-tools: Bash, Read
argument-hint: [--json]
disable-model-invocation: false
---

# /agentflow:workflows

> **Make it visible:** this is read-only; just run it and surface the list.

Lists every workflow under `<workspace>/workflows/` — a folder with a `WORKFLOW.md` (human-authored)
and/or a `workflow.json` (compiled spec), or a bare `workflows/<name>.json`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" workflows [--json]
```

For each: `name`, `format`, stage count + declared `params` (when a `workflow.json` is present), the
path, and a one-line description. Use it to find the right workflow + its params, then run it:

```bash
/agentflow:run-workflow workflows/<name>/workflow.json --param <name>=<value> …
```

Related: `/agentflow:create-workflow` (author a new workflow), `/agentflow:run-workflow` (execute one),
`/agentflow:board` (active runs).
