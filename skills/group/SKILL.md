---
name: group
description: |
  Partition N items into K groups by key. Output is items.json-compatible — feed it directly to /enumerate to process per-group.

  USE this skill autonomously when:
  - the user wants to partition a set of items by a key (path, domain, label, severity, component, ...);
  - the next natural step would be to process each partition (e.g. "group migrations by table, then validate each group");
  - input is large enough (typically >= 10 items) that grouping reduces noise.

  DO NOT use this skill autonomously when:
  - input is small (< 10 items) — process inline or pass to /enumerate directly;
  - the user wants a single aggregate (use /reduce instead — collapse N to 1);
  - grouping is not actually a step toward downstream work (no point partitioning if you do not process per group).

  Methods:
  - **path-prefix** (deterministic): group by leading path segments. Good for "by directory", "by module".
  - **regex** (deterministic): group by capture group on a field (id or data path).
  - **jsonpath** (deterministic): group by dotted JSON path into the item.
  - **llm-classify** (LLM-driven): semantic grouping when no deterministic key works. Slower, costs an agent dispatch.

  Explicit user invocation (`/group ...`) bypasses the threshold guardrail.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --file <spec.md> | --from-run <run-id> --method <path-prefix|regex|jsonpath|llm-classify> [--method-config <json>] [--run-id NAME] [--model haiku|sonnet|opus]
---

# /group

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/group/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/group.js`) — shared framework
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/group` run. Job:
1. resolve the input items (from another run, a file, or inline),
2. apply the chosen grouping method (deterministic in pure Python, or LLM-classify via one Agent),
3. produce `groups.json` — an items.json-compatible array of group items, ready for downstream `/enumerate`.

**Composition pattern**: the output of `/group` IS a valid input for `/enumerate`. Pipe them: `/group → /enumerate --from-file <groups.json>`. Each "item" enumerate sees is a whole group, with `data: {group_id, items, size}`.

## Input forms

### Form A — structured markdown file
```
/group --file path/to/spec.md
```
With YAML frontmatter (config + input source + method config) and an optional `## Classify` section (only for method=llm-classify):
```markdown
---
run-id: cs-by-component
method: llm-classify
model: sonnet
input:
  source: run
  cmd: enumerate
  run_id: enum-abc123
method_config:
  prompt-style: short
---

## Classify
<prompt instructing the agent how to assign each item to a group — only for llm-classify>
```

### Form B — inline flags
```
/group --from-run <enum-run-id> --method path-prefix --depth 2 [--run-id NAME]
/group --from-file <items.json> --method regex --pattern "^src/([^/]+)/" --field id
/group --from-file <items.json> --method jsonpath --path data.component
/group --from-run <enum-run-id> --method llm-classify --classify-prompt "Group by intent: auth, billing, api, infra, other" --model sonnet
```

If neither input source nor method are provided → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/group/defaults.md` (YAML frontmatter). Use defaults when CLI/spec do not supply a value.

## Step 1 — Parse and validate

- Determine form A or B.
- Resolve the final config by priority (CLI > spec frontmatter > defaults > hardcoded).
- If `run-id` is missing: generate `grp-<8 char hash>` from the hash of the input source + method + method_config.
- Validate method ∈ {`path-prefix`, `regex`, `jsonpath`, `llm-classify`}.
- For `regex`: `pattern` is required; `field` defaults to `id`.
- For `jsonpath`: `path` is required (e.g. `data.component`, `data.labels.0`).
- For `llm-classify`: a classify prompt is required (the section `## Classify` in spec, or `--classify-prompt`).

## Step 2 — Threshold guardrail (autonomous invocation only)

After the input source is resolved (you can peek at items count cheaply by reading the source), compute `items_total`. If `items_total < min_items` from defaults (default 10) AND this is an autonomous invocation, STOP and use `AskUserQuestion`:
> "Only <N> items to group. /group adds an extra step (and possibly an agent dispatch for llm-classify). For this size you can probably feed items directly to /enumerate without partitioning. Proceed with /group anyway?"
> Options: **skip** (cancel /group, the caller can use the items directly) | **proceed** (continue with /group)

If the user typed `/group` explicitly → skip the guardrail.

## Step 3 — Build the input source descriptor and init state

Write the input source descriptor to `.group/<run-id>/input-source.json`:
```json
{"source": "run",  "cmd": "enumerate", "run_id": "enum-abc123"}
{"source": "file", "path": "<path-to-json-array>"}
{"source": "inline", "data": [ {...}, {...} ]}
```

Then init the state:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" init <run-id> \
  --method <path-prefix|regex|jsonpath|llm-classify> \
  --input-source .group/<run-id>/input-source.json \
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
   This writes `.group/<run-id>/items-to-classify.json` and marks state in_progress.

2. Dispatch ONE Agent. Self-contained prompt:
   - `subagent_type`: from config (default `general-purpose`)
   - `model`: from config if not `inherit`
   - `description`: `group:<run-id>:classify`
   - `prompt`:
     - the user's classify prompt (from spec `## Classify` section or `--classify-prompt`)
     - input file: `.group/<run-id>/items-to-classify.json` (JSON array of `{id, data, ...}`)
     - output file: `.group/<run-id>/classification.json` (JSON object `{"<item_id>": "<group_id>", ...}` covering EVERY item)
     - **strict I/O rules**:
       - "Read the input file. For EACH item, decide its group based on the classification rule. Do NOT comment while working."
       - "Write the result to `.group/<run-id>/classification.json` via the `Write` tool: a JSON object mapping every `id` from the input to a `group_id` string. Group IDs should be short, lowercase, hyphenated (e.g. `auth`, `billing`, `data-pipeline`)."
       - "Cover EVERY input id. If unsure, use the group `unclassified`."
       - "The file MUST be ONLY the JSON object — no prose, no fence."
       - "Your final response to the orchestrator must be a single line: `OK <group_count>`. Nothing else."

3. Apply the classification:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" apply-classification <run-id> \
     --mapping .group/<run-id>/classification.json
   ```
   This produces `groups.json` and marks done.

   If the classification file is missing or unparseable: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" fail <run-id> --error "<reason>"`. The Stop hook will retry on the next turn (up to `max_auto_continues`).

## Step 5 — Final report

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/group.js" status <run-id>
```

Print: `run-id`, `method`, `items_total`, `groups_count`, `output_pointer`, plus a one-line summary of group sizes (e.g. "auth: 12, billing: 8, api: 5, unclassified: 2").

Suggest the next step explicitly: "Output `.group/<run-id>/groups.json` is items.json-compatible. Run `/enumerate --list-file .group/<run-id>/groups.json --task '...'` to process per group, or `/reduce` it for a partition-aware digest."

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) scans `.group/`. For /group, "residual work" = `status in {"pending", "in_progress"}` AND `auto_continues < max_auto_continues`. If you are re-activated by the hook with a /group run-id:
- DO NOT re-init.
- Read state. If method is deterministic → re-run `run-deterministic`. If method is `llm-classify` → check whether `classification.json` exists; if yes, run `apply-classification`; if no, re-dispatch the classify agent (Step 4b.2).

## Important rules

- **Single-writer**: only you (orchestrator) call `init`/`run-deterministic`/`prepare-classify`/`apply-classification`/`fail`. The classify agent only writes the classification file.
- **Output is canonical and stable**: `groups.json` shape is always `[{"id": <group_id>, "data": {"group_id", "items", "size"}}, ...]`. Downstream consumers can rely on this.
- **Deterministic when possible**: prefer `path-prefix`/`regex`/`jsonpath` over `llm-classify` — cheaper, faster, reproducible across runs.
- **Idempotence**: re-running `/group` with the same run-id without `--force` resumes.

## Quick example

Group .cs files by directory and validate each group:
```
/group --from-run enum-cs-files --method path-prefix --method-config '{"depth": 2}' --run-id cs-by-dir
/enumerate --list-file .group/cs-by-dir/groups.json \
           --task "review every file in this group as a coherent unit; cross-reference for cross-file bugs"
```

LLM-classify Jira issues by intent:
```
/group --from-file .pipe/<run>/issues.json --method llm-classify \
       --classify-prompt "Read each issue. Assign to one of: regression, feature-request, ux, performance, infra. Use 'other' if unclear." \
       --model sonnet
```
