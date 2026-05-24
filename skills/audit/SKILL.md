---
name: audit
description: |
  Deep code-audit recipe: discover files in a target → review each (LLM, cached) → partition by
  component → executive digest with hotspots and recurring patterns. A layer-3 recipe over /agentflow:pipe
  (the 6-stage pipeline and caching are detailed in the body).

  USE when the user asks to "review / audit / find bugs across" a folder, repo, or glob and wants a
  persisted, structured report — and the target is large enough (≥ ~10 files) that per-file parallelism
  plus a digest beats reading inline.

  DON'T use for a few named files (read them inline), exploratory questions ("what does this do?"), or
  generic per-item work that isn't a code review (→ /agentflow:foreach).
  Explicit invocation (`/agentflow:audit …`) skips these checks.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --target <path> [--file-glob "**/*.cs"] [--review-model haiku|sonnet|opus] [--group-depth N] [--digest-model opus|sonnet|haiku] [--run-id NAME]
---

# /agentflow:audit

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

You are the orchestrator of a `/agentflow:audit` recipe. Your job is to **construct a 6-stage pipeline.json**, hand it to `/agentflow:pipe`, and let the framework drive execution. The recipe itself adds no new primitives.

## Step 0 — Resolve config + compute manifest hash for the run-id

Read `${CLAUDE_PLUGIN_ROOT}/skills/audit/defaults.md`. Apply override priority CLI > defaults.

Required: `--target <path>`. If missing → ask via `AskUserQuestion` or abort with a clear message.

**Manifest hash** (forces a new run when source files change):
- List all files under `<target>` matching `<file_glob>` and not `<file_exclude>`
- For each: take `(rel_path, mtime_ns)` — fast, no byte reads
- Sort by rel_path
- `manifest_hash = sha256(joined entries)[:16]`

**Run-id derivation** (when `--run-id` is NOT provided):
- `audit-<8 char hash>` where the hash is `sha256(target + glob + review_model + manifest_hash)[:8]`
- This way: same content → same run-id (resume works), changed content → new run-id (fresh run).

Echo the resolved config + run-id in one line. If target has > 200 files, ask for confirmation (cost/duration warning).

## Step 1 — Working dirs

Create `.flow/audit/<run-id>/` (recipe scratch) and `.flow/pipe/<run-id>/` (pipeline state).

## Step 2 — Export the discover env vars

The 6-stage structure is shipped as a **self-contained declarative workflow-file** at
`${CLAUDE_PLUGIN_ROOT}/workflows/audit/workflow.json` (this is the canonical, reusable
artifact — you do NOT hand-build a stages.json). Its `discover` stage runs the sibling
`discover.mjs` via `{{workflow.dir}}` (so the whole `workflows/audit/` folder is movable);
the script reads the target/glob from the environment and emits a /agentflow:foreach-compatible
items array with a per-file `content_hash` (for the review `--cache`).

Export these before init (resolve `${CLAUDE_PLUGIN_ROOT}` to its real path here):

```bash
export AUDIT_TARGET="<resolved-target-path>"
export AUDIT_GLOB="<file_glob>"          # e.g. "**/*.cs"; default "**/*"
export AUDIT_EXCLUDE="<file_exclude>"    # comma-separated globs; may be empty
```

(No `AUDIT_DISCOVER` needed — the workflow finds its own script via `{{workflow.dir}}`.) To tune
the review/digest models or group depth, copy the whole `workflows/audit/` folder into your project's
`workflows/` and edit the `--model` / `--method-config` values; pass that copy's `workflow.json` to `--workflow`.

## Step 3 — (the pipeline is the workflow-file)

No stages.json to build. The workflow-file already wires the 6 stages with declarative
templates (`{{stages.<name>.run_id}}`, `{{stages.<name>.result_pointer}}`, `{{run.dir}}`),
resolved by /agentflow:pipe at tick time. The stages are: `discover` (bash) → `review` (/agentflow:foreach,
`--kind code-review --cache`) → `build-group-input` (json) → `partition` (/agentflow:group path-prefix)
→ `build-digest-inputs` (json) → `digest` (/agentflow:reduce, markdown).

## Step 4 — Validate and init the pipe

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> \
  --workflow "${CLAUDE_PLUGIN_ROOT}/workflows/audit/workflow.json" \
  [--no-stop-on-failure if user passed --keep-going] \
  [--force if --run-id was explicitly provided and overrides existing]
```

`/agentflow:pipe init` automatically runs schema validation on every primitive stage's init_args (catches typos in flags / bad kind values / missing required configs BEFORE the pipeline starts). A clear error listing surfaces here, not mid-run.

## Step 5 — Drive the pipe

Use `pipe drive` (NOT manual `tick` + execute loops) — it auto-runs every bash stage and every deterministic primitive stage (in this recipe: `discover`, `build-group-input`, `partition`, `build-digest-inputs`) without your involvement, stopping ONLY when an Agent dispatch is needed (`review` and `digest` stages).

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" drive <run-id>
```

Output is JSON:
- `{"action": "needs_agent", "cmd": "foreach", "suggested_child_run_id": "...", "init_args": [...]}` — you must init the child + run the dispatch loop + advance, then call `drive` again.
- `{"action": "done", "result_pointer": "..."}` — pipeline complete, surface the digest.
- `{"action": "failed", ...}` — surface the error.

### When `needs_agent` for `/agentflow:foreach review`:

1. Run the child init: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" init <suggested_child_run_id> <init_args...> --force`
2. Record in pipe: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" start-primitive-child <run-id> --child-cmd foreach --child-run-id <suggested>`
3. Follow `/agentflow:foreach` SKILL.md Step 4 dispatch loop: status → claim → split into chunks → fan-out parallel Agents in ONE message → complete-batch each result file.
4. After every Agent return, record token usage: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" budget-add <enum-run-id> --tokens <total_tokens> --model <review_model>` so the budget aggregates correctly.
5. When `complete-batch` reports `run_status: done`, call `drive` again — it advances past the review stage, auto-runs the bash bridges + group, and stops at `digest`.

### When `needs_agent` for `/agentflow:reduce digest`:

1. Init the reduce child + record + materialize (the reduce SKILL covers Steps 2-4).
2. Dispatch ONE digest agent (no fan-out for /agentflow:reduce).
3. After Agent returns: `state/reduce.js budget-add` for the tokens, then `state/reduce.js complete
   <child-id> --output-path ./<run-id>-audit.md` — write the digest to a **visible file in the
   workspace root** (e.g. `audit-3f2a-audit.md`), not buried under `.flow/`.
4. Call `drive` once more → returns `done`.

## Step 6 — Final report

When `drive` returns `done`:
- `Read` the first 30 lines of `result_pointer` (the digest markdown) and surface inline.
- Run `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <run-id>` and surface the total cost.
- Run `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <run-id>` for the full child tree breakdown.
- Suggest follow-ups (e.g. "to refine the auth component, run `/agentflow:foreach --kind audit --model opus --items <groups.json filtered>`").

## Important rules

- **Idempotence**: re-running with the same `--run-id` (or the same `--target` if run-id is auto-derived) resumes. With the manifest hash in run-id derivation: a file content change → new run-id → fresh run. Pure resume of a half-completed run uses the SAME run-id.
- **No file modification**: this recipe is read-only on the target. The **digest lands as a visible
  `./<run-id>-audit.md`** in the workspace; internal state lives under `.flow/audit/<run-id>/`,
  `.flow/pipe/<run-id>/`, `.flow/foreach/<run-id>-s1-foreach/`, `.flow/group/<run-id>-s3-partition/`,
  `.flow/reduce/<run-id>-s5-digest/`.
- **Incremental re-runs**: with `--cache` on the review stage, files whose `content_hash` matches a prior cached result are skipped (no agent dispatch). Hits saved under `.flow/cache/foreach-code-review/`.
- **Validate then drive**: trust the dry-run validation `/agentflow:pipe init` performs. Catches recipe typos before any agent dispatch.

## Quick example

```
/agentflow:audit --target examples/fake-repo
```

Expected on the bundled fake-repo (8 files, 4 components, 6 with intentional bugs):
- stage discover finds 8 .cs files (each with sha256 content_hash)
- stage review dispatches /agentflow:foreach (sonnet, conc=4, --cache) → 6 bug reports + 2 clean
- stage build-group-input materializes the run reference
- stage partition runs /agentflow:group path-prefix depth=1 → 4 groups (auth, billing, api, data)
- stage build-digest-inputs materializes the reduce inputs
- stage digest dispatches /agentflow:reduce (opus, markdown) → executive report
- Final digest written to a visible `./<run-id>-audit.md` in the workspace

Re-running the same command without changing fake-repo: the same run-id is regenerated, all 8 review items become cache hits → no agent dispatch for review → only the digest runs again (still costs ~$0.10 for the opus call). If you change one file, only that file dispatches a new review agent.
