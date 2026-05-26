import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveLens, detectStack, refineStack, SEVERITY_RANK } from "../workflows/pr-review/lenses.mjs";

const WF = resolve("workflows/pr-review");
const DISCOVER = join(WF, "discover.mjs");
const CLASSIFY = join(WF, "classify.mjs");
const REPORT = join(WF, "report.mjs");
const INSPECT = resolve("dist/inspect.js");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prr-"));
}
function node(script: string, env: Record<string, string>, cwd?: string): string {
  return execFileSync("node", [script], { encoding: "utf8", env: { ...process.env, ...env }, ...(cwd ? { cwd } : {}) });
}
function lastJson(out: string): any {
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}
function gitRepo(): string {
  const base = tmp();
  const r = join(base, "repo");
  mkdirSync(join(r, "src"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "a@b.c");
  g("config", "user.name", "t");
  return r;
}

test("lens cascade: additive merge by id + per-id override + whole-lens override", () => {
  const base = tmp();
  const shipped = join(base, "shipped");
  const project = join(base, "project");
  mkdirSync(shipped, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(shipped, "csharp.json"), JSON.stringify({ lens: "csharp", rules: [
    { id: "a", severity: "major", guidance: "A" },
    { id: "b", severity: "minor", guidance: "B" },
  ] }));
  // Project layer: override 'a' severity, add 'c'.
  writeFileSync(join(project, "csharp.json"), JSON.stringify({ lens: "csharp", rules: [
    { id: "a", severity: "critical", guidance: "A!" },
    { id: "c", severity: "info", guidance: "C" },
  ] }));

  const merged = resolveLens("csharp", [shipped, null, project]);
  const byId = Object.fromEntries(merged.map((r: any) => [r.id, r]));
  assert.equal(merged.length, 3); // a (overridden), b (kept), c (added)
  assert.equal(byId["a"].severity, "critical"); // project overrode shipped by id
  assert.equal(byId["b"].severity, "minor"); // untouched
  assert.equal(byId["c"].severity, "info"); // added

  // Whole-lens override replaces everything.
  writeFileSync(join(project, "csharp.json"), JSON.stringify({ lens: "csharp", override: true, rules: [{ id: "z", severity: "minor", guidance: "Z" }] }));
  const replaced = resolveLens("csharp", [shipped, null, project]);
  assert.deepEqual(replaced.map((r: any) => r.id), ["z"]);
});

test("detectStack maps extensions; refineStack disambiguates JS/TS family by content", () => {
  assert.equal(detectStack("src/Foo.cs"), "csharp");
  assert.equal(detectStack("a/b.tsx"), "typescript-react");
  assert.equal(detectStack("x.py"), "python");
  assert.equal(detectStack("svc.ts"), "node"); // plain TS defaults to node, refined by content
  assert.equal(detectStack("README.md"), null);
  assert.ok(SEVERITY_RANK.critical > SEVERITY_RANK.major && SEVERITY_RANK.major > SEVERITY_RANK.minor);

  assert.equal(refineStack("node", "import { Component } from '@angular/core';"), "angular");
  assert.equal(refineStack("node", "import React from 'react';"), "typescript-react");
  assert.equal(refineStack("node", "import { readFileSync } from 'node:fs';"), "node"); // plain node
  assert.equal(refineStack("csharp", "anything"), "csharp"); // non-JS/TS untouched
});

test("shipped lenses are valid JSON with id+severity+guidance rules", () => {
  for (const key of ["csharp", "typescript-react", "security", "node", "angular", "python", "go", "java"]) {
    const j = JSON.parse(readFileSync(join(WF, "lenses", `${key}.json`), "utf8"));
    assert.ok(Array.isArray(j.rules) && j.rules.length > 0, `${key} has rules`);
    for (const r of j.rules) {
      assert.ok(r.id && r.guidance, `${key} rule has id+guidance`);
      assert.ok(["info", "minor", "major", "critical"].includes(r.severity), `${key}/${r.id} severity valid`);
    }
  }
});

test("discover: emits changed files + the files that reference them (related)", () => {
  const r = gitRepo();
  writeFileSync(join(r, "src", "Foo.cs"), "class Foo {}\n");
  writeFileSync(join(r, "src", "Bar.cs"), "using Foo;\nclass Bar {}\n");
  execFileSync("git", ["add", "-A"], { cwd: r });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: r });
  writeFileSync(join(r, "src", "Foo.cs"), "class Foo { async void B() {} }\n");
  execFileSync("git", ["add", "-A"], { cwd: r });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: r });

  const items = JSON.parse(node(DISCOVER, { PRREVIEW_DIR: r, PRREVIEW_BASE: "HEAD~1" }));
  const byId = Object.fromEntries(items.map((i: any) => [i.id, i.data]));
  assert.equal(byId["src/Foo.cs"].reason, "changed");
  assert.equal(byId["src/Bar.cs"].reason, "related"); // Bar references Foo
  assert.deepEqual(byId["src/Bar.cs"].related_to, ["src/Foo.cs"]);
});

test("classify: attaches stack + security lenses and team rules from review-rules.json", () => {
  const base = tmp();
  const proj = join(base, "p");
  mkdirSync(join(proj, ".agentflow"), { recursive: true });
  writeFileSync(join(proj, ".agentflow", "review-rules.json"), JSON.stringify({ rules: [{ id: "team-x", severity: "major", guidance: "team rule" }] }));
  const itemsPath = join(base, "items.json");
  writeFileSync(itemsPath, JSON.stringify([{ id: "src/Foo.cs", data: { path: "/x/src/Foo.cs", rel_path: "src/Foo.cs", content_hash: "h" } }]));

  const out = JSON.parse(node(CLASSIFY, { PRREVIEW_ITEMS: itemsPath, PRREVIEW_PROJECT: proj }));
  const d = out[0].data;
  assert.ok(d.lenses.includes("csharp") && d.lenses.includes("security") && d.lenses.includes("team"));
  assert.ok(d.rules.some((r: any) => r.id === "team-x"));
  assert.ok(d.rules.some((r: any) => r.id === "sec-injection")); // security lens applied
});

test("report: deterministic gate blocks at/above threshold; rollup + markdown", () => {
  const base = tmp();
  const feDir = join(base, "foreach");
  mkdirSync(join(feDir, "rev"), { recursive: true });
  const items = {
    "src/Foo.cs": { id: "src/Foo.cs", status: "done", result: { findings: [{ rule_id: "cs-async-void", severity: "major", line: 1, note: "x" }] } },
    "src/ok.cs": { id: "src/ok.cs", status: "done", result: { findings: [] } },
  };
  writeFileSync(join(feDir, "rev", "state.json"), JSON.stringify({ items }));
  const outMd = join(base, "report.md");

  // gate=major → blocks
  const blocked = JSON.parse(node(REPORT, { PRREVIEW_REVIEW_RUN: "rev", PRREVIEW_FOREACH_DIR: feDir, PRREVIEW_GATE: "major", PRREVIEW_OUT: outMd }).trim());
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.verdict, "CHANGES REQUESTED");
  assert.equal(blocked.by_severity.major, 1);
  assert.equal(blocked.files_reviewed, 2);
  assert.ok(existsSync(outMd));
  assert.match(readFileSync(outMd, "utf8"), /cs-async-void/);

  // gate=critical → a major finding does NOT block
  const ok = JSON.parse(node(REPORT, { PRREVIEW_REVIEW_RUN: "rev", PRREVIEW_FOREACH_DIR: feDir, PRREVIEW_GATE: "critical", PRREVIEW_OUT: outMd }).trim());
  assert.equal(ok.blocked, false);
  assert.equal(ok.verdict, "OK");
});

test("inspect workflows lists pr-review as shipped from an unrelated cwd", () => {
  const cwd = tmp(); // no workflows/ here → only the plugin's shipped ones show
  const out = JSON.parse(execFileSync("node", [INSPECT, "workflows", "--json"], { encoding: "utf8", cwd }).trim());
  const pr = out.find((w: any) => w.name === "pr-review");
  assert.ok(pr, "pr-review present");
  assert.equal(pr.origin, "shipped");
  assert.equal(pr.stages, 4);
});
