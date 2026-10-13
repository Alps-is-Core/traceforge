import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const exec = promisify(execFile),
  cli = path.resolve("src/cli.js");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "traceforge-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const decode = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

test("real CLI capture → modify → diff → search → HTML export", async (t) => {
  const root = await fixture(t),
    target = path.join(root, "app.js"),
    workspace = path.join(root, "store");
  const run = async (...args) =>
    (
      await exec(process.execPath, [cli, ...args, "--workspace", workspace], {
        timeout: 30000,
      })
    ).stdout;
  await writeFile(target, 'import "before";');
  const before = JSON.parse(await run("inspect", target, "--json"));
  await writeFile(target, 'import "after";');
  const after = JSON.parse(await run("inspect", target, "--json"));
  const diff = JSON.parse(await run("diff", before.id, after.id));
  assert.equal(diff.files.changed.length, 1);
  assert.equal(diff.findings.added[0].value, "after");
  const evidence = JSON.parse(await run("search", after.id, "after"));
  assert.equal(evidence.total, 1);
  const report = JSON.parse(await run("report", after.id, "--json"));
  assert.ok((await readFile(report.path, "utf8")).includes("Traceforge"));
  await assert.rejects(run("show", "../bad"), /UUID/);
  await assert.rejects(run("inspect", target, "--typo"), /Unknown option/);
  const version = await exec(process.execPath, [cli, "--version"]);
  assert.equal(version.stdout.trim(), "0.1.0");
});
test(
  "real MCP stdio preserves CLI/MCP evidence parity, paging, graph, compare and export",
  { timeout: 60000 },
  async (t) => {
    const root = await fixture(t),
      target = path.join(root, "app.js"),
      workspace = path.join(root, "store");
    await writeFile(target, 'import "alpha"; import "beta";');
    const client = new Client({ name: "traceforge-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--workspace", workspace],
      }),
    );
    t.after(() => client.close());
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert.equal(
      tools.tools.find((v) => v.name === "rea_call_tool").annotations
        .readOnlyHint,
      false,
    );
    const captured = decode(
      await client.callTool({
        name: "traceforge_inspect",
        arguments: { target, label: "MCP baseline" },
      }),
    );
    assert.equal(captured.findings, 2);
    const ledger = decode(
      await client.callTool({
        name: "traceforge_search_evidence",
        arguments: { snapshotId: captured.id, limit: 1 },
      }),
    );
    assert.equal(ledger.nextOffset, 1);
    assert.equal(ledger.findings[0].value, "alpha");
    const cliLedger = JSON.parse(
      (
        await exec(process.execPath, [
          cli,
          "search",
          captured.id,
          "",
          "--limit",
          "1",
          "--workspace",
          workspace,
        ])
      ).stdout,
    );
    assert.deepEqual(ledger, cliLedger);
    const graph = decode(
      await client.callTool({
        name: "traceforge_graph",
        arguments: { snapshotId: captured.id },
      }),
    );
    assert.equal(graph.edges.length, 2);
    const diff = decode(
      await client.callTool({
        name: "traceforge_compare",
        arguments: { before: captured.id, after: captured.id },
      }),
    );
    assert.equal(diff.files.changed.length, 0);
    const report = decode(
      await client.callTool({
        name: "traceforge_export_report",
        arguments: { snapshotId: captured.id },
      }),
    );
    assert.ok(
      (await readFile(report.path, "utf8")).startsWith("<!doctype html>"),
    );
    const brief = decode(
      await client.callTool({
        name: "traceforge_reconstruction_brief",
        arguments: { snapshotId: captured.id },
      }),
    );
    assert.ok(brief.markdown.includes(captured.id));
    const bad = await client.callTool({
      name: "traceforge_search_evidence",
      arguments: { snapshotId: captured.id, limit: 0 },
    });
    assert.equal(bad.isError, true);
  },
);
test(
  "real pinned REA engine discovery and JavaScript analysis through the MCP bridge",
  { timeout: 60000 },
  async (t) => {
    const root = await fixture(t),
      target = path.join(root, "sample.js");
    await writeFile(target, 'export const message="Traceforge";');
    const client = new Client({
      name: "traceforge-engine-test",
      version: "1.0.0",
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--workspace", path.join(root, "store")],
      }),
    );
    t.after(() => client.close());
    const catalog = decode(
      await client.callTool({
        name: "rea_list_tools",
        arguments: { query: "analyze_javascript_application", limit: 20 },
      }),
    );
    const tool = catalog.tools.find(
      (v) => v.name === "analyze_javascript_application",
    );
    assert.ok(tool);
    assert.ok(tool.inputSchema);
    assert.equal(tool.outputSchema, undefined);
    const result = await client.callTool({
      name: "rea_call_tool",
      arguments: {
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory", detail: "summary" },
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 500));
    assert.ok(JSON.stringify(result).includes("sha256"));
  },
);
