---
# Default config for /pipe.

context_policy: summary     # none | summary | last-only | full — how prior stages' results
                            # are surfaced to the next stage's agent (v1: stored, behavior
                            # used by stages that opt in via their own prompts)
auto_continue: true         # if true, the Stop hook resumes the pipe across turns
max_auto_continues: 50      # cross-stage cap; pipelines run many turns (each child primitive
                            # has its own auto_continues budget on top)
max_stages: 20              # safety cap on stage count
stop_on_failure: true       # if a stage fails, the pipe fails (rather than skipping ahead)
---

# Notes

- /pipe is a **pure composer**. It holds no loop semantics — use /iterate as a stage if
  you need a loop. It holds no map semantics — use /enumerate. It holds no fold semantics —
  use /reduce. Each stage produces a `result_pointer`; the next stage consumes it via
  env vars (bash stages) or via `--from-run`/`--from-file` (primitive stages).

- **Stage types in v1**: `bash` (synchronous, single command) and `primitive` (spawn one of
  /enumerate, /group, /reduce, /iterate; /pipe waits for the child to be done, then advances).
  Bash stages run inside the same turn; primitive stages typically span multiple turns and
  rely on cross-turn auto-continue.

- **Yielding pattern**: while a primitive child is running, /pipe's residual-work predicate
  returns None — the Stop hook routes the next turn to the CHILD primitive (which has its
  own auto-continue loop). Only when the child is done does /pipe become "the active run"
  and the orchestrator advances the stage cursor.

- **Auto_continues budget**: `max_auto_continues: 50` at the pipe level is on top of each
  child's own cap. A pipeline with three /enumerate stages and one /iterate stage can
  easily consume 100+ Stop-hook invocations across the whole pipe. Tune up if the pipeline
  is genuinely long; tune down if you want a tighter ceiling.

- **`stop_on_failure: true`** by default: a failed stage aborts the pipeline. Override only
  when downstream stages have meaningful behavior on partial input.

- **Pipe vs recipe**: /pipe is the runtime. A layer-3 "recipe" (e.g. `/flow:audit`) is
  a SKILL.md that constructs a stages.json and invokes /pipe. Recipes are documentation +
  defaults, not new primitives.
