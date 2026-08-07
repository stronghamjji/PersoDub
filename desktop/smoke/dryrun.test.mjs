// Integration dry run: the exact flow main.js drives, minus the window.
// Proves start -> healthy -> UI served -> stop -> zero leftover processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { startEngines } from "../src/orchestrator.js";
import { DEFAULTS } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "fake");

test("full dry run: start, serve UI, stop, no leftovers", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "oddry-"));
  const cfg = {
    ...DEFAULTS,
    sidecarPort: 0,
    sidecarHealthTimeoutMs: 10000,
    backendHealthTimeoutMs: 10000,
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}"],
    backendCmd: [process.execPath, join(FAKE, "fake_backend.mjs"), "{port}"],
    backendCwd: HERE,
  };
  const { url, pids, stopAll } = await startEngines(cfg, { logDir });
  const html = await (await fetch(url)).text();
  assert.ok(html.includes("PersoDub"), "UI page should be served");
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.status, "ok");
  stopAll();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const anyAlive = pids.some((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    if (!anyAlive) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const p of pids) {
    assert.throws(() => process.kill(p, 0), undefined, `pid ${p} should be gone`);
  }
});
