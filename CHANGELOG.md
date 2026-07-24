# Changelog

All notable changes to **Agent Flow** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-beta.12] - 2026-07-24

### Fixed
- **CLI runtimes died with `ENAMETOOLONG` on any realistic prompt.** `claude -p` received the prompt as
  an **argv argument**, and argv has an OS length limit (~32 KB on Windows). A workflow step's prompt
  carries its `<input>` — `gdpr-domain`'s assess input is ~109 KB — so the runtime worked for toy
  prompts and failed for every real one. Both runtimes now send the prompt on **stdin** (codex already
  did), which also keeps it out of the shell needed for the Windows `.cmd` shim.
  Found on the first end-to-end run of the dual-mode pilot; the earlier `PONG` validations were 4 bytes
  long and could never have surfaced it.

## [1.0.0-beta.11] - 2026-07-24

### Added
- **`gdpr-domain` dual mode — an adversarial second opinion, opt-out by default.** A `dual` param
  (`auto` | `none` | `codex-cli` | `claude-cli`) adds two `when`-guarded stages in which an
  **independent** model re-judges the 17 `llm` checks and agrees or disputes each verdict. It runs
  sessionlessly via `step`, so it is genuinely a second model rather than the same one grading itself.
  With `auto` it runs only if `codex` is installed; with `none` the report is **bit-for-bit** what it
  was before.
  - Each check now carries a `confidence_mode`: `single-model` · `dual-confirmed` · **`disputed`**.
  - **`disputed` is the payload**, not a by-product: the feature's output is a map of where two
    independent judges diverge on the same evidence — precisely where a human should look. A dispute
    keeps **both** verdicts (`status` + `dual_status`) and is surfaced at the top of the report.
  - **A dispute never moves the score, the verdict or the counts** — a contested pass must not read as
    a clean pass, and equally must not be silently downgraded. It is reported *alongside* the rollup.
    Pinned by regression tests.
  - Dual applies only where a model actually judged. The `auto` checks are decided by code and already
    reproducible; a second opinion there would be noise — which is the determinism boundary telling us
    where the feature belongs.

## [1.0.0-beta.10] - 2026-07-24

### Fixed
- **`codex-cli` only worked inside a git repository.** `codex exec` aborts with *"Not inside a trusted
  directory and --skip-git-repo-check was not specified"* whenever the cwd isn't a git repo — so the
  runtime silently worked in a repo and failed with a confusing message anywhere else. The engine now
  passes `--skip-git-repo-check`: a `step` is an explicitly requested, engine-driven invocation, so it
  opts out of codex's own workspace guard. Found while running a cross-model loop from a neutral
  working directory (the beta.9 validation happened to run inside this repo, which hid it).

## [1.0.0-beta.9] - 2026-07-24

### Fixed
First live validation of `step --runtime codex-cli` (previously only unit-tested against stub
binaries, and against an **invented** output shape — which is why none of this ever failed). Three
real defects, all of them blockers:
- **`codex exec` hung forever.** It prints *"Reading additional input from stdin…"* and blocks waiting
  on stdin even when the prompt is passed as an argument. The engine now always closes/feeds the
  child's stdin.
- **`spawnSync codex ENOENT`, then `codex.cmd EINVAL` on Windows.** npm shims are `<bin>.cmd` and
  Node applies no `PATHEXT`; Node also refuses to exec a `.cmd` without a shell (CVE-2024-27980). The
  engine now retries `<bin>.cmd`/`.exe` and uses `shell: true` only for `.cmd`/`.bat`. That stays safe
  because **codex now receives the prompt on stdin**, so it never travels through a shell.
- **`extractResult` couldn't read codex's real output.** codex emits
  `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`; the parser only looked at
  top-level `message`/`content`/`text`, so a run "succeeded" while returning the entire JSONL dump
  instead of the answer. Now parsed correctly, and the unit test uses a **verbatim capture** from
  codex-cli 0.144.6 instead of a fabricated shape.

Verified end to end on both runtimes: `codex-cli` → `PONG`, `claude-cli` → `PING`, ~8-11 s each.
Cross-model steps (`claude-cli` ↔ `codex-cli`) are therefore usable for the first time.

## [1.0.0-beta.8] - 2026-07-24

### Fixed
- **`step --runtime claude-cli/codex-cli` no longer recurses into its own parent run.** The child is a
  real Claude Code session that inherits our environment and — with the plugin installed globally — our
  hooks. Its Stop hook therefore discovered the **parent's** in-flight run and started driving it,
  burning the parent's auto-continue budget and returning meta-commentary about the run instead of the
  prompt's answer. The engine now marks children with `AGENTFLOW_CHILD` (the Stop hook is a no-op
  there) and strips `*_STATE_DIR` overrides from the child environment.
  Measured on the same prompt: **296 s → 11 s**, output `1029 bytes of commentary` → `PONG`.
  Found by the first live validation of the CLI runtimes, which until now were only unit-tested
  against stub binaries.

## [1.0.0-beta.7] - 2026-07-24

### Fixed
- **The plugin manifest version was stuck at `1.0.0-beta.4`.** Claude Code's marketplace reads
  `.claude-plugin/plugin.json`, not `package.json` — so beta.5 and beta.6 bumped only the latter and
  the marketplace kept reporting beta.4 as the latest, never offering the update (which meant the
  preserve-chat littering fix couldn't actually reach anyone). Both files now declare beta.7.

### Added
- **Version-drift gate.** A test asserts `package.json` and `.claude-plugin/plugin.json` declare the
  same version (plus that `marketplace.json` lists the plugin). `release.yml` gates the tagged release
  on `npm test`, so a release with drifting versions can no longer ship.

## [1.0.0-beta.6] - 2026-07-18

### Fixed
- **preserve-chat no longer creates `.agentflow/` in workspaces that don't use Agent Flow.** The
  `PreCompact`/`SessionEnd` hooks fire in *every* project when the plugin is installed globally, and
  the hook copied the full transcript unconditionally — littering unrelated repos with multi-MB
  snapshots (observed: ~184 MB across 12 projects that had never run a flow). It now writes only where
  `.agentflow/` already exists, which a run's `init` always creates first.

### Added
- **Chat snapshot retention.** `.agentflow/chat/` keeps only the most recent **5** sessions, pruning
  older `<session>.jsonl`/`.md` pairs so it can't grow without bound. Override with
  `$AGENTFLOW_CHAT_KEEP`. The snapshot just written is always kept.

## [1.0.0-beta.5] - 2026-07-06

### Fixed
- **`step --validate-only` no longer touches the filesystem.** Pipe's preflight
  (`validatePrimitiveStage`) validates a `step` stage by calling `step init --validate-only` with
  *dummy-resolved* templates, so a `{{workflow.dir}}`-based `prompt-file` path doesn't exist yet. The
  validate-only guard now short-circuits **before** `existsSync`/`readFileSync` (mirroring the `pipe`
  primitive), so a workflow whose `step` stage references its prompt via `{{workflow.dir}}` — e.g.
  `gdpr-domain`'s `assess` — validates and runs instead of failing init with "prompt-file not found".
  Regression test added.

### Changed
- **Dependency bumps** (dev/CI only — zero runtime deps): `@types/node` 22.20.0; CI actions
  `checkout` v7, `configure-pages` v6, `deploy-pages` v5, `upload-pages-artifact` v5.

## [1.0.0-beta.4] - 2026-05-26

### Fixed (from a real Pragmatic.Design run)
- **`remediate load` typed-checklist mode** — when the checklist has any `<!-- deferred: <type> -->` /
  `<!-- skipped: ... -->` markers (the disposition annotations a reconciliation pass writes), only
  `- [ ]` lines whose `deferred: <type>` matches `types` are loaded. Bare `- [ ]` without a marker are
  skipped. Untyped checklists keep the legacy behavior (back-compat).
- **`remediate` default `min_severity` was too strict** (was `major` → filtered out real `minor`
  findings). Lowered to `minor` so the floor matches the documented `info|minor|major|critical` ladder.
- **`remediate reconcile` suffix-match for paths** — a report path `src/X/Y.cs` now also matches a git
  path `Module/src/X/Y.cs` (common when reports use module-relative paths and git shows repo-relative).
  Closes a class of false `fixed_without_change` flags.
- **`remediate` stage 5 was misusing `iterate`** (`--stage` is a bash command, not an agent prompt → it
  exited non-zero every time). Replaced with a single-shot bash `verify` — the foreach `gate-cmd` /
  `gate-every` already catches integration breaks mid-flight (the real mid-run gate).
- **`remediate reconcile --param ignore_paths`** — comma-list of patterns (prefix `docs/`, exact
  `Makefile`, glob `*.xlsx`) excluded from scope-creep and the leash, so untracked docs/marketplace
  files don't pollute the integrity signal. `reconcile.json` now reports `changed_files` (post-filter)
  + `changed_files_total` + `ignored_paths`.

## [1.0.0-beta.3] - 2026-05-26

### Added
- **`remediate` workflow** (coverage-integrity remediation) — closes the loop after a review/checklist and
  defends the "nothing dropped without a reason / the report doesn't lie" guarantee that a per-item
  self-report model erodes. `load` (findings/checklist → **typed** fix items; `types` filter, default
  `code`) → `fix` (foreach, minimal edit, **mandatory disposition** `fixed|deferred|skipped|failed`+reason,
  refactors forbidden) → **`disposition`** (every item must have a disposition; a **bare** item — left with
  no reason — is detected, not dropped) → **`reconcile`** (checks claims against **git ground truth**: flags
  `fixed` items whose file wasn't changed / reverted, and scope creep beyond `max_files`/fix) → `verify`
  (an `iterate`/until **integration gate** — the FULL build/test, looped until green). Born from a real
  run's failure modes (88% bare items, trusted self-report, per-module "green" hiding integration breaks,
  `[x]` surviving a revert).
- **`foreach --gate-cmd "<cmd>" --gate-every N`** — a **mid-run integration gate**: after every N
  completed items, `complete-batch` runs the full command (e.g. a build); on failure the run **pauses**
  with a `gate_failure`, so an integration break is caught early instead of only at the end (the
  per-module-"green"-hides-the-break failure mode). Opt-in (off by default → no behavior change).
  `remediate` exposes it as `--param gate_every`.
- **`remediate reconcile` now de-ticks the report** — beyond flagging, it writes a corrected, truthful
  `reconciled.json` / `reconciled.md` where a `fixed` item git can't confirm is downgraded to `reverted`
  with a reason. The report no longer lies after a revert.
- **`board` shows per-run cost** — active runs now display `~$N` inline, so cost is visible during long
  loops, not only in the cumulative total / `inspect budget`.
- **`email-auth` workflow** — fully-deterministic email-authentication posture of a domain (SPF, DMARC,
  MX, DKIM common selectors, MTA-STS, TLS-RPT, BIMI), DNS-only: `scan` (resolve records) → `evaluate`
  (decide every checklist check in code) → `report` (markdown). Same input → same verdicts, no LLM.
- **pr-review lens library expanded** — added shipped lenses `node`, `angular`, `python`, `go`, `java`
  (with `csharp`, `typescript-react`, `security` → 8). Stack detection now refines the JS/TS family by
  content (`@angular` → angular, `react` import → typescript-react, else node), so `.ts` files get the
  right lens.
- **`knowledge-build` graph export** — `finalize` now also emits the LLM-derived relations as a portable
  graph in three formats: `graph.json`, Graphviz `graph.dot`, and Neo4j `graph.cypher` — the seed for a
  graph-DB import (v2).
- **`knowledge-build` workflow** — turn a repo into **structured markdown documentation** (a folder tree
  the team owns). `resolve` (mode + git ref) → `walk` (every code file, the deterministic coverage
  baseline) → `plan` (LLM proposes a doc schema + groups every file into code/domain entities) →
  `validate` (guarantees coverage — unassigned files sweep into `_unclassified`) → `document` (foreach,
  one md per entity, cached) → `relate` (LLM-derived relationships, a deterministic list from a fixed
  vocabulary — a graph-DB seed) → `finalize` (`index.md` + `relations.md` + a manifest). Two modes:
  **`bootstrap`** (records the git HEAD in the manifest) and **`update`** (diffs since the recorded ref →
  re-documents only the new/changed entities). The LLM enumerates/relates; **code guarantees every file
  is covered**.
- **`pr-review` workflow** — adaptive, **diff-scoped** code review. `discover` (git diff for changed
  files + grep for the files that reference them) → `classify` (detect each file's stack, resolve lenses
  through a **cascade** + always `security` + team rules → a materialized census) → `review` (foreach,
  one pass per file against its resolved rules, cached) → `report` (deterministic rollup + **gate** at a
  severity threshold + PR-comment markdown). Ships `csharp`, `typescript-react`, `security` lenses;
  customize via `<repo>/.agentflow/lenses/<key>.json` (per-stack) and `review-rules.json` (team rules) —
  **additive, with override by rule id or whole lens**. The exhaustive set is every changed + related
  file; the verdict is code over the findings' severities (the determinism boundary on enumeration).
- **Shipped workflows are now discoverable when installed** — `/agentflow:workflows` (and `inspect
  workflows`) scans BOTH the workspace `workflows/` (origin `local`) AND the plugin's bundled
  `workflows/` (origin `shipped`); a local workflow shadows a shipped one of the same name.
  `/agentflow:run-workflow` resolves a bare name (`run pr-review`) → workspace first, else shipped.
- **`/agentflow:runs`** — the run **control panel** (read *and* write, complementing read-only
  `board`/`inspect`). A *job* is a top-level run (workflow/`pipe`, `do`, standalone primitive); a `pipe`'s
  stage sub-runs are managed with their parent.
  - `runs [list] [--all] [--json]` — top-level jobs in **scheduling order** (the `POS` column = the queue
    the Stop hook walks).
  - `runs pause` / `runs resume` — **global** stop button (the `.agentflow/PAUSED` sentinel): while present,
    the Stop hook auto-resumes nothing.
  - `runs stop <id>` / `runs resume <id>` — pause/resume **one** job (and its subtree) via a `paused` flag;
    other jobs keep advancing. Non-destructive (state preserved).
  - `runs priority <id> <n>` — set scheduling priority (default 0; higher runs sooner).
  - `runs rm <id> [--force]` — delete a run + subtree (refuses an active job / a running pipe's child
    unless `--force`); `runs clean [--failed|--all] [--older-than 7d] [--dry-run]` — GC **finished** jobs
    only (never a running job's children).
- **Deterministic multi-run scheduling.** The Stop hook now advances concurrent top-level jobs in a
  defined order — **priority desc, then oldest-job-first (FIFO over the job's `created_at`)** — instead of
  alphabetically. One run-step per turn; a `pipe`'s children still advance before the parent (round-robin
  fairness is intentionally deferred). Pausing a job pauses its whole subtree.

### Changed
- **`/agentflow:workflows` now reads metadata from `WORKFLOW.md`**, not just `workflow.json` — the catalog
  shows stage count, declared params, and description for every shipped/authored workflow (previously
  md-only workflows listed just name/format/path).
- **`audit` is no longer a `/`-menu command** — it is the shipped `workflows/audit/` recipe, like the
  other shipped workflows. Reach it by asking ("audit src for bugs") or run it explicitly with
  `/agentflow:run-workflow workflows/audit/WORKFLOW.md --param target=…`. Its skill is now
  `user-invocable: false` (still model-invocable); the over-advertised `--review-model`/`--group-depth`/
  `--digest-model` flags (never wired) were removed from its hint.

### Fixed
- **`budget-add` ignored its flags for `step` and `queue`** — both called the recorder with no options, so
  `--tokens`/`--usd`/`--event-type`/`--model`/`--meta` were dropped (telemetry recorded 0, and token/USD
  caps never tripped for queue runs). Both now parse the flags like every other primitive.
- **Report writers could overwrite the HTML report.** When `report_out` lacked a `.html` suffix, the
  `.summary.json` path was derived by a no-op `.replace(/\.html$/, …)` and collided with the HTML file.
  `security-repo`/`security-domain`/`gdpr-repo`/`gdpr-domain` now derive a distinct summary path for any suffix.
- Docs: `audit` skill pointed at a non-existent `workflow.json` for the copy-and-tune path (it ships as
  `WORKFLOW.md`); `CONTRIBUTING.md` now notes the Windows/PowerShell `npm` shim caveat (use Git Bash / `npm.cmd`).

## [1.0.0-beta.2] - 2026-05-25

### Added
- **`/agentflow:do`** — describe a one-off **deterministic** operation; it designs an inline pipe
  (code-first, LLM step only where judgment is needed), names + runs it (no saved file), then offers to
  **promote** it to a reusable `workflows/<name>/WORKFLOW.md`. The ephemeral sibling of create-workflow.
- **`/agentflow:how`** — Agent Flow help desk: maps a plain-language intent to the right command(s) + a
  copy-paste recipe, grounded in the installed docs/skills. Read-only (explains, doesn't execute).
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

### Changed
- **Slimmer `/` menu**: the low-level building-block skills (`enumerate`, `foreach`, `reduce`, `group`,
  `repeat`/`until`/`while`, `step`, `pipe`, `queue`, `mailbox`, `notify`, `history`) are now
  `user-invocable: false` — hidden from the slash-command menu but still composed by the engine and
  auto-invocable by the model (descriptions stay in context). The front door is the ~9 entry commands
  (`do`, `how`, `create-workflow`, `run-workflow`, `checklist`, `audit`, `workflows`, `board`, `inspect`).
  README "Commands" reorganized into front-door vs building-blocks.

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
