import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { startEngines, startPackProcesses, killStalePids, applyBinDir, sidecarArgv, packAlive, OUT_OF_MEMORY } from "./orchestrator.js";
import { readRuntime } from "./runtimeFile.js";
import { DEFAULTS } from "./config.js";
import { PATH_SEP, venvBin } from "./platform.js";
import { getFreePort } from "./freePort.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "fake");

function fakeCfg(extra = {}) {
  return {
    ...DEFAULTS,
    // A throwaway kit: startEngines writes runtime.json into cfg.kitDir, and
    // a test must never write into the developer's real kit.
    kitDir: mkdtempSync(join(tmpdir(), "odkit-")),
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
  const lines = [];
  const { url, pids, stopAll, processes } = await startEngines(fakeCfg(), { logDir, log: (line) => lines.push(line) });
  const res = await fetch(url);
  assert.ok((await res.text()).includes("PersoDub"));
  // shell.log's account of the start: the voice engine, then the backend,
  // each under a banner, numbered and timed.
  assert.match(lines[0], /^ENGINES START: kit=.+ packs=engine$/);
  assert.equal(lines.filter((l) => l === "#".repeat(30)).length, 2);
  const engineLines = lines.filter((l) => l.startsWith("[Engine"));
  assert.equal(engineLines.length, 4, lines.join("\n"));
  [/^\[Engine 1\/2\] engine START \(port \d+\)$/, /^\[Engine 1\/2\] engine READY \(\d+\.\ds\)$/,
   /^\[Engine 2\/2\] backend START \(port \d+\)$/, /^\[Engine 2\/2\] backend READY \(\d+\.\ds\)$/]
    .forEach((shape, i) => assert.match(engineLines[i], shape));
  // What the memory line measures: both live processes, the backend first.
  assert.deepEqual(processes().map((p) => p.name), ["backend", "engine"]);
  assert.deepEqual(processes().map((p) => p.pid).sort(), [...pids].sort());
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

// A voice engine that never answers used to take the whole app down with it:
// the window opened on "engine start failed" although Perso dubs, erasing,
// exporting and finished projects need no voice engine at all.
test("sidecar never ready -> the app still starts, the engine is stopped and marked failed", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--never-ready"],
    sidecarHealthTimeoutMs: 1500,
  });
  // What the last launch announced: its address and process id must not outlive it.
  writeFileSync(join(cfg.kitDir, "runtime.json"), JSON.stringify({ tts_url: "http://127.0.0.1:1", tts_pid: 4242 }));
  const logged = [];
  const engines = await startEngines(cfg, { logDir, log: (line, level = "INFO") => logged.push([level, line]) });
  try {
    assert.ok((await (await fetch(engines.url)).text()).includes("PersoDub"), "the backend is up");
    assert.deepEqual(engines.failed.map((f) => f.pack), ["engine"]);
    assert.match(engines.failed[0].message, /timed out/);
    const failedLine = logged.find(([, line]) => line.includes("engine FAILED"));
    assert.ok(failedLine, logged.map(([, line]) => line).join("\n"));
    assert.equal(failedLine[0], "ERROR");
    assert.match(failedLine[1], /^\[Engine 1\/2\] engine FAILED \(\d+\.\ds\): Health check timed out after \d+ms: http:\/\/127\.0\.0\.1:\d+\/health/);
    const rt = readRuntime(cfg.kitDir);
    assert.equal(rt.tts_url, undefined, "a sidecar that never answered is not announced");
    assert.equal(rt.tts_pid, undefined, "nor is its process id");
    assert.equal(rt.tts_state, "failed");
    assert.equal(engines.pids.length, 1, "only the backend is left running");
  } finally {
    engines.stopAll();
  }
});

test("a sidecar that exits while starting is noticed at once, with its own last lines, masked", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  // Lines an earlier launch left in the same log must not be told as this one's.
  writeFileSync(join(logDir, "sidecar.log"), "EARLIER LAUNCH LINE\n");
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--die"],
    sidecarHealthTimeoutMs: 60000,   // the old wait: a dead engine must not sit it out
  });
  const t0 = Date.now();
  const lines = [];
  const levels = [];
  let exits = 0;
  const log = (line, level = "INFO") => { lines.push(line); levels.push(level); };
  const engines = await startEngines(cfg, { logDir, log, onExit: () => { exits++; } });
  try {
    assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
    const { message } = engines.failed[0];
    assert.match(message, /engine stopped while starting \(exit code 3\)/);
    assert.match(message, /RuntimeError: fake engine could not load/);
    assert.ok(!message.includes("EARLIER LAUNCH LINE"), message);
    assert.ok(!message.includes(homedir()), "the home folder is masked");
    assert.equal(readRuntime(cfg.kitDir).tts_state, "failed");
    // The end is in shell.log too, and bootFlow.js is told, for its memory line.
    assert.ok(lines.includes("engine EXITED (exit code 3)"), lines.join("\n"));
    assert.equal(exits, 1);
    // Under the FAILED line, what the engine itself said, indented, at ERROR.
    const failed = lines.findIndex((l) => l.startsWith("[Engine 1/2] engine FAILED"));
    assert.deepEqual(lines.slice(failed + 1, failed + 3), ["  Last lines of sidecar.log:", "  Traceback (most recent call last):"]);
    assert.ok(lines[failed + 3].startsWith("  RuntimeError: fake engine could not load (~/"), lines[failed + 3]);
    assert.deepEqual(levels.slice(failed, failed + 4), ["ERROR", "ERROR", "ERROR", "ERROR"]);
  } finally {
    engines.stopAll();
  }
});

// Issue #187: Windows ran out of paging file while the voice engine loaded,
// and the page said only that it "could not start".
test("a sidecar that ran out of memory while starting is marked failed for that reason", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--die-out-of-memory"],
  });
  const engines = await startEngines(cfg, { logDir });
  try {
    assert.equal(engines.failed[0].outOfMemory, true);
    assert.match(engines.failed[0].message, /\(os error 1455\)/);
    const rt = readRuntime(cfg.kitDir);
    assert.equal(rt.tts_state, "failed");
    assert.equal(rt.tts_failure, "memory");
  } finally {
    engines.stopAll();
  }
  // Any other reason leaves no such word, and an engine that answers takes it away.
  const children = [];
  const opts = { logDir, env: process.env, children, record: () => {} };
  const dying = { ...cfg, sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--die"] };
  await assert.rejects(startPackProcesses(dying, "engine", opts), (err) => err.outOfMemory === false);
  assert.equal(readRuntime(cfg.kitDir).tts_failure, "");
  writeFileSync(join(cfg.kitDir, "runtime.json"), JSON.stringify({ tts_state: "failed", tts_failure: "memory" }));
  const [child] = await startPackProcesses({ ...cfg, sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}"] },
                                           "engine", opts);
  try {
    assert.equal(readRuntime(cfg.kitDir).tts_failure, undefined);
  } finally {
    child.kill();
  }
});

test("the words an engine that ran out of memory leaves behind", () => {
  for (const line of ["OSError: �� �۾��� �Ϸ��ϱ� ���� ����¡ ������ �ʹ� �۽��ϴ�. (os error 1455)",
                      "OSError: The paging file is too small for this operation to complete. (os error 1455)",
                      "MemoryError", "RuntimeError: [enforce fail at alloc_cpu.cpp:114] . DefaultCPUAllocator: not enough memory",
                      "torch.OutOfMemoryError: CUDA out of memory."]) {
    assert.ok(OUT_OF_MEMORY.test(line), line);
  }
  assert.ok(!OUT_OF_MEMORY.test("RuntimeError: fake engine could not load"));
});

test("a sidecar still loading its model is waited for past the silence limit", async () => {
  // "loading" answers are progress: only silence runs the limit out.
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--loading=2000"],
    sidecarHealthTimeoutMs: 1000,
  });
  const engines = await startEngines(cfg, { logDir });
  try {
    assert.deepEqual(engines.failed, []);
    const rt = readRuntime(cfg.kitDir);
    assert.match(rt.tts_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(rt.tts_state, undefined, "the state goes once the engine answers");
  } finally {
    engines.stopAll();
  }
});

test("a load that never ends is still given up on, at the load limit", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const cfg = fakeCfg({
    sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--loading=60000"],
    sidecarHealthTimeoutMs: 1000,
    engineLoadTimeoutMs: 2000,
  });
  const engines = await startEngines(cfg, { logDir });
  try {
    assert.deepEqual(engines.failed.map((f) => f.pack), ["engine"]);
    assert.equal(readRuntime(cfg.kitDir).tts_state, "failed");
  } finally {
    engines.stopAll();
  }
});

// The retry is the install-pack IPC, which lands in startPackProcesses once
// more (through startPack): a second start after a failed one must come up
// and wipe the failure.
test("a pack started again after a failed start is announced and loses its failed state", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const children = [];
  const opts = { logDir, env: process.env, children, record: () => {} };
  const dying = fakeCfg({ sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}", "--die"] });
  await assert.rejects(startPackProcesses(dying, "engine", opts), /stopped while starting/);
  assert.equal(readRuntime(dying.kitDir).tts_state, "failed");
  assert.equal(children.length, 0, "the failed process is forgotten");
  const cfg = { ...dying, sidecarCmd: [process.execPath, join(FAKE, "fake_sidecar.mjs"), "{port}"] };
  const [child] = await startPackProcesses(cfg, "engine", opts);
  try {
    const rt = readRuntime(cfg.kitDir);
    assert.match(rt.tts_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(rt.tts_state, undefined);
  } finally {
    child.kill();
  }
});

test("a program that cannot be run at all counts as dead, not alive", () => {
  assert.equal(packAlive([{ exitCode: null, signalCode: null, killed: false, launchError: new Error("ENOENT") }]), false);
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
  // The edition rides along: it decides where a dub runs by default (app/setup.py), so an
  // open-source build told "production" would send a new user's dubs to Perso.
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  // Inherited from the environment here, the way a stale value in the kit's kit.env would
  // reach the same merge -- what this build is must win over what it once was told.
  const prior = { client: process.env.PERSODUB_CLIENT, edition: process.env.PERSODUB_EDITION, logs: process.env.PERSODUB_LOG_DIR };
  process.env.PERSODUB_CLIENT = "server";
  process.env.PERSODUB_EDITION = "production";
  process.env.PERSODUB_LOG_DIR = "/stale/logs";
  let stop = () => {};
  try {
    const { url, stopAll } = await startEngines(fakeCfg(), { logDir, appVersion: "1.2.3", locale: "ko", edition: "opensource" });
    stop = stopAll;
    assert.deepEqual(await (await fetch(`${url}/env`)).json(), {
      PERSODUB_CLIENT: "desktop",
      PERSODUB_APP_VERSION: "1.2.3",
      // What "auto" means to the backend's language (app/i18n.py).
      PERSODUB_LOCALE: "ko",
      PERSODUB_EDITION: "opensource",
      // The engine's own logs go in the shell's log folder, beside shell.log.
      PERSODUB_LOG_DIR: logDir,
    });
  } finally {
    stop();
    for (const [name, value] of [["PERSODUB_CLIENT", prior.client], ["PERSODUB_EDITION", prior.edition], ["PERSODUB_LOG_DIR", prior.logs]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

// The backend finds the voice sidecar through the kit's runtime.json, not
// through its environment (fixed at launch): the shell writes the address
// once the sidecar answers, and a pack started later in the session goes the
// same way. The handle exposes startPack/stopPack for the install-pack IPC.
test("the sidecar's address is announced in the kit's runtime.json, and the handle can start and stop packs", async () => {
  const cfg = fakeCfg();
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const engines = await startEngines(cfg, { logDir });
  const rt = readRuntime(cfg.kitDir);
  assert.match(rt.tts_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  // Its process id beside it, so the backend can measure the engine's memory.
  assert.equal(rt.tts_pid, engines.processes().find((p) => p.name === "engine").pid);
  assert.equal(rt.ollama_url, undefined);
  assert.equal(rt.ollama_pid, undefined);
  assert.equal(typeof engines.startPack, "function");
  assert.equal(typeof engines.stopPack, "function");
  engines.stopPack("engine");
  assert.equal(readRuntime(cfg.kitDir).tts_url, undefined, "stopPack withdraws the address");
  assert.equal(readRuntime(cfg.kitDir).tts_pid, undefined, "and the process id with it");
  engines.stopAll();
  assert.ok(await waitGone(engines.pids));
});


test("startPack's liveness rule: a process that exited or was killed by a signal counts as dead", () => {
  assert.equal(packAlive([{ exitCode: null, signalCode: null, killed: false }]), true);
  assert.equal(packAlive([{ exitCode: 1, signalCode: null, killed: false }]), false, "exited");
  assert.equal(packAlive([{ exitCode: null, signalCode: "SIGKILL", killed: false }]), false, "killed by the system");
  assert.equal(packAlive([{ exitCode: null, signalCode: null, killed: true }]), false, "stopped by us");
  assert.equal(packAlive([]), false);
  assert.equal(packAlive(undefined), false, "never started");
});


test("a sidecar that exits asking to be started again comes back, announced afresh, and stopAll still ends it", async () => {
  const cfg = fakeCfg();
  const logDir = mkdtempSync(join(tmpdir(), "odlog-"));
  const lines = [];
  const engines = await startEngines(cfg, { logDir, log: (line) => lines.push(line) });
  const before = readRuntime(cfg.kitDir).tts_url;
  await fetch(before + "/restart", { method: "POST" });
  // The old address is withdrawn as the process goes, and a new one announced
  // once the fresh sidecar answers: wait for an address whose /health is up.
  let after = "";
  for (let i = 0; i < 100 && !after; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const url = readRuntime(cfg.kitDir).tts_url;
    if (!url || url === before && i < 3) continue;
    try {
      const body = await (await fetch(url + "/health")).json();
      if (body.status === "ok") after = url;
    } catch { /* not up yet */ }
  }
  assert.ok(after, "a fresh sidecar is announced after the restart exit");
  assert.equal(readRuntime(cfg.kitDir).tts_pid, engines.processes().find((p) => p.name === "engine").pid,
    "the new process's id, not the old one's");
  // shell.log: the end that asked for it, then the engine started on its own.
  assert.ok(lines.includes("engine EXITED (exit code 75), restarting"), lines.join("\n"));
  assert.ok(lines.some((l) => /^engine READY \(\d+\.\ds\)$/.test(l)), lines.join("\n"));
  const pids = JSON.parse(readFileSync(join(logDir, "pids.json"), "utf8"));
  engines.stopAll();
  assert.ok(await waitGone(pids), "the restarted sidecar is stopped with the rest");
});
