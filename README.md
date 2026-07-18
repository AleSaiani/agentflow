<div align="center">

# Agent Flow

**Durable, deterministic LLM agent workflows — described in plain English, run inside Claude Code, with zero runtime dependencies.**

[![CI](https://github.com/AleSaiani/agentflow/actions/workflows/ci.yml/badge.svg)](https://github.com/AleSaiani/agentflow/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-1.0.0--beta.6-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)

`/agentflow:create-workflow` · `/agentflow:run-workflow` · [**Docs**](docs/) · [**Cookbook**](docs/cookbook.md)

</div>

---

## The problem

You kick off a long, multi-step agent job in Claude Code — *review 200 files*, *draft every chapter of an
outline*, *drain a work queue from three terminals*. Then context **compaction** hits, or you close the
session, and the in-flight sub-agents take their state with them. There's no checkpoint to resume from.
Hours of work, gone — and stitching sub-agents together by hand is fragile long before that happens.

## The fix

**Agent Flow turns a plain-English goal into a durable, resumable workflow.** Each step is an LLM doing
the work, but the **control flow is deterministic** and **every run is a `state.json` on disk** — so a
`Stop` hook auto-continues it across turns, and a long job survives parallelism, interruptions, and even
compaction. Close the laptop at step 47 of 100; reopen and it resumes at 48.

> **You don't type the flags.** You describe the goal; the skill writes the exact commands. The
> `/agentflow:…` lines in this README show *what runs under the hood*, for transparency.

**Familiar by design.** If you've written a Claude Code skill, you already know the shape: a `WORKFLOW.md`
is the same idea as a `SKILL.md` — frontmatter plus one heading per step — run right in your session.
**No server, no Python, no extra services** — it runs on the same Node that powers Claude Code; Agent
Flow just adds the durable state and deterministic control flow that turn those steps into a resumable pipeline.

<!-- demo GIF (recorded with charmbracelet/vhs) goes here once captured:
     ![Agent Flow demo](docs/assets/demo.gif) -->

```text
You ▸ /agentflow:create-workflow "review every .cs file in src → group findings by area → one digest"

Agent Flow ▸ designed `code-review` (discover → review·foreach → group → digest·reduce). Run it?

You ▸ /agentflow:run-workflow workflows/code-review/WORKFLOW.md

Agent Flow ▸ stage 2/4 · review  ███████░░░  142/200 items · 3 agents · $0.38
             — context compaction —
             ▸ resumed from disk at item 143/200 …
             ✓ done · digest written to ./code-review-digest.md
```

## Quickstart

**Install** (inside Claude Code):

```shell
/plugin marketplace add AleSaiani/agentflow
/plugin install agentflow@agentflow
```

**Describe → build → run.** You say what you want; Agent Flow writes a **self-contained, movable folder**
— a human-readable `WORKFLOW.md` (frontmatter + one heading per stage, like a `SKILL.md`) plus any helper
script, referenced relatively so the folder runs anywhere:

```shell
/agentflow:create-workflow "review every .cs file in src → group findings by area → one digest"
/agentflow:run-workflow   workflows/code-review/WORKFLOW.md     # --dry-run to preview · --param k=v for inputs
```

```text
workflows/code-review/
  WORKFLOW.md       ← the steps, in readable markdown (read it, diff it, hand-edit it)
  discover.mjs      ← a helper script (called via {{workflow.dir}}, so the folder is portable)
```

**See the engine work in ~10 seconds — no LLM at all.** From a clone, drive a bundled all-deterministic
demo straight to `done`:

```shell
node dist/state/pipe.js init demo --workflow examples/workflows/demo.json
node dist/state/pipe.js drive demo          # → {"action":"done","steps_taken":5}
node dist/inspect.js board                  # the dashboard of all runs
```

That's the whole machine: a pipeline of stages, driven to completion, fully inspectable. The only thing
the LLM adds is the *work inside* the stages that need judgment. → Full walkthrough in
**[Getting started](docs/getting-started.md)**.

## How it works

```text
plain-English goal  →  WORKFLOW.md (deterministic spec)  →  state.json on disk  →  Stop hook resumes across turns
```

- **Runs are state on disk.** Every invocation is a `state.json` under `.agentflow/<cmd>/<run-id>/`.
  Claude is the only writer (atomic temp-file + rename), so an interrupted write never corrupts a run —
  and resuming needs only the file, not the chat history.
- **The Stop hook is the continuity engine.** When a turn ends, a hook scans for in-flight runs and, if
  there's residual work under the cap, resumes them — purely from disk. That's what carries a loop across
  turns and across compaction, with no daemon. A second hook **snapshots the chat transcript** to
  `.agentflow/chat/` before compaction.
- **The determinism boundary.** The LLM produces *structured data*; **branching is always code over that
  data, never a judgment on free text**. A fuzzy decision ("did the review find a security issue?")
  becomes a step whose structured output (a bool/enum) a deterministic predicate reads.

→ The full mental model is in **[Concepts](docs/concepts.md)**.

## What you get

- **Durable & resumable** — runs survive parallelism, interruption, and context compaction; nothing has
  to be redone.
- **A programmatic vocabulary** — `enumerate` (unfold) · `foreach` (map) · `reduce` (fold) · `group`
  (partition) · `repeat`/`until`/`while` (loop) · `step` (one unit) — composed by `pipe`.
- **Workflows as readable markdown** — author `WORKFLOW.md`, parameterize with `params` + `--param`,
  branch with conditional `fork` routing, validate a step's structured output against a schema, and
  **nest sub-workflows**.
- **Any runtime for a step** — run a prompt inline, in a subagent, or **sessionlessly via `claude -p` /
  `codex exec`** — the basis for cross-model (adversarial/cooperative) conversations.
- **Scale safely** — split a list across terminals with `--shard`, or have many workers drain one
  **lock-free queue** (atomic-rename claim, no double-processing); coordinate instances via a **mailbox**.
- **Stay in control** — **cost caps** (`--max-usd`) pause a run; a `--stop-file` pauses on demand;
  `pipe progress` shows where you are; `board`/`history`/`inspect` show what's in flight and what it cost.
- **Reuse results without re-running** — `inspect results <run>` dumps a finished run's outputs
  (`--json` / `--checklist`) so you can transform an expensive run deterministically — e.g. turn 2,000
  review results into a `CHECKLIST.md` without one re-review.
- **Zero runtime dependencies** — TypeScript compiled to a committed `dist/`; Node builtins only; Apache-2.0.

## Why Agent Flow

It earns its keep when work **fans out** (many items), **loops** (until a condition holds), or runs long
enough to **risk interruption**. If your task is a single prompt, you don't need it — just ask Claude.

| Instead of… | Agent Flow gives you |
|---|---|
| **Plain Claude Code sub-agents** | The same agents, but with durable state — they resume across turns and survive compaction, composed with a real vocabulary instead of ad-hoc prompting |
| **LangGraph / LangChain** | No Python service, no runtime deps, no separate process — workflows live in your Claude Code session as readable, diffable markdown |
| **Airflow / Prefect / Temporal** | No server, no scheduler, no infra — durability is a `state.json` on disk, not a database |

## Examples

Described in plain language (left) → what Agent Flow runs (right). Full versions in the
**[Cookbook](docs/cookbook.md)**.

| You say | It runs |
|---|---|
| "Audit `src` for bugs and give me a report." | `/agentflow:run-workflow workflows/audit/WORKFLOW.md --param target=src --param glob="**/*.cs"` |
| "Draft every chapter of this outline." | `enumerate` outline → chapters · `foreach` draft each · `reduce` stitch |
| "Work through every task file in `tasks/`." | `/agentflow:foreach --folder tasks --prompt "Do the task in this file"` (file kanban) |
| "Keep fixing the build until it passes." | `/agentflow:until --stage "npm run build" --stop "npm run build"` |
| "Chew through this list from 3 terminals." | `/agentflow:queue --items work.json --prompt "…"` in each terminal |
| "Have a second model critique the draft, loop until solid." | two `/agentflow:step` (different `--model`) inside `/agentflow:until` |
| "Review the diff; only deploy if it's safe." | a `step` emits `{blocking}` → `fork` routes to `ship` or `fix` |
| "Audit `src`, but stop if it passes $5." | `/agentflow:run-workflow workflows/audit/WORKFLOW.md --param target=src --max-usd 5` (pauses at the cap) |
| "Turn that finished review into a to-do list — don't re-run it." | `inspect results <run> --checklist > CHECKLIST.md` → `/agentflow:checklist` |

## Commands

You only type a handful — describe what you want and Agent Flow wires the rest. The low-level primitives
are **building blocks** the engine composes for you, kept out of the `/` menu so it stays focused.

**Front door** — what you actually type (the `/agentflow:` menu):

| Command | What it does |
|---|---|
| `do` | Describe a one-off deterministic operation → designs + runs an inline pipeline, then offers to promote it to a saved workflow |
| `how` | Help desk: "how do I … with Agent Flow?" → the right command + a copy-paste recipe (read-only) |
| `create-workflow` | Author a reusable `WORKFLOW.md` (validates + previews) |
| `run-workflow` | Run a workflow end to end (`--dry-run`, `--param k=v`); echoes a progress block each turn |
| `checklist` | Run a repeatable `- [ ]` to-do list — tick items, write back, resume only the open ones |
| `workflows` · `board` · `inspect` | Observe: workflow catalog · live dashboard · a run's detail/tree/budget — plus `inspect results <run>` (reuse a finished run) and `pipe progress <run>` (where you are) |
| `runs` | Control: list jobs in scheduling order, pause/resume one job or the whole engine, set priority, delete or clean up finished runs |

**Building blocks** — composed by the engine, hidden from the `/` menu (`user-invocable: false`) but
still scriptable via their CLIs: the FP vocabulary `enumerate` · `foreach` · `reduce` · `group` ·
`repeat`/`until`/`while` · `step` · `pipe`, plus `queue` (lock-free shared queue), `mailbox` (directed
cross-instance messages), `notify` (webhook/desktop), `history`. Sources are pluggable everywhere — a
folder, a markdown checklist (`- [ ] task {model:opus}`), a JSON list, or another run's output.

**Shipped workflows** — ready-to-run recipes under `workflows/`: **`pr-review`** (adaptive, diff-scoped
code review), **`remediate`** (fix every finding → loop until green), **`knowledge-build`** (repo →
structured md docs, bootstrap/update), `audit` (whole-tree review → digest), `gdpr-domain`/`gdpr-repo`,
`security-domain`/`security-repo`/`security-pack`, **`email-auth`** (SPF/DMARC/DKIM posture),
`release-gate`. List them with `/agentflow:workflows` (local **and** shipped, with stage count + params);
run one with `/agentflow:run-workflow <name>`.

## Controlling & reusing a run

Once a run is going (or finished) you stay in command — all on durable state, so nothing is lost or
redone:

- **Choose how it executes** — `--concurrency N` / `--chunk-size M` (parallelism and agent count are
  separate knobs), `--serial`, or `--execution main-thread` for small lists.
- **Steer it live** — create the `--stop-file` to pause at the next chunk (delete to resume); `--max-usd`
  pauses at a cost cap; `Esc` interrupts and the state is on disk. `pipe progress <run>` shows stage %,
  the current phase + item countdown, cumulative agents/$, and what's next.
- **Run many, in order** — when several jobs are in flight, `runs` shows the queue (priority, then
  oldest-first) and lets you steer it: `runs pause`/`resume` is the global stop button, `runs stop <id>`
  pauses just one job, `runs priority <id> N` bumps it up. `runs clean` GCs finished runs so the workspace
  stays tidy. (Pausing is non-destructive — state is kept and the run picks up where it left off.)
- **Reuse a finished run without re-running** — every result is persisted; `inspect results <run> --json`
  (or `--checklist`) operates on the saved items deterministically, so nothing is dropped.

→ Full recipes in the **[Cookbook](docs/cookbook.md)**.

## Documentation

| Page | What it covers |
|---|---|
| **[Getting started](docs/getting-started.md)** | Install · see the engine work in ~10s (no LLM) · your first real run |
| **[Concepts](docs/concepts.md)** | The mental model: runs as state on disk, the Stop hook, the determinism boundary, the workflow layer |
| **[Cookbook](docs/cookbook.md)** | Real scenarios: one command → full workflow → operating at scale → composing operators |
| **[Reference](docs/reference.md)** | Every command, flag, and CLI subcommand · the WORKFLOW.md schema · sources & views |
| **[Production](docs/production.md)** | Running it for real: resilience, cost caps, approval gates, secrets/env, concurrency, audit |
| **[Beta testing](docs/beta-test.md)** | A graded protocol to verify the promises live (cross-turn resume, compaction) |

New here? Read **Getting started**, skim **Concepts**, then keep the **Cookbook** open and copy from it.

## Install & requirements

```shell
# inside Claude Code
/plugin marketplace add AleSaiani/agentflow
/plugin install agentflow@agentflow
```

Local development (point Claude Code at a clone):

```shell
git clone https://github.com/AleSaiani/agentflow && cd agentflow
npm install && npm run build
claude --plugin-dir .
```

> Requires **Node ≥ 22** and **Git Bash** (shell stages run under bash for POSIX semantics on every OS).
> On Windows, Agent Flow auto-prefers Git Bash and **skips the WSL/Store `bash.exe`** (`System32`); set
> `$AGENTFLOW_BASH` to point at a specific bash if needed.

## Contributing

Issues and PRs are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup (`npm install &&
npm run build && npm test`) and the PR workflow. Security reports go through the
**[security policy](SECURITY.md)**, not public issues. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Status

`1.0.0-beta.6`. Primitives, the workflow layer (WORKFLOW.md, params, fork, schema validation, stage
retry/timeout, approval gate, on-failure), `queue`/`mailbox`/`step`, inspect/board, and the hooks
(cross-turn resume + preserve-chat) are implemented and covered by an automated suite (**121 tests**, run
in CI) including a simulated cross-turn loop. The recommended final check before production is a **live
multi-turn Claude Code session smoke test**. Roadmap and deferred items live in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) © 2026 Alessandro Saiani
