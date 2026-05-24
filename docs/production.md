# Running Agent Flow in production

Agent Flow is built for unattended, long-running, real-money work. This page collects the knobs that
make a workflow safe to leave running. (See [`workflows/release-gate`](../workflows/release-gate/WORKFLOW.md)
for a template that wires most of them.)

## Resilience — survive transient failures
- **Retry**: a bash stage `- retries: N` re-runs on non-zero exit (N extra attempts) — for flaky
  networks/CLIs.
- **Timeout**: `- timeout: <seconds>` bounds each attempt; a hung command is killed (exit 124).
- **On failure**: a workflow-level `config: { on_failure: "<bash>" }` runs a cleanup/alert when the
  pipe fails, with `$PIPE_FAIL_REASON` + `$PIPE_RUN_ID` in the env.
- **Resume**: every run is on disk; the Stop hook auto-continues across turns and survives compaction.
  Unstick a run interrupted mid-flight with `foreach reset <id> --in-progress-to-pending`.

## Cost control — never blow the budget
- **Caps**: `--max-usd N` (also `--max-tokens`, `--max-agents`) on `foreach`/`pipe`/`queue` **pause** the
  run when exceeded (status shows `paused`; the Stop hook won't resume). Record spend with `budget-add`.
- **Manual pause**: `--stop-file <path>` — while the file exists, the run stops claiming and won't
  auto-resume. `touch` it to pause every worker; delete it to continue.
- Watch spend live with `/agentflow:board` and `/agentflow:inspect budget <run-id>`.

## Human-in-the-loop — gate irreversible actions
- A stage `- approve: true` (+ `- approve-prompt: "…"`) **pauses** the pipe before it runs; the
  orchestrator asks the user and only proceeds on `pipe approve <run-id>`. Put it before a deploy.

## Input safety
- **Typed params**: declare a param's `type` (`string`/`number`/`integer`/`boolean`) and/or `enum` —
  bad `--param` values fail fast at `init` instead of corrupting a run.
- **Output schema**: a `bash`/`json` stage `output_schema` validates its JSON before any downstream
  step branches on it — the determinism boundary, enforced.

## Secrets & environment
- Bash stages and `step --runtime *-cli` inherit the **process environment**, so API keys / tokens for
  `gh`, `curl`, `claude`, `codex`, etc. come from the env you launch Claude Code in (or a `.env` you
  source) — **never hard-code them in `WORKFLOW.md`** (it's committed). Pass *non-secret* config via
  `--param`; keep secrets in env.
- Don't echo secrets into `$PIPE_OUTPUT_PATH` or stage output — those files are persisted under
  `.agentflow/`. The `notify` webhook reads `$AGENTFLOW_NOTIFY_WEBHOOK` from the env, not a flag, for
  the same reason.
- `.agentflow/` (state, cache, chat snapshots) is gitignored — keep it that way.

## Concurrency — scale without corruption
- **Static split**: `foreach --shard k/N` with distinct run-ids → N terminals, disjoint items, no locks.
- **Dynamic shared queue**: `/agentflow:queue` — many workers drain one queue via atomic-rename claim
  (no double-processing); `reclaim --older-than <sec>` recovers a dead worker's in-flight items.
- **Coordination**: `/agentflow:mailbox` for directed messages between separate instances.
- Single-writer + atomic writes mean a given run is only ever driven by one orchestrator; use shard or
  queue (not the same run-id from two drivers) for parallelism.

## Durability & audit
- **Preserve-chat**: a PreCompact/SessionEnd hook snapshots the transcript to `.agentflow/chat/` so the
  conversation survives compaction.
- **History**: `/agentflow:history` (time-ordered runs) and `/agentflow:inspect tree <id>` (full child
  tree + aggregated budget) are the audit trail; state on disk is the source of truth, not the chat.

## Engineering
- Zero runtime dependencies (Node builtins); ships compiled `dist/`. CI builds, runs the test suite,
  and verifies the committed `dist/` is fresh on every push/PR.
- Requires Node ≥ 22 and **Git Bash** on Windows (auto-detected; the WSL/Store `bash.exe` is skipped —
  override with `$AGENTFLOW_BASH`).
