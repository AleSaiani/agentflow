/**
 * Preserve-chat hook: snapshot the full conversation transcript to disk so it survives context
 * compaction. Wired to `PreCompact` (just before Claude Code compacts) and `SessionEnd` (final flush).
 *
 * Claude Code passes the hook a JSON payload on stdin including `transcript_path` (the session .jsonl)
 * and `session_id` / `cwd`. We copy the raw transcript to `<cwd>/.agentflow/chat/<session>.jsonl` and
 * render a human-readable `<session>.md` beside it. Never blocks or fails the turn — exits 0 no matter
 * what (a snapshot must not break the session).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    if (transcriptPath && existsSync(transcriptPath)) {
        try {
            const dir = join(cwd, ".agentflow", "chat");
            mkdirSync(dir, { recursive: true });
            copyFileSync(transcriptPath, join(dir, `${session}.jsonl`));
            writeFileSync(join(dir, `${session}.md`), renderMarkdown(readFileSync(transcriptPath, "utf8")), "utf8");
        }
        catch {
            /* snapshot is best-effort; never fail the turn */
        }
    }
    process.exit(0);
}
void main();
