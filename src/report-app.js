(() => {
  "use strict";
  const snapshots = JSON.parse(
    document.getElementById("traceforge-data").textContent,
  );
  const $ = (id) => document.getElementById(id);
  const escape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  let selected = 0,
    tab = "evidence",
    page = 0,
    query = "",
    kind = "";
  const current = () => snapshots[selected];
  function display(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  function selectSnapshot(index) {
    selected = index;
    page = 0;
    $("snapshot-list").innerHTML = snapshots
      .map(
        (s, i) =>
          `<button class="snapshot ${i === selected ? "active" : ""}" data-index="${i}" aria-pressed="${i === selected}"><span>${escape(s.label)}</span><small>${escape(new Date(s.createdAt).toLocaleString())}</small></button>`,
      )
      .join("");
    $("snapshot-list")
      .querySelectorAll("button")
      .forEach((b) =>
        b.addEventListener("click", () =>
          selectSnapshot(Number(b.dataset.index)),
        ),
      );
    const s = current();
    $("title").textContent = s.label;
    $("target").textContent = s.target;
    $("file-count").textContent = s.files.length;
    $("finding-count").textContent = s.findings.length;
    $("edge-count").textContent = s.graph.edges.length;
    $("coverage-value").textContent = s.coverage.complete
      ? "Complete"
      : "Partial";
    $("coverage-caption").textContent = s.coverage.complete
      ? "Within declared inventory scope"
      : `${s.coverage.diagnostics.length} diagnostics to review`;
    $("fingerprint").textContent = `SHA-256 ${s.fingerprint.slice(0, 16)}…`;
    $("snapshot-id").textContent = `SNAPSHOT ${s.id.slice(0, 8)}`;
    render();
  }
  function render() {
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    });
    $("tools").hidden = tab !== "evidence";
    if (tab === "evidence") renderEvidence();
    if (tab === "graph") renderGraph();
    if (tab === "changes") renderChanges();
    if (tab === "coverage") renderCoverage();
  }
  function renderEvidence() {
    const matches = current().findings.filter(
      (f) =>
        (!kind || f.kind === kind) &&
        JSON.stringify(f).toLowerCase().includes(query.toLowerCase()),
    );
    const start = page * 30,
      items = matches.slice(start, start + 30);
    $("content").innerHTML =
      `<div class="panel"><div class="panel-head"><span>Evidence ledger</span><span class="muted mono">${matches.length} records</span></div>${items.length ? `<table class="evidence"><thead><tr><th>Type</th><th>Observation</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${items.map((f) => `<tr><td><span class="kind">${escape(f.kind)}</span></td><td><button class="evidence-button" data-id="${escape(f.id)}">${escape(display(f.value).slice(0, 200))}</button></td><td class="mono muted">${escape(f.source.path)}${f.source.line ? `:${f.source.line}` : f.source.offset !== undefined ? ` @${f.source.offset}` : ""}</td><td><span class="confidence ${escape(f.confidence)}">${escape(f.confidence)}</span></td></tr>`).join("")}</tbody></table>` : '<div class="empty">No matching evidence. Try a different query or file type.</div>'}<div class="pagination"><span>${matches.length ? `${start + 1}–${Math.min(start + 30, matches.length)}` : "0"} of ${matches.length}</span><div><button id="prev" ${page === 0 ? "disabled" : ""}>← Previous</button> <button id="next" ${start + 30 >= matches.length ? "disabled" : ""}>Next →</button></div></div></div>`;
    $("prev").onclick = () => {
      page--;
      renderEvidence();
    };
    $("next").onclick = () => {
      page++;
      renderEvidence();
    };
    document.querySelectorAll("[data-id]").forEach(
      (b) =>
        (b.onclick = () => {
          const f = current().findings.find((v) => v.id === b.dataset.id);
          $("detail-title").textContent = `${f.kind} · ${f.source.path}`;
          $("detail-json").textContent = JSON.stringify(f, null, 2);
          $("detail-dialog").showModal();
        }),
    );
  }
  function renderGraph() {
    const s = current(),
      edges = s.graph.edges.slice(0, 60);
    const sources = [...new Set(edges.map((e) => e.from))],
      targets = [...new Set(edges.map((e) => e.to))];
    const height = Math.max(
      230,
      Math.max(sources.length, targets.length) * 46 + 50,
    );
    const node = (name, x, y) =>
      `<g class="graph-node"><rect x="${x}" y="${y}" width="240" height="30" rx="4"/><text x="${x + 10}" y="${y + 19}">${escape(name.length > 32 ? name.slice(0, 29) + "…" : name)}</text><title>${escape(name)}</title></g>`;
    const lines = edges
      .map(
        (e) =>
          `<path class="graph-line" fill="none" ${e.resolved ? "" : 'stroke-dasharray="4 4"'} d="M 265 ${sources.indexOf(e.from) * 46 + 40} C 355 ${sources.indexOf(e.from) * 46 + 40}, 355 ${targets.indexOf(e.to) * 46 + 40}, 445 ${targets.indexOf(e.to) * 46 + 40}"><title>${escape(e.type)}${e.channel ? `: ${escape(e.channel)}` : ""}</title></path>`,
      )
      .join("");
    $("content").innerHTML =
      `<div class="panel"><div class="panel-head"><span>Dependency & IPC map</span><span class="muted mono">${s.graph.edges.length} relationships</span></div>${edges.length ? `<div class="graph-wrap"><svg viewBox="0 0 710 ${height}" role="img" aria-label="Dependency relationships">${lines}${sources.map((v, i) => node(v, 25, i * 46 + 25)).join("")}${targets.map((v, i) => node(v, 445, i * 46 + 25)).join("")}</svg></div>` : '<div class="empty">No static import or IPC relationships found.</div>'}<div class="legend"><span>━ Resolved file import</span><span>┄ External / unresolved / IPC candidate</span></div></div><p class="muted">Showing ${edges.length} of ${s.graph.edges.length} edges. Full provenance is available in the JSON export. IPC links are matching-channel candidates, not verified runtime calls.</p><div class="panel"><div class="panel-head">Relationship evidence</div><ul class="list">${edges.map((e) => `<li>${escape(e.from)} → ${escape(e.to)}<br><span class="muted">${escape(e.type)} · evidence ${escape(e.evidenceId)}${e.channel ? ` · ${escape(e.channel)}` : ""}</span></li>`).join("")}</ul></div>`;
  }
  function difference(a, b) {
    const ma = new Map(a.files.map((f) => [f.path, f])),
      mb = new Map(b.files.map((f) => [f.path, f]));
    return {
      added: b.files.filter((f) => !ma.has(f.path)),
      removed: a.files.filter((f) => !mb.has(f.path)),
      changed: b.files.filter(
        (f) => ma.has(f.path) && ma.get(f.path).sha256 !== f.sha256,
      ),
    };
  }
  function renderChanges(baseline) {
    const options = snapshots
      .map((s, i) =>
        i !== selected
          ? `<option value="${i}">${escape(s.label)} · ${escape(new Date(s.createdAt).toLocaleString())}</option>`
          : "",
      )
      .join("");
    if (!options) {
      $("content").innerHTML =
        '<div class="panel empty">Capture a second snapshot in this workspace to compare versions.<br><br><code>traceforge inspect ./target --label "After change"</code></div>';
      return;
    }
    const beforeIndex = baseline ?? (selected === 0 ? 1 : 0),
      before = snapshots[beforeIndex],
      after = current(),
      diff = difference(before, after);
    const list = (items, cls) =>
      items.length
        ? `<ul class="list">${items.map((f) => `<li class="${cls}">${escape(f.path)}</li>`).join("")}</ul>`
        : '<div class="empty">No files in this category</div>';
    $("content").innerHTML =
      `<div class="tools"><label for="baseline" class="muted">Compare current snapshot against</label><select id="baseline">${options}</select></div>${!before.coverage.complete || !after.coverage.complete ? '<div class="callout">One or both scans are partial. An absent file may be unexamined; deletion is not proven.</div>' : ""}<div class="grid2"><div class="panel"><div class="panel-head">Added · ${diff.added.length}</div>${list(diff.added, "add")}</div><div class="panel"><div class="panel-head">Removed · ${diff.removed.length}</div>${list(diff.removed, "remove")}</div></div><div class="panel" style="margin-top:20px"><div class="panel-head">Content changed · ${diff.changed.length}</div>${list(diff.changed, "")}</div><p class="muted">Changes use SHA-256 content hashes. The CLI diff also compares semantic findings, ignoring line movement.</p>`;
    $("baseline").value = String(beforeIndex);
    $("baseline").onchange = () => renderChanges(Number($("baseline").value));
  }
  function renderCoverage() {
    const s = current();
    $("content").innerHTML =
      `<div class="panel"><div class="panel-head"><span>Scope & limitations</span><span class="badge">${s.coverage.complete ? "COMPLETE IN SCOPE" : "PARTIAL"}</span></div><ul class="coverage-list">${s.limitations.map((v) => `<li>${escape(v)}</li>`).join("")}</ul><div class="detail"><pre>${escape(JSON.stringify({ bytesExamined: s.coverage.bytesExamined, limits: s.coverage.limits, excludedDirectories: s.coverage.excludedDirectories }, null, 2))}</pre></div></div><div class="panel" style="margin-top:20px"><div class="panel-head">Diagnostics · ${s.coverage.diagnostics.length}</div>${s.coverage.diagnostics.length ? `<ul class="list">${s.coverage.diagnostics.map((v) => `<li>${escape(v.path)}<br><span class="muted">${escape(v.reason)}</span></li>`).join("")}</ul>` : '<div class="empty">No skipped files or parse failures inside the inventory scope.</div>'}</div>`;
  }
  $("search").oninput = (e) => {
    query = e.target.value;
    page = 0;
    renderEvidence();
  };
  $("kind").onchange = (e) => {
    kind = e.target.value;
    page = 0;
    renderEvidence();
  };
  document.querySelectorAll(".tab").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab;
        render();
      }),
  );
  $("close-detail").onclick = () => $("detail-dialog").close();
  $("export").onclick = () => {
    const blob = new Blob([JSON.stringify(current(), null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `traceforge-${current().id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("status").textContent =
      "Snapshot exported. Review paths and extracted strings before sharing.";
  };
  $("copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(current().id);
      $("status").textContent = "Snapshot ID copied.";
    } catch {
      $("status").textContent = `Snapshot ID: ${current().id}`;
    }
  };
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "/" &&
      !["INPUT", "SELECT", "TEXTAREA"].includes(
        document.activeElement.tagName,
      ) &&
      !$("detail-dialog").open
    ) {
      e.preventDefault();
      tab = "evidence";
      render();
      $("search").focus();
    }
  });
  if (snapshots.length) selectSnapshot(0);
  else {
    $("title").textContent = "Your first investigation";
    $("content").innerHTML =
      '<div class="panel empty">No snapshots yet.<br><br><code>traceforge inspect ./target --label "Baseline"</code><p>Reload this page after capturing a snapshot.</p></div>';
    $("export").disabled = true;
    $("copy").disabled = true;
  }
})();
