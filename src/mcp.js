import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import {
  inspect,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  compareSnapshots,
  searchEvidence,
  summary,
} from "./core.js";
import { exportReport } from "./report.js";
import { reconstructionBrief } from "./brief.js";
import { EngineBridge } from "./engine.js";
export function createServer(workspace = ".traceforge") {
  const server = new McpServer({ name: "traceforge", version: "0.1.0" });
  const engine = new EngineBridge();
  const json = (result) => ({
    content: [{ type: "text", text: JSON.stringify(result) }],
  });
  const tool = (name, description, shape, handler, readonly = true) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: readonly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          return json(await handler(args));
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      },
    );
  const id = z.string().uuid();
  tool(
    "traceforge_inspect",
    "Statically inspect a local file/directory without running target code. Save an immutable evidence snapshot with hashes, locations, coverage and import/IPC graph. Returns summary; use search for paginated evidence. Writes only to the selected workspace.",
    { target: z.string().min(1), label: z.string().max(200).optional() },
    async ({ target, label }) => {
      const snapshot = await inspect(target, { label, workspace });
      await saveSnapshot(snapshot, workspace);
      return {
        ...summary(snapshot),
        coverage: snapshot.coverage,
        limitations: snapshot.limitations,
      };
    },
    false,
  );
  tool(
    "traceforge_list_snapshots",
    "List saved investigation summaries, newest first.",
    {
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ offset, limit }) => {
      const snapshots = await listSnapshots(workspace);
      return {
        total: snapshots.length,
        nextOffset: offset + limit < snapshots.length ? offset + limit : null,
        snapshots: snapshots.slice(offset, offset + limit).map(summary),
      };
    },
  );
  tool(
    "traceforge_search_evidence",
    "Search saved facts by text and optional kind; includes original file hash and source location. Partial scans do not establish absence.",
    {
      snapshotId: id,
      query: z.string().default(""),
      kind: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ snapshotId, ...options }) =>
      searchEvidence(await loadSnapshot(snapshotId, workspace), options),
  );
  tool(
    "traceforge_compare",
    "Compare caller-selected snapshots using content hashes and semantic findings. Reports additions/removals/changes and whether both inventories were complete. Line movement alone does not create semantic finding changes.",
    { before: id, after: id },
    async ({ before, after }) =>
      compareSnapshots(
        await loadSnapshot(before, workspace),
        await loadSnapshot(after, workspace),
      ),
  );
  tool(
    "traceforge_graph",
    "Read paginated import/IPC relationships and their evidence IDs. IPC relationships are inferred matching-channel candidates; unresolved imports are retained.",
    {
      snapshotId: id,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ snapshotId, offset, limit }) => {
      const s = await loadSnapshot(snapshotId, workspace);
      return {
        snapshotId,
        total: s.graph.edges.length,
        edges: s.graph.edges.slice(offset, offset + limit),
        nextOffset:
          offset + limit < s.graph.edges.length ? offset + limit : null,
        limitations: s.limitations,
      };
    },
  );
  tool(
    "traceforge_reconstruction_brief",
    "Generate a deterministic Markdown implementation handoff from saved evidence. Includes source/evidence references, interface candidates, declared dependencies, verification checklist and unknowns. Does not claim to reconstruct unobserved behavior.",
    { snapshotId: id },
    async ({ snapshotId }) => ({
      markdown: reconstructionBrief(await loadSnapshot(snapshotId, workspace)),
    }),
  );
  tool(
    "traceforge_export_report",
    "Write a standalone interactive HTML report to this workspace/reports. Reports may contain target paths and extracted strings; review before sharing.",
    { snapshotId: id },
    async ({ snapshotId }) => ({
      path: await exportReport(
        [await loadSnapshot(snapshotId, workspace)],
        path.resolve(workspace, "reports", `${snapshotId}.html`),
      ),
    }),
    false,
  );
  tool(
    "rea_list_tools",
    "Discover tools from the pinned REA engine by query, returning exact schemas. REA engine starts on first use. Native engines are bring-your-own; discovery does not analyze or execute a target.",
    {
      query: z.string().default(""),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
    (args) => engine.list(args),
  );
  server.registerTool(
    "rea_call_tool",
    {
      description:
        "Call an explicitly selected REA tool with its exact arguments. Discover its schema with rea_list_tools first. Effects depend on that tool: some run targets, capture runtime state or modify local configuration. Honor its documented target scope and effects. Results come from REA; they are not automatically saved as Traceforge snapshots.",
      inputSchema: {
        name: z.string().min(1),
        arguments: z.record(z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, arguments: args }) => {
      try {
        return await engine.call(name, args);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    },
  );
  return {
    server,
    close: async () => {
      await engine.close();
      await server.close();
    },
  };
}
export async function serveMcp(workspace) {
  const instance = createServer(workspace);
  await instance.server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await instance.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  return instance;
}
