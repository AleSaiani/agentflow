import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The plugin marketplace reads `.claude-plugin/plugin.json`, NOT `package.json` — so a release that
 * bumps only one of them ships a plugin that still advertises the old version and never offers an
 * update. This test is the gate: `npm test` runs it, and `release.yml` gates the tagged release on
 * `npm test`, so the two versions can no longer drift apart unnoticed.
 */
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(p), "utf8"));

test("manifest: package.json and .claude-plugin/plugin.json declare the same version", () => {
  const pkg = read("package.json")["version"];
  const plugin = read(".claude-plugin/plugin.json")["version"];
  assert.equal(
    plugin,
    pkg,
    `version drift: package.json=${pkg} vs .claude-plugin/plugin.json=${plugin} — bump both (the marketplace reads plugin.json)`,
  );
});

test("manifest: the newest CHANGELOG entry is the declared version", () => {
  const version = read("package.json")["version"];
  const changelog = readFileSync(resolve("CHANGELOG.md"), "utf8");
  // Every `## [x.y.z] - date` heading, skipping the standing `## [Unreleased]` section.
  const entries = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]).filter((v) => v !== "Unreleased");
  assert.equal(
    entries[0],
    version,
    `CHANGELOG's newest entry is ${entries[0]} but package.json says ${version} — every release needs its own entry, newest first`,
  );
});

test("manifest: the README version badge matches the declared version", () => {
  const version = read("package.json")["version"];
  const readme = readFileSync(resolve("README.md"), "utf8");
  const badge = readme.match(/img\.shields\.io\/badge\/version-(.+?)-blue/);
  assert.ok(badge, "README must carry a shields.io version badge");
  const shown = badge[1].replace(/--/g, "-"); // shields.io escapes '-' as '--'
  assert.equal(shown, version, `README badge shows ${shown} but package.json says ${version}`);
});

test("manifest: plugin and marketplace agree on the plugin name", () => {
  const plugin = read(".claude-plugin/plugin.json");
  const market = read(".claude-plugin/marketplace.json");
  const listed = (market["plugins"] as Record<string, unknown>[])?.map((p) => p["name"]);
  assert.ok(listed?.includes(plugin["name"]), `marketplace.json must list the plugin '${String(plugin["name"])}'`);
});
