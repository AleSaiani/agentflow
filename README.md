# flow

**Deterministic, composable iteration — and declarative workflows — inside a single Claude Code session.**

`flow` gives an LLM the control-flow primitives you'd reach for in code — `for each`,
`reduce`, `group by`, `while`, and pipeline composition — as durable, resumable operations that
survive across turns and context compaction. The state lives on disk; a Stop hook carries loops
across turns; and a declarative workflow-file lets you wire the primitives into reusable pipelines.

Think of it as a **structured, durable "Ralph loop"**: not a blind while-loop over a task list, but
a deterministic engine where the *worker* is an LLM and the *control flow* is code.

## The determinism boundary

The core principle: **the LLM produces structured data; branching is always evaluated by code.**
A fuzzy judgment ("did the review find a security issue?") becomes a step whose structured output
feeds a deterministic predicate. The engine never branches on free text — that's what keeps
"deterministic" honest.

## Primitives

| Skill | Programming analog | What it does |
|---|---|---|
| `/flow:enumerate` | `for each` / `map` | Apply one task to many items in parallel chunks across N subagents, with per-item overrides and a content-hash cache |
| `/flow:reduce` | `reduce` / fold | Collapse N inputs into 1 digest (markdown or JSON) via a single agent |
| `/flow:group` | `group by` | Partition N items into K groups by key — deterministic (path-prefix / regex / jsonpath) or LLM-classify. Output feeds `/enumerate` |
| `/flow:iterate` | `while` / `do…while` | Repeat a stage until a predicate is satisfied (or `while` it holds), with hard cap, convergence detection, and a clean kill switch |
| `/flow:pipe` | pipeline / DAG | Compose an ordered pipeline of stages (bash, json, or a primitive invocation), with declarative wiring templates and per-stage conditional guards |
| `/flow:inspect` | — | Read-only: list runs, show a run, draw a `/pipe` child tree, aggregate budget, print a timeline |
| `/flow:board` | — | Session-start dashboard: active runs, blockers, cumulative cost, suggested next actions |
| `/flow:audit` | recipe | A layer-3 recipe: discover → per-file review → partition → executive digest, shipped as a declarative workflow-file |

## The workflow layer

- **Source / View** — items come from a pluggable source: an inline list, a JSON file, another
  run's output, or a **markdown checklist** (`- [ ] task {model:opus, subagent:code-reviewer}`).
  A View can reflect authoritative state back onto the checklist (`[ ]` ↔ `[x]`).
- **Conditional steps** — a `/pipe` stage may carry a `when` guard (a bash predicate); exit 0 runs
  the stage, non-zero skips it. This is the "do only if" step.
- **Workflow-files** — a declarative JSON `WorkflowSpec` compiles 1:1 into `pipe.stages[]`, so you
  can version and reuse pipelines (see [`workflows/flow:audit.json`](workflows/flow:audit.json)).
- **Graph seam** — each stage carries a `next` edge. v1 traversal is linear; conditional branches
  and back-edges are schema-ready for v1.1.

## How it works

- **Single-writer state.** Each run is a `state.json` under `.<cmd>/<run-id>/` at the workspace
  root. The orchestrator (Claude) is the only writer; subagents write result files it commits.
- **Cross-turn continuity.** A `Stop` hook scans every run; if one has `auto_continue` and residual
  work (and is under its `max_auto_continues` cap), it blocks the turn and tells Claude how to
  resume. Resumption depends solely on disk state, so runs survive context compaction.
- **Composition.** `/pipe` reads its children's state to decide when to advance; it never mutates
  them. `pipe drive` auto-runs every bash, json, and deterministic stage, stopping only when an
  agent dispatch is genuinely needed.

## Install

This repository is both the plugin and its own marketplace.

```shell
# from inside Claude Code
/plugin marketplace add AleSaiani/flow-cc
/plugin install flow@flow-cc
```

For local development, point Claude Code at the directory directly:

```shell
claude --plugin-dir /path/to/flow-cc
```

## Quickstart

```
# Apply a review to every C# file under a folder, then digest the findings:
/flow:audit --target examples/fake-repo

# Or compose your own pipeline from a workflow-file:
node "$CLAUDE_PLUGIN_ROOT/dist/state/pipe.js" init my-run --workflow workflows/flow:audit.json
node "$CLAUDE_PLUGIN_ROOT/dist/state/pipe.js" drive my-run

# Inspect what's in flight:
/flow:board
```

## Architecture

- **TypeScript → committed `dist/`**, run with `node`. **Zero runtime dependencies** (Node builtins
  only: `fs`, `path`, `crypto`, `child_process`, `util.parseArgs`). Node ≥ 22.
- Source in `src/` (strict, ESM/NodeNext); the registry in `src/common.ts` is the composition
  contract every primitive registers into. Add a primitive → the Stop hook and `/pipe` pick it up
  with no changes.
- `git bash` must be on `PATH` (the `/iterate` stage/predicate and `/pipe` bash stages run under bash
  for POSIX semantics on every OS).

Build and test:

```shell
npm install      # dev deps only (typescript, @types/node)
npm run build    # tsc → dist/
npm test         # node:test, builds first
```

## Status

v0.1.0. Primitives, the workflow layer, inspect/board, and the Stop hook are implemented and
covered by an automated test suite, including a simulated cross-turn resumption loop (each turn a
fresh process reading only disk state). **A live multi-turn Claude Code session smoke test is the
recommended final check** before relying on it in production — the Stop hook output contract is
verified against the current docs, but real-session resumption + compaction has not been exercised
interactively here.

Deferred to v1.1: YAML workflow front-end, folder-kanban source, conditional branch/back-edge
runtime, nested enumeration fan-out, lock-based sharding, and a Codex adapter.

## License

[Apache-2.0](LICENSE) © 2026 Alessandro Saiani
