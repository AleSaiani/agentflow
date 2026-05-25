---
name: checklist
description: |
  Run a **repeatable checklist / to-do list** from a markdown file of `- [ ]` items — execute the open
  items, tick them `[x]`, and write the file back. Re-running resumes only the still-open items, so the
  file IS the durable, repeatable state.

  USE for a generic user to-do that should be runnable again and again: "run my TODO.md", "esegui la
  checklist", "go through CHECKLIST.md", "do the open items in release-steps.md". Each `- [ ]` line is
  itself the instruction for that item (optionally refined by --prompt).

  This is thin sugar over /agentflow:foreach with `--checkbox`: same engine, same durability and
  cross-turn resume, friendlier defaults. For "apply one operation to a JSON list / folder / glob" use
  /agentflow:foreach directly; to first GENERATE the list use /agentflow:enumerate; for one combined
  output use /agentflow:reduce.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: <checklist.md> [--prompt "<how to do each item>"] [--serial] [--model haiku|sonnet|opus] [--execution main-thread|subagent] [--dry-run]
---

# /agentflow:checklist

> **Make it visible:** in one line say you're starting a checklist run (file + run-id). `/agentflow:board`
> then lists it on disk — the audit trail. All paths are relative to the workspace root.

You are running a **repeatable checklist**. This is `/agentflow:foreach --checkbox` with defaults — follow
the **foreach** skill's orchestration (`${CLAUDE_PLUGIN_ROOT}/skills/foreach/SKILL.md`); this file only
fixes the sugar.

## Resolve arguments
- **File** (required): the first positional, else the user's named file, else `TODO.md` in the workspace
  root if present. It must contain markdown task lines (`- [ ] ...`, completed ones `- [x] ...`).
- **Per-item operation** (`--prompt`): default is *"Complete this checklist task. The task text is in the
  item's `data`. Do it end-to-end using the available tools, then report concisely what you did and any
  follow-up. If the task is ambiguous or cannot be completed, say so and leave it for review."* Override
  with `--prompt` (e.g. `--prompt "Draft the section described by each item"`).
- `--serial` → run items in list order, one at a time (sequential to-do). Default is parallel chunks.
- `--model` / `--execution` / `--dry-run` pass through to foreach (`--dry-run` = `--validate-only` +
  report the open-item count without executing).

## Run it (defaults wired)
1. **Init** a run (id like `checklist-<file-stem>-<date>`):
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" init <run-id> --checkbox <file> --prompt "<operation>" [--serial]
   ```
   `--checkbox` pre-marks existing `[x]` lines as done, so only open items are scheduled (this is what
   makes re-runs resume cleanly). For `--dry-run`, add `--validate-only` and stop here, reporting
   `total`/`pending`.
2. **Drive** the run exactly as the foreach skill describes: `claim` a chunk → dispatch each item to a
   subagent (or do it inline for `main-thread`) with the operation + the item's task text → record results
   with `complete`/`complete-batch`. The **state file is the only source of truth**; subagents never write
   state.
3. **Write back**: when items reach a terminal state, reflect them onto the file:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" view <run-id> --checkbox <file>
   ```
   Done items become `- [x]`; failed/blocked ones stay `- [ ]` and are reported for the next run.
4. **Close**: print a one-line summary (done / failed / remaining) and the run-id. Re-running
   `/agentflow:checklist <file>` later picks up exactly the still-open items.

## Notes
- **Repeatable by design**: the checkbox file is the state. Nothing else is needed to resume.
- Cross-turn durability and the Stop-hook auto-resume come for free from the foreach engine.
- To stop a long run, create the foreach `--stop-file`; to cap cost, pass `--max-usd` (see foreach).
