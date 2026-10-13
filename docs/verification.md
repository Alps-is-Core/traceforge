# Verification

Verified locally on 13 October 2026 with Node.js v22.23.1, npm 10.9.8, macOS, installed Google Chrome, and pinned `rea-agents@6.4.0`.

## Passing checks

- Syntax checks for every runtime JavaScript module and the browser test.
- Prettier formatting checks across source, tests, documentation and workflow configuration.
- Release archive install into a fresh local package directory, followed by the packaged doctor and static inspection CLI.
- 16 core/integration tests with zero skips.
- A separate real Chromium browser test with zero skips.
- Real CLI sequence: inspect → modify target → inspect → compare → search → export HTML.
- Real MCP stdio sequence: catalog → inspect → paginated search → compare → graph → report → reconstruction brief; CLI and MCP search results match.
- Real pinned REA MCP discovery and `analyze_javascript_application` on a local self-owned fixture, through Traceforge's bridge.
- Desktop and 390 px mobile UI: search/filter results, evidence dialog, dependency graph, comparison, coverage, slash-key focus and JSON download.
- Standalone `file://` HTML operation, escaped executable markup, loopback Host/Origin rejection and unknown-route handling.
- AST imports versus comments/strings, TSX, malformed syntax, deterministic fingerprints, workspace exclusion across macOS path aliases, symlink omission, file/byte bounds, HAR credential omission, binary offsets, corrupt snapshots, UUID path validation, exclusive writes, semantic diffs and bounded IPC fanout.

## Verification limits

No real Hopper, Ghidra, IDA, Android device, .NET, browser-capture or other native/runtime provider lane was exercised. Those capabilities come from the pinned upstream engine and retain its prerequisites. Static IPC and route matches are candidates, not runtime proofs. No end-to-end arbitrary-software reconstruction benchmark or agent-token performance study was performed.

GitHub CI runs core/integration checks on Linux with Node 22 and 24, and real Chromium UI verification on Linux. The repository's Actions results are the authoritative record for those remote runs.
