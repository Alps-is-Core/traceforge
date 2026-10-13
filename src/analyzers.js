import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import path from "node:path";

const digest = (v) => createHash("sha256").update(v).digest("hex");
export function finding(
  file,
  kind,
  value,
  location = {},
  confidence = "observed",
) {
  const key = JSON.stringify([file.path, kind, value, location]);
  return {
    id: digest(key).slice(0, 20),
    kind,
    value,
    confidence,
    source: { path: file.path, sha256: file.sha256, ...location },
  };
}
const literal = (node) =>
  node?.type === "StringLiteral" ? node.value : undefined;
function member(node) {
  if (node?.type === "Identifier") return node.name;
  if (
    node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression"
  ) {
    const property = node.computed
      ? literal(node.property)
      : node.property?.name;
    return property ? `${member(node.object)}.${property}` : undefined;
  }
  return undefined;
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "comments", "tokens", "errors"].includes(key))
      continue;
    if (Array.isArray(child)) child.forEach((v) => walk(v, visit));
    else if (child && typeof child === "object") walk(child, visit);
  }
}
export function analyzeJavaScript(file, text) {
  const findings = [],
    diagnostics = [];
  const loc = (n) => ({ line: n.loc?.start.line, column: n.loc?.start.column });
  try {
    const ast = parse(text, {
      sourceType: "unambiguous",
      plugins: [
        "typescript",
        ...(file.path.endsWith(".tsx") || file.path.endsWith(".jsx")
          ? ["jsx"]
          : []),
      ],
    });
    walk(ast.program, (n) => {
      if (
        [
          "ImportDeclaration",
          "ExportAllDeclaration",
          "ExportNamedDeclaration",
        ].includes(n.type) &&
        n.source
      )
        findings.push(finding(file, "import", literal(n.source), loc(n)));
      if (["CallExpression", "OptionalCallExpression"].includes(n.type)) {
        const name = member(n.callee);
        const first = literal(n.arguments?.[0]);
        if (
          (name === "require" || n.callee?.type === "Import") &&
          first !== undefined
        )
          findings.push(finding(file, "import", first, loc(n)));
        if (
          first !== undefined &&
          /^(ipcMain|ipcRenderer)\.(handle|handleOnce|on|once|invoke|send|sendSync)$/.test(
            name ?? "",
          )
        )
          findings.push(
            finding(
              file,
              "ipc",
              { call: name, channel: first },
              loc(n),
              "inferred",
            ),
          );
        if (first !== undefined && name === "contextBridge.exposeInMainWorld")
          findings.push(finding(file, "bridge", first, loc(n), "inferred"));
        if (
          first !== undefined &&
          /\.(get|post|put|patch|delete|use)$/.test(name ?? "") &&
          first.startsWith("/")
        )
          findings.push(
            finding(
              file,
              "route",
              { call: name, route: first },
              loc(n),
              "inferred",
            ),
          );
        if (first !== undefined && name === "fetch")
          findings.push(
            finding(file, "request", safeUrl(first), loc(n), "inferred"),
          );
      }
      if (n.type === "ImportExpression" && literal(n.source) !== undefined)
        findings.push(finding(file, "import", literal(n.source), loc(n)));
      if (n.type.startsWith("Export") && n.declaration) {
        const names = n.declaration.id?.name
          ? [n.declaration.id.name]
          : (n.declaration.declarations ?? [])
              .map((v) => v.id?.name)
              .filter(Boolean);
        for (const name of names)
          findings.push(finding(file, "export", name, loc(n)));
      }
    });
  } catch (e) {
    diagnostics.push({
      path: file.path,
      reason: `JavaScript parse failed: ${e.message}`,
    });
  }
  return { findings, diagnostics };
}
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}
export function analyzeJson(file, text) {
  const findings = [],
    diagnostics = [];
  try {
    const data = JSON.parse(text);
    if (path.basename(file.path) === "package.json") {
      if (typeof data.name === "string")
        findings.push(
          finding(file, "package", {
            name: data.name,
            version:
              typeof data.version === "string" ? data.version : "unknown",
          }),
        );
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        if (
          !data[section] ||
          typeof data[section] !== "object" ||
          Array.isArray(data[section])
        )
          continue;
        for (const [name, version] of Object.entries(data[section]))
          if (typeof version === "string")
            findings.push(
              finding(file, "dependency", { name, version, section }),
            );
      }
    }
    if (file.path.endsWith(".har")) {
      if (!Array.isArray(data.log?.entries))
        throw new Error("HAR log.entries must be an array");
      for (const [index, entry] of data.log.entries.entries()) {
        if (!entry.request || typeof entry.request.url !== "string") {
          diagnostics.push({
            path: file.path,
            reason: `HAR entry ${index} has no request URL`,
          });
          continue;
        }
        findings.push(
          finding(
            file,
            "network",
            {
              method: String(entry.request.method ?? "UNKNOWN"),
              url: safeUrl(entry.request.url),
              status: Number.isInteger(entry.response?.status)
                ? entry.response.status
                : null,
              mimeType:
                typeof entry.response?.content?.mimeType === "string"
                  ? entry.response.content.mimeType
                  : null,
              durationMs: typeof entry.time === "number" ? entry.time : null,
            },
            { entry: index },
          ),
        );
      }
    }
  } catch (e) {
    diagnostics.push({
      path: file.path,
      reason: `JSON parse failed: ${e.message}`,
    });
  }
  return { findings, diagnostics };
}
export function analyzeBinary(file, bytes) {
  const findings = [],
    diagnostics = [];
  let format = "unknown";
  const head = bytes.subarray(0, 4).toString("hex");
  if (head === "7f454c46") {
    format = "ELF";
    if (
      bytes.length >= 20 &&
      [1, 2].includes(bytes[4]) &&
      [1, 2].includes(bytes[5])
    )
      findings.push(
        finding(
          file,
          "binary-header",
          {
            format,
            bits: bytes[4] === 2 ? 64 : 32,
            endian: bytes[5] === 1 ? "little" : "big",
            machine:
              bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18),
          },
          { offset: 0 },
        ),
      );
    else
      diagnostics.push({
        path: file.path,
        reason: "Truncated or unsupported ELF header",
      });
  } else if (bytes.subarray(0, 2).toString() === "MZ") {
    format = "PE";
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
    if (
      pe >= 0 &&
      pe + 24 <= bytes.length &&
      bytes.subarray(pe, pe + 4).toString("hex") === "50450000"
    )
      findings.push(
        finding(
          file,
          "binary-header",
          {
            format,
            machine: bytes.readUInt16LE(pe + 4),
            sections: bytes.readUInt16LE(pe + 6),
          },
          { offset: pe },
        ),
      );
    else
      diagnostics.push({
        path: file.path,
        reason: "DOS MZ signature present; valid PE header unavailable",
      });
  } else if (
    [
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
    ].includes(head)
  ) {
    format = "Mach-O candidate";
    findings.push(
      finding(
        file,
        "binary-header",
        {
          format,
          magic: head,
          limitation:
            "Signature only; universal and Java class signatures may overlap",
        },
        { offset: 0 },
      ),
    );
  } else if (head === "0061736d") {
    format = "WebAssembly";
    if (bytes.length >= 8)
      findings.push(
        finding(
          file,
          "binary-header",
          { format, version: bytes.readUInt32LE(4) },
          { offset: 0 },
        ),
      );
    else
      diagnostics.push({
        path: file.path,
        reason: "Truncated WebAssembly header",
      });
  }
  if (format !== "unknown" || bytes.includes(0)) {
    // Byte offsets refer to the original input; no target code is executed.
    let start = -1,
      count = 0;
    for (let i = 0; i <= bytes.length; i++) {
      const printable = i < bytes.length && bytes[i] >= 32 && bytes[i] <= 126;
      if (printable && start < 0) start = i;
      if (!printable && start >= 0) {
        if (i - start >= 6) {
          if (count >= 500) {
            diagnostics.push({
              path: file.path,
              reason: "ASCII string coverage capped at 500 records",
            });
            break;
          }
          findings.push(
            finding(
              file,
              "string",
              bytes.subarray(start, Math.min(i, start + 512)).toString("ascii"),
              { offset: start },
            ),
          );
          count++;
          if (i - start > 512)
            diagnostics.push({
              path: file.path,
              reason: `String at offset ${start} truncated to 512 bytes`,
            });
        }
        start = -1;
      }
    }
  }
  return { findings, diagnostics, format };
}
export function buildGraph(files, findings, diagnostics = []) {
  const paths = new Set(files.map((f) => f.path));
  const edges = [];
  const maxEdges = 10000;
  const add = (edge) => {
    if (edges.length >= maxEdges) return false;
    edges.push(edge);
    return true;
  };
  for (const f of findings.filter((v) => v.kind === "import")) {
    let target = f.value,
      resolved = false;
    if (target.startsWith(".")) {
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(f.source.path), target),
      );
      const candidates = [
        base,
        ...[".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".json"].map(
          (x) => base + x,
        ),
        ...["index.js", "index.ts", "index.tsx", "index.mjs", "index.cjs"].map(
          (x) => `${base}/${x}`,
        ),
      ];
      target = candidates.find((x) => paths.has(x)) ?? base;
      resolved = paths.has(target);
    }
    if (
      !add({
        from: f.source.path,
        to: target,
        type: f.value.startsWith(".") ? "local-import" : "external-import",
        resolved,
        evidenceId: f.id,
      })
    )
      break;
  }
  const channels = new Map();
  for (const f of findings.filter((v) => v.kind === "ipc")) {
    const items = channels.get(f.value.channel) ?? [];
    items.push(f);
    channels.set(f.value.channel, items);
  }
  ipc: for (const [channel, items] of channels) {
    const handlers = items.filter((f) => f.value.call.startsWith("ipcMain."));
    const senders = items.filter((f) =>
      /^ipcRenderer\.(invoke|send|sendSync)$/.test(f.value.call),
    );
    for (const a of senders)
      for (const b of handlers)
        if (
          !add({
            from: a.source.path,
            to: b.source.path,
            type: "ipc-candidate",
            channel,
            resolved: false,
            evidenceId: a.id,
            supportingEvidenceId: b.id,
          })
        )
          break ipc;
  }
  if (edges.length >= maxEdges)
    diagnostics.push({
      path: ".",
      reason: "Relationship coverage capped at 10000 edges",
    });
  return { nodes: files.map((f) => ({ id: f.path, kind: f.kind })), edges };
}
