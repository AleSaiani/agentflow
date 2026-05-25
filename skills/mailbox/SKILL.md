---
name: mailbox
user-invocable: false
description: |
  Directed outbox/inbox messaging between concurrent Agent Flow instances or sessions. One instance
  sends to a named box, another receives from it; `recv` claims the oldest message with an atomic
  rename, so two receivers never get the same message (FIFO, no locks). The cross-instance comms layer
  behind cross-model conversations and multi-session coordination.

  USE for directed messages between agents/sessions ("send this to the reviewer instance", "have model
  A and model B exchange via mailboxes", "coordinate two terminals with messages"). For a shared *work*
  pool that any worker drains, use /agentflow:queue instead.
allowed-tools: Bash, Read, Write
argument-hint: send <id> --to <box> --message "<text>" | recv <id> --box <box> | peek <id> --box <box> | status <id>
---

# /agentflow:mailbox

> **Make it visible:** say in one line what you send/receive (box + who).

Boxes live under `.agentflow/mailbox/<id>/<box>/`; messages are files, received oldest-first via an
atomic rename (so concurrent receivers don't double-consume). Passive infrastructure — no auto-resume.

```bash
# send (outbox): a string, a file, or JSON
node "${CLAUDE_PLUGIN_ROOT}/dist/mailbox.js" send <id> --to <box> (--message "<text>" | --message-file <f> | --json '<json>') [--from <name>]
# receive (inbox): atomically claim the oldest message; {message:null} when empty
node "${CLAUDE_PLUGIN_ROOT}/dist/mailbox.js" recv <id> --box <box>
# peek (no consume) · status (counts per box)
node "${CLAUDE_PLUGIN_ROOT}/dist/mailbox.js" peek <id> --box <box>
node "${CLAUDE_PLUGIN_ROOT}/dist/mailbox.js" status <id>
```

**Cross-model conversation.** Give each model a box: A `send <id> --to critic …`; the critic session
`recv <id> --box critic`, responds with `send <id> --to author …`; loop until a deterministic
convergence check passes. (For a single-session A↔B exchange, two `/agentflow:step` stages in an
`/agentflow:until` loop are simpler — use mailboxes when the instances are genuinely separate.)
