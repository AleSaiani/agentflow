# Reference

Everything Agent Flow can do, and how. You normally invoke a **skill** (`/agentflow:<name>`) and Claude drives
the underlying CLI for you; the CLI is documented here too for power users and for understanding what
the skill does. All state lives in `state.json` under `.agentflow/<cmd>/<run-id>/` at the workspace root.

- [Quick map](#quick-map)
- [The primitives](#the-primitives) — enumerate · foreach · reduce · group · loops · pipe
- [Authoring & running workflows](#authoring--running-workflows) — compose · run
- [Inspecting](#inspecting) — inspect · board
- [Workflow-file schema](#workflow-file-schema)
- [Sources & views](#sources--views)
- [Conventions](#conventions) — cross-turn, budget, cache, models

## Quick map

| Skill | Verb | One-liner |
|---|---|---|
| `enumerate` | unfold 1→N | generate a list of items from a spec |
| `foreach` | map N→N | apply one operation to each item |
| `reduce` | fold N→1 | collapse many inputs into one digest |
| `group` | partition | split items into K groups by key |
| `repeat` / `until` / `while` | loop | run a stage by count / do…until / while…do |
| `pipe` | compose | run an ordered pipeline of stages |
| `run-workflow` | execute | run a workflow-file end to end |
| `create-workflow` | author | build a reusable workflow-file |
| `inspect` / `board` / `history` | observe | read-only status, trees, budget, dashboard, and a time-ordered run log |
| `audit` | recipe | discover → review → partition → digest |

The engine CLIs are `node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" <subcommand> <run-id> [flags]`
and `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" <subcommand>`. Loops (`repeat`/`until`/`while`)
share the `iterate.js` engine.

---

## The primitives

### `enumerate` — unfold (1 → N)

Generate a list of items from a higher-level spec (outline → chapters, feature → tasks). Produces an
`items.json` array consumed by `foreach` or `group`. The complement of `reduce`.

**Invoke:** `/agentflow:enumerate --prompt "<what list to produce>" [--input <source>]`

**CLI** (`dist/state/enumerate.js`):
- `init <id> --prompt "<instructions>" [--input <path>] [--model …] [--execution main-thread|subagent] [--max-auto-continues N] [--force] [--validate-only]`
- `start <id>` · `complete <id> --items-path <file>` (validates JSON array) · `fail <id> --error "…"`
- `status <id>` · `runs` · `increment-continues <id>` · `budget-add <id> [--tokens N] [--model …]`

**Output:** `result_pointer` → the items.json. Item shape: `{"id":"<slug>","data":{…}}`.

### `foreach` — map (N → N)

Apply one operation to every item, in parallel chunks across subagents **or** inline in the main
thread. The operation is a **prompt**; model and subagent are optional.

**Invoke:** `/agentflow:foreach (--items <json> | --checkbox <md> | --folder <dir> | --source <spec>) (--prompt "<operation>" | --prompt-file <path>) [--kind …] [--serial] [--carry] [--execution main-thread|subagent] [--cache]`

The operation is, primarily, a **`--prompt`** (the instructions applied per item) — or `--prompt-file
<path>` to read it from a file. `--model`, `--subagent-type` (which agent runs each item) and
`--execution main-thread` are optional knobs. **`--serial`** processes one item at a time in list
order (no fan-out); **`--carry`** implies serial and threads each item the previous item's output.
**`--shard k/N`** keeps only items at `index % N == k` (run N terminals with distinct run-ids to split
a list, no locks); **`--stop-file <path>`** pauses the run (and the Stop hook) while that file exists.

**CLI** (`dist/state/foreach.js`):
- `init <id> (--items <path> | --checkbox <path> | --folder <dir> | --source <json>) (--prompt "…" | --prompt-file <path>) [--kind code-review|transformation|extraction|validation|audit] [--serial] [--carry] [--shard k/N] [--stop-file <path>] [--cache] [--model …] [--concurrency N] [--chunk-size N|auto] [--max-retries N] [--execution main-thread|subagent] [--subagent-type …] [--force] [--validate-only]`
- `claim <id> --count N` · `claim-serial <id>` (next item in order + `prev_result` for `--carry`) · `complete <id> <item-id> [--result <json>]` · `fail <id> <item-id> [--error "…"] [--retry]`
- `complete-batch <id> --results <file>` (array of `{id, ok, result, error}`)
- `status <id>` · `list <id> [--status …] [--limit N]` · `reset <id> [--failed-to-pending] [--in-progress-to-pending]`
- `view <id> (--checkbox <path> | --folder <dir>)` (write-back: toggle checklist boxes / move kanban files to match status) · `runs` · `budget-add` · `increment-continues`

**Per-item overrides:** items may carry `task: {prompt, model, subagentType}`; dispatch resolves
`item.task?.X ?? config.X`. Checkbox annotations (`{model:opus, subagent:code-reviewer}`) populate it.

### `reduce` — fold (N → 1)

Collapse N inputs into one digest (markdown or JSON) via a single agent.

**Invoke:** `/agentflow:reduce --inputs <descriptors> --prompt "<synthesis instructions>" [--output-format markdown|json]`

**CLI** (`dist/state/reduce.js`):
- `init <id> --inputs <path> [--prompt "…"] [--model …] [--output-format markdown|json] [--force] [--validate-only]`
- `materialize <id> --out <file>` (resolves run/file/inline inputs into one file for the agent)
- `start <id>` · `complete <id> --output-path <file>` · `fail <id> --error "…"`
- `status <id>` · `runs` · `budget-add` · `increment-continues`

**Inputs** is a JSON array of descriptors: `{"source":"run","cmd":"foreach","run_id":"…"}` |
`{"source":"file","path":"…"}` | `{"source":"inline","data":…}`.

### `group` — partition

Split items into K groups by key. Output `groups.json` is `items.json`-compatible — feed it to
`foreach` to process per group.

**Invoke:** `/agentflow:group --method path-prefix|regex|jsonpath|llm-classify --input-source <descriptor>`

**CLI** (`dist/state/group.js`):
- `init <id> --method <m> --input-source <path> [--method-config '{…}'] [--model …] [--min-items N] [--force] [--validate-only]`
- `run-deterministic <id>` (path-prefix / regex / jsonpath — fully automatic)
- `prepare-classify <id>` + `apply-classification <id> --mapping <file>` (llm-classify: one agent returns `{item_id: group_id}`)
- `fail <id>` · `status <id>` · `runs` · `budget-add` · `increment-continues`

**method-config:** path-prefix `{"depth":1}` · regex `{"pattern":"^([A-Z]+)-","field":"id"}` ·
jsonpath `{"path":"data.component"}`.

### Loops — `repeat` · `until` · `while` (engine: `iterate`)

One engine, three ergonomic skills. Runs **one iteration per turn** by default; the Stop hook resumes
the next across turns. Each iteration captures stdout; env: `ITER_INDEX`, `ITER_OUTPUT_PATH`,
`ITER_PREV_OUTPUT_PATH`.

| Skill | Semantics | Init |
|---|---|---|
| `repeat` | fixed count (`for`) | `--stage "<cmd>" --times N` |
| `until` | do…until (run, then check) | `--stage "<cmd>" --stop "<predicate>"` |
| `while` | while…do (check first) | `--stage "<cmd>" --stop "<predicate>" --mode while --check-first` |

`--stage` and `--stop` accept a **plain bash command string** or a JSON `{type, command, mode?}`.

**CLI** (`dist/state/iterate.js`):
- `init <id> --stage "<cmd>" (--stop "<predicate>" [--mode until|while] | --times N) [--check-first] [--max-iterations N] [--no-convergence-check] [--model …] [--force] [--validate-only]`
- `run-iteration <id>` → `{action:"continue"|"stop", reason, …}` · `kill <id>` · `fail <id>` · `status <id>` · `runs` · `budget-add` · `increment-continues`

Stop reasons: `predicate_satisfied | max_iterations | convergence | stage_failed | killed`.
Predicate exit codes: `until` → exit 0 = stop; `while` → exit 0 = continue.

### `pipe` — compose

Run an ordered pipeline of stages (bash / json / a primitive). Holds no loop/map/fold of its own;
loops come from an `iterate` stage. Reads children's state to advance; never mutates them.

**CLI** (`dist/state/pipe.js`):
- `init <id> (--stages <json> | --workflow <json>) [--param name=value …] [--context-policy …] [--max-stages N] [--no-stop-on-failure] [--skip-validate-stages] [--force]`
- `tick <id>` → next action · `drive <id> [--max-steps N]` → auto-run until an agent is needed · `plan <id>` → **dry-run** the resolved stage plan
- `complete-bash-stage <id> --exit-code N --output-path <f> [--error "…"]` · `complete-json-stage <id> --output-path <f>`
- `start-primitive-child <id> --child-cmd <cmd> --child-run-id <id>` · `advance <id>` · `fail <id>` · `status <id>` · `runs` · `budget-add`

`drive` auto-handles bash, json, and deterministic `group` stages; it stops with
`{"action":"needs_agent", …}` when an `enumerate`/`foreach`/`reduce`/`llm-classify` dispatch is required.

---

## Authoring & running workflows

### `create-workflow` — author a workflow-file

Design a reusable `WorkflowSpec` JSON that wires the primitives, validate it, and save it under
`workflows/`. Invoke: `/agentflow:create-workflow "<describe the workflow>" [--name NAME]`. Produces a file you run
with `/agentflow:run-workflow`. See [Workflow-file schema](#workflow-file-schema).

### `run-workflow` — execute a workflow-file

`/agentflow:run-workflow <workflow.json> [--param name=value …] [--run-id NAME] [--dry-run]` = `pipe init --workflow` + `pipe drive` (or
`pipe plan` for `--dry-run`). The one-command way to execute a saved pipeline.

---

## Inspecting

`/agentflow:inspect` (read-only), `/agentflow:board` (dashboard), `/agentflow:history` (chronological log). CLI: `dist/inspect.js`.
- `runs [--cmd <name>] [--json]` — list every run
- `history [--limit N] [--cmd <name>] [--json]` — runs newest-first ("what ran, and when")
- `show <id> [--cmd <name>] [--pretty]` — one run's status + primitive-specific extras
- `tree <id> [--max-depth N]` — a pipe's child tree
- `budget <id> [--json]` — cost aggregated across a run and its children
- `timeline <id> [--limit N]` — timestamps + budget events
- `board [--json] [--no-failed]` — active / done / failed / blockers + suggested next actions

---

## Workflow-file schema

A `WorkflowSpec` compiles 1:1 into `pipe.stages[]`:

```jsonc
{
  "name": "my-flow",
  "description": "...",
  "params": {                                              // optional: per-invocation inputs
    "target": { "required": true, "description": "..." },  // required → must pass --param target=...
    "glob":   { "default": "**/*" },                       // default when --param omitted
    "exclude": ""                                          // bare value = its default
  },
  "config": { "context_policy": "summary", "max_auto_continues": 50, "stop_on_failure": true },
  "stages": [
    {
      "name": "unique-name",                                 // required to wire references
      "type": "bash" | "json" | "primitive",
      "when": { "type": "bash", "command": "<predicate>" },  // optional guard: exit 0 runs, else skip
      "next": "<stage-name>" | <index> | null,               // graph edge (v1: linear; schema-ready)
      "spec": { /* type-specific */ }
    }
  ]
}
```

- **bash** → `{ "command": "<shell; writes $PIPE_OUTPUT_PATH>", "output_path"?: "…" }`
- **json** → `{ "value": <any JSON; string leaves resolve templates>, "output_path"?: "…" }`
- **primitive** → `{ "cmd": "enumerate|foreach|group|reduce|iterate", "init_args": [ … ] }`

**Params** are supplied at run time with `--param name=value` (repeatable) and referenced anywhere as
`{{params.<name>}}` (use `|shell` when injecting into a `bash` command). A `required` param with no
value aborts `init`; declared defaults apply otherwise.

**Wiring templates** (resolved at run time): `{{run.id}}`, `{{run.dir}}`, `{{workflow.dir}}`,
`{{params.<name>}}`, `{{stages.<name>.result_pointer}}`, `{{stages.<name>.run_id}}` — with filters
`|json` `|shell` `|raw`.

---

## Sources & views

A **Source** produces the `Item[]` a run consumes:

| Source | Spec | Notes |
|---|---|---|
| inline | `{"source":"inline","items":[…]}` | items embedded directly |
| file | `{"source":"file","path":"…"}` | a JSON array of items |
| run | `{"source":"run","cmd":"foreach","run_id":"…"}` | another run's item-level output |
| checkbox | `{"source":"checkbox","path":"TODO.md"}` | a markdown checklist; `[x]`=done, `[ ]`=pending; `{model:…, subagent:…}` → per-item `task` |
| folder | `{"source":"folder","path":"tasks/"}` | a file kanban: one file per item in `todo/` / `in-progress/` / `done/` (status from the folder); a flat folder = all pending. The file's contents are the task |

A **View** reflects authoritative state back onto a human artifact:
- checkbox: `foreach view <id> --checkbox <path>` toggles `[ ]`↔`[x]`.
- folder: `foreach view <id> --folder <dir>` moves each task file into the folder matching its status
  (`todo` / `in-progress` / `done`) — a live kanban.

Authoritative state always stays in `state.json`; the View is a projection.

---

## Conventions

- **Cross-turn.** Set `auto_continue` (default on) and the Stop hook resumes an unfinished run next
  turn, up to `max_auto_continues`. State is on disk, so runs survive context compaction.
- **Budget.** Record usage with `budget-add <id> --tokens N --model <m>`; inspect with
  `/agentflow:inspect budget <id>` (aggregates across children).
- **Cache.** `foreach --cache` skips items whose `data.content_hash` matched a prior result
  (`.agentflow/cache/`), making re-runs cheap.
- **Models.** `--model inherit|haiku|sonnet|opus` (and per-item overrides). Optional — work can run
  in the main thread (`--execution main-thread`) with no subagent at all.
- **Determinism boundary.** The LLM produces structured data; branching (`when`, loop predicates) is
  always deterministic code over that data — never on free text.
