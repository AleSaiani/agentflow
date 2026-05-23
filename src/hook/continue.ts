/**
 * Generalized Stop hook: forces Claude to continue active runs of any primitive.
 *
 * Driven by the `PRIMITIVES` registry in common.ts. Every primitive self-registers at import
 * time. This hook scans the runtime dir of each registered primitive, finds runs with
 * `auto_continue=true` and residual work, and emits `{"decision":"block","reason":"..."}` to
 * block turn termination — the continuity engine that carries loops across turns.
 *
 * Safety cap: per-run `auto_continues`, capped at `max_auto_continues`. Atomic pre-increment
 * guarantees the counter advances even if Claude makes no real progress next turn.
 *
 * Adding a new primitive requires NO changes here — just import a module that calls
 * registerPrimitive() at load. Faithful port of `claude_continue.py`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PRIMITIVES, type ResidualWork, saveAtomic, stateDir } from "../common.js";

// Import every state module so they self-register into PRIMITIVES.
// Order matters: /pipe yields to its primitive children, so children must come FIRST
// (children's residual work is detected before /pipe's "advance" residual).
import "../state/enumerate.js";
import "../state/foreach.js";
import "../state/group.js";
import "../state/iterate.js";
import "../state/reduce.js";
import "../state/pipe.js";

function findActiveRun(): [string, string, string] | null {
  for (const [cmd, spec] of PRIMITIVES) {
    const d = stateDir(cmd);
    if (!existsSync(d)) continue;

    for (const name of readdirSync(d).sort()) {
      const sp = join(d, name, "state.json");
      if (!existsSync(sp)) continue;
      let state: Record<string, any>;
      try {
        state = JSON.parse(readFileSync(sp, "utf8"));
      } catch {
        continue;
      }

      const config = state["config"] ?? {};
      if (!config["auto_continue"]) continue;

      const cap = config["max_auto_continues"] ?? 20;
      if ((state["auto_continues"] ?? 0) >= cap) continue;

      const residual: ResidualWork | null = spec.hasResidualWork(state);
      if (residual === null) continue;

      // Atomic pre-increment: ensures the cap advances even if Claude makes no real
      // progress in the following turn.
      state["auto_continues"] = (state["auto_continues"] ?? 0) + 1;
      saveAtomic(sp, state);

      return [cmd, name, spec.resumeMsg(name, residual)];
    }
  }
  return null;
}

/** Drain stdin (the hook payload) so the caller's write side never blocks. */
function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      process.stdin.resume();
      process.stdin.on("data", () => {});
      process.stdin.on("end", fin);
      process.stdin.on("error", fin);
    } catch {
      fin();
    }
    setTimeout(fin, 200); // safety: never hang the turn waiting on stdin
  });
}

async function main(): Promise<void> {
  await drainStdin();
  const active = findActiveRun();
  if (active === null) {
    process.exit(0);
  }
  const reason = active[2];
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

void main();
