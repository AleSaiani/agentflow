/**
 * On-demand notification helper. Zero-dep: a webhook POST (Slack/Discord-compatible) for the
 * headless/away case, plus a best-effort OS desktop notification, and always a line on stdout so the
 * orchestrator can surface it. Never throws — a notification must not fail a run.
 *
 *   node dist/notify.js --message "audit done: 8 files, 2 critical" [--title "..."] [--webhook URL] [--no-desktop]
 *
 * Webhook URL also reads from $AGENTFLOW_NOTIFY_WEBHOOK. Use it at a run's completion (the run/board
 * SKILLs call it when the user asks to be pinged).
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

function desktop(title: string, message: string): boolean {
  try {
    if (process.platform === "win32") {
      const ps =
        "[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|Out-Null;" +
        "$n=New-Object System.Windows.Forms.NotifyIcon;" +
        "$n.Icon=[System.Drawing.SystemIcons]::Information;" +
        `$n.BalloonTipTitle=${JSON.stringify(title)};$n.BalloonTipText=${JSON.stringify(message)};` +
        "$n.Visible=$true;$n.ShowBalloonTip(5000);Start-Sleep -Milliseconds 250";
      return spawnSync("powershell", ["-NoProfile", "-Command", ps], { timeout: 6000 }).status === 0;
    }
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
      return spawnSync("osascript", ["-e", script], { timeout: 6000 }).status === 0;
    }
    return spawnSync("notify-send", [title, message], { timeout: 6000 }).status === 0;
  } catch {
    return false;
  }
}

async function postWebhook(url: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      title: { type: "string", default: "Agent Flow" },
      message: { type: "string" },
      webhook: { type: "string" },
      "no-desktop": { type: "boolean", default: false },
    },
  });
  const title = values["title"] as string;
  const message = (values["message"] as string) ?? "";
  const url = (values["webhook"] as string) || process.env["AGENTFLOW_NOTIFY_WEBHOOK"] || "";
  const sent: string[] = [];
  if (url && (await postWebhook(url, `${title}: ${message}`))) sent.push("webhook");
  if (!values["no-desktop"] && desktop(title, message)) sent.push("desktop");
  process.stdout.write(JSON.stringify({ title, message, sent }) + "\n");
}

void main();
