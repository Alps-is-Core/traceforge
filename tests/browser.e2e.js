import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { chromium } from "playwright-core";
import { inspect, saveSnapshot } from "../src/core.js";
import { exportReport } from "../src/report.js";

test(
  "dashboard and standalone report work in real Chromium on desktop and mobile",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "traceforge-browser-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "store"),
      target = path.join(root, "main.js");
    await writeFile(
      target,
      'import "electron";\nipcMain.handle("notes:list",()=>[]);',
    );
    const before = await inspect(target, { label: "Baseline", workspace });
    await saveSnapshot(before, workspace);
    await writeFile(
      target,
      'import "electron";\nipcMain.handle("notes:list",()=>[]);\nipcRenderer.invoke("notes:list");',
    );
    const after = await inspect(target, {
      label: "</script><script>window.pwned=true</script>",
      workspace,
    });
    await saveSnapshot(after, workspace);
    const server = spawn(
      process.execPath,
      ["src/cli.js", "dashboard", "--workspace", workspace, "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => server.kill("SIGTERM"));
    const url = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Dashboard startup timed out")),
        10000,
      );
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      server.once("error", reject);
      server.once("exit", (code) => {
        if (code) reject(new Error(`Dashboard exited ${code}`));
      });
    });
    const executablePath =
      process.env.TRACEFORGE_CHROME ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined);
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator("#finding-count").filter({ hasText: "3" }).waitFor();
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await page.locator("#search").fill("notes:list");
    assert.equal(await page.locator("tbody tr").count(), 2);
    await page.locator(".evidence-button").first().click();
    assert.equal(await page.locator("dialog").isVisible(), true);
    await page.locator("#close-detail").click();
    await page.locator('[data-tab="graph"]').click();
    assert.equal(await page.locator("svg").count(), 1);
    assert.ok(
      (await page.locator("#content").textContent()).includes("ipc-candidate"),
    );
    await page.locator('[data-tab="changes"]').click();
    assert.ok(
      (await page.locator("#content").textContent()).includes(
        "Content changed · 1",
      ),
    );
    await page.locator('[data-tab="coverage"]').click();
    assert.ok(
      (await page.locator("#content").textContent()).includes(
        "target code was not executed",
      ),
    );
    await page.keyboard.press("/");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((e) => document.activeElement === e),
      true,
    );
    const download = page.waitForEvent("download");
    await page.locator("#export").click();
    assert.ok((await download).suggestedFilename().endsWith(".json"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#search").fill("");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    const standalone = await exportReport(
      [after],
      path.join(root, "report.html"),
    );
    await page.goto(`file://${standalone}`);
    await page.locator("#finding-count").filter({ hasText: "3" }).waitFor();
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.deepEqual(errors, []);
    const forbiddenStatus = await new Promise((resolve, reject) => {
      const req = request(
        url,
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(forbiddenStatus, 403);
    const badOrigin = await fetch(url, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await fetch(`${url}/unexpected`)).status, 404);
  },
);
