import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const WF = resolve("workflows/email-auth");
const EVALUATE = join(WF, "evaluate.mjs");
const REPORT = join(WF, "report.mjs");
const CHECKLIST = join(WF, "checklist.json");

function tmp() {
  return mkdtempSync(join(tmpdir(), "ea-"));
}
function run(script: string, env: Record<string, string>): any {
  return JSON.parse(execFileSync("node", [script], { encoding: "utf8", env: { ...process.env, ...env } }).trim());
}
function byId(verdicts: any[]) {
  return Object.fromEntries(verdicts.map((v: any) => [v.id, v]));
}

test("email-auth evaluate: a strong posture passes the major checks", () => {
  const dir = tmp();
  const scan = join(dir, "scan.json");
  writeFileSync(scan, JSON.stringify({
    domain: "good.example", spf: { present: true, qualifier: "-", record: "v=spf1 -all" },
    dmarc: { present: true, policy: "reject", rua: true }, mx: [{ exchange: "mx", priority: 10 }],
    mta_sts: { present: true }, tls_rpt: { present: true }, dkim: { selectors_checked: ["default"], selectors_found: ["default"] }, bimi: { present: false },
  }));
  const ev = run(EVALUATE, { EMAILAUTH_SCAN: scan, EMAILAUTH_CHECKLIST: CHECKLIST });
  const v = byId(ev.verdicts);
  for (const id of ["spf-present", "spf-hardfail", "dmarc-present", "dmarc-enforced", "dmarc-rua", "dkim-selector", "mta-sts"]) {
    assert.equal(v[id].status, "pass", `${id} should pass`);
  }
});

test("email-auth evaluate: missing SPF/DMARC and +all fail; verdict = ACTION NEEDED", () => {
  const dir = tmp();
  const scan = join(dir, "scan.json");
  writeFileSync(scan, JSON.stringify({
    domain: "bad.example", spf: { present: true, qualifier: "+", record: "v=spf1 +all" },
    dmarc: { present: true, policy: "none", rua: false }, mx: [], mta_sts: { present: false }, tls_rpt: { present: false },
    dkim: { selectors_checked: ["default", "google"], selectors_found: [] }, bimi: { present: false },
  }));
  const ev = run(EVALUATE, { EMAILAUTH_SCAN: scan, EMAILAUTH_CHECKLIST: CHECKLIST });
  const v = byId(ev.verdicts);
  assert.equal(v["spf-hardfail"].status, "fail"); // +all
  assert.equal(v["dmarc-enforced"].status, "fail"); // p=none
  assert.equal(v["dkim-selector"].status, "warn");

  // report → verdict + completeness + markdown
  const out = join(dir, "report.md");
  const evPath = join(dir, "verdicts.json");
  writeFileSync(evPath, JSON.stringify(ev));
  const summary = run(REPORT, { EMAILAUTH_VERDICTS: evPath, EMAILAUTH_CHECKLIST: CHECKLIST, EMAILAUTH_OUT: out });
  assert.equal(summary.verdict, "ACTION NEEDED");
  assert.equal(summary.incomplete, false); // every check has a verdict
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, "utf8"), /Email authentication — bad\.example/);
});
