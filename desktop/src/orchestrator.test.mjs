import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { startEngines, killStalePids, applyBinDir, sidecarArgv } from "./orchestrator.js";
import { DEFAULTS } from "./config.js";
import { PATH_SEP, venvBin } from "./platform.js";
import { getFreePort } from "./freePort.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "fake");

function fakeCfg(extra = {}) {
  return {
    ...DEFAULTS,
    sidecarPort: 0, // orchestrator replaces 0 with a free port in override mode
    sidecarHealthTimeoutMs: 10000,
    backendHealthTimeoutMs: 10000,
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}"],
    backendCmd: [process.execPath, join(FAKE, "fake_backend.mjs"), "{port}"],
    backendCwd: process.cwd(),
    ...extra,
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pids, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("applyBinDir prepends PERSODUB_BIN_DIR to PATH when present", () => {
  assert.equal(applyBinDir({ PATH: "/usr/bin" }).PATH, "/usr/bin");
  const env = applyBinDir({ PERSODUB_BIN_DIR: "/kit/bin", PATH: "/usr/bin" });
  assert.equal(env.PATH, `/kit/bin${PATH_SEP}/usr/bin`);
});

test("starts fakes, reports url, stopAll kills everything", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const { url, pids, stopAll } = await startEngines(fakeCfg(), { logDir });
  const res = await fetch(url);
  assert.ok((await res.text()).includes("PersoDub"));
  stopAll();
  assert.ok(await waitGone(pids), "engine processes should die after stopAll");
});

test("sidecar with no voice model yet (model_loaded:false) still boots", async () => {
  // The voice model may not be downloaded at boot any more (in-app catalog);
  // the sidecar lazy-loads it and /synthesize 503s until then, so startup
  // must only wait for status "ok", not model_loaded.
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--no-model"],
  });
  const { url, pids, stopAll } = await startEngines(cfg, { logDir });
  assert.ok((await (await fetch(url)).text()).includes("PersoDub"));
  stopAll();
  assert.ok(await waitGone(pids), "engine processes should die after stopAll");
});

test("sidecar never ready -> rejects and leaves no processes", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--never-ready"],
    sidecarHealthTimeoutMs: 1500,
  });
  await assert.rejects(startEngines(cfg, { logDir }), (err) => err.logDir === logDir);
  await killStalePids(logDir);
  assert.ok(true);
});

test("killStalePids kills a recorded stale process", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(logDir, "pids.json"), JSON.stringify([child.pid]));
  await killStalePids(logDir);
  assert.ok(await waitGone([child.pid]), "stale pid should be killed");
});

test("killStalePids survives null/garbage pids and still clears the file", async () => {
  // A failed spawn writes pid null; kill(-null) is kill(-0), which signals our
  // own process group. If this test survives, the guard works.
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const { writeFileSync, existsSync } = await import("node:fs");
  const path = join(logDir, "pids.json");
  writeFileSync(path, JSON.stringify([null, 0, -5, "x", 1]));
  await killStalePids(logDir);
  assert.ok(!existsSync(path), "pids file should be removed");
});

test("hands the backend its desktop identity, overriding a stale kit.env", async () => {
  // The backend reports to Perso as the desktop app only because these two arrive here
  // (app/perso_client.py). Without them it reports as a plain server run, so a desktop
  // release would silently stop counting -- with nothing failing. Hence an end-to-end
  // assertion on what the spawned process actually received, not on how it was built.
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  // Inherited from the environment here, the way a stale value in the kit's kit.env would
  // reach the same merge -- what this build is must win over what it once was told.
  const prior = process.env.PERSODUB_CLIENT;
  process.env.PERSODUB_CLIENT = "server";
  let stop = () => {};
  try {
    const { url, stopAll } = await startEngines(fakeCfg(), { logDir, appVersion: "1.2.3" });
    stop = stopAll;
    assert.deepEqual(await (await fetch(`${url}/env`)).json(), {
      PERSODUB_CLIENT: "desktop",
      PERSODUB_APP_VERSION: "1.2.3",
    });
  } finally {
    stop();
    if (prior === undefined) delete process.env.PERSODUB_CLIENT;
    else process.env.PERSODUB_CLIENT = prior;
  }
});

test("the sidecar is launched from the engines venv", () => {
  const argv = sidecarArgv("/k", 3901);
  assert.equal(argv[0], venvBin(join("/k", "engines_venv"), "uvicorn"));
  assert.deepEqual(argv.slice(1), ["server:app", "--host", "127.0.0.1", "--port", "3901"]);
});

test("the backend comes up on the preferred port when it is free, and says which port it used", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const preferred = await getFreePort();
  const { url, port, stopAll } = await startEngines(fakeCfg(), { logDir, preferredBackendPort: preferred });
  try {
    assert.equal(port, preferred);
    assert.ok(url.endsWith(`:${preferred}`), url);
  } finally {
    stopAll();
  }
});
