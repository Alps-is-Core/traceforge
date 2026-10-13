# Product decisions and implementation plan

The reference is REA, a reverse-engineering CLI/MCP toolkit. The linked demo is titled “How To Use REA To Clone Any Software In Minutes.” Its transcript was unavailable (YouTube subtitle requests returned HTTP 429); implementation decisions were based on the public repository, package and documentation, not claimed visual inspection of the video.

Upstream inspected: morluto/rea at commit `18831491cfb5cb98abbffce0cb04dae12a90fe28`. Runtime engine: `rea-agents@6.4.0`.

## Direction

Preserve the proven upstream analysis breadth through a pinned engine dependency. Implement a distinct workbench around the recurring analyst problem: evidence gets scattered across agent calls and terminal output, and comparing iterations or handing off a reconstruction requires manual work.

Traceforge adds immutable snapshots, a searchable ledger, static graph views, diffs, portable reports and deterministic reconstruction briefs. The interface uses an understated dark analysis workspace, mint highlights, monospace evidence locations and explicit confidence/coverage. The primary task is examining evidence, so the ledger is the default view.

## Execution sequence

1. Inspect reference architecture, scope, licensing, tool contracts and tests.
2. Implement shared workspace analysis and provenance before adapters.
3. Add content/semantic comparison and bounded relationship derivation.
4. Build the read-only dashboard and offline report UI.
5. Add CLI, agent tools and a lazy protocol bridge to the real upstream engine.
6. Test real CLI/MCP workflows, malformed inputs, boundaries, reports and browser interaction.
7. Package, document, publish the public repository and verify CI.

## Tradeoffs

- Depending on REA keeps original capabilities available and attribution accurate; it also makes engine behavior dependent on upstream. Version 6.4.0 and its transitive resolution are locked.
- File-backed immutable snapshots avoid database setup. v0.1.0 has no multi-user collaboration or automatic live refreshing.
- Static interface candidates are starting points for investigation. This project does not claim to regenerate arbitrary software automatically.
- A bridge with two engine tools keeps the initial MCP catalog small; agent tool selection still requires discovery and the exact upstream schema. No agent-token performance improvement is claimed without a measured evaluation.

## Future work

Potential follow-ups: validated import of REA Evidence bundles, analyst annotations, provider-specific verification lanes, transactional capture support, graph cycle analysis, and a multi-user workspace with explicit access control. These are not shipped features.
