import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspect,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  compareSnapshots,
  searchEvidence,
} from "../src/core.js";
import { renderReport, serializeForHtml } from "../src/report.js";
import { buildGraph } from "../src/analyzers.js";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "traceforge-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("captures parsed imports, IPC, bridge, routes and package evidence with real source hashes", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "main.cjs"),
    "const {ipcMain}=require('electron');\nconst n=require('./notes');\nipcMain.handle('notes:list',()=>n);\napp.get('/notes',handler);\n",
  );
  await writeFile(
    path.join(root, "preload.cjs"),
    "const {ipcRenderer,contextBridge}=require('electron');\ncontextBridge.exposeInMainWorld('notes',{list:()=>ipcRenderer.invoke('notes:list')});\n",
  );
  await writeFile(path.join(root, "notes.js"), "export const notes=[];");
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"notes","dependencies":{"electron":"^36"}}',
  );
  const s = await inspect(root);
  assert.equal(s.coverage.complete, true);
  assert.equal(s.files.length, 4);
  assert.ok(
    s.findings.some(
      (f) =>
        f.kind === "ipc" && f.source.line === 3 && f.confidence === "inferred",
    ),
  );
  assert.ok(s.findings.some((f) => f.kind === "bridge"));
  assert.ok(s.findings.some((f) => f.kind === "route"));
  assert.ok(s.findings.some((f) => f.kind === "export" && f.value === "notes"));
  assert.ok(
    s.graph.edges.some(
      (e) => e.type === "local-import" && e.resolved && e.to === "notes.js",
    ),
  );
  assert.ok(
    s.graph.edges.some(
      (e) =>
        e.type === "ipc-candidate" &&
        e.channel === "notes:list" &&
        e.supportingEvidenceId,
    ),
  );
  assert.match(s.findings[0].source.sha256, /^[a-f0-9]{64}$/);
});
test("does not mistake comments and ordinary strings for JavaScript imports", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "a.js"),
    '// require("fake")\nconst s = "ipcMain.handle(\'fake\')";\nimport("./real.js");',
  );
  const s = await inspect(root);
  assert.deepEqual(
    s.findings.filter((f) => f.kind === "import").map((f) => f.value),
    ["./real.js"],
  );
});
test("parses TypeScript and TSX with positions", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "a.tsx"),
    'import React from "react";\nexport const App = (x: string) => <p>{x}</p>;',
  );
  const s = await inspect(root);
  assert.equal(s.coverage.complete, true);
  assert.equal(s.findings[0].value, "react");
});
test("inventory fingerprint is deterministic; malformed syntax creates explicit partial coverage", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "bad.js"), "export const = ;");
  const a = await inspect(root),
    b = await inspect(root);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.id, b.id);
  assert.equal(a.coverage.complete, false);
  assert.match(a.coverage.diagnostics[0].reason, /parse failed/);
});
test("skips excluded trees and symlinks, and reports real resource limits", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "node_modules", "hidden.js"),
    'require("hidden")',
  );
  await writeFile(path.join(root, "a.js"), 'require("a")');
  await writeFile(path.join(root, "b.js"), 'require("b")');
  await symlink(path.join(root, "a.js"), path.join(root, "link.js"));
  const s = await inspect(root);
  assert.equal(s.files.length, 2);
  assert.deepEqual(s.coverage.excludedDirectories, ["node_modules"]);
  assert.equal(s.coverage.complete, false);
  const limited = await inspect(root, { limits: { maxFiles: 1 } });
  assert.equal(limited.files.length, 1);
  assert.ok(
    limited.coverage.diagnostics.some((v) => v.reason.includes("count limit")),
  );
  const tiny = await inspect(root, { limits: { maxFileBytes: 2 } });
  assert.equal(tiny.files.length, 0);
  assert.equal(tiny.coverage.complete, false);
  await assert.rejects(
    inspect(root, { limits: { maxFiles: -1 } }),
    /Invalid maxFiles/,
  );
});
test("workspace inside target is excluded from repeated snapshots", async (t) => {
  const root = await fixture(t),
    workspace = path.join(root, "evidence");
  await writeFile(path.join(root, "a.js"), "export const a=1;");
  const a = await inspect(root, { workspace });
  await saveSnapshot(a, workspace);
  const b = await inspect(root, { workspace });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(b.files.length, 1);
});
test("HAR records omit credentials, query values, fragments, headers and payloads", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "capture.har"),
    JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://user:password@example.com/api?token=PRIVATE_QUERY#PRIVATE_FRAGMENT",
              headers: [{ name: "Authorization", value: "Bearer private" }],
              postData: { text: "sensitive" },
            },
            response: {
              status: 200,
              content: {
                mimeType: "application/json",
                text: "private-response",
              },
            },
            time: 23,
          },
        ],
      },
    }),
  );
  const s = await inspect(root),
    record = s.findings.find((f) => f.kind === "network");
  assert.equal(record.value.url, "https://example.com/api");
  const output = JSON.stringify(s);
  for (const value of [
    "password",
    "PRIVATE_QUERY",
    "PRIVATE_FRAGMENT",
    "Bearer private",
    "sensitive",
    "private-response",
  ])
    assert.equal(output.includes(value), false);
});
test("binary headers and ASCII strings use original byte offsets; malformed headers are partial", async (t) => {
  const root = await fixture(t),
    bytes = Buffer.alloc(80);
  Buffer.from("7f454c46", "hex").copy(bytes);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(62, 18);
  Buffer.from("hello-traceforge").copy(bytes, 32);
  await writeFile(path.join(root, "sample.elf"), bytes);
  const s = await inspect(root);
  assert.equal(
    s.findings.find((f) => f.kind === "binary-header").value.bits,
    64,
  );
  assert.equal(s.findings.find((f) => f.kind === "string").source.offset, 32);
  await writeFile(path.join(root, "bad.exe"), Buffer.from("MZ"));
  const bad = await inspect(path.join(root, "bad.exe"));
  assert.equal(bad.coverage.complete, false);
});
test("snapshot storage is immutable and validates IDs and corrupt files", async (t) => {
  const root = await fixture(t),
    workspace = path.join(root, "store");
  await writeFile(path.join(root, "a.js"), "export const a=1");
  const s = await inspect(root);
  const saved = await saveSnapshot(s, workspace);
  assert.equal((await loadSnapshot(s.id, workspace)).id, s.id);
  assert.equal((await listSnapshots(workspace)).length, 1);
  await assert.rejects(saveSnapshot(s, workspace), /EEXIST/);
  await assert.rejects(loadSnapshot("../escape", workspace), /UUID/);
  await writeFile(saved, "{}");
  await assert.rejects(loadSnapshot(s.id, workspace));
});
test("comparison detects file and semantic changes but ignores line movement", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "a.js"), 'import "old";\nexport const a=1;');
  await writeFile(path.join(root, "removed.txt"), "old");
  const a = await inspect(root);
  await writeFile(
    path.join(root, "a.js"),
    '\nimport "new";\nexport const a=1;',
  );
  await rm(path.join(root, "removed.txt"));
  await writeFile(path.join(root, "added.txt"), "new");
  const b = await inspect(root),
    diff = compareSnapshots(a, b);
  assert.equal(diff.files.changed.length, 1);
  assert.equal(diff.files.added.length, 1);
  assert.equal(diff.files.removed.length, 1);
  assert.deepEqual(
    diff.findings.added.map((f) => f.value),
    ["new"],
  );
  assert.deepEqual(
    diff.findings.removed.map((f) => f.value),
    ["old"],
  );
  assert.equal(diff.comparable, true);
  const partial = { ...b, coverage: { ...b.coverage, complete: false } };
  assert.equal(compareSnapshots(a, partial).comparable, false);
});
test("search pagination preserves provenance and rejects invalid ranges", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "a.js"),
    'import "alpha";import "beta";import "gamma";',
  );
  const s = await inspect(root);
  const a = searchEvidence(s, { query: "", kind: "import", limit: 2 });
  assert.equal(a.total, 3);
  assert.equal(a.nextOffset, 2);
  assert.equal(
    searchEvidence(s, { offset: 2, limit: 2 }).findings[0].value,
    "gamma",
  );
  assert.throws(() => searchEvidence(s, { limit: 0 }));
});
test("IPC fanout is bounded and explicitly reported", () => {
  const findings = Array.from({ length: 300 }, (_, i) => ({
    id: String(i),
    kind: "ipc",
    value: {
      call: i < 150 ? "ipcMain.handle" : "ipcRenderer.invoke",
      channel: "same",
    },
    source: { path: `${i}.js` },
  }));
  const diagnostics = [],
    graph = buildGraph([], findings, diagnostics);
  assert.equal(graph.edges.length, 10000);
  assert.equal(diagnostics.length, 1);
});
test("standalone reports escape executable markup and enforce a no-network CSP", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "a.js"), "export const a=1;");
  const s = await inspect(root, {
    label: "</script><script>globalThis.pwned=1</script>",
  });
  const html = await renderReport([s]);
  assert.equal(html.includes(s.label), false);
  assert.ok(html.includes("\\u003c/script"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("script-src 'sha256-"));
  assert.deepEqual(JSON.parse(serializeForHtml([s]))[0].label, s.label);
});
