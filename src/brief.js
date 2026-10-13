// A deterministic evidence handoff, not an LLM-generated reconstruction claim.
export function reconstructionBrief(snapshot) {
  const clean = (value) =>
    String(value)
      .replace(/[\r\n]/g, " ")
      .replace(/`/g, "'")
      .replace(/[<>]/g, "");
  const ref = (f) =>
    `\`${clean(f.source.path)}${f.source.line ? `:${f.source.line}` : ""}\` · evidence \`${f.id}\``;
  const lines = [
    `# Reconstruction brief: ${clean(snapshot.label)}`,
    "",
    `Snapshot: \`${snapshot.id}\``,
    `Inventory fingerprint: \`${snapshot.fingerprint}\``,
    `Captured: ${snapshot.createdAt}`,
    "",
    "## Goal",
    "",
    "Implement independently observed interfaces and behavior in your own project. Use the evidence below as starting points; static names alone do not establish runtime behavior.",
    "",
    "## Evidence inventory",
    "",
    `- ${snapshot.files.length} files examined; ${snapshot.findings.length} findings; ${snapshot.graph.edges.length} relationships.`,
    `- Coverage: ${snapshot.coverage.complete ? "complete within declared inventory scope" : "partial; review diagnostics before drawing absence conclusions"}.`,
    "",
    "## Interfaces to investigate",
    "",
  ];
  const interfaces = snapshot.findings.filter((f) =>
    ["ipc", "bridge", "route", "request", "export"].includes(f.kind),
  );
  for (const f of interfaces.slice(0, 100))
    lines.push(
      `- **${f.kind}**: \`${clean(typeof f.value === "string" ? f.value : JSON.stringify(f.value))}\` (${f.confidence}). ${ref(f)}`,
    );
  if (!interfaces.length)
    lines.push(
      "No interface candidates were recovered by the static workspace analyzer. This does not establish that none exist.",
    );
  if (interfaces.length > 100)
    lines.push(
      `Only 100 of ${interfaces.length} interface candidates are included; use search or JSON export for the rest.`,
    );
  lines.push("", "## Dependencies to evaluate", "");
  const deps = snapshot.findings.filter((f) => f.kind === "dependency");
  for (const f of deps.slice(0, 100))
    lines.push(
      `- \`${clean(f.value.name)}\` at declared range \`${clean(f.value.version)}\` (${clean(f.value.section)}). ${ref(f)}`,
    );
  if (!deps.length) lines.push("No package dependency declarations recovered.");
  if (deps.length > 100)
    lines.push(
      `Only 100 of ${deps.length} dependency declarations are included.`,
    );
  lines.push(
    "",
    "## Verification plan",
    "",
    "- [ ] Record inputs, outputs, errors and boundary cases for each interface before implementing it.",
    "- [ ] Trace unresolved imports and candidate IPC channels with the REA engine.",
    "- [ ] Add contract tests for observed interfaces and regression tests for boundary cases.",
    "- [ ] Compare baseline and new snapshots; classify intended interface changes.",
    "- [ ] Review source and dependency licensing before redistribution.",
    "",
    "## Open questions",
    "",
    "- Which relationships are observed at runtime, and which are only static candidates?",
    "- Which behavior depends on external services, platform APIs or unavailable native engines?",
    "- What data shapes, failure modes and performance properties remain unknown?",
    "",
    "## Scope and diagnostics",
    "",
  );
  for (const limitation of snapshot.limitations)
    lines.push(`- ${clean(limitation)}`);
  for (const diagnostic of snapshot.coverage.diagnostics.slice(0, 100))
    lines.push(`- \`${clean(diagnostic.path)}\`: ${clean(diagnostic.reason)}`);
  return lines.join("\n") + "\n";
}
