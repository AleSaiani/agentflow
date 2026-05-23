---
name: enumerate
description: |
  Apply the SAME task to MANY items in parallel chunks across N subagents, with persistent state and cross-turn auto-continue.

  USE this skill autonomously ONLY when ALL of the following hold:
  - the user wants the same task applied across MANY items (typically >= 15);
  - the user signals "scope-wide" intent: "every", "all", "entire codebase", glob patterns ("**/*.cs"), a folder, "each migration", "all PRs", etc.;
  - per-item parallelism actually saves time (the task is non-trivial AND items are independent).

  DO NOT use this skill autonomously when:
  - the user names a specific small set ("look at foo.py and bar.py");
  - the count is small (< 15 items) — read them inline in a single agent instead;
  - the task requires cross-item reasoning that cannot be split (use a single agent + /reduce after);
  - the user is exploring/asking a question rather than running a batch operation.

  When in doubt, read items inline. The orchestration overhead of /enumerate is wasteful for small batches and confusing for exploratory work.

  Explicit user invocation (`/enumerate ...`) bypasses these rules — the user knows what they want.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --file <spec.md> | --list "<prompt>" --task "<prompt>" [--run-id NAME] [--concurrency N] [--chunk-size N|auto] [--model haiku|sonnet|opus] [--no-auto-continue]
---

# /enumerate

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/enumerate/` (this folder: SKILL.md + defaults.md + task-kinds.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/enumerate.js`) — shared framework across primitives
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)
>
> All paths in this file are **relative to the workspace root** (the dir where Claude Code runs). No absolute references.

You are the **orchestrator** of a `/enumerate` run. Your only job:
1. resolve a (deterministic) list of items from a source,
2. dispatch items to subagents in parallel chunks,
3. persist state at every step.

**The state file is the source of truth** — not the conversation. You are the only writer of state. Subagents process items and return results; they NEVER write to state.

## List-prompt and task-prompt sources

Two input forms, never mixed:

### Form A — structured markdown file
```
/enumerate --file path/to/spec.md
```
The file has YAML frontmatter (config overrides) plus `## List` and `## Task` sections:
```markdown
---
run-id: run-name
concurrency: 4
chunk-size: auto
model: sonnet
auto-continue: true
---

## List
<prompt that produces the list — MUST request a JSON array>

## Task
<prompt to run for each item — receives the item's `data` as context>
```

### Form B — inline flags
```
/enumerate --list "<list-prompt>" --task "<task-prompt>" \
           [--run-id NAME] [--concurrency N] [--chunk-size N|auto] \
           [--model haiku|sonnet|opus] [--max-retries N] \
           [--no-auto-continue]
```

If either list-prompt or task-prompt is missing → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/enumerate/defaults.md` (YAML frontmatter). Extract defaults. When a value is missing in CLI or spec, use the default from here.

**Override priority** (high → low):
1. CLI flag
2. Spec frontmatter (Form A)
3. defaults.md
4. Hardcoded fallback in the state helper

If `defaults.md` is missing or unparseable: use the hardcoded fallback and surface a WARNING to the user (non-blocking).

## Step 1 — Parse and validate

- Determine form A or B.
- If A: `Read` the spec, parse frontmatter + `## List` / `## Task` sections.
- Resolve the final config by priority.
- If `run-id` is missing: generate a deterministic `enum-<8 char hash>` from the hash of the list-prompt.

## Step 1.5 — Task preflight enrichment

Read `${CLAUDE_PLUGIN_ROOT}/skills/enumerate/task-kinds.md`. Classify the user's task-prompt into one of the kinds (`code-review`, `transformation`, `extraction`, `validation`, `audit`, `unknown`).

**Explicit override**: if the user passed `--kind <name>` (CLI) or `kind: <name>` (spec frontmatter), use it and skip classification.

**Automatic classification** (when no override):
- Keyword match (see table in `task-kinds.md`).
- Priority among multiple matches: `audit > code-review > validation > transformation > extraction`.
- If no match OR task-prompt < 80 chars with generic verbs ("check", "look", "see if"): kind = `unknown`.

**If kind = unknown**: use `AskUserQuestion` with the question + options described in `task-kinds.md`. Map the choice to a kind. If the user picks "other" with a description: enrich using the `unknown` fallback.

**Effective model**: the kind template suggests a model (haiku/sonnet/opus). If the user did NOT force `--model`, use the suggested one. If they did force, honor the user's choice but log "kind=X would suggest Y, forced to Z".

**Enriched task-prompt**: do NOT pre-enrich manually in this step. Instead, pass `--kind <name>` to `state/enumerate.js init` (Step 2). The state helper loads the matching template from `task-kinds.md`, prepends it to the user task-prompt, and stores the enriched prompt in state.task_prompt + the chosen kind in state.config.kind. This way the enrichment happens once, in one place, and any downstream resume (including /pipe-spawned children whose dispatch loop bypasses this SKILL flow) uses the already-enriched prompt without re-doing the work.

Confirm to the user in a single line: `run-id`, `kind`, `effective model`, `concurrency`, `chunk-size`, `auto-continue`, first 150 chars of list-prompt and user task-prompt.

## Step 2 — Resolve list

You execute the list-prompt yourself (DO NOT delegate to a subagent — it's cheap and we want determinism).

**Required output**: a JSON array of objects, each with a unique `id`. Example:
```json
[
  {"id": "src/foo.py", "data": {"path": "src/foo.py"}},
  {"id": "src/bar.py", "data": {"path": "src/bar.py"}}
]
```

If the list-prompt does not already specify the format, **add it yourself** before running it: explicitly request "Output: JSON array of {id, data}, no prose, no fence".

If the prompt is of the form "find files matching X" and you can do it deterministically with `Glob`/`Grep`, do that directly — preferable to generating the list from memory.

**Pre-existing items file (`/group` composition)**: if the user already has a JSON array of `{id, data}` (e.g. the `groups.json` produced by `/group`), skip list resolution entirely. Copy or read the file and write it as `.enumerate/<run-id>/items.json`, then call `init`. This is the canonical `/group → /enumerate` composition: each "item" enumerate processes is a whole group with `data: {group_id, items, size}`.

**Threshold guardrail** (after the list is resolved, BEFORE init): if `len(items) < min_items` from defaults (default 15) AND this is an autonomous invocation (not the user typing `/enumerate` explicitly), STOP and use `AskUserQuestion`:
> "Only <N> items found. /enumerate adds orchestration overhead (state file, chunk dispatch, Stop hook). For this size it's usually faster to read them inline in this agent. Proceed with /enumerate anyway?"
> Options: **inline** (cancel /enumerate, the main agent processes them directly) | **proceed** (continue with /enumerate as planned)

If the user typed `/enumerate` explicitly → skip the guardrail (consider it consent).

Save the JSON to `.enumerate/<run-id>/items.json` with `Write`. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" init <run-id> \
  --items .enumerate/<run-id>/items.json \
  --task-prompt "<user task-prompt verbatim>" \
  --kind <code-review|transformation|extraction|validation|audit|unknown> \
  --concurrency <N> --chunk-size <N|auto> \
  --max-retries <N> --max-auto-continues <N> \
  --model <inherit|haiku|sonnet|opus> \
  [--auto-continue|--no-auto-continue] \
  [--force]
```

The state helper handles `--kind` by reading `${CLAUDE_PLUGIN_ROOT}/skills/enumerate/task-kinds.md`, prepending the matching template to the user task-prompt, and storing the result in `state.task_prompt`. After init the prompt is already enriched; downstream dispatch uses it as-is.

If the run-id exists **without `--force`**: ask the user to choose `resume` (skip init, process pending) or `reset` (start over). DO NOT overwrite without confirmation.

## Step 3 — Compute effective chunk_size

- If config says `chunk_size: <int>`: use it.
- If `auto`: compute `chunk = max(1, min(50, ceil(total / concurrency)))`.
- Example: 10 items, concurrency 4 → chunk = 3 → 4 Agents handle [3,3,3,1] in 1 wave.
- Example: 1000 items, concurrency 4 → chunk = 50 → 20 chunks total in 5 waves.

## Step 4 — Dispatch loop

For each iteration (safety cap: max 100):

1. **Status check**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" status <run-id>
   ```
   If `pending == 0 && in_progress == 0`: exit the loop, go to Step 5.

2. **Claim wave**: claim `concurrency * chunk_size` items:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" claim <run-id> --count <concurrency * chunk_size>
   ```
   Output: JSON array of items just marked `in_progress`.

3. **Split into chunks**: divide the array into at most `concurrency` chunks, each with up to `chunk_size` items. If claim returned fewer items than expected (end of queue), make smaller chunks — one chunk per Agent.

4. **Prepare chunk files**: write each chunk (array of items) to `.enumerate/<run-id>/wave-<W>-chunk-<N>.json` via `Write`. Subagents read this as compact input; the orchestrator keeps it as reference if a subagent fails to write.

5. **Parallel fan-out**: launch one Agent **per chunk**, **all in the same message** (single message, multiple `Agent` tool uses). For each Agent:
   - `subagent_type`: from config (default `general-purpose`)
   - `model`: from config if not `inherit`, otherwise omitted
   - `description`: short, format `enum:<run-id>:chunk-<N>`
   - `prompt`: **self-contained** (the subagent does not see this conversation). Include:
     - the **enriched** task-prompt from preflight (see Step 1.5)
     - chunk file path: `.enumerate/<run-id>/wave-<W>-chunk-<N>.json` (list of `{id, data}`)
     - output file path: `.enumerate/<run-id>/results-chunk-<N>.json`
     - **strict I/O rules**:
       - "Run the analysis silently. DO NOT comment while working. DO NOT emit draft output."
       - "When done, write the result to `.enumerate/<run-id>/results-chunk-<N>.json` via the `Write` tool: a JSON array `[{"id": "...", "ok": true|false, "result": <any>, "error": <string|null>}, ...]` covering ALL items in the chunk."
       - "The array MUST be the ONLY thing in the file. No prose, no markdown fence."
       - "Your final response to the orchestrator must be: a single line `OK <N>` where N is the count of items processed. Nothing else."

6. **Record budget + commit results** (single-writer model, **bulk**): for each completed chunk N, do BOTH of:

   **6a. Budget**: every Agent tool return includes a `<usage>total_tokens: N ...</usage>` block. Extract `total_tokens` and record it as a budget event:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" budget-add <run-id> \
     --tokens <total_tokens_from_agent_usage> \
     --model <model_from_config> \
     --event-type agent_dispatch \
     --meta '{"chunk": <N>, "wave": <W>}'
   ```
   Do this once per Agent return (one `budget-add` per chunk). Cost tracking aggregates across all chunks; `/inspect budget <run-id>` will show the cumulative figures.

   **6b. State commit**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" complete-batch <run-id> --results .enumerate/<run-id>/results-chunk-<N>.json
   ```
   `complete-batch` reads the array and commits in one shot (atomic save). Items with `ok: false` are placed in retry/failed automatically following `max_retries`.

   Order matters: record budget first (always succeeds even if the result file is malformed), then commit state. That way a parsing failure does not lose the cost signal.

   **Degenerate cases**:
   - File `results-chunk-<N>.json` missing or unparseable: mark every item in the chunk as `fail --retry` with error "agent crashed / no result file". Use `claim` + manual `fail --retry` for each item in the chunk.
   - File present but only covers M < N items: `complete-batch` applies the M present; the rest stay `in_progress`. Mark them manually as `fail --retry` with error "missing in agent output".
7. **Continue?**: if `auto_continue == false`, exit and show status. Otherwise go back to step 1.

## Step 5 — Final report

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" status <run-id>
node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" list <run-id> --status failed --limit 20
```

Print: totals per status, and — if any `failed` — a compact list with error truncated to 200 chars.

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) exists that:
- at the end of each turn, scans `.enumerate/`,
- if it finds a run with `auto_continue=true` and residual work,
- forces Claude to continue in the next turn with the instruction "resume /enumerate <run-id>".

Cap: `max_auto_continues` per run (default 20). Beyond that, the hook stops.

**When this hook re-activates you** (you'll see a system message with the run-id):
- DO NOT re-init. Go directly to **Step 4 (dispatch loop)** for the given run-id.
- If you see items `in_progress` inherited from a prior turn that died midway:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" reset <run-id> --in-progress-to-pending
  ```

## Important rules

- **Single-writer**: only you (orchestrator) call `complete`/`fail`. Subagents NEVER write to state.
- **Real fan-out**: Agents within a wave MUST be launched in the same message. Sequential = lost parallelism.
- **No silent skip**: every item ends `done` or `failed`. Never left `in_progress`.
- **Safety cap**: max 100 iterations of the loop. If reached, stop.
- **Context economy**: store only the structured result (the final JSON) in state, not the subagent's full text output.
- **Idempotence**: `/enumerate` with the same run-id without `--force` must be able to resume.

## Quick example

```
/enumerate --file examples/spec-example.md
```

```
/enumerate --list "find every .md under examples/ — output JSON array of {id: path, data: {path}}" \
           --task "read the file and report {wc, has_frontmatter, sections}" \
           --concurrency 3 --chunk-size auto --model sonnet
```
