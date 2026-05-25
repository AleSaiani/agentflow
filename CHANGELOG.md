# Changelog

All notable changes to **Agent Flow** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`pipe progress <id>`** — a one-glance "you are here" view for long, multi-resume runs: overall
  stage `N/total` + %, the current phase and (for a foreach/group child) its item progress with a bar,
  cumulative scale (agents · $ · resume k/max), and the next stages. `run-workflow` now echoes it each
  turn so both the phase and the within-phase countdown are always visible together. `--json` for tooling.
- **`inspect results <run>`** — extract a finished run's outputs for deterministic reuse **without
  re-running** (results are persisted in `state.json`): `--json` (one row per item, lossless),
  `--checklist` (a `- [ ]` line per item — nothing dropped), `--field a.b` to pull a result field,
  `--status` to filter. Turns an expensive review run into a `CHECKLIST.md` for `/agentflow:checklist`.
- README: a **"Controlling & reusing a run"** section (execution knobs — parallel/serial/fewer-agents/
  inline; steering a live run; reuse-without-re-run; one-shot vs saved workflows).
- **Nested sub-workflows (composition).** A `pipe` can now be a child of a `pipe`: author a stage as
  `## <name> · workflow` (`- workflow: <path>` + repeatable `- param:`), or `cmd: "pipe"` in JSON.
  Deterministic sub-workflows run to completion inline; LLM-containing ones pause and the Stop hook
  resumes them. Provenance shows in `inspect tree`; budgets roll up. (`pipe` added to supported child
  cmds; `pipe init --validate-only`; `drive` recursively drives a pipe child.)
- **`/agentflow:checklist`** — sugar over `foreach --checkbox` for a repeatable user to-do list: run the
  open `- [ ]` items, tick them, write the file back; re-running resumes only the still-open items.
- **Flagship compliance/security workflow suite** (showcasing the determinism boundary on law/standard-
  mapped checklists → self-contained HTML reports):
  - `workflows/gdpr-domain/` — external GDPR/ePrivacy audit of a domain (41 checks: code + bounded LLM +
    manual), with an optional **live-browser layer** (Vercel CLI / Playwright MCP via a subagent step).
  - `workflows/gdpr-repo/` — internal GDPR audit of a repository (28 checks).
  - `workflows/security-domain/` & `workflows/security-repo/` — fully-deterministic OWASP web-security
    and SAST-lite source audits (16 checks each, no LLM).
  - `workflows/security-pack/` — a meta-workflow nesting security-domain + security-repo into one index
    (a worked example of workflow composition).

## [1.0.0-beta.2] - 2026-05-24

Production-hardening + capability expansion over beta.1.

### Added
- **`step`** primitive — run ONE prompt once with `--runtime main|subagent|claude-cli|codex-cli`
  (the sessionless CLIs are executed by the engine). The unit that lets a stage be an arbitrary
  skill, an MCP-using agent, `claude -p`, or a different model (cross-model conversations).
- **`queue`** — a lock-free shared work queue (atomic-rename claim, collision-free item names,
  `reclaim`) that many workers drain safely; **`mailbox`** — directed outbox/inbox between instances.
- **`WORKFLOW.md`** authoring format (frontmatter + `## n. name · type` stages; deterministic md→spec
  parser) — now the way to author workflows; `create-workflow` writes it, `run-workflow`/`pipe` run it.
- Workflow layer: **params** (`--param`, with `type`/`enum` validation), `{{workflow.dir}}`, **fork**
  (conditional `next`/`route`), **`output_schema`** validation, stage **retry**/**timeout**,
  **human-approval** gate (`approve`), and a workflow **`on_failure`** hook.
- Control & ops: **cost caps** (`--max-usd`/`--max-tokens`/`--max-agents` → pause), `--stop-file`
  pause, `foreach` **`--shard`/`--serial`/`--carry`/`--prompt-file`** + automatic folder-kanban,
  **`notify`** (webhook/desktop), **`workflows`** catalog, and **preserve-chat**
  (PreCompact/SessionEnd → `.agentflow/chat/`).
- Shipped workflow library: `workflows/audit/` + `workflows/release-gate/` (a production template).
- Continuous integration (GitHub Actions: build + tests + committed-`dist/` freshness check).

### Changed
- Rebranded to **Agent Flow** (`agentflow`, `/agentflow:*`, `.agentflow/`); `compose`→`create-workflow`,
  `run`→`run-workflow`. Runtime state consolidated under a single `.agentflow/` dir. `reduce` writes a
  **visible** `./<run-id>.<ext>` by default. README/docs reorganized for navigation.

### Fixed
- Windows bash resolution prefers **Git Bash** and skips the WSL/Store `bash.exe` (broke pipe/iterate).
- `pipe` registers the `step` child primitive; `queue` filenames are collision-free; `iterate`
  evaluates the until/while predicate before the convergence fallback. Line endings normalized to LF.

## [1.0.0-beta.1] - 2026-05-23

First public beta. Brand: **Agent Flow** (`/agentflow:*`), distributed as `agentflow@agentflow`.

### Added
- Project scaffold: TypeScript (strict, ESM/NodeNext) build to committed `dist/`,
  Apache-2.0 license, plugin manifest, and self-hosted marketplace catalog.
- Core (`src/common.ts`): typed base state, atomic I/O, workspace-root resolution,
  primitive registry, budget tracking, content-hash cache, knowledge journals.
- A programmatic primitive vocabulary (unfold / map / fold / partition / loop):
  - `enumerate` — **unfold** (1→N): generate an items list from a spec.
  - `foreach` — **map** (N→N): apply an operation per item; the op is a `--prompt`, with
    `--model`/`--subagent-type` optional and `--execution main-thread|subagent`; per-item overrides,
    checkbox source, content-hash cache.
  - `reduce` — **fold** (N→1) · `group` — partition (deterministic + llm-classify).
  - `iterate` engine surfaced as three loop skills: `repeat` (fixed count, `--times`),
    `until` (do…until), `while` (while…do, `--check-first`); hard cap + convergence + kill switch.
  - `pipe` — composer with declarative wiring templates and a `plan` dry-run.
- `run-workflow` (execute a workflow-file end to end, `--dry-run`) and `create-workflow` (author a workflow-file
  from the primitives).
- Workflow layer: `Source`/`View` seam (inline | file | run | checkbox), per-stage
  `when` guard (conditional steps), and a declarative JSON workflow-file that compiles
  into `pipe.stages[]` (`pipe init --workflow`). Graph `next` edge carried in schema.
- `inspect` (runs / show / tree / budget / timeline) and `board` dashboard.
- Generalized `Stop` hook for cross-turn auto-continue, wired via `hooks/hooks.json`.
- `audit` recipe re-expressed as the first declarative workflow-file, plus
  the `examples/fake-repo` corpus.
- Test suite (Node's built-in `node:test`) including a simulated cross-turn loop.
- Documentation: branded README, `docs/getting-started.md`, `docs/concepts.md`, and a
  runnable no-LLM demo workflow (`examples/workflows/demo.json`).

[1.0.0-beta.2]: https://github.com/AleSaiani/agentflow/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/AleSaiani/agentflow/releases/tag/v1.0.0-beta.1
