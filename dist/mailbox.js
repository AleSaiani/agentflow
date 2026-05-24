/**
 * Mailbox — directed outbox/inbox messaging between concurrent Agent Flow instances.
 *
 * Where /queue is a shared *work* pool (any worker pulls any item), a mailbox is *directed*: instance
 * A sends to box "bob", instance B receives from box "bob". Messages are files under
 * `.agentflow/mailbox/<id>/<box>/`; `recv` claims the oldest with an **atomic rename** (into
 * `<box>/.read/`), so two readers of the same box never consume the same message. The cross-instance
 * comms layer behind cross-model conversations and multi-session coordination.
 *
 * Not a Stop-hook primitive (it's passive infrastructure — it never "completes" or auto-resumes).
 *
 *   send <id> --to <box> (--message <text> | --message-file <f> | --json <json>) [--from <name>]
 *   recv <id> --box <box>            # atomically claim the oldest message; {message:null} if empty
 *   peek <id> --box <box>            # list pending without consuming
 *   status <id>                      # message counts per box
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { die, now, print, stateDir } from "./common.js";
const READ = ".read";
function boxesRoot(id) {
    return join(stateDir("mailbox"), id);
}
function boxDir(id, box) {
    return join(boxesRoot(id), box.replace(/[^A-Za-z0-9._-]+/g, "-"));
}
function cmdSend(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: { to: { type: "string" }, message: { type: "string" }, "message-file": { type: "string" }, json: { type: "string" }, from: { type: "string" } },
    });
    const id = positionals[0];
    const to = values["to"];
    if (!id || !to)
        die("error: send requires a run_id and --to <box>");
    let body;
    if (values["json"] !== undefined)
        body = JSON.parse(values["json"]);
    else if (values["message-file"])
        body = readFileSync(values["message-file"], "utf8");
    else if (values["message"] !== undefined)
        body = values["message"];
    else
        die("error: send requires --message, --message-file, or --json");
    const dir = boxDir(id, to);
    mkdirSync(dir, { recursive: true });
    const ts = now();
    // millisecond epoch prefix → lexicographic order == arrival order (FIFO), with a random tiebreak.
    const fname = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
    const msg = { to, from: values["from"] ?? null, ts, body };
    writeFileSync(join(dir, fname), JSON.stringify(msg, null, 2), "utf8");
    print({ run_id: id, to, sent: fname });
}
/** Atomically claim the oldest pending message in a box (rename into <box>/.read/). */
function cmdRecv(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { box: { type: "string" } } });
    const id = positionals[0];
    const box = values["box"];
    if (!id || !box)
        die("error: recv requires a run_id and --box <box>");
    const dir = boxDir(id, box);
    const pending = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    for (const fname of pending) {
        const from = join(dir, fname);
        const readDir = join(dir, READ);
        mkdirSync(readDir, { recursive: true });
        const to = join(readDir, fname);
        try {
            renameSync(from, to); // ATOMIC: only one receiver of this box wins the message
        }
        catch {
            continue;
        }
        return print({ run_id: id, box, message: JSON.parse(readFileSync(to, "utf8")) });
    }
    print({ run_id: id, box, message: null });
}
function cmdPeek(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { box: { type: "string" } } });
    const id = positionals[0];
    const box = values["box"];
    if (!id || !box)
        die("error: peek requires a run_id and --box <box>");
    const dir = boxDir(id, box);
    const pending = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    print(pending.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))));
}
function cmdStatus(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
    const id = positionals[0];
    if (!id)
        die("error: status requires a run_id");
    const root = boxesRoot(id);
    const boxes = {};
    if (existsSync(root)) {
        for (const b of readdirSync(root)) {
            const d = join(root, b);
            const pending = readdirSync(d).filter((f) => f.endsWith(".json")).length;
            const readDir = join(d, READ);
            const read = existsSync(readDir) ? readdirSync(readDir).filter((f) => f.endsWith(".json")).length : 0;
            boxes[b] = { pending, read };
        }
    }
    print({ run_id: id, boxes });
}
function main(argv) {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "send":
            return cmdSend(rest);
        case "recv":
            return cmdRecv(rest);
        case "peek":
            return cmdPeek(rest);
        case "status":
            return cmdStatus(rest);
        default:
            die(`error: unknown subcommand '${sub ?? ""}' (send|recv|peek|status)`);
    }
}
main(process.argv.slice(2));
