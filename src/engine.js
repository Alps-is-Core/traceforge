import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const require = createRequire(import.meta.url);
export function enginePath() {
  return path.join(
    path.dirname(require.resolve("rea-agents/package.json")),
    "scripts/rea.mjs",
  );
}
export function runEngine(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath(), ...args], {
      stdio: "inherit",
    });
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (e) => {
      cleanup();
      reject(e);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}
export class EngineBridge {
  #client;
  #connecting;
  async client() {
    if (this.#client) return this.#client;
    if (!this.#connecting)
      this.#connecting = (async () => {
        const client = new Client({
          name: "traceforge-engine-bridge",
          version: "0.1.0",
        });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [enginePath(), "mcp"],
          stderr: "inherit",
        });
        try {
          await client.connect(transport);
          this.#client = client;
          return client;
        } catch (e) {
          await transport.close();
          throw e;
        } finally {
          this.#connecting = undefined;
        }
      })();
    return this.#connecting;
  }
  async list({ query = "", offset = 0, limit = 20 } = {}) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid engine catalog pagination");
    const client = await this.client();
    let cursor;
    const all = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const matches = all.filter((t) =>
      `${t.name} ${t.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    return {
      total: matches.length,
      offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      tools: matches
        .slice(offset, offset + limit)
        .map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
    };
  }
  async call(name, args) {
    return (await this.client()).callTool(
      { name, arguments: args },
      undefined,
      { timeout: 180000 },
    );
  }
  async close() {
    if (this.#connecting) await this.#connecting.catch(() => {});
    await this.#client?.close();
    this.#client = undefined;
  }
}
