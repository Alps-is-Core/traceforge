import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { snapshotSchema, writeAtomic } from "./core.js";
export function serializeForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
export async function renderReport(snapshots) {
  snapshots.forEach((s) => snapshotSchema.parse(s));
  const [css, app] = await Promise.all([
    readFile(new URL("./report.css", import.meta.url), "utf8"),
    readFile(new URL("./report-app.js", import.meta.url), "utf8"),
  ]);
  const hash = createHash("sha256").update(app).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Traceforge · Investigation workspace</title><style>${css}</style></head><body><aside><div class="brand"><span class="mark">⌁</span>Traceforge</div><div class="subbrand">FOLLOW THE EVIDENCE</div><div class="label sidebar-label">Investigation snapshots</div><nav class="snapshots" id="snapshot-list" aria-label="Snapshots"></nav><div class="aside-foot"><span class="dot"></span>Local workspace<br>Static evidence · REA engine<br>Traceforge v0.1.0 / MIT</div></aside><main><header class="topbar"><div class="crumb">Workspace <span aria-hidden="true">/</span> <strong>Investigation</strong></div><span class="badge">LOCAL • READ ONLY</span></header><section class="intro"><div><div class="label">INVESTIGATION OVERVIEW</div><h1 id="title">Loading workspace</h1><div class="target" id="target">Content-addressed evidence, at your fingertips.</div></div><div class="intro-actions"><button id="copy">Copy ID</button><button class="primary" id="export">Export JSON ↗</button></div></section><div class="stats"><div class="stat"><div class="label">Files examined</div><div class="num" id="file-count">0</div><small>SHA-256 fingerprinted</small></div><div class="stat"><div class="label">Evidence records</div><div class="num" id="finding-count">0</div><small>Every finding has a source</small></div><div class="stat"><div class="label">Relationships</div><div class="num" id="edge-count">0</div><small>Imports & IPC candidates</small></div><div class="stat"><div class="label">Inventory coverage</div><div class="num" style="font-size:25px;letter-spacing:-1px" id="coverage-value">—</div><small id="coverage-caption">Within declared scope</small></div></div><div class="tabs" role="tablist" aria-label="Investigation views"><button class="tab active" role="tab" data-tab="evidence" aria-selected="true">Evidence ledger</button><button class="tab" role="tab" data-tab="graph" aria-selected="false">Dependency map</button><button class="tab" role="tab" data-tab="changes" aria-selected="false">Version changes</button><button class="tab" role="tab" data-tab="coverage" aria-selected="false">Scope & diagnostics</button></div><div class="tools" id="tools"><label class="search"><span aria-hidden="true">⌕</span><input type="search" id="search" placeholder="Search evidence, channels, modules…" aria-label="Search evidence"><kbd>/</kbd></label><select id="kind" aria-label="Filter evidence type"><option value="">All evidence types</option>${["import", "export", "ipc", "bridge", "route", "request", "package", "dependency", "network", "binary-header", "string"].map((x) => `<option value="${x}">${x}</option>`).join("")}</select></div><section id="content" aria-label="Investigation results"></section><div id="status" class="status" role="status"></div><footer class="footer"><span id="snapshot-id">SNAPSHOT</span><span id="fingerprint">SHA-256 provenance</span><span>NO TARGET EXECUTION</span></footer></main><dialog id="detail-dialog"><button id="close-detail" aria-label="Close detail">Close ×</button><h2 id="detail-title">Evidence</h2><pre id="detail-json"></pre></dialog><script id="traceforge-data" type="application/json">${serializeForHtml(snapshots)}</script><script>${app}</script></body></html>`;
}
export async function exportReport(snapshots, destination) {
  return writeAtomic(destination, await renderReport(snapshots));
}
