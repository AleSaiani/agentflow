---
name: foreach
description: |
  Apply ONE operation to EVERY item of a list — the **map** (N→N). The operation is a prompt; items
  come from a JSON list, a markdown checklist, or another run's output. Runs in parallel subagents or
  inline in the main thread, with persistent state and cross-turn auto-continue.

  USE on any "do the same thing to each of these" intent — formal OR casual: "for each X…", "per ogni…",
  "go through these one by one", "do every item in TODO.md", "review each of these files", "handle all
  of them", a glob, a folder. Trigger on the INTENT, then judge by count (the count gate, Step 2.5):
  - 1–2 items → just do it inline, no machinery;
  - a borderline handful (~3–10) → ask whether to use the durable/parallel mechanism or handle inline;
  - genuinely many, or heavy/independent items → use foreach.

  DON'T use when the list must first be generated from a spec (→ /agentflow:enumerate, then foreach), or you
  need one combined output (→ /agentflow:reduce). For the prebuilt "review every file → digest", use /agentflow:audit.

  Explicit invocation (`/agentflow:foreach …`) skips the count check — the user already chose the mechanism.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: (--items <json> | --checkbox <md> | --folder <dir> | --source <spec>) (--prompt "<operation>" | --prompt-file <path>) [--kind code-review|transformation|extraction|validation|audit] [--execution main-thread|subagent] [--model haiku|sonnet|opus] [--subagent-type <name>] [--serial] [--carry] [--shard k/N] [--stop-file <path>] [--concurrency N] [--cache] [--no-auto-continue]
---

# /agentflow:foreach

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/foreach/` (this folder: SKILL.md + defaults.md + task-kinds.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/foreach.js`) — shared framework across primitives
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)
>
> All paths in this file are **relative to the workspace root** (the dir where Claude Code runs). No absolute references.

You are the **orchestrator** of a `/agentflow:foreach` run. Your only job:
1. resolve a (deterministic) list of items from a source,
2. dispatch items to subagents in parallel chunks,
3. persist state at every step.

**The state file is the source of truth** — not the conversation. You are the only writer of state. Subagents process items and return results; they NEVER write to state.

## Invocation

`foreach` **consumes** a list — it does not generate one. To produce a list from a spec, run
/agentflow:enumerate first and pass its output here. Provide exactly one source plus the operation:

**Source (one of):**
- `--items <file.json>` — a JSON array of `{id, data, task?}`
- `--checkbox <file.md>` — a markdown checklist (`[x]`/`[ ]`; inline `{model:…, subagent:…}` → per-item task)
- `--folder <dir>` — a file kanban (`todo/` / `in-progress/` / `done/`, or a flat folder = all pending)
- `--source '<json>'` — an explicit SourceSpec (incl. `{"source":"run","cmd":"…","run_id":"…"}`)

**Operation (the per-item instructions, one of):**
- `--prompt "<instructions applied to each item>"` — inline, the primary config
- `--prompt-file <path>` — read the operation from a file (use for long/multi-line prompts);
  mutually exclusive with `--prompt`

**Optional knobs:** `--kind <code-review|…>`, `--model …`, `--subagent-type <name>` (which agent
runs each item; per-item override via `{subagent:…}` in a checklist), `--execution main-thread|subagent`,
`--concurrency N`, `--chunk-size N|auto`, `--max-retries N`, `--cache`, `--run-id NAME`,
`--no-auto-continue`, `--force`, plus **serial mode**:
- `--serial` — process **one item at a time, in list order** (no fan-out; forces `concurrency 1`,
  `chunk 1`). Use when items must not run concurrently (shared resource, rate limit, ordering matters).
- `--carry` — implies `--serial` **and** feeds each item the **previous item's output** (a sequential
  scan / accumulation). Each step depends on the one before it.
- `--shard k/N` — keep only the items at positions `index % N == k`. Run **N terminals** with
  `k = 0..N-1` and **distinct run-ids** to split one list across processes — each shard is its own
  state file, so there are no concurrent writers (read-partition, no locks).
- `--stop-file <path>` — a **pause gate**: while this file exists, the dispatch loop stops claiming
  new items and the Stop hook does **not** auto-resume the run. Delete the file (and send a message)
  to continue. Lets you halt/resume external workers by touching a file.

**Invoked with natural language?** (e.g. `/agentflow:foreach review every .cs file in src/ for bugs`) —
translate the user's words into a source + `--prompt`, don't ask them for flags. If they name files you
can list deterministically (a glob, a folder), build the items list yourself with `Glob`/`Grep` (or use
`--folder`); only if the list must be *generated* from a higher-level spec do you need /agentflow:enumerate
first. If no source and no operation can be inferred → ask one short clarifying question.

## Folder-kanban flow (`--folder`)

With `--folder`, `state.json` is authoritative **and the engine moves the files for you,
automatically** — you don't run `view` and you don't read the engine source. The file base is stored
in `config.folder` at `init`; every state transition projects onto the board in the same call:

- `claim` → moves the item's file `todo/ → in-progress/`.
- `complete` / `complete-batch` → moves it `in-progress/ → done/` (a terminal `fail` also lands in
  `done/`; a retried item goes back to `todo/`).
- The subfolders are created on demand; a flat folder (no subfolders) is treated as all-pending, and
  files migrate into `todo/`/`in-progress/`/`done/` as they're worked.

Each item's `data.file` is its filename; `data.path` is the absolute path to read while processing.
`view <run-id> --folder <dir>` still exists as a **manual resync** (e.g. after editing state by hand),
but you should not need it during a normal run.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/foreach/defaults.md` (YAML frontmatter). Extract defaults. When a value is missing in CLI or spec, use the default from here.

**Override priority** (high → low): CLI flag > defaults.md > the state helper's built-in fallback. If
`defaults.md` is missing or unparseable, use the fallback and surface a non-blocking WARNING.

## Step 1 — Parse and validate

- Confirm exactly one source flag (`--items` / `--checkbox` / `--folder` / `--source`) and the
  operation `--prompt` are present.
- Resolve config by priority.
- If `run-id` is missing: derive a deterministic `foreach-<8 char hash>` from the source + prompt.

## Step 1.5 — Task preflight enrichment

Read `${CLAUDE_PLUGIN_ROOT}/skills/foreach/task-kinds.md`. Classify the user's task-prompt into one of the kinds (`code-review`, `transformation`, `extraction`, `validation`, `audit`, `unknown`).

**Explicit override**: if the user passed `--kind <name>` (CLI) or `kind: <name>` (spec frontmatter), use it and skip classification.

**Automatic classification** (when no override):
- Keyword match (see table in `task-kinds.md`).
- Priority among multiple matches: `audit > code-review > validation > transformation > extraction`.
- If no match OR task-prompt < 80 chars with generic verbs ("check", "look", "see if"): kind = `unknown`.

**If kind = unknown**: use `AskUserQuestion` with the question + options described in `task-kinds.md`. Map the choice to a kind. If the user picks "other" with a description: enrich using the `unknown` fallback.

**Effective model**: the kind template suggests a model (haiku/sonnet/opus). If the user did NOT force `--model`, use the suggested one. If they did force, honor the user's choice but log "kind=X would suggest Y, forced to Z".

**Enriched task-prompt**: do NOT pre-enrich manually in this step. Instead, pass `--kind <name>` to `state/foreach.js init` (Step 2). The state helper loads the matching template from `task-kinds.md`, prepends it to the user task-prompt, and stores the enriched prompt in state.task_prompt + the chosen kind in state.config.kind. This way the enrichment happens once, in one place, and any downstream resume (including /agentflow:pipe-spawned children whose dispatch loop bypasses this SKILL flow) uses the already-enriched prompt without re-doing the work.

Confirm to the user in a single line: `run-id`, `kind`, `effective model`, `concurrency`, `chunk-size`, `auto-continue`, first 150 chars of list-prompt and user task-prompt.

## Step 2 — Resolve items, gate by count, init

1. **Resolve** the items from the chosen source — `foreach` does NOT invent the list. The state
   helper reads `--items` / `--checkbox` / `--folder` / `--source` at `init`; you don't pre-generate
   anything. (Need a list produced from a spec? That's /agentflow:enumerate — its `items.json` becomes your
   `--items`.) A `groups.json` from /agentflow:group is items.json-compatible: pass it as `--items`, and
   each item is a whole group (`data: {group_id, items, size}`).

2. **Count gate** (skip if the user invoked `/agentflow:foreach` explicitly). Read the source to get the
   item count, then:
   - **≤ 2** → do the work inline this turn; no state, no subagents.
   - **~3–10** → `AskUserQuestion`: *"N items — run the durable/parallel mechanism (resumable across
     turns), or handle them inline now?"* Proceed per the answer.
   - **> 10** (or fewer but heavy/independent) → proceed.

   This is what lets the skill trigger on a casual "do X for each of these" without forcing the full
   mechanism onto a handful of items.

3. **Init** (when proceeding):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" init <run-id> \
     (--items <file> | --checkbox <md> | --folder <dir> | --source '<json>') \
     (--prompt "<operation, verbatim>" | --prompt-file <path>) \
     [--kind <code-review|transformation|extraction|validation|audit>] \
     [--execution main-thread|subagent] [--model <inherit|haiku|sonnet|opus>] [--subagent-type <name>] \
     [--serial] [--carry] [--shard <k/N>] [--stop-file <path>] \
     [--concurrency <N>] [--chunk-size <N|auto>] [--max-retries <N>] [--cache] \
     [--max-auto-continues <N>] [--auto-continue|--no-auto-continue] [--force]
   ```
   The state helper applies `--kind` (prepends the matching `task-kinds.md` template to `--prompt` and
   stores the enriched prompt in `state.task_prompt`). If the run-id exists **without `--force`**: ask
   `resume` (process pending) or `reset` (start over) — never overwrite silently.

## Step 3 — Compute effective chunk_size

- If config says `chunk_size: <int>`: use it.
- If `auto`: compute `chunk = max(1, min(50, ceil(total / concurrency)))`.
- Example: 10 items, concurrency 4 → chunk = 3 → 4 Agents handle [3,3,3,1] in 1 wave.
- Example: 1000 items, concurrency 4 → chunk = 50 → 20 chunks total in 5 waves.

## Operation config & execution mode

The operation applied to each item is, first and foremost, a **prompt** (`--prompt`, the
instructions). `--model` and `--subagent-type` are optional. `--execution` chooses how the work runs:

- **`subagent`** (default): fan claimed items out to parallel `Agent` calls (the dispatch loop below).
- **`main-thread`**: the orchestrator processes each claimed item **inline** — read it, do the work
  in this thread, `complete` it — with no `Agent` dispatch. Use for cheap/short operations or when
  you want everything in one context. The state mechanics (`claim` → `complete-batch`) are identical;
  only who does the work changes. Read `config.execution` and branch accordingly.

**Serial / carry** (`config.serial` / `config.carry`): when either is set, do **not** fan out. Process
one item at a time in list order using `claim-serial` (see Step 4b). `serial` alone is a throttle
(items stay independent); `carry` additionally threads each item the previous item's result. These
work with either execution mode (a single subagent per item, or inline).

## Step 4 — Dispatch loop

For each iteration (safety cap: max 100):

1. **Status check**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" status <run-id>
   ```
   If `pending == 0 && in_progress == 0`: exit the loop, go to Step 5.
   If `paused == true` (a `--stop-file` is present): **stop claiming**, report the run is paused, and
   exit — the Stop hook will not auto-resume until the file is removed. (Same check applies in Step 4b.)

2. **Claim wave**: claim `concurrency * chunk_size` items:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" claim <run-id> --count <concurrency * chunk_size>
   ```
   Output: JSON array of items just marked `in_progress`.

3. **Split into chunks**: divide the array into at most `concurrency` chunks, each with up to `chunk_size` items. If claim returned fewer items than expected (end of queue), make smaller chunks — one chunk per Agent.

4. **Prepare chunk files**: write each chunk (array of items) to `.agentflow/foreach/<run-id>/wave-<W>-chunk-<N>.json` via `Write`. Subagents read this as compact input; the orchestrator keeps it as reference if a subagent fails to write.

5. **Parallel fan-out**: launch one Agent **per chunk**, **all in the same message** (single message, multiple `Agent` tool uses). For each Agent:
   - `subagent_type`: from config (default `general-purpose`)
   - `model`: from config if not `inherit`, otherwise omitted
   - `description`: short, format `enum:<run-id>:chunk-<N>`
   - `prompt`: **self-contained** (the subagent does not see this conversation). Include:
     - the **enriched** task-prompt from preflight (see Step 1.5)
     - chunk file path: `.agentflow/foreach/<run-id>/wave-<W>-chunk-<N>.json` (list of `{id, data}`)
     - output file path: `.agentflow/foreach/<run-id>/results-chunk-<N>.json`
     - **strict I/O rules**:
       - "Run the analysis silently. DO NOT comment while working. DO NOT emit draft output."
       - "When done, write the result to `.agentflow/foreach/<run-id>/results-chunk-<N>.json` via the `Write` tool: a JSON array `[{"id": "...", "ok": true|false, "result": <any>, "error": <string|null>}, ...]` covering ALL items in the chunk."
       - "The array MUST be the ONLY thing in the file. No prose, no markdown fence."
       - "Your final response to the orchestrator must be: a single line `OK <N>` where N is the count of items processed. Nothing else."

6. **Record budget + commit results** (single-writer model, **bulk**): for each completed chunk N, do BOTH of:

   **6a. Budget**: every Agent tool return includes a `<usage>total_tokens: N ...</usage>` block. Extract `total_tokens` and record it as a budget event:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" budget-add <run-id> \
     --tokens <total_tokens_from_agent_usage> \
     --model <model_from_config> \
     --event-type agent_dispatch \
     --meta '{"chunk": <N>, "wave": <W>}'
   ```
   Do this once per Agent return (one `budget-add` per chunk). Cost tracking aggregates across all chunks; `/agentflow:inspect budget <run-id>` will show the cumulative figures.

   **6b. State commit**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" complete-batch <run-id> --results .agentflow/foreach/<run-id>/results-chunk-<N>.json
   ```
   `complete-batch` reads the array and commits in one shot (atomic save). Items with `ok: false` are placed in retry/failed automatically following `max_retries`.

   Order matters: record budget first (always succeeds even if the result file is malformed), then commit state. That way a parsing failure does not lose the cost signal.

   **Degenerate cases**:
   - File `results-chunk-<N>.json` missing or unparseable: mark every item in the chunk as `fail --retry` with error "agent crashed / no result file". Use `claim` + manual `fail --retry` for each item in the chunk.
   - File present but only covers M < N items: `complete-batch` applies the M present; the rest stay `in_progress`. Mark them manually as `fail --retry` with error "missing in agent output".
7. **Continue?**: if `auto_continue == false`, exit and show status. Otherwise go back to step 1.

## Step 4b — Serial / carry dispatch (when `config.serial` or `config.carry`)

If either flag is set, **replace Step 4's wave/fan-out** with this one-at-a-time loop (no parallel
Agents). Each iteration handles a single item, in list order, and is resumable across turns:

1. **Claim the next item**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" claim-serial <run-id>
   ```
   Returns `{item, prev_id, prev_result}`. If `item == null` → done, go to Step 5. `prev_result` is the
   output of the item that ran just before this one (reconstructed from disk, so it's correct even after
   a resume).
2. **Process the item** (one item, so no chunk file needed):
   - `config.execution == "subagent"`: dispatch **one** Agent for this item (same self-contained prompt
     + strict I/O rules as Step 4.5, writing a 1-element results array).
   - `config.execution == "main-thread"`: do the work inline.
   - **If `config.carry`**: prepend the previous result to the operation, e.g. *"Previous item's output
     (build on it): <prev_result>"*. On the first item `prev_result` is null — say "this is the first item".
3. **Commit** with `complete <run-id> <item-id> --result '<json>'` (or `fail … --retry`), record budget,
   then loop to 1. Honor `auto_continue` exactly as in Step 4.7.

Because items are committed one by one, the Stop hook resumes mid-list cleanly and `claim-serial`
re-hands an interrupted `in_progress` item without double-counting attempts.

## Sharding across terminals (`--shard k/N`)

To split one big list across **N parallel terminals/sessions**, init **N separate runs** with distinct
run-ids, each taking one shard of the items (positions where `index % N == k`):

```bash
# terminal 1
/agentflow:foreach --items work.json --shard 0/3 --run-id work-0 --prompt "<op>"
# terminal 2
/agentflow:foreach --items work.json --shard 1/3 --run-id work-1 --prompt "<op>"
# terminal 3
/agentflow:foreach --items work.json --shard 2/3 --run-id work-2 --prompt "<op>"
```

Each run is its own `state.json`, so there are no concurrent writers (read-partition, no locks). The
shards are disjoint, so even a `--folder` source is safe (each terminal only moves its own files).
Pair with `--stop-file` to pause every worker by touching one file. `/agentflow:board` shows all shards.

## Step 5 — Final report

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" status <run-id>
node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" list <run-id> --status failed --limit 20
```

Print: totals per status, and — if any `failed` — a compact list with error truncated to 200 chars.

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) exists that:
- at the end of each turn, scans `.agentflow/foreach/`,
- if it finds a run with `auto_continue=true` and residual work,
- forces Claude to continue in the next turn with the instruction "resume /agentflow:foreach <run-id>".

Cap: `max_auto_continues` per run (default 20). Beyond that, the hook stops.

**When this hook re-activates you** (you'll see a system message with the run-id):
- DO NOT re-init. Go directly to **Step 4 (dispatch loop)** for the given run-id.
- If you see items `in_progress` inherited from a prior turn that died midway:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" reset <run-id> --in-progress-to-pending
  ```

## Important rules

- **Single-writer**: only you (orchestrator) call `complete`/`fail`. Subagents NEVER write to state.
- **Real fan-out**: Agents within a wave MUST be launched in the same message. Sequential = lost parallelism.
- **No silent skip**: every item ends `done` or `failed`. Never left `in_progress`.
- **Safety cap**: max 100 iterations of the loop. If reached, stop.
- **Context economy**: store only the structured result (the final JSON) in state, not the subagent's full text output.
- **Idempotence**: `/agentflow:foreach` with the same run-id without `--force` must be able to resume.

## Quick example

```bash
# files.json: [{"id":"src/a.cs","data":{"path":"src/a.cs"}}, {"id":"src/b.cs","data":{"path":"src/b.cs"}}]
/agentflow:foreach --items files.json --kind code-review --cache \
           --prompt "Review this file for bugs; report {severity, findings}"
```

Or drive a checklist / a folder kanban directly (no JSON to build):
```bash
/agentflow:foreach --checkbox TODO.md --prompt "Complete this task"
/agentflow:foreach --folder tasks    --prompt "Do the task described in this file"
```
