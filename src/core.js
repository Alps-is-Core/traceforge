import {
  open,
  readdir,
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  analyzeJavaScript,
  analyzeJson,
  analyzeBinary,
  buildGraph,
} from "./analyzers.js";

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 10000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFindings: 50000,
});
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".traceforge",
  ".traceforge-demo",
  "coverage",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const locationSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  line: z.number().optional(),
  column: z.number().optional(),
  offset: z.number().optional(),
  entry: z.number().optional(),
});
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.string(),
  target: z.string(),
  fingerprint: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number(),
      kind: z.string(),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      value: z.unknown(),
      confidence: z.enum(["observed", "derived", "inferred"]),
      source: locationSchema,
    }),
  ),
  graph: z.object({
    nodes: z.array(z.object({ id: z.string(), kind: z.string() })),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.string(),
        resolved: z.boolean(),
        evidenceId: z.string(),
        supportingEvidenceId: z.string().optional(),
        channel: z.string().optional(),
      }),
    ),
  }),
  coverage: z.object({
    complete: z.boolean(),
    filesExamined: z.number(),
    bytesExamined: z.number(),
    excludedDirectories: z.array(z.string()),
    diagnostics: z.array(z.object({ path: z.string(), reason: z.string() })),
    limits: z.object({
      maxFiles: z.number(),
      maxFileBytes: z.number(),
      maxTotalBytes: z.number(),
      maxFindings: z.number(),
    }),
  }),
  limitations: z.array(z.string()),
});
export async function inspect(target, options = {}) {
  const root = await realpath(path.resolve(target));
  const rootStat = await stat(root);
  if (!rootStat.isDirectory() && !rootStat.isFile())
    throw new Error("Target must be an ordinary file or directory");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits))
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_LIMITS[key]
    )
      throw new Error(
        `Invalid ${key}: must be between 1 and ${DEFAULT_LIMITS[key]}`,
      );
  const files = [],
    findings = [],
    diagnostics = [],
    excluded = new Set();
  let total = 0,
    stopped = false;
  const canonicalFuturePath = async (input) => {
    try {
      return await realpath(input);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(input);
      if (parent === input) throw e;
      return path.join(await canonicalFuturePath(parent), path.basename(input));
    }
  };
  const workspace = options.workspace
    ? await canonicalFuturePath(path.resolve(options.workspace))
    : undefined;
  const consume = async (absolute, relative) => {
    if (files.length >= limits.maxFiles) {
      diagnostics.push({
        path: relative,
        reason: "File count limit reached; remaining targets unexamined",
      });
      stopped = true;
      return;
    }
    let handle;
    try {
      handle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile()) {
        diagnostics.push({
          path: relative,
          reason: "Target changed to non-file during scan",
        });
        return;
      }
      if (
        info.size > limits.maxFileBytes ||
        total + info.size > limits.maxTotalBytes
      ) {
        diagnostics.push({
          path: relative,
          reason: "File or total byte limit exceeded; file unexamined",
        });
        return;
      }
      const remaining = Math.min(
        limits.maxFileBytes,
        limits.maxTotalBytes - total,
      );
      // Allocate at most the validated budget, and detect a file growing after stat.
      const buffer = Buffer.alloc(Math.min(info.size + 1, remaining + 1));
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(
          buffer,
          read,
          buffer.length - read,
          read,
        );
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read > info.size || (await handle.stat()).size !== info.size) {
        diagnostics.push({
          path: relative,
          reason: "File changed size during scan; retry for stable evidence",
        });
        return;
      }
      const bytes = buffer.subarray(0, read);
      const ext = path.extname(relative).toLowerCase();
      const kind = /\.[cm]?[jt]sx?$/.test(relative)
        ? "javascript"
        : [".json", ".har"].includes(ext)
          ? "json"
          : bytes.includes(0)
            ? "binary"
            : "resource";
      const file = {
        path: relative,
        sha256: sha(bytes),
        bytes: bytes.length,
        kind,
      };
      files.push(file);
      total += bytes.length;
      const result =
        kind === "javascript"
          ? analyzeJavaScript(file, bytes.toString("utf8"))
          : kind === "json"
            ? analyzeJson(file, bytes.toString("utf8"))
            : analyzeBinary(file, bytes);
      diagnostics.push(...result.diagnostics);
      const available = limits.maxFindings - findings.length;
      findings.push(...result.findings.slice(0, available));
      if (result.findings.length > available)
        diagnostics.push({
          path: relative,
          reason: "Finding limit reached; remaining facts omitted",
        });
    } catch (e) {
      diagnostics.push({
        path: relative,
        reason: `Read failed: ${e.code ?? e.message}`,
      });
    } finally {
      await handle?.close();
    }
  };
  const visit = async (dir, prefix = "") => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      diagnostics.push({
        path: prefix || ".",
        reason: `Directory read failed: ${e.code ?? e.message}`,
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (stopped) break;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({ path: relative, reason: "Symlink skipped" });
        continue;
      }
      if (entry.isDirectory()) {
        if (
          EXCLUDED.has(entry.name) ||
          entry.name.startsWith(".traceforge") ||
          absolute === workspace
        ) {
          excluded.add(relative);
          continue;
        }
        await visit(absolute, relative);
      } else if (entry.isFile()) await consume(absolute, relative);
      else diagnostics.push({ path: relative, reason: "Special file skipped" });
    }
  };
  if (rootStat.isDirectory()) await visit(root);
  else await consume(root, path.basename(root));
  const graph = buildGraph(files, findings, diagnostics);
  return snapshotSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    label: options.label ?? path.basename(root),
    createdAt: new Date().toISOString(),
    target: root,
    fingerprint: sha(JSON.stringify(files.map((f) => [f.path, f.sha256]))),
    files,
    findings,
    graph,
    coverage: {
      complete: diagnostics.length === 0,
      filesExamined: files.length,
      bytesExamined: total,
      excludedDirectories: [...excluded].sort(),
      diagnostics,
      limits,
    },
    limitations: [
      "Static observations only: target code was not executed.",
      "Coverage applies to inventoried files; excluded directories are outside scope.",
      "IPC and route matches are syntax-based candidates; aliases, dynamic channels, bundler resolution and runtime dispatch are not proven.",
      "Binary inspection covers signatures and bounded ASCII strings, not disassembly. Use the REA engine for deeper analysis.",
      "Snapshots may contain paths, strings and package metadata from the target. Review reports before sharing. HAR headers, bodies, credentials, query values and fragments are omitted.",
    ],
  });
}
export async function saveSnapshot(snapshot, workspace = ".traceforge") {
  snapshotSchema.parse(snapshot);
  const directory = path.resolve(workspace, "snapshots");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${snapshot.id}.json`);
  await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return target;
}
export async function loadSnapshot(id, workspace = ".traceforge") {
  if (!z.string().uuid().safeParse(id).success)
    throw new Error("Snapshot ID must be a UUID");
  const target = path.resolve(workspace, "snapshots", `${id}.json`);
  const info = await stat(target);
  if (info.size > 64 * 1024 * 1024)
    throw new Error("Snapshot exceeds 64 MiB read limit");
  return snapshotSchema.parse(JSON.parse(await readFile(target, "utf8")));
}
export async function listSnapshots(workspace = ".traceforge") {
  let names;
  try {
    names = await readdir(path.resolve(workspace, "snapshots"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const jsonNames = names.filter((name) => name.endsWith(".json"));
  if (jsonNames.length > 1000)
    throw new Error(
      "Workspace exceeds 1000 snapshots; split or archive investigations",
    );
  let bytes = 0;
  for (const name of jsonNames) {
    bytes += (await stat(path.resolve(workspace, "snapshots", name))).size;
    if (bytes > 128 * 1024 * 1024)
      throw new Error(
        "Workspace snapshot data exceeds 128 MiB; split or archive investigations",
      );
  }
  const result = [];
  for (const name of jsonNames.sort()) {
    if (!name.endsWith(".json")) continue;
    const snapshot = await loadSnapshot(name.slice(0, -5), workspace);
    result.push(snapshot);
  }
  return result.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}
export function summary(snapshot) {
  return {
    id: snapshot.id,
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    target: snapshot.target,
    fingerprint: snapshot.fingerprint,
    files: snapshot.files.length,
    findings: snapshot.findings.length,
    edges: snapshot.graph.edges.length,
    complete: snapshot.coverage.complete,
    diagnostics: snapshot.coverage.diagnostics.length,
  };
}
export function compareSnapshots(before, after) {
  const a = new Map(before.files.map((f) => [f.path, f]));
  const b = new Map(after.files.map((f) => [f.path, f]));
  const added = after.files.filter((f) => !a.has(f.path));
  const removed = before.files.filter((f) => !b.has(f.path));
  const changed = after.files
    .filter((f) => a.has(f.path) && a.get(f.path).sha256 !== f.sha256)
    .map((f) => ({
      path: f.path,
      before: a.get(f.path).sha256,
      after: f.sha256,
    }));
  // Ignore source line movement when deciding whether a semantic finding changed.
  const key = (f) => JSON.stringify([f.source.path, f.kind, f.value]);
  const counts = (fs) => {
    const m = new Map();
    for (const f of fs) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
    return m;
  };
  const subtract = (fs, other) => {
    const m = counts(other);
    return fs.filter((f) => {
      const k = key(f),
        n = m.get(k) ?? 0;
      if (n) {
        m.set(k, n - 1);
        return false;
      }
      return true;
    });
  };
  return {
    before: before.id,
    after: after.id,
    comparable: before.coverage.complete && after.coverage.complete,
    coverage: {
      before: before.coverage.complete,
      after: after.coverage.complete,
    },
    files: {
      added,
      removed,
      changed,
      unchanged: after.files.length - added.length - changed.length,
    },
    findings: {
      added: subtract(after.findings, before.findings),
      removed: subtract(before.findings, after.findings),
    },
    limitations: [
      "File absence in a partial scan does not prove deletion.",
      "Comparison is between caller-selected inventories; target paths may differ.",
    ],
  };
}
export function searchEvidence(
  snapshot,
  { query = "", kind, offset = 0, limit = 100 } = {},
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new Error("Offset must be nonnegative and limit between 1 and 500");
  const needle = query.toLowerCase();
  const matches = snapshot.findings.filter(
    (f) =>
      (!kind || f.kind === kind) &&
      JSON.stringify(f).toLowerCase().includes(needle),
  );
  return {
    snapshotId: snapshot.id,
    total: matches.length,
    offset,
    limit,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    findings: matches.slice(offset, offset + limit),
  };
}
export async function writeAtomic(target, content) {
  const absolute = path.resolve(target),
    temporary = `${absolute}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, absolute);
  return absolute;
}
