# Concepts

The mental model behind Agent Flow. Read [getting-started.md](getting-started.md) first if you want to see
it run before you read about it.

## Runs are state on disk

Every invocation of a primitive creates a **run**: a `state.json` under `.agentflow/<cmd>/<run-id>/` at the
workspace root (`.agentflow/enumerate/`, `.agentflow/group/`, `.agentflow/iterate/`, `.agentflow/pipe/`, `.agentflow/reduce/`). The state is the single
source of truth — it holds the items, their statuses, results, config, and a budget log.

**The orchestrator (Claude) is the only writer.** Subagents process work and write *result files*;
the orchestrator commits them into state via the CLI. No locks needed. Writes are atomic (temp file +
rename), so an interrupted write never corrupts a run.

Because everything is on disk, **a run survives context compaction**: resuming needs only the file,
not the conversation history.

## The Stop hook is the continuity engine

When Claude finishes a turn, a `Stop` hook scans every run. If a run has `auto_continue` and
**residual work** (items pending/in-progress, a pipe stage to advance, an iteration to run) and is
under its `max_auto_continues` cap, the hook **blocks the turn** and returns a message telling Claude
exactly how to resume. The cap is pre-incremented atomically, so the loop always makes progress
toward termination even if a turn does nothing.

This is what carries a loop across turns — and across compaction — without any daemon or external
trigger. Add a new primitive that registers into the shared registry and the hook picks it up with no
changes.

## The determinism boundary

Agent Flow is deterministic where it matters and fuzzy only where it must be:

- **Deterministic predicates** — control flow (a `while` stop condition, a pipe stage's `when` guard)
  is a bash command judged by exit code. Code decides.
- **LLM judgment** — when a decision is genuinely fuzzy ("did the review find a security issue?"),
  make it a *step* whose **structured output** (a bool/enum field) feeds a deterministic predicate.

The rule: **the LLM produces structured data; branching is always evaluated by code — never on free
text.** That's what lets you call the engine "deterministic" with a straight face.

## Primitives

The vocabulary is the functional-programming triad plus partition and loop:

| Primitive | Role |
|---|---|
| **enumerate** | *unfold* (1→N): generate a list of items from a spec (LLM or deterministic) |
| **foreach** | *map* (N→N): apply one operation to each item — main-thread or parallel subagents |
| **reduce** | *fold* (N→1): collapse N inputs into one digest via a single agent |
| **group** | partition items into K groups (deterministic methods, or one LLM-classify pass) |
| **iterate** | repeat a stage; surfaced as `repeat` (count), `until` (do…until), `while` (while…do); hard cap + convergence + kill switch |
| **pipe** | compose the above into an ordered pipeline; holds no loop/map/fold of its own |

`enumerate` and `group` produce an items.json that `foreach` (map) and `group` consume; `reduce`
collapses; `iterate` loops. `pipe` composes them — loops inside a pipeline come from using `iterate`
(or a `repeat`/`until`/`while` stage) as a step. **`create-workflow`** authors a reusable workflow-file from
these; **`run-workflow`** executes one (with `--dry-run`/`plan` to preview).

The per-item **operation** is a prompt (the instructions); model and subagent are optional, and
`foreach` can process items inline in the main thread (`--execution main-thread`) instead of fanning
out to subagents.

## The workflow layer

- **Source** produces the `Item[]` a run operates on: `inline` | `file` | `run` (another run's
  output) | `checkbox` (a markdown checklist). **View** projects authoritative state back onto a
  human artifact (e.g. toggling checklist boxes). New sources slot in without touching the primitives.
- **Conditional steps** — a pipe stage may carry a `when` guard: a bash predicate run before the
  stage. Exit 0 runs it; non-zero marks it `skipped`. This is "do only if".
- **Workflow-files** — a declarative JSON `WorkflowSpec` (`{name, config, stages[]}`) compiles 1:1
  into a pipe's `stages[]`. No new engine — it's a reusable, versionable front-end for `pipe init`.
  Stages wire to each other with templates: `{{stages.<name>.result_pointer}}`, `{{run.dir}}`, etc.
- **Graph seam** — each stage carries a `next` edge. v1 traversal is linear; conditional branches and
  back-edges (workflow loops) are schema-ready for a later release.

## `pipe drive`

`drive` is the autonomous workhorse: it loops `tick` and executes every action that does **not** need
an LLM — bash stages, json stages, and deterministic `group` stages — stopping only when the next
action is a genuine agent dispatch (an `enumerate`/`reduce` loop, or `group --method llm-classify`).
It returns exactly what Claude must do next, so a multi-stage pipeline collapses from dozens of tool
calls to a handful.

## Budget & inspection

Every run logs a budget (tokens, agent dispatches, USD estimate). `/agentflow:inspect budget <run-id>`
aggregates cost across a run and its children; `/agentflow:board` is the session-start dashboard (active
runs, blockers, cumulative cost, suggested next actions). `/agentflow:inspect` never mutates state.

## Recipes (layer 3)

A *recipe* like `audit` is a thin shell over `pipe` plus a shipped workflow-file — it adds no new
primitive, it just wires existing ones. It's the pattern for packaging a reusable, opinionated
workflow as a single command.
