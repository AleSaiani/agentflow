import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const WF = resolve("workflows/knowledge-build");
const RESOLVE = join(WF, "resolve.mjs");
const WALK = join(WF, "walk.mjs");
const VALIDATE = join(WF, "validate.mjs");
const FINALIZE = join(WF, "finalize.mjs");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kb-"));
}
function node(script: string, env: Record<string, string>): string {
  return execFileSync("node", [script], { encoding: "utf8", env: { ...process.env, ...env } });
}
function gitRepo(): string {
  const r = join(tmp(), "repo");
  mkdirSync(join(r, "src"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "a@b.c");
  g("config", "user.name", "t");
  return r;
}
const gadd = (r: string, msg: string) => {
  execFileSync("git", ["add", "-A"], { cwd: r });
  execFileSync("git", ["commit", "-qm", msg], { cwd: r });
};

test("walk: enumerates every code file with a content hash; honors the changed set", () => {
  const r = gitRepo();
  writeFileSync(join(r, "src", "a.ts"), "export const a=1;\n");
  writeFileSync(join(r, "src", "b.cs"), "class B{}\n");
  writeFileSync(join(r, "README.md"), "# not code\n");
  const base = tmp();
  const cfg = join(base, "cfg.json");
  writeFileSync(cfg, JSON.stringify({ repo: r, changed: ["src/a.ts"], mode: "update" }));
  const out = JSON.parse(node(WALK, { KB_CONFIG: cfg }));
  const rels = out.files.map((f: any) => f.rel).sort();
  assert.deepEqual(rels, ["src/a.ts", "src/b.cs"]); // README.md excluded (not code)
  assert.ok(out.files.every((f: any) => f.hash && f.hash !== "0"));
  assert.equal(out.files.find((f: any) => f.rel === "src/a.ts").changed, true);
  assert.equal(out.files.find((f: any) => f.rel === "src/b.cs").changed, false);
});

test("validate: every file is covered — unassigned files sweep into _unclassified", () => {
  const base = tmp();
  const out = join(base, "out");
  const cfg = join(base, "cfg.json");
  const plan = join(base, "plan.json");
  const files = join(base, "files.json");
  writeFileSync(cfg, JSON.stringify({ mode: "bootstrap", repo: base, out_dir: out, manifest_path: join(out, "manifest.json"), ref: "abc" }));
  writeFileSync(files, JSON.stringify({ files: [{ rel: "a.ts", hash: "h1", changed: true }, { rel: "b.ts", hash: "h2", changed: true }] }));
  writeFileSync(plan, JSON.stringify({ schema: { sections: ["Purpose"] }, entities: [{ id: "x", kind: "code", area: "src", files: ["a.ts"] }] }));

  const items = JSON.parse(node(VALIDATE, { KB_CONFIG: cfg, KB_PLAN: plan, KB_FILES: files }));
  const ids = items.map((i: any) => i.id).sort();
  assert.deepEqual(ids, ["_unclassified/unclassified", "src/x"]); // b.ts swept into _unclassified
  const x = items.find((i: any) => i.id === "src/x");
  assert.ok(x.data.content_hash && x.data.doc_path.endsWith("src/x.md"));
  assert.ok(existsSync(join(out, "schema.json")) && existsSync(join(out, "entities.json")));
});

test("validate (update): only entities touching a changed file are re-documented", () => {
  const base = tmp();
  const out = join(base, "out");
  const cfg = join(base, "cfg.json");
  const plan = join(base, "plan.json");
  const files = join(base, "files.json");
  writeFileSync(cfg, JSON.stringify({ mode: "update", repo: base, out_dir: out, manifest_path: join(out, "manifest.json"), ref: "new" }));
  writeFileSync(files, JSON.stringify({ files: [{ rel: "a.ts", hash: "h1", changed: true }, { rel: "b.ts", hash: "h2", changed: false }] }));
  writeFileSync(plan, JSON.stringify({ entities: [{ id: "ea", kind: "code", area: "src", files: ["a.ts"] }, { id: "eb", kind: "code", area: "src", files: ["b.ts"] }] }));

  const items = JSON.parse(node(VALIDATE, { KB_CONFIG: cfg, KB_PLAN: plan, KB_FILES: files }));
  assert.deepEqual(items.map((i: any) => i.id), ["src/ea"]); // eb (unchanged) skipped
});

test("resolve: bootstrap records HEAD; update diffs since the recorded ref", () => {
  const r = gitRepo();
  const out = join(tmp(), "out");
  writeFileSync(join(r, "src", "Foo.cs"), "class Foo{}\n");
  writeFileSync(join(r, "src", "util.ts"), "export const x=1;\n");
  gadd(r, "base");

  // bootstrap → ref = HEAD, full pass (changed null)
  const boot = JSON.parse(node(RESOLVE, { KB_DIR: r, KB_MODE: "bootstrap", KB_OUT: out }));
  assert.equal(boot.mode, "bootstrap");
  assert.equal(boot.changed, null);
  assert.ok(boot.ref && boot.ref.length >= 7);

  // write a manifest recording that ref (finalize would do this), then change a file + commit
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ ref: boot.ref, entities: [] }));
  writeFileSync(join(r, "src", "Foo.cs"), "class Foo{ int x; }\n");
  gadd(r, "change");

  const upd = JSON.parse(node(RESOLVE, { KB_DIR: r, KB_MODE: "update", KB_OUT: out }));
  assert.equal(upd.mode, "update");
  assert.equal(upd.prev_ref, boot.ref);
  assert.deepEqual(upd.changed, ["src/Foo.cs"]); // only the changed code file
});

test("finalize: writes index.md + relations + a manifest with the ref and entities", () => {
  const base = tmp();
  const out = join(base, "out");
  mkdirSync(out, { recursive: true });
  const cfg = join(base, "cfg.json");
  const entities = join(base, "entities.json");
  const rel = join(base, "rel.json");
  writeFileSync(cfg, JSON.stringify({ mode: "bootstrap", repo: base, out_dir: out, manifest_path: join(out, "manifest.json"), ref: "deadbeef" }));
  writeFileSync(entities, JSON.stringify([
    { id: "src/foo", data: { entity_id: "foo", kind: "code", area: "src", summary: "Foo", files: ["src/Foo.cs"], content_hash: "h1", doc_path: join(out, "src", "foo.md").split("\\").join("/") } },
  ]));
  writeFileSync(rel, JSON.stringify({ relations: [{ from: "src/foo", to: "src/bar", kind: "depends-on" }] }));

  const summary = JSON.parse(node(FINALIZE, { KB_CONFIG: cfg, KB_ENTITIES: entities, KB_RELATIONS: rel }));
  assert.equal(summary.entities, 1);
  assert.equal(summary.relations, 1);
  assert.ok(existsSync(join(out, "index.md")));
  assert.match(readFileSync(join(out, "index.md"), "utf8"), /\[foo\]\(src\/foo\.md\)/);
  assert.ok(existsSync(join(out, "relations.md")));

  // graph export (the graph-DB seed): json + Graphviz + Cypher
  assert.equal(summary.graph.nodes, 1);
  assert.equal(summary.graph.edges, 1);
  const graph = JSON.parse(readFileSync(join(out, "graph.json"), "utf8"));
  assert.deepEqual(graph.nodes[0].id, "src/foo");
  assert.equal(graph.edges[0].kind, "depends-on");
  assert.match(readFileSync(join(out, "graph.dot"), "utf8"), /digraph knowledge/);
  assert.match(readFileSync(join(out, "graph.cypher"), "utf8"), /MERGE \(n:Entity/);
  assert.match(readFileSync(join(out, "graph.cypher"), "utf8"), /\[:DEPENDS_ON\]/);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.ref, "deadbeef");
  assert.equal(manifest.entities.length, 1);
  assert.equal(manifest.entities[0].content_hash, "h1");
});
