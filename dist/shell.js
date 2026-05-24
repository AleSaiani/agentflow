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
let cachedBash = null;
/** Dirs whose `bash` is the WSL/Store launcher, NOT Git Bash — it mangles Windows cwd/paths. */
function isWslLauncherDir(dir) {
    const d = dir.toLowerCase();
    return d.includes("system32") || d.includes("windowsapps");
}
/**
 * Resolve a usable bash. On Windows this must be **Git Bash**, never the WSL/Store `bash.exe`
 * (`C:\Windows\System32\bash.exe`), which mangles Windows cwd/paths and breaks pipe/iterate stages.
 * Priority: $AGENTFLOW_BASH → PATH (skipping WSL launchers) → known Git install paths → derive from
 * `git --exec-path` → "bash" (so the failure is "bash not found", not cmd.exe mangling).
 */
export function whichBash() {
    if (cachedBash)
        return cachedBash;
    const isWin = process.platform === "win32";
    const override = process.env["AGENTFLOW_BASH"];
    if (override && existsSync(override))
        return (cachedBash = override);
    if (!isWin) {
        for (const dir of (process.env["PATH"] || "").split(":"))
            if (dir && existsSync(join(dir, "bash")))
                return (cachedBash = join(dir, "bash"));
        return (cachedBash = "bash");
    }
    // Windows: scan PATH but skip WSL/Store launcher dirs so a real Git Bash wins.
    for (const dir of (process.env["PATH"] || "").split(";")) {
        if (!dir || isWslLauncherDir(dir))
            continue;
        for (const e of ["bash.exe", "bash"]) {
            const c = join(dir, e);
            if (existsSync(c))
                return (cachedBash = c);
        }
    }
    // Known Git for Windows install locations.
    for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"] && join(process.env["LOCALAPPDATA"], "Programs")]) {
        if (!base)
            continue;
        const c = join(base, "Git", "bin", "bash.exe");
        if (existsSync(c))
            return (cachedBash = c);
    }
    // Derive from git itself: `git --exec-path` → <git>/mingw64/libexec/git-core → <git>/bin/bash.exe.
    try {
        const r = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
        if (r.status === 0 && r.stdout) {
            const root = r.stdout.trim().replace(/[\\/](mingw64|mingw32|usr)[\\/]libexec[\\/]git-core.*$/i, "");
            const c = join(root, "bin", "bash.exe");
            if (existsSync(c))
                return (cachedBash = c);
        }
    }
    catch {
        /* git not found — fall through */
    }
    return (cachedBash = "bash");
}
export function runBash(command, cwd, env) {
    const proc = spawnSync(whichBash(), ["-c", command], { cwd, env, encoding: "utf8" });
    if (proc.error)
        throw proc.error;
    return { status: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}
