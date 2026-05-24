# Cookbook

Real scenarios, from a single command to a full multi-stage workflow.

**How to read these.** You **don't type the flags** — you describe the goal in plain language and
Claude picks the right Agent Flow skill and runs it. Each scenario is laid out as:

- **You say** — what you actually type to Claude (natural language);
- **Claude runs** — the command it translates that into (shown for transparency);
- the **input** file(s) and the **result** you get.

Mental model in one line: **`enumerate` makes a list → `foreach` works each item → `reduce` digests
the results**, with `group` to partition, `repeat`/`until`/`while` to loop, and `pipe`/`create-workflow`/`run-workflow`
to wire it all into a reusable workflow. State is on disk, so any of these survives across turns.

---

## Level 1 — one primitive

### 1. Work through a checklist in parallel

**You say:** *"Here's `TODO.md` — do every unchecked task."*

**Input** — `TODO.md`:
```markdown
- [ ] Add a rate limiter to the API {model:opus}
- [ ] Write tests for the billing module
- [x] Update the changelog
```

**Claude runs:**
```text
/agentflow:foreach --checkbox TODO.md --prompt "Complete this task; report what you changed"
```

Each `- [ ]` line becomes an item (the `[x]` line starts done; inline `{model:opus}` is a per-item
override). Claude works them in parallel subagents and checkpoints progress — reopen mid-run and it
resumes. **Result** — with the checkbox view, finished tasks flip to `[x]` in the file:
```markdown
- [x] Add a rate limiter to the API {model:opus}
- [x] Write tests for the billing module
- [x] Update the changelog
```

### 1b. Track a folder of task files (file kanban)

> "Each file in `tasks/todo/` is a job — work through them."

```text
/agentflow:foreach --folder tasks --prompt "Do the task described in this file"
```

One file = one item; status comes from the folder (`todo/` / `in-progress/` / `done/`). As each item
is claimed and completed, the engine **moves its file across the folders automatically** — a kanban
you watch live in your file tree, no extra command. A flat folder (no subfolders) is treated as
all-pending. Same engine as the checklist; just a different **Source**.

### 2. Summarize many results into one report

> "Summarize these 20 review files into an executive digest."

```text
/agentflow:reduce --inputs reviews.json --prompt "Executive digest: severity rollup, top hotspots, recurring patterns" --output-format markdown
```

One agent reads all inputs (files, inline data, or another run's output) and writes a single digest.
The digest lands as a **visible file in your workspace** — `./<run-id>.md` (e.g. name the run
`audit-digest` and you get `audit-digest.md`), not buried under `.agentflow/`.

### 3. Turn an outline into a structured list

> "Break this book outline into a list of chapters I can draft."

```text
/agentflow:enumerate --prompt "Expand this outline into chapters: id, title, one-line brief" --input outline.md
```

The **unfold**: a spec in, a list out. Produces an `items.json` you can inspect, tweak, and then feed
to `foreach`. (If the list already exists — a glob, a file — skip this and point `foreach` at it.)

### 4. Loop until something passes

> "Keep fixing the build until it's green (max 8 tries)."

```text
/agentflow:until --stage "npm run build" --stop "npm run build" --max-iterations 8
```

`--stage` and `--stop` are plain bash commands (pass JSON only for extra fields). `do…until` runs the
body, then checks the predicate — exit 0 = satisfied = stop. One iteration per turn; the Stop hook
fires the next. Stops on `predicate_satisfied`, `max_iterations`, `convergence` (output stopped
changing), or a `kill`.

### 5. Repeat a fixed number of times

> "Run the flaky test 10 times and collect the failures."

```text
/agentflow:repeat --stage "pytest tests/flaky_test.py" --times 10
```

A bounded count loop — no predicate, just N runs.

---

## Level 2 — compose two primitives

### 6. Generate, then act (unfold → map)

> "Draft every chapter of this outline."

```text
/agentflow:enumerate --prompt "Outline → chapters (id, title, brief)" --input outline.md   # → chapters.json
/agentflow:foreach --items chapters.json --prompt "Draft this chapter from data.brief; ~800 words"
```

Inspect `chapters.json` between the two steps to edit the plan before committing compute to drafting.

### 7. Review every file, then digest (map → fold)

> "Review all the C# files under `src/` and give me a report."

```text
# 1. discover (a quick bash list with per-file content hashes for caching)
# 2. /agentflow:foreach --items files.json --kind code-review --cache --prompt "Review this file"
# 3. /agentflow:reduce --inputs <foreach run> --prompt "Digest: hotspots + recurring patterns"
```

This is exactly what the shipped `audit` recipe automates (Level 3, scenario 9).

### 8. Partition, then process per group (group → map)

> "Group these migrations by table, then validate each group."

```text
/agentflow:group --method regex --input-source migrations.json --method-config '{"pattern":"_(\\w+)_table","field":"id"}'
# groups.json is items.json-compatible:
/agentflow:foreach --items <groups.json> --prompt "Validate this group of migrations together"
```

`group` output drops straight into `foreach`. Use `path-prefix` / `jsonpath` for deterministic keys,
or `llm-classify` when the key needs judgment (one agent returns the mapping; the branch stays code).

---

## Level 3 — full workflows

### 9. The `audit` recipe (discover → review → group → digest)

**You say:** *"Audit `examples/fake-repo` for bugs."*

**Claude runs:**
```text
/agentflow:audit --target examples/fake-repo
```

A layer-3 recipe: a shipped workflow-file ([`workflows/audit/WORKFLOW.md`](../workflows/audit/WORKFLOW.md)) wires
discover (bash) → review (`foreach`, cached) → partition (`group`) → digest (`reduce`). `pipe drive`
auto-runs the deterministic stages and stops only for the two LLM stages.

**Result** — a markdown digest (excerpt):
```markdown
# Code audit — examples/fake-repo (8 files, 4 components)

## Severity rollup
🔴 2 critical · 🟠 3 major · 🟡 4 minor

## Hotspots
1. auth/TokenIssuer.cs — token signed with a hardcoded secret (critical)
2. billing/RefundProcessor.cs — refund amount not validated against the charge (critical)

## Recurring patterns
- Missing null-checks on external input (5 files)
- Catch-all `catch (Exception)` swallowing errors (3 files)
```

Re-run after changing one file: only that file's review re-dispatches — cache hits skip the rest, so
it's cheap.

### 10. Author and run your own workflow

> "Build me a reusable workflow: pull open issues, triage each, then summarize."

```text
/agentflow:create-workflow "fetch open issues → triage each by severity → summarize the triage" --name triage
```

`create-workflow` confirms the name (proposing one, or take your own), designs the `WorkflowSpec`, and writes
a **self-contained folder** `workflows/triage/` (the `WORKFLOW.md` plus any scripts it needs,
referenced via `{{workflow.dir}}` so the folder is movable), then validates + previews:

```text
/agentflow:run-workflow workflows/triage/WORKFLOW.md --dry-run    # shows the resolved stage plan, runs nothing
/agentflow:run-workflow workflows/triage/WORKFLOW.md              # init + drive to completion
```

The folder is yours to version, move, edit (swap models, depth, prompts), and re-run.

### 11. Conditional steps — do only if

> "Run the test suite; only deploy if it passed; always post a summary."

In the workflow-file, a stage's `when` guard is a bash predicate (exit 0 = run, non-zero = skip):

```jsonc
{ "name": "test",   "type": "bash", "spec": { "command": "npm test > $PIPE_OUTPUT_PATH 2>&1; echo $? > {{run.dir}}/test.rc" } },
{ "name": "deploy", "type": "bash",
  "when": { "type": "bash", "command": "[ \"$(cat {{run.dir}}/test.rc)\" = 0 ]" },
  "spec": { "command": "./deploy.sh" } },
{ "name": "report", "type": "bash", "spec": { "command": "./post-summary.sh" } }
```

The LLM may *produce* the data a guard reads (e.g. a review step writes `{"blocking": true}`), but the
branch itself is always deterministic code — never a judgment on free text.

### 12. Choose where the work runs

> "These are tiny edits — don't spin up 20 subagents."

```text
/agentflow:foreach --items items.json --prompt "Apply this one-line fix" --execution main-thread
```

`main-thread` processes each item inline in the orchestrator (no fan-out) — cheaper and simpler for
short ops. Switch to `--execution subagent` (default) when items are heavy and independent. The state
mechanics are identical; only who does the work changes.

### 12b. Process one at a time — serial, or a running accumulation

> "Apply these migrations one by one, in order — never two at once." / "Translate each chapter,
> keeping the glossary the previous chapter established."

```text
/agentflow:foreach --items migrations.json --serial --prompt "Apply this migration"
/agentflow:foreach --items chapters.json   --carry  --prompt "Translate; reuse terms from the previous chapter's output"
```

`--serial` runs items strictly one at a time in list order (no parallel subagents) — for shared
resources, rate limits, or order-sensitive work. `--carry` goes further: it implies serial **and**
feeds each item the previous item's result, so the operation accumulates (a sequential scan). Both
checkpoint per item, so they resume mid-list across turns. Long operation? Keep it in a file with
`--prompt-file ops/translate.md` instead of a giant inline `--prompt`.

### 12c. Split a queue across terminals, with a pause switch

> "This list is huge — I want to chew through it from three terminals at once, and be able to pause
> them all." 

```text
# one per terminal, each takes a disjoint third of the list:
/agentflow:foreach --items work.json --shard 0/3 --run-id work-0 --stop-file PAUSE --prompt "<op>"
/agentflow:foreach --items work.json --shard 1/3 --run-id work-1 --stop-file PAUSE --prompt "<op>"
/agentflow:foreach --items work.json --shard 2/3 --run-id work-2 --stop-file PAUSE --prompt "<op>"
```

`--shard k/N` keeps only the items at `index % N == k`, so the three runs are disjoint — separate
state files, no locking, no double-processing (works with a `--folder` source too, since each shard
moves only its own files). `touch PAUSE` and every worker stops claiming at its next checkpoint and
won't auto-resume; delete `PAUSE` and nudge each session to continue. `/agentflow:board` shows all shards.

### 12d. A shared queue drained by many workers (dynamic, no locks)

> "I don't want to pre-split — just let several terminals pull from one queue, and I'll keep adding
> work to it." 

```text
# create the queue once, then run this in each terminal (same id):
/agentflow:queue --items work.json --prompt "Do the task in data"
# add more work any time, from anywhere:
/agentflow:queue add work-queue --items more.json
```

Unlike `--shard` (a static, up-front split), a **queue** is pulled dynamically: each `claim` is an
**atomic file rename**, so any number of workers drain the *same* queue with zero chance of grabbing
the same item twice — no locks. Items can arrive over time (`add`), a `--stop-file` pauses every
worker, and `queue reclaim <id> --older-than 600` returns a crashed worker's in-flight items to the
pool. Use `--shard` when you have a fixed list to divide; use `queue` when work is shared or streaming.

---

## Level 4 — operating at scale

### 13. Cheap re-runs with caching

Add `--cache` to `foreach` (the `audit` recipe does). Items carry a `data.content_hash`; on re-run,
unchanged items hit the cache (`.agentflow/cache/`) and skip dispatch entirely. Change one file → only that item
re-runs.

### 14. Watch cost and progress

```text
/agentflow:board                        # active runs, blockers, cumulative cost, suggested next actions
/agentflow:inspect tree <pipe-run-id>   # the full child tree of a pipeline
/agentflow:inspect budget <run-id>      # tokens / agents / USD, aggregated across children
```

Record usage as you go with `budget-add` so the totals are real.

### 15. Resume a long run across turns (and after compaction)

Nothing special to do: any run with `auto_continue` (default) is picked up by the Stop hook each turn
until it's done or hits `max_auto_continues`. Because state is on disk, a long `foreach` or a deep
`pipe` resumes correctly even after the conversation is compacted. Stuck items from an interrupted
session: `… foreach reset <run-id> --in-progress-to-pending`, then send any message to resume.

---

## Level 5 — composing operators

The RxJS-style operators are **compositions** of the primitives, not separate commands:

### 16. `tap` — a side-effect that doesn't change the data

A `bash` stage whose output you simply don't wire downstream: log, write a file, or ping. Downstream
stages keep referencing the *previous* stage, so the tap is pure side-effect.

```markdown
## notify-progress · bash
```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/notify.js" --message "review stage done"
```
```

### 17. `gate` — run/abort on a condition (deterministic or LLM-judged)

A per-stage `when:` guard skips one stage; a `bash` stage that exits non-zero (with `stop_on_failure`)
aborts the flow. For an **LLM-judged** gate, make it a `step` that emits structured JSON, validate it
with `output-schema`, then branch with a `when:` bash predicate over that JSON — never on free text.

```markdown
## judge · step
- runtime: claude-cli
- prompt: Output JSON {"blocking": <bool>} — is the diff at {{stages.diff.result_pointer}} unsafe to ship?
- output-schema: { type: object, required: [blocking] }

## deploy · bash
- when: [ "$(jq -r .blocking {{stages.judge.result_pointer}})" = false ]
```sh
./deploy.sh
```
```

### 18. `filter` — keep matching items

Use `group` to partition then feed one group to `foreach`, or a `bash` stage that selects (e.g. with
`node`/`jq`) and emits a smaller `items.json` the next stage consumes.

### 19. Cross-model conversation (adversarial / cooperative)

Two `step` stages with **different `--model`/`--runtime`** (e.g. `claude-cli` opus proposes,
`codex-cli` critiques), looped with `/agentflow:until` whose predicate is a deterministic convergence
check over their structured outputs. The exchange passes through each step's `output_pointer`; the loop
predicate (code) decides when they've converged. Determinism boundary holds — the models produce data,
the branch is code.

---

## Where to go next

- [reference.md](reference.md) — every skill, flag, and subcommand.
- [concepts.md](concepts.md) — the model: state on disk, the Stop hook, the determinism boundary.
- [`workflows/audit/WORKFLOW.md`](../workflows/audit/WORKFLOW.md) — a complete, real workflow-file to learn from.
