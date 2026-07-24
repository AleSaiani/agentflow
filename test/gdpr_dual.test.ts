import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Dual-mode contract for gdpr-domain's reporter. The whole point of an adversarial second opinion is
 * that it surfaces DISAGREEMENT without quietly changing the verdict — so the invariants worth pinning
 * are: the score/verdict never move, and a contested check never reads as a clean one.
 */
const W = resolve("workflows/gdpr-domain");
const REPORT = join(W, "report.mjs");

function fixture(): { dir: string; checklist: any } {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-dual-"));
  const checklist = JSON.parse(readFileSync(join(W, "checklist.json"), "utf8"));
  writeFileSync(join(dir, "evidence.json"), JSON.stringify({ domain: "example.com", privacy: {} }), "utf8");
  // one code verdict per `auto` check so the run is structurally complete
  const code = checklist.checks.filter((c: any) => c.decision_mode === "auto").map((c: any) => ({ id: c.id, status: "pass", rationale: "", evidence: [] }));
  writeFileSync(join(dir, "code.json"), JSON.stringify(code), "utf8");
  const llm = checklist.checks.filter((c: any) => c.decision_mode === "llm").map((c: any, i: number) => ({ id: c.id, status: i % 3 === 0 ? "fail" : "pass", rationale: "first", evidence: [] }));
  writeFileSync(join(dir, "llm.json"), JSON.stringify(llm), "utf8");
  // second model: disagrees on the first three, agrees on the rest
  const dual = llm.map((v: any, i: number) => ({ id: v.id, agrees: i >= 3, status: i < 3 ? (v.status === "pass" ? "fail" : "pass") : v.status, rationale: "second", evidence: [] }));
  writeFileSync(join(dir, "dual.json"), JSON.stringify(dual), "utf8");
  writeFileSync(join(dir, "empty.json"), "[]", "utf8");
  return { dir, checklist };
}

function report(dir: string, dualPath: string | ""): any {
  const out = join(dir, dualPath ? "on.html" : "off.html");
  const stdout = execFileSync("node", [REPORT], {
    encoding: "utf8",
    env: {
      ...process.env,
      GDPR_DOMAIN: "example.com",
      GDPR_CHECKLIST: join(W, "checklist.json"),
      GDPR_EVIDENCE: join(dir, "evidence.json"),
      GDPR_CODE_VERDICTS: join(dir, "code.json"),
      GDPR_LLM_VERDICTS: join(dir, "llm.json"),
      GDPR_BROWSER_VERDICTS: join(dir, "empty.json"),
      GDPR_DUAL_VERDICTS: dualPath,
      GDPR_REPORT_OUT: out,
    },
  });
  const summary = JSON.parse(stdout.trim());
  // stdout is the compact rollup; the full per-check `results` array lives in the sibling summary file
  const full = JSON.parse(readFileSync(summary.summary_json, "utf8"));
  return { summary, full, html: readFileSync(out, "utf8") };
}

test("gdpr dual: a second opinion never moves the score, the verdict, or the counts", () => {
  const { dir } = fixture();
  const off = report(dir, "");
  const on = report(dir, join(dir, "dual.json"));

  assert.equal(on.summary.score, off.summary.score, "score must not move");
  assert.equal(on.summary.verdict, off.summary.verdict, "verdict must not move");
  assert.deepEqual(on.summary.counts, off.summary.counts, "status counts must not move");
  // A contested check is reported ALONGSIDE the score, never folded into it.
  assert.equal(on.summary.disputed.length, 3);
});

test("gdpr dual: off is inert — no dual state and nothing contested rendered", () => {
  const { dir } = fixture();
  const off = report(dir, "");
  assert.equal(off.summary.dual_mode, "off");
  assert.equal(off.summary.confidence.dual_confirmed, 0);
  assert.equal(off.summary.confidence.disputed, 0);
  assert.ok(!off.html.includes("contested by a second model"), "no contested banner when dual is off");
});

test("gdpr dual: on classifies every llm check as confirmed or disputed, and surfaces the dispute", () => {
  const { dir, checklist } = fixture();
  const on = report(dir, join(dir, "dual.json"));
  const llmCount = checklist.checks.filter((c: any) => c.decision_mode === "llm").length;

  assert.equal(on.summary.dual_mode, "on");
  assert.equal(on.summary.confidence.dual_confirmed + on.summary.confidence.disputed, llmCount);
  // code- and manual-decided checks are never second-guessed: a second opinion there would be noise
  assert.equal(on.summary.confidence.single_model, checklist.checks.length - llmCount);
  assert.ok(on.html.includes("contested by a second model"), "the dispute must be visible in the report");
  // both verdicts are kept — discarding one would throw away the only thing the second model added
  const d = on.full.results.find((r: any) => r.confidence_mode === "disputed");
  assert.ok(d.dual_status && d.dual_status !== d.status, "the dissenting verdict is retained");
});
