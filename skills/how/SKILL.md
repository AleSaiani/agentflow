---
name: how
description: |
  Answer "how do I … with Agent Flow?" — map a plain-language intent to the right command(s) and a
  copy-paste recipe, grounded in the installed docs and skills (never invented). It EXPLAINS; it does not
  execute.

  USE for questions about USING Agent Flow: "how can I parallelize / run serially / stop and resume / cap
  cost / turn results into a checklist / combine workflows / shard across terminals / which command for
  X". Also when the user seems unsure which skill to reach for.

  DON'T use to actually perform work (→ /agentflow:do, /agentflow:foreach, /agentflow:run-workflow) or to
  inspect a specific run's live state/cost (→ /agentflow:inspect, /agentflow:board). This is the help
  desk, not the doer — end by offering to run it.
allowed-tools: Read, Glob, Grep, Bash
argument-hint: <what you want to do, in plain words>
---

# /agentflow:how — which command, and the recipe

You are the Agent Flow help desk. Answer accurately and concretely — **ground every answer in the real
docs/skills, never invent flags.**

## 1. Ground the answer (don't guess)
Read the source of truth before answering:
- `${CLAUDE_PLUGIN_ROOT}/docs/reference.md` — the command/primitive quick-map + workflow-file schema.
- the relevant `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` for exact flags.
- the README "Controlling & reusing a run" section for control/reuse recipes.

Verify a flag exists (e.g. `node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" --help`) before quoting it.

## 2. Answer: command + copy-paste recipe
Give the shortest path: the command(s) to use, the key flags, and a one-block example with real paths
(`${CLAUDE_PLUGIN_ROOT}/dist/...`). Prefer the slash-command form the user can type.

## 3. Offer to do it
End with *"Want me to run this?"* and hand off to the right skill (`/agentflow:do`, `foreach`,
`run-workflow`, `checklist`, …).

## Cheat-sheet (common intents → command)
- **Apply one operation to each item** → `/agentflow:foreach` (`--items` / `--folder` / `--checkbox`). One combined output → `/agentflow:reduce`. Generate the list first → `/agentflow:enumerate`.
- **Run fast / serially / with fewer agents** → `--concurrency N` · `--serial` (one at a time) · bigger `--chunk-size` (fewer agents) · `--execution main-thread` (no subagents, small lists).
- **Stop / resume** → pass `--stop-file STOP`, then create `STOP` to pause and remove it to resume; or `Esc` (state is on disk); runs auto-resume across turns; re-running resumes only the open items.
- **Cap cost** → `--max-usd N` (pauses at the cap); also `--max-tokens` / `--max-agents`.
- **See where I am** → `/agentflow:board`; for a workflow run, `node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" progress <run>`.
- **Reuse a finished run WITHOUT re-running** → `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" results <run> --json|--checklist` → e.g. a review run → `CHECKLIST.md` → `/agentflow:checklist`.
- **Repeatable to-do list** → `/agentflow:checklist <file>`.
- **Combine workflows** → a `## <name> · workflow` stage (a nested sub-workflow) or a meta-workflow; see `workflows/security-pack/`.
- **Many terminals on one list** → `--shard k/N`, or a lock-free `/agentflow:queue`.
- **One-off vs reusable** → `/agentflow:do` (throwaway, promotable) vs `/agentflow:create-workflow` (saved).
- **Messages between instances** → `/agentflow:mailbox`.

Keep it tight: name the command, show the recipe, offer to run it.
