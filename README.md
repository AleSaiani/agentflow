<div align="center">

# Agent Flow

**Describe a workflow in plain language — Agent Flow builds it, runs it, and keeps it running across turns.**

[![version](https://img.shields.io/badge/version-1.0.0--beta.1-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)

`agentflow` · a Claude Code plugin · `/agentflow:create-workflow` · `/agentflow:run-workflow` · [**Docs**](docs/)

</div>

---

## What it is

You tell Claude what you want done across many things — *"review every file in `src/`, group the
findings, write me one digest"* — and **Agent Flow turns it into a durable, resumable workflow**. Each
step is an LLM doing the work, but the **control flow is deterministic** and **every run is a state
file on disk** — so a long job survives parallelism, interruptions, and even context compaction.

> **You don't type the flags.** You describe the goal; the skill writes the exact commands. The
> `/agentflow:…` lines below show *what runs under the hood*, for transparency.

## The main way: describe → build → run

You say:

> *"Review every `.cs` file under `src/`, group the findings by area, and give me one digest."*

```text
/agentflow:create-workflow "review every .cs file in src → group findings by area → one digest"
```

Agent Flow designs the workflow, confirms a name, and writes a **self-contained, movable folder** — a
human-readable `WORKFLOW.md` (frontmatter + one heading per stage, like a `SKILL.md`) plus any helper
script, referenced relatively so the folder runs anywhere:

```text
workflows/code-review/
  WORKFLOW.md       ← the steps, in readable markdown (you can read, diff, and hand-edit it)
  discover.mjs      ← a helper script (called via {{workflow.dir}}, so the folder is portable)
```

Then run it — now, or any time, on any machine:

```text
/agentflow:run-workflow workflows/code-review/WORKFLOW.md     # --dry-run to preview · --param k=v for inputs
```

It drives itself: deterministic steps run automatically, LLM steps dispatch agents, and the whole
thing **resumes across turns** if interrupted. The digest lands as a plain file in your workspace.

## What you get

- **Durable & resumable** — every run is a `state.json` on disk; a Stop hook auto-continues in-flight
  runs across turns, and they survive context compaction. A second hook even **snapshots the chat
  transcript** to `.agentflow/chat/` before compaction.
- **A programmatic vocabulary** — `enumerate` (unfold) · `foreach` (map) · `reduce` (fold) · `group`
  (partition) · `repeat`/`until`/`while` (loop) · `step` (one unit) — composed by `pipe`.
- **Workflows as readable markdown** — author `WORKFLOW.md`, parameterize with `params` + `--param`,
  branch with conditional `fork` routing, and validate a step's structured output against a schema.
- **Any runtime for a step** — run one prompt inline, in a subagent, or **sessionlessly via `claude -p`
  / `codex exec`** — the basis for cross-model (adversarial/cooperative) conversations.
- **Scale safely** — split a list across terminals with `--shard`, or have many workers drain one
  **lock-free queue** (atomic-rename claim, no double-processing); coordinate instances via a
  **mailbox** (directed outbox/inbox).
- **Stay in control** — **cost caps** (`--max-usd`) pause a run; a `--stop-file` pauses on demand;
  `board`/`history`/`inspect` show what's in flight and what it cost; `notify` pings you when done.
- **Zero runtime dependencies** — TypeScript compiled to a committed `dist/`; Node builtins only.

## Commands

`create-workflow` wires the primitives for you, but each is callable directly.

**Author & run workflows**

| Command | What it does |
|---|---|
| `/agentflow:create-workflow` | Author a reusable `WORKFLOW.md` (validates + previews) |
| `/agentflow:run-workflow` | Run a workflow end to end (`--dry-run`, `--param k=v`) |
| `/agentflow:workflows` | List the workflows authored in this workspace |
| `/agentflow:audit` | Shipped recipe: discover → review each → group → executive digest |

**Iteration primitives** (the FP vocabulary, each a persisted, resumable run)

| Command | Like | What it does |
|---|---|---|
| `/agentflow:enumerate` | `unfold` (1→N) | Generate a list of items from a spec |
| `/agentflow:foreach` | `map` (N→N) | A prompt per item — parallel or `--serial`/`--carry`, `--shard`, folder-kanban, cache |
| `/agentflow:reduce` | `fold` (N→1) | Collapse N inputs into one digest (md/json) |
| `/agentflow:group` | `group by` | Partition into K groups — path-prefix / regex / jsonpath / LLM-classify |
| `/agentflow:repeat` · `until` · `while` | loop | Run a stage by count / do…until / while…do |
| `/agentflow:step` | one unit | Run ONE prompt once — inline / subagent / `claude -p` / `codex exec` |
| `/agentflow:pipe` | compose | Ordered stages + `when` guards + conditional `fork` routing + `output_schema` |

**Scale, coordinate & observe**

| Command | What it does |
|---|---|
| `/agentflow:queue` | A lock-free shared work queue — many workers drain it safely (atomic-rename claim) |
| `/agentflow:mailbox` | Directed messages between instances (outbox/inbox, atomic FIFO recv) |
| `/agentflow:board` · `inspect` · `history` | Read-only: live dashboard · one run's detail/tree/budget · run log |
| `/agentflow:notify` | Ping a webhook (Slack/Discord) and/or desktop when a long run finishes |

Sources are pluggable everywhere: a folder, a markdown checklist (`- [ ] task {model:opus}`), a JSON
list, or another run's output — same engine underneath.

## Real examples

Described in plain language (left) → what Agent Flow runs (right). Full versions in the
**[Cookbook](docs/cookbook.md)**.

| You say | It runs |
|---|---|
| "Audit `src` for bugs and give me a report." | `/agentflow:audit --target src --file-glob "**/*.cs"` |
| "Draft every chapter of this outline." | `enumerate` outline → chapters · `foreach` draft each · `reduce` stitch |
| "Work through every task file in `tasks/`." | `/agentflow:foreach --folder tasks --prompt "Do the task in this file"` (file kanban) |
| "Keep fixing the build until it passes." | `/agentflow:until --stage "npm run build" --stop "npm run build"` |
| "Chew through this list from 3 terminals." | `/agentflow:queue --items work.json --prompt "…"` in each terminal |
| "Have a second model critique the draft, loop until solid." | two `/agentflow:step` (different `--model`) inside `/agentflow:until` |
| "Review the diff; only deploy if it's safe." | a `step` emits `{blocking}` → `fork` routes to `ship` or `fix` |
| "Audit `src`, but stop if it passes $5." | `/agentflow:audit … ` with `--max-usd 5` (pauses at the cap) |

## Documentation

| Page | What it covers |
|---|---|
| **[Getting started](docs/getting-started.md)** | Install · see the engine work in ~10s (no LLM) · your first real run |
| **[Concepts](docs/concepts.md)** | The mental model: runs as state on disk, the Stop hook, the determinism boundary, the workflow layer |
| **[Cookbook](docs/cookbook.md)** | Real scenarios, one command → full workflow → operating at scale → composing operators |
| **[Reference](docs/reference.md)** | Every command, flag, and CLI subcommand · the WORKFLOW.md schema · sources & views · conventions |
| **[Beta testing](docs/beta-test.md)** | A graded protocol to verify the promises live (cross-turn resume, compaction) |

New here? Read **Getting started**, skim **Concepts**, then keep the **Cookbook** open and copy from it.

## Install

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

> Requires Node ≥ 22 and **Git Bash** (shell stages run under bash for POSIX semantics on every OS). On
> Windows, Agent Flow auto-prefers Git Bash and **skips the WSL/Store `bash.exe`** (`System32`); set
> `$AGENTFLOW_BASH` to point at a specific bash if needed.

## How it works (the short version)

Every run is a `state.json` under `.agentflow/<cmd>/<run-id>/`; Claude is the only writer (atomic
writes). A `Stop` hook finds any in-flight run and resumes it across turns — purely from disk, so runs
survive compaction. The control flow is deterministic; only the work *inside* each step is the LLM
(**it produces structured data; branching is always code over that data, never a judgment on free
text**). The engine is TypeScript compiled to a committed `dist/`, **zero runtime dependencies**. See
[Concepts](docs/concepts.md) for the full model.

## Status

`1.0.0-beta.1`. Primitives, the workflow layer (WORKFLOW.md, params, fork, schema validation),
`queue`/`mailbox`/`step`, inspect/board, and the hooks (cross-turn resume + preserve-chat) are
implemented and covered by an automated suite (77 tests, including a simulated cross-turn loop). The
recommended final check before production is a **live multi-turn Claude Code session smoke test**
(install, real turns, a real `claude -p`/`codex` step). Roadmap and deferred items live in
[CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) © 2026 Alessandro Saiani
