/**
 * Preserve-chat hook: snapshot the full conversation transcript to disk so it survives context
 * compaction. Wired to `PreCompact` (just before Claude Code compacts) and `SessionEnd` (final flush).
 *
 * Claude Code passes the hook a JSON payload on stdin including `transcript_path` (the session .jsonl)
 * and `session_id` / `cwd`. We copy the raw transcript to `<cwd>/.agentflow/chat/<session>.jsonl` and
 * render a human-readable `<session>.md` beside it. Never blocks or fails the turn — exits 0 no matter
 * what (a snapshot must not break the session).
 *
 * Two guards keep this from littering the disk: it only writes where `.agentflow/` already exists
 * (the plugin is installed globally, so these hooks fire in every project), and it keeps only the
 * most recent `AGENTFLOW_CHAT_KEEP` sessions (default 5).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** How many session snapshots to keep; override with AGENTFLOW_CHAT_KEEP. */
const DEFAULT_KEEP = 5;
/**
 * Retention: keep only the N most recent sessions (each is a `<session>.jsonl` + `<session>.md` pair)
 * and prune the rest, so `.agentflow/chat/` can't grow without bound. The snapshot just written is
 * always the newest, so it is never pruned. Best-effort — never fails the turn.
 */
function pruneOldSnapshots(dir, keep) {
    try {
        const newest = new Map(); // session id → newest mtime across its files
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".jsonl") && !f.endsWith(".md"))
                continue;
            const id = f.replace(/\.(jsonl|md)$/, "");
            newest.set(id, Math.max(newest.get(id) ?? 0, statSync(join(dir, f)).mtimeMs));
        }
        const stale = [...newest.entries()]
            .sort((a, b) => b[1] - a[1]) // newest first
            .slice(keep) // everything past the keep window
            .map(([id]) => id);
        for (const id of stale)
            for (const ext of [".jsonl", ".md"])
                rmSync(join(dir, id + ext), { force: true });
    }
    catch {
        /* pruning is best-effort; a full disk or a locked file must not break the session */
    }
}
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        let done = false;
        const fin = () => {
            if (!done) {
                done = true;
                resolve(data);
            }
        };
        try {
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => (data += c));
            process.stdin.on("end", fin);
            process.stdin.on("error", fin);
        }
        catch {
            fin();
        }
        setTimeout(fin, 300); // never hang the turn waiting on stdin
    });
}
/** Best-effort render of a Claude transcript .jsonl into readable markdown (role + text blocks). */
function renderMarkdown(jsonl) {
    const out = ["# Conversation transcript", ""];
    for (const line of jsonl.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            continue;
        }
        const msg = e["message"] ?? {};
        const role = e["type"] ?? e["role"] ?? msg["role"] ?? "";
        const content = msg["content"] ?? e["content"];
        let text = "";
        if (typeof content === "string")
            text = content;
        else if (Array.isArray(content))
            text = content
                .map((b) => (typeof b === "string" ? b : b?.["text"] ?? ((b?.["type"] && `[${b["type"]}]`) || "")))
                .filter(Boolean)
                .join("\n");
        if (!role && !text.trim())
            continue;
        out.push(`### ${role || "?"}`, "", text.trim(), "");
    }
    return out.join("\n");
}
async function main() {
    const raw = await readStdin();
    let payload = {};
    try {
        payload = JSON.parse(raw);
    }
    catch {
        /* no/!JSON payload → nothing to do */
    }
    const transcriptPath = payload["transcript_path"];
    const cwd = payload["cwd"] || process.cwd();
    const session = String(payload["session_id"] ?? "session").replace(/[^A-Za-z0-9._-]+/g, "-");
    // Only snapshot in a workspace that ACTUALLY uses Agent Flow. With the plugin installed globally
    // these hooks fire in every project, so creating `.agentflow/` here would litter unrelated repos
    // with multi-MB transcript copies. A run's `init` always creates `.agentflow/` before compaction
    // could matter, so "the directory already exists" is the correct in-use signal.
    const base = join(cwd, ".agentflow");
    if (transcriptPath && existsSync(transcriptPath) && existsSync(base)) {
        try {
            const dir = join(base, "chat");
            mkdirSync(dir, { recursive: true });
            copyFileSync(transcriptPath, join(dir, `${session}.jsonl`));
            writeFileSync(join(dir, `${session}.md`), renderMarkdown(readFileSync(transcriptPath, "utf8")), "utf8");
            const keep = Math.max(1, parseInt(process.env["AGENTFLOW_CHAT_KEEP"] ?? "", 10) || DEFAULT_KEEP);
            pruneOldSnapshots(dir, keep);
        }
        catch {
            /* snapshot is best-effort; never fail the turn */
        }
    }
    process.exit(0);
}
void main();
