---
name: group
user-invocable: false
description: |
  Partition N items into K groups by key — the partition step. Output is items.json-compatible: feed
  it straight to /agentflow:foreach to process per group. Methods: path-prefix / regex / jsonpath
  (deterministic) or llm-classify (semantic, when no deterministic key works).

  USE when the user wants to split a set by a key before acting on each part — "group these by
  component/table/label/severity, then handle each group", "bucket the issues by …". Trigger on the
  intent; for a small set, ask whether grouping is worth it or just process inline.

  DON'T use to produce a single aggregate (→ /agentflow:reduce — collapse N to 1), or when you won't
  actually process per group afterward. Explicit invocation (`/agentflow:group …`) skips the size check.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --method path-prefix|regex|jsonpath|llm-classify --input-source <descriptor> [--method-config '{…}'] [--model haiku|sonnet|opus]
---

# /agentflow:group

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/group/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/group.js`) — shared framework
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/agentflow:group` run. Job:
1. resolve the input items (from another run, a file, or inline),
2. apply the chosen grouping method (deterministic in pure Python, or LLM-classify via one Agent),
3. produce `groups.json` — an items.json-compatible array of group items, ready for downstream `/agentflow:foreach`.

**Composition pattern**: the output of `/agentflow:group` IS a valid input for `/agentflow:foreach`. Pipe them: `/agentflow:group → /agentflow:foreach --items <groups.json>`. Each "item" foreach sees is a whole group, with `data: {group_id, items, size}`.

## Invocation

```
/agentflow:group --method path-prefix|regex|jsonpath|llm-classify \
        --input-source <descriptor.json> [--method-config '{…}'] \
        [--model haiku|sonnet|opus] [--run-id NAME]
```

`--input-source` is a descriptor file:
```json
{"source": "run",  "cmd": "foreach", "run_id": "…"}   // or
{"source": "file", "path": "<items.json>"}            // or
{"source": "inline", "data": [ {"id": "…", "data": {…}} ]}
```

`--method-config` per method: `path-prefix` `'{"depth":2}'` · `regex`
`'{"pattern":"^src/([^/]+)/","field":"id"}'` · `jsonpath` `'{"path":"data.component"}'`. For
`llm-classify`, the classify instructions are given to the agent at dispatch time (Step 4b). If no
method or input source is provided → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/group/defaults.md` (YAML frontmatter). Use defaults when CLI/spec do not supply a value.

## Step 1 — Parse and validate

- Resolve config by priority (CLI > defaults > hardcoded).
- If `run-id` is missing: generate `group-<8 char hash>` from the input source + method + method_config.
- Validate method ∈ {`path-prefix`, `regex`, `jsonpath`, `llm-classify`}.
- For `regex`: `pattern` is required; `field` defaults to `id`.
- For `jsonpath`: `path` is required (e.g. `data.component`, `data.labels.0`).
- For `llm-classify`: classify instructions are required (given to the agent at dispatch, Step 4b).

## Step 2 — Threshold guardrail (autonomous invocation only)

After the input source is resolved (you can peek at items count cheaply by reading the source), compute `items_total`. If `items_total < min_items` from defaults (default 10) AND this is an autonomous invocation, STOP and use `AskUserQuestion`:
> "Only <N> items to group. /agentflow:group adds an extra step (and possibly an agent dispatch for llm-classify). For this size you can probably feed items directly to /agentflow:foreach without partitioning. Proceed with /agentflow:group anyway?"
> Options: **skip** (cancel /agentflow:group, the caller can use the items directly) | **proceed** (continue with /agentflow:group)

If the user typed `/agentflow:group` explicitly → skip the guardrail.

## Step 3 — Build the input source descriptor and init state

Write the input source descriptor to `.agentflow/group/<run-id>/input-source.json`:
```json
{"source": "run",  "cmd": "foreach", "run_id": "enum-abc123"}
{"source": "file", "path": "<path-to-json-array>"}
{"source": "inline", "data": [ {...}, {...} ]}
```

Then init the state:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" init <run-id> \
  --method <path-prefix|regex|jsonpath|llm-classify> \
  --input-source .agentflow/group/<run-id>/input-source.json \
  --method-config '<json>' \
  --model <model> --min-items <N> \
  --max-auto-continues <N> \
  [--auto-continue|--no-auto-continue] \
  [--force]
```

`--method-config` examples:
- `path-prefix`: `'{"depth": 2}'`
- `regex`: `'{"pattern": "^src/([^/]+)/", "field": "id"}'`
- `jsonpath`: `'{"path": "data.component"}'`
- `llm-classify`: `'{}'` (the prompt is passed at dispatch time)

If the run-id exists **without `--force`**: ask the user `resume` or `reset`. DO NOT overwrite without confirmation.

## Step 4a — Deterministic methods (path-prefix, regex, jsonpath)

One shot. The state helper resolves input + applies method + writes `groups.json` + marks done:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" run-deterministic <run-id>
```

Skip to Step 5.

## Step 4b — LLM-classify method

1. Materialize input items to a file the agent will read:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" prepare-classify <run-id>
   ```
   This writes `.agentflow/group/<run-id>/items-to-classify.json` and marks state in_progress.

2. Dispatch ONE Agent. Self-contained prompt:
   - `subagent_type`: from config (default `general-purpose`)
   - `model`: from config if not `inherit`
   - `description`: `group:<run-id>:classify`
   - `prompt`:
     - the user's classify instructions
     - input file: `.agentflow/group/<run-id>/items-to-classify.json` (JSON array of `{id, data, ...}`)
     - output file: `.agentflow/group/<run-id>/classification.json` (JSON object `{"<item_id>": "<group_id>", ...}` covering EVERY item)
     - **strict I/O rules**:
       - "Read the input file. For EACH item, decide its group based on the classification rule. Do NOT comment while working."
       - "Write the result to `.agentflow/group/<run-id>/classification.json` via the `Write` tool: a JSON object mapping every `id` from the input to a `group_id` string. Group IDs should be short, lowercase, hyphenated (e.g. `auth`, `billing`, `data-pipeline`)."
       - "Cover EVERY input id. If unsure, use the group `unclassified`."
       - "The file MUST be ONLY the JSON object — no prose, no fence."
       - "Your final response to the orchestrator must be a single line: `OK <group_count>`. Nothing else."

3. Apply the classification:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" apply-classification <run-id> \
     --mapping .agentflow/group/<run-id>/classification.json
   ```
   This produces `groups.json` and marks done.

   If the classification file is missing or unparseable: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" fail <run-id> --error "<reason>"`. The Stop hook will retry on the next turn (up to `max_auto_continues`).

## Step 5 — Final report

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" status <run-id>
```

Print: `run-id`, `method`, `items_total`, `groups_count`, `output_pointer`, plus a one-line summary of group sizes (e.g. "auth: 12, billing: 8, api: 5, unclassified: 2").

Suggest the next step explicitly: "Output `.agentflow/group/<run-id>/groups.json` is items.json-compatible. Run `/agentflow:foreach --items .agentflow/group/<run-id>/groups.json --prompt '...'` to process per group, or `/agentflow:reduce` it for a partition-aware digest."

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) scans `.agentflow/group/`. For /agentflow:group, "residual work" = `status in {"pending", "in_progress"}` AND `auto_continues < max_auto_continues`. If you are re-activated by the hook with a /agentflow:group run-id:
- DO NOT re-init.
- Read state. If method is deterministic → re-run `run-deterministic`. If method is `llm-classify` → check whether `classification.json` exists; if yes, run `apply-classification`; if no, re-dispatch the classify agent (Step 4b.2).

## Important rules

- **Single-writer**: only you (orchestrator) call `init`/`run-deterministic`/`prepare-classify`/`apply-classification`/`fail`. The classify agent only writes the classification file.
- **Output is canonical and stable**: `groups.json` shape is always `[{"id": <group_id>, "data": {"group_id", "items", "size"}}, ...]`. Downstream consumers can rely on this.
- **Deterministic when possible**: prefer `path-prefix`/`regex`/`jsonpath` over `llm-classify` — cheaper, faster, reproducible across runs.
- **Idempotence**: re-running `/agentflow:group` with the same run-id without `--force` resumes.

## Quick example

Group .cs files by directory, then review each group together:
```bash
# src.json: {"source":"run","cmd":"foreach","run_id":"review-cs"}
/agentflow:group --method path-prefix --method-config '{"depth":2}' --input-source src.json --run-id cs-by-dir
/agentflow:foreach --items .agentflow/group/cs-by-dir/groups.json \
           --prompt "Review every file in this group together; cross-reference for cross-file bugs"
```

LLM-classify Jira issues by intent (the classify instructions go to the agent at dispatch, Step 4b):
```bash
# issues.json: {"source":"file","path":".agentflow/pipe/triage/issues.json"}
/agentflow:group --method llm-classify --input-source issues.json --model sonnet
```
