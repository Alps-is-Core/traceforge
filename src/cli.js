#!/usr/bin/env node
import path from "node:path";
import { createServer } from "node:http";
import {
  inspect,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  summary,
  compareSnapshots,
  searchEvidence,
  writeAtomic,
} from "./core.js";
import { exportReport, renderReport } from "./report.js";
import { reconstructionBrief } from "./brief.js";
import { runEngine } from "./engine.js";
import { serveMcp } from "./mcp.js";
const HELP = `
Traceforge · follow the evidence

Usage: traceforge <command> [arguments] [options]

  inspect <target>             Capture a static evidence snapshot
  list                        List saved snapshots
  show <id>                   Read a complete snapshot
  search <id> <query>          Search the evidence ledger
  diff <before> <after>       Compare hashes and semantic findings
  graph <id>                   Read the dependency/IPC graph
  report <id>                  Export standalone interactive HTML
  brief <id>                   Generate an evidence-linked reconstruction brief
  dashboard                   Serve a local read-only workspace UI
  mcp                         Start the agent MCP server over stdio
  engine [rea arguments...]   Run the bundled REA CLI (all upstream commands)
  doctor                      Check bundled engine and workspace readiness

Options:
  --workspace <path>           Storage directory (default: .traceforge)
  --label <text>               Snapshot label
  --output <path>              Export destination (report/show/graph/diff)
  --json                      Print machine-readable results
  --history                   Include workspace history in an HTML report
  --kind <type>                Evidence type filter for search
  --offset <n> --limit <n>     Search pagination (default: 0 / 100)
  --port <n>                   Dashboard port (default: 4318)

Examples:
  traceforge inspect ./app --label "Baseline"
  traceforge dashboard
  traceforge engine analyze-javascript-application ./app --json
  traceforge mcp --workspace /absolute/path/to/evidence

Snapshots inspect targets without executing their code. REA engine commands
retain upstream behavior, prerequisites and effects. See docs/architecture.md.
`;
function parseArgs(args) {
  const options = {},
    positional = [];
  const valueFlags = new Set([
    "workspace",
    "label",
    "output",
    "kind",
    "offset",
    "limit",
    "port",
  ]);
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (name === "json" || name === "help" || name === "history") {
      options[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new Error(`Unknown option: ${value}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--"))
      throw new Error(`${value} requires a value`);
    options[name] = args[++i];
  }
  return { options, positional };
}
function integer(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("Expected a nonnegative integer");
  return Number(raw);
}
function requireArgs(args, count) {
  if (args.length !== count)
    throw new Error(
      `Expected ${count} positional argument(s); got ${args.length}. Run traceforge --help.`,
    );
}
async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && raw[0] === "--version") {
    process.stdout.write("0.1.0\n");
    return;
  }
  if (raw[0] === "engine") {
    process.exitCode = await runEngine(raw.slice(1));
    return;
  }
  const { options: opts, positional } = parseArgs(raw),
    [command, ...args] = positional;
  if (!command || opts.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write("0.1.0\n");
    return;
  }
  const workspace = path.resolve(opts.workspace ?? ".traceforge");
  const output = async (data) => {
    const text = JSON.stringify(data, null, 2) + "\n";
    if (opts.output) {
      const destination = await writeAtomic(opts.output, text);
      process.stdout.write(
        opts.json
          ? JSON.stringify({ path: destination }) + "\n"
          : `Written to ${destination}\n`,
      );
    } else process.stdout.write(text);
  };
  if (command === "inspect") {
    requireArgs(args, 1);
    const s = await inspect(args[0], { label: opts.label, workspace });
    const saved = await saveSnapshot(s, workspace);
    if (opts.json)
      await output({ ...summary(s), path: saved, coverage: s.coverage });
    else
      process.stdout.write(
        `\nTraceforge captured ${s.label}\n\n  ID        ${s.id}\n  Files     ${s.files.length}\n  Evidence  ${s.findings.length}\n  Edges     ${s.graph.edges.length}\n  Coverage  ${s.coverage.complete ? "complete within inventory scope" : `partial (${s.coverage.diagnostics.length} diagnostics)`}\n  Saved     ${saved}\n\nOpen workspace: traceforge dashboard --workspace ${JSON.stringify(workspace)}\n`,
      );
  } else if (command === "list") {
    requireArgs(args, 0);
    await output((await listSnapshots(workspace)).map(summary));
  } else if (command === "show") {
    requireArgs(args, 1);
    await output(await loadSnapshot(args[0], workspace));
  } else if (command === "graph") {
    requireArgs(args, 1);
    await output((await loadSnapshot(args[0], workspace)).graph);
  } else if (command === "search") {
    requireArgs(args, 2);
    await output(
      searchEvidence(await loadSnapshot(args[0], workspace), {
        query: args[1],
        kind: opts.kind,
        offset: integer(opts.offset, 0),
        limit: integer(opts.limit, 100),
      }),
    );
  } else if (command === "diff") {
    requireArgs(args, 2);
    await output(
      compareSnapshots(
        await loadSnapshot(args[0], workspace),
        await loadSnapshot(args[1], workspace),
      ),
    );
  } else if (command === "brief") {
    requireArgs(args, 1);
    const destination = await writeAtomic(
      opts.output ?? path.join(workspace, "briefs", `${args[0]}.md`),
      reconstructionBrief(await loadSnapshot(args[0], workspace)),
    );
    process.stdout.write(
      opts.json
        ? JSON.stringify({ path: destination }) + "\n"
        : `Brief: ${destination}\n`,
    );
  } else if (command === "report") {
    requireArgs(args, 1);
    const current = await loadSnapshot(args[0], workspace);
    const snapshots = opts.history
      ? [
          current,
          ...(await listSnapshots(workspace)).filter(
            (s) => s.id !== current.id,
          ),
        ]
      : [current];
    const destination = await exportReport(
      snapshots,
      opts.output ?? path.join(workspace, "reports", `${args[0]}.html`),
    );
    process.stdout.write(
      opts.json
        ? JSON.stringify({ path: destination }) + "\n"
        : `Report: ${destination}\n`,
    );
  } else if (command === "mcp") {
    requireArgs(args, 0);
    await serveMcp(workspace);
  } else if (command === "dashboard") {
    requireArgs(args, 0);
    const port = integer(opts.port, 4318);
    if (port < 0 || port > 65535)
      throw new Error("Port must be between 0 and 65535");
    const server = createServer(async (req, res) => {
      if (
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "") ||
        (req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`)
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (req.method !== "GET" || req.url !== "/") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      try {
        const html = await renderReport(await listSnapshots(workspace));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Workspace could not be read: ${e.message}`);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    process.stdout.write(
      `Traceforge workspace: http://127.0.0.1:${server.address().port}\nRead-only dashboard. Reload after capturing new snapshots. Ctrl+C to stop.\n`,
    );
    const close = () => server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else if (command === "doctor") {
    requireArgs(args, 0);
    const { enginePath } = await import("./engine.js");
    await output({
      traceforge: "0.1.0",
      node: process.version,
      engine: "REA 6.4.0",
      enginePath: enginePath(),
      workspace,
      snapshots: (await listSnapshots(workspace)).length,
      staticInspection: "ready",
      deepAnalysis:
        "Use traceforge engine doctor for provider readiness; Ghidra/Hopper/IDA are optional external installations.",
    });
  } else throw new Error(`Unknown command: ${command}. Run traceforge --help.`);
}
main().catch((e) => {
  process.stderr.write(`Traceforge: ${e.message}\n`);
  process.exitCode = 1;
});
