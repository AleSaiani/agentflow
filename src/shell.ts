/**
 * Bash execution helper. Forces bash (POSIX semantics) regardless of host OS so that
 * shell snippets ($VAR, [ ] tests, pipes) behave identically on Windows and Unix. The
 * workspace convention requires git bash on PATH; falls back to "bash" so the failure
 * mode is "bash not found" rather than cmd.exe mangling the command. Shared by /iterate
 * (stage + stop predicate) and /pipe (bash stages + the stage.when guard).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

let cachedBash: string | null = null;

export function whichBash(): string {
  if (cachedBash) return cachedBash;
  const isWin = process.platform === "win32";
  const exts = isWin ? ["bash.exe", "bash"] : ["bash"];
  const sep = isWin ? ";" : ":";
  for (const dir of (process.env["PATH"] || "").split(sep)) {
    if (!dir) continue;
    for (const e of exts) {
      const c = join(dir, e);
      if (existsSync(c)) {
        cachedBash = c;
        return c;
      }
    }
  }
  cachedBash = "bash";
  return cachedBash;
}

export function runBash(command: string, cwd: string, env: NodeJS.ProcessEnv): ShellResult {
  const proc = spawnSync(whichBash(), ["-c", command], { cwd, env, encoding: "utf8" });
  if (proc.error) throw proc.error;
  return { status: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}
