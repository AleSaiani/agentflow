# knowledge-build — repo → structured markdown documentation

Turns a repository into a structured md tree (folders + files) the team owns. What it adds over "ask an
LLM to document the code" is **the determinism of covering everything** — every code file is accounted for
(code enforces it; the LLM only groups/names) — plus **LLM-derived relationships materialized as a
deterministic list** (the seed for a future graph DB).

```bash
/agentflow:run-workflow knowledge-build --param repo=. --param out_dir=docs/knowledge          # bootstrap
/agentflow:run-workflow knowledge-build --param mode=update                                     # incremental
```

## Two modes
- **bootstrap** — full pass; records the current `git HEAD` in `<out_dir>/manifest.json`.
- **update** — diffs the repo since the manifest's recorded ref and **re-documents only the new/changed
  entities**, then advances the ref. (No manifest yet → run bootstrap first.)

## Stages
`resolve` (mode + git ref + changed set) → `walk` (every code file + hash — the coverage baseline) →
`plan` *(LLM)* proposes a doc schema for this repo + groups every file into **code + domain** entities →
`validate` guarantees coverage (unassigned files → `_unclassified`) and materializes the entities census →
`document` *(foreach)* writes one structured md per entity (cached by entity hash) → `relate` *(LLM)*
derives relationships from a fixed vocabulary (`depends-on`, `used-by`, `part-of`, `implements`) →
`finalize` writes `index.md`, `relations.md`, and the manifest.

The determinism boundary: the LLM proposes the schema, groups entities, writes the docs, and derives
relations (all structured + written to disk); **code** guarantees coverage and drives the incremental diff.

## Output (`out_dir`, default `docs/knowledge/`)
```
index.md          architecture map + entity index (links)
schema.json       the LLM-proposed doc schema for this repo
entities.json     the materialized entity census
relations.md / .json   the relationship graph (human + machine)
graph.json / .dot / .cypher   the graph in three portable formats (Graphviz, Neo4j) — the graph-DB seed
manifest.json     ref commit + per-entity hashes + doc paths (drives update)
<area>/<entity>.md     one structured doc per entity
```

## Roadmap
- v2: import `graph.cypher` / `graph.json` into a **graph DB** and query the knowledge graph.
- Feeds **Dreaming** — an idle/autonomous agent reads this md tree to answer questions, flag drift, and
  propose work without re-scanning the repo.
