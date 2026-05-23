---
name: audit
description: |
  Deep code audit recipe: find files in a target tree, review each one (LLM), partition by component, then produce an executive digest with hotspot list and recurring patterns. A layer-3 recipe — a thin shell over /pipe that wires the framework primitives.

  USE this skill autonomously when:
  - the user asks for a "code review" / "audit" / "find bugs" / "review every file" against a folder, repo, or glob;
  - the target is large enough that per-file parallelism + structured digest beats inline reading (>= ~10 files);
  - the user wants a persisted, structured report (executive summary, hotspots), not a conversational answer.

  DO NOT use this skill autonomously when:
  - the user names a small specific set of files — read them inline;
  - the request is exploratory ("what does this folder do?") rather than audit-oriented;
  - the user wants a security audit specifically — that calls for the `audit` kind on /enumerate, possibly via a separate `/security-audit-deep` recipe (not built yet).

  Explicit user invocation (`/flow:audit ...`) bypasses these checks.

  Pipeline (6 stages with declarative wiring): bash discover (with per-file content_hash) → /enumerate code-review with cache → bash build group-input → /group path-prefix → bash build digest-inputs → /reduce digest. No primitive logic added — the recipe is a thin shell over /pipe with wiring templates ({{stages.X.run_id}}, {{stages.X.result_pointer}}) so child run-ids are NOT hardcoded.

  Incremental re-runs are cheap: per-file content_hash + `/enumerate --cache` means unchanged files skip the agent dispatch. The run-id itself includes a manifest hash, so changing any source file forces a fresh run while leaving the cache intact for files that didn't change.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --target <path> [--file-glob "**/*.cs"] [--review-model haiku|sonnet|opus] [--review-concurrency N] [--group-depth N] [--digest-model opus|sonnet|haiku] [--run-id NAME]
---

# /flow:audit

You are the orchestrator of a `/flow:audit` recipe. Your job is to **construct a 6-stage pipeline.json**, hand it to `/pipe`, and let the framework drive execution. The recipe itself adds no new primitives.

## Step 0 — Resolve config + compute manifest hash for the run-id

Read `${CLAUDE_PLUGIN_ROOT}/skills/flow:audit/defaults.md`. Apply override priority CLI > defaults.

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

Create `.audit/<run-id>/` (recipe scratch) and `.pipe/<run-id>/` (pipeline state).

## Step 2 — Export the discover env vars

The 6-stage structure is shipped as a **declarative workflow-file** at
`${CLAUDE_PLUGIN_ROOT}/workflows/flow:audit.json` (this is the canonical, reusable
artifact — you do NOT hand-build a stages.json). Its `discover` stage runs the bundled
`discover.mjs`, which reads the target/glob from the environment and emits a
/enumerate-compatible items array with a per-file `content_hash` (for the review `--cache`).

Export these before init (resolve `${CLAUDE_PLUGIN_ROOT}` to its real path here):

```bash
export AUDIT_TARGET="<resolved-target-path>"
export AUDIT_GLOB="<file_glob>"          # e.g. "**/*.cs"; default "**/*"
export AUDIT_EXCLUDE="<file_exclude>"    # comma-separated globs; may be empty
export AUDIT_DISCOVER="${CLAUDE_PLUGIN_ROOT}/workflows/discover.mjs"
```

To tune the review/digest models or group depth, copy the workflow file into your project's
`workflows/` and edit the `--model` / `--method-config` values; pass that copy to `--workflow`.

## Step 3 — (the pipeline is the workflow-file)

No stages.json to build. The workflow-file already wires the 6 stages with declarative
templates (`{{stages.<name>.run_id}}`, `{{stages.<name>.result_pointer}}`, `{{run.dir}}`),
resolved by /pipe at tick time. The stages are: `discover` (bash) → `review` (/enumerate,
`--kind code-review --cache`) → `build-group-input` (json) → `partition` (/group path-prefix)
→ `build-digest-inputs` (json) → `digest` (/reduce, markdown).

## Step 4 — Validate and init the pipe

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> \
  --workflow "${CLAUDE_PLUGIN_ROOT}/workflows/flow:audit.json" \
  [--no-stop-on-failure if user passed --keep-going] \
  [--force if --run-id was explicitly provided and overrides existing]
```

`/pipe init` automatically runs schema validation on every primitive stage's init_args (catches typos in flags / bad kind values / missing required configs BEFORE the pipeline starts). A clear error listing surfaces here, not mid-run.

## Step 5 — Drive the pipe

Use `pipe drive` (NOT manual `tick` + execute loops) — it auto-runs every bash stage and every deterministic primitive stage (in this recipe: `discover`, `build-group-input`, `partition`, `build-digest-inputs`) without your involvement, stopping ONLY when an Agent dispatch is needed (`review` and `digest` stages).

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" drive <run-id>
```

Output is JSON:
- `{"action": "needs_agent", "cmd": "enumerate", "suggested_child_run_id": "...", "init_args": [...]}` — you must init the child + run the dispatch loop + advance, then call `drive` again.
- `{"action": "done", "result_pointer": "..."}` — pipeline complete, surface the digest.
- `{"action": "failed", ...}` — surface the error.

### When `needs_agent` for `/enumerate review`:

1. Run the child init: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" init <suggested_child_run_id> <init_args...> --force`
2. Record in pipe: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" start-primitive-child <run-id> --child-cmd enumerate --child-run-id <suggested>`
3. Follow `/enumerate` SKILL.md Step 4 dispatch loop: status → claim → split into chunks → fan-out parallel Agents in ONE message → complete-batch each result file.
4. After every Agent return, record token usage: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" budget-add <enum-run-id> --tokens <total_tokens> --model <review_model>` so the budget aggregates correctly.
5. When `complete-batch` reports `run_status: done`, call `drive` again — it advances past the review stage, auto-runs the bash bridges + group, and stops at `digest`.

### When `needs_agent` for `/reduce digest`:

1. Init the reduce child + record + materialize (the reduce SKILL covers Steps 2-4).
2. Dispatch ONE digest agent (no fan-out for /reduce).
3. After Agent returns: `state/reduce.js budget-add` for the tokens, then `state/reduce.js complete <child-id> --output-path <digest.md>`.
4. Call `drive` once more → returns `done`.

## Step 6 — Final report

When `drive` returns `done`:
- `Read` the first 30 lines of `result_pointer` (the digest markdown) and surface inline.
- Run `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <run-id>` and surface the total cost.
- Run `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <run-id>` for the full child tree breakdown.
- Suggest follow-ups (e.g. "to refine the auth component, run `/enumerate --kind audit --model opus --items <groups.json filtered>`").

## Important rules

- **Idempotence**: re-running with the same `--run-id` (or the same `--target` if run-id is auto-derived) resumes. With the manifest hash in run-id derivation: a file content change → new run-id → fresh run. Pure resume of a half-completed run uses the SAME run-id.
- **No file modification**: this recipe is read-only on the target. Outputs land under `.audit/<run-id>/`, `.pipe/<run-id>/`, `.enumerate/<run-id>-s1-enumerate/`, `.group/<run-id>-s3-partition/`, `.reduce/<run-id>-s5-digest/`.
- **Incremental re-runs**: with `--cache` on the review stage, files whose `content_hash` matches a prior cached result are skipped (no agent dispatch). Hits saved under `.cache/enumerate-code-review/`.
- **Validate then drive**: trust the dry-run validation `/pipe init` performs. Catches recipe typos before any agent dispatch.

## Quick example

```
/flow:audit --target examples/fake-repo
```

Expected on the bundled fake-repo (8 files, 4 components, 6 with intentional bugs):
- stage discover finds 8 .cs files (each with sha256 content_hash)
- stage review dispatches /enumerate (sonnet, conc=4, --cache) → 6 bug reports + 2 clean
- stage build-group-input materializes the run reference
- stage partition runs /group path-prefix depth=1 → 4 groups (auth, billing, api, data)
- stage build-digest-inputs materializes the reduce inputs
- stage digest dispatches /reduce (opus, markdown) → executive report
- Final digest at `.reduce/<run-id>-s5-digest/digest.md`

Re-running the same command without changing fake-repo: the same run-id is regenerated, all 8 review items become cache hits → no agent dispatch for review → only the digest runs again (still costs ~$0.10 for the opus call). If you change one file, only that file dispatches a new review agent.
