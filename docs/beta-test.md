# Beta testing Flow

A graded protocol to verify the promises end to end in a real Claude Code session. Each level maps to
a claim; do them in order. Steps marked **(you)** are run interactively in Claude Code.

## What you're verifying

1. The plugin loads; skills are invokable and trigger from natural language.
2. The engine drives stages (deterministically, no LLM needed for the demo).
3. **Automatic cross-turn resume** — the headline promise (mechanism explained below).
4. Sources work: checklist, folder-kanban, files.
5. State survives context compaction.

## How automatic resume works (so you know what you're testing)

There is no daemon and no polling. It's a **Claude Code `Stop` hook**:

1. Every run writes its state to a file on disk (`.foreach/<id>/state.json`, etc.).
2. When Claude finishes a turn, Claude Code fires the `Stop` hook — Flow wires
   `node "$CLAUDE_PLUGIN_ROOT/dist/hook/continue.js"` (see `hooks/hooks.json`).
3. The hook scans every run's state. If one has `auto_continue` **and** residual work (items pending,
   a loop iteration left, a pipe stage to advance) **and** is under its `max_auto_continues` cap, it
   prints `{"decision":"block","reason":"…resume this run…"}` and exits 0.
4. Claude Code reads that and, instead of ending, **continues** — feeding Claude the `reason`, which
   tells it exactly how to pick the run back up. The counter is pre-incremented so the loop always
   makes progress toward its cap (a hard safety ceiling against infinite loops).

Because step 3 reads only the disk, it works **across turns and across context compaction** — the
conversation history is irrelevant to resuming. That's the property Level 2 and Level 5 below confirm.

## Install

From the plugin directory (no GitHub needed — `dist/` is committed):

**(you)** launch a session with the plugin loaded, from a scratch workspace you don't mind writing to
(the repo itself is fine — runtime dirs are gitignored):

```
! claude --plugin-dir AleSaiani/agentflow
```

Or install it as a local marketplace inside an existing session:

```
/plugin marketplace add AleSaiani/agentflow
/plugin install flow@flow-cc
```

Requirements: **Node ≥ 22** and **git bash on `PATH`** (for the shell stages).

## Level 0 — preflight (no LLM, ~10s)

Confirms Node, paths, and the engine work before spending any model calls. From the repo dir:

```
! node dist/state/pipe.js init beta-demo --workflow examples/workflows/demo.json
! node dist/state/pipe.js drive beta-demo
```

Expect `{"action":"done", …}`. If this fails, fix the environment before going on.

## Level 1 — skill loads + natural-language trigger **(you)**

- Type `/flow:board` → expect the dashboard (probably "Nothing active. Clean slate.").
- Then, in plain language (do **not** type flags): *"Work through every unchecked task in
  `examples/TODO.md`."* Expect Claude to recognize this as a `foreach` over the checklist. There are
  3 tasks, so it may ask whether to use the durable mechanism or just do them inline (the count gate)
  — either answer is fine; pick "durable" to exercise the machinery.

## Level 2 — automatic cross-turn resume (the key test) **(you)**

Start a loop that needs several turns, then **watch it continue on its own**:

> *"Run a loop that prints the iteration number; do 4 iterations."*

Claude should set up `/flow:repeat` (engine `iterate`, `auto_continue` on, `--times 4`) and run the
first iteration, then end its response. **The Stop hook should immediately fire the next iteration**,
and the next — without you typing anything. You'll see it count through the iterations and stop at 4.

If it stops after one iteration and waits for you, auto-resume is NOT firing — note it (see "watch
for" below). Cross-check with `/flow:inspect show <run-id>` → `iteration_count` should reach 4 and
`status: done`.

## Level 3 — folder kanban **(you)**

> *"Each file in `examples/tasks/todo/` is a job — do each one."*

Expect a `foreach --folder` over the three task files. As they complete, run the view (or ask Claude
to) and watch the files move from `examples/tasks/todo/` into `examples/tasks/done/`:

```
! ls examples/tasks/todo examples/tasks/done
```

(Reset afterwards with `git checkout examples/tasks` if you want to re-run.)

## Level 4 — the audit recipe **(you)**

> *"Audit `examples/fake-repo` for bugs and give me a report."*

Expect `/flow:audit`: discover → review each file (subagents) → group → digest. It should run the
deterministic stages itself and stop only for the two LLM stages, then surface a markdown digest.
Inspect the tree and cost:

```
! node dist/inspect.js tree <run-id>
! node dist/inspect.js budget <run-id>
```

## Level 5 — compaction survival **(you)**

With an in-flight run (e.g. a long `foreach` or the audit mid-way), force a compaction (`/compact`, or
just keep a long session going) and then continue. The run should resume correctly from disk — the
Stop hook doesn't care that the history was compacted.

## What to watch for

- **`${CLAUDE_PLUGIN_ROOT}` in the Bash tool.** Skill *content* is substituted, so commands Claude
  copies from a SKILL run with the real path. If you see `command not found` or a literal
  `${CLAUDE_PLUGIN_ROOT}` in a failed command, that's the one open assumption — report it.
- **git bash not on PATH** → `/flow:iterate`/`pipe` bash stages fail. Install/expose git bash.
- **Windows paths** in templates — the `|json`/`|shell` filters handle escaping; flag anything odd.
- **The count gate** asking on tiny lists is by design (≤2 inline, ~3–10 ask, >10 run).

## Report back

For each level: ✅/❌ + what you saw. The most valuable signals are Level 2 (does auto-resume fire
unprompted?) and the `${CLAUDE_PLUGIN_ROOT}`-in-bash check — those are the only things not already
covered by the automated suite.
