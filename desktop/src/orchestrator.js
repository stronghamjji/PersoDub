import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, openSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, KIT_ENV } from "./kitEnv.js";
import { getFreePort, getPreferredPort } from "./freePort.js";
import { waitForHealth } from "./health.js";
import { IS_WIN, venvBin, exeName, PATH_SEP } from "./platform.js";
import { readRuntime, writeRuntime, clearRuntime } from "./runtimeFile.js";
import { PACKS, packInstalled } from "./installSpec.js";

const PIDS_FILE = "pids.json";

// Force-kill a spawned engine and its descendants. POSIX kills the process
// group (the child is a group leader via detached); Windows has no process
// groups, so taskkill /T walks the process tree by PID.
function forceKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (IS_WIN) {
    // windowsHide: taskkill is a console program launched from a GUI process,
    // so without it every kill flashed a console window on screen -- three per
    // launch (stale engines) and three more per quit.
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* group gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

// kit.env's PERSODUB_BIN_DIR (kit/bin: ffmpeg, ffprobe) must be visible to the
// backend's subprocesses; GUI apps start with a minimal PATH.
export function applyBinDir(env) {
  if (!env.PERSODUB_BIN_DIR) return env;
  // Windows env names are case-insensitive and the real key is usually "Path",
  // so prepend to whatever spelling already exists rather than a stray "PATH".
  const key = IS_WIN ? (Object.keys(env).find((k) => k.toLowerCase() === "path") || "Path") : "PATH";
  env[key] = `${env.PERSODUB_BIN_DIR}${PATH_SEP}${env[key] || ""}`;
  return env;
}

export async function killStalePids(logDir) {
  const path = join(logDir, PIDS_FILE);
  if (!existsSync(path)) return;
  let pids = [];
  try { pids = JSON.parse(readFileSync(path, "utf8")); } catch { /* corrupt file: just remove */ }
  for (const pid of pids) {
    // A failed spawn records pid null, and kill(-null) === kill(-0) SIGKILLs
    // OUR OWN process group -- the app would kill itself on every launch.
    forceKillTree(pid);
  }
  rmSync(path, { force: true });
}

function substitute(argv, port) {
  return argv.map((a) => a.replaceAll("{port}", String(port)));
}

function launch(argv, { cwd, env, logPath }) {
  const fd = openSync(logPath, "a");
  // POSIX detaches so the engine leads a process group stopChild can signal.
  // Windows must NOT detach: DETACHED_PROCESS strips the console entirely and
  // makes Windows ignore windowsHide, so every console child an engine spawns
  // (ollama's gpu probes, ffmpeg) opened its own visible window. windowsHide
  // alone gives the engine a hidden console the whole tree inherits, and
  // taskkill /T reaps by PID without needing a process group anyway.
  return spawn(argv[0], argv.slice(1), { cwd, env, detached: !IS_WIN, windowsHide: true, stdio: ["ignore", fd, fd] });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { forceKillTree(child.pid); return; }
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* group gone */ }
  const killTimer = setTimeout(() => forceKillTree(child.pid), 3000);
  killTimer.unref();
}

// The voice sidecar's launch line. Exported so the path it boots from is
// testable without spawning anything: it must be the engines venv (the voice
// packages merged into it in 0.5.1), never the retired qwen_venv.
export function sidecarArgv(kitDir, port) {
  return [venvBin(join(kitDir, "engines_venv"), "uvicorn"),
          "server:app", "--host", "127.0.0.1", "--port", String(port)];
}

// One pack's process: started at boot for every pack already on disk, and
// again by the install-pack IPC the moment a pack finishes downloading -- the
// same function both times, so a pack installed mid-session behaves exactly
// like one that was there at launch. Each process announces where it listens
// through <kit>/runtime.json (runtimeFile.js), which the backend reads at use
// time (app/runtime.py) -- never through the backend's environment, which is
// fixed at its launch. Returns the children it started (for stopPack).
export async function startPackProcesses(cfg, packId, { logDir, env, children, record, healthTimeoutMs }) {
  if (packId === "ollama-runtime") {
    // Local translation runs through an Ollama server owned by this app:
    // kit-contained binary and models dir, free port (never fights a user's
    // own Ollama on 11434), killed with the other engines.
    const ollamaBin = join(cfg.kitDir, "ollama", exeName("ollama"));
    if (!existsSync(ollamaBin)) return [];
    const port = await getFreePort();
    const child = launch([ollamaBin, "serve"], {
      cwd: cfg.kitDir,
      env: { ...env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: join(cfg.kitDir, "models", "ollama") },
      logPath: join(logDir, "ollama.log"),
    });
    children.push(child);
    record();
    // Announced only once it answers: right after an on-demand install the
    // page pulls a model within the second, and a server still binding its
    // port turned that first pull into a refused connection.
    await announceWhenUp(`http://127.0.0.1:${port}/api/tags`, (b) => Array.isArray(b.models),
                         () => writeRuntime(cfg.kitDir, { ollama_url: `http://127.0.0.1:${port}` }));
    return [child];
  }
  if (packId === "engine") {
    const port = await getFreePort();
    const child = launch(sidecarArgv(cfg.kitDir, port), {
      cwd: join(cfg.kitDir, "sidecar"), env, logPath: join(logDir, "sidecar.log"),
    });
    children.push(child);
    record();
    // Status ok is enough: the voice model may not be downloaded yet (it is
    // optional, fetched through the in-app catalog), and the sidecar
    // lazy-loads it when the weights appear (vendor/sidecar/server.py) --
    // /synthesize answers 503 until then. Waiting on model_loaded here made
    // every model-less boot a 2-minute timeout and an error screen.
    await announceWhenUp(`http://127.0.0.1:${port}/health`, (b) => b.status === "ok",
                         () => writeRuntime(cfg.kitDir, { tts_url: `http://127.0.0.1:${port}` }));
    return [child];
  }
  return [];

  // Waits for the process just launched to answer, then announces it. A
  // process that never answers is stopped and forgotten before the error goes
  // up, so a retry does not leave a second copy running.
  async function announceWhenUp(url, predicate, announce) {
    const child = children[children.length - 1];
    try {
      await waitForHealth(url, { timeoutMs: healthTimeoutMs ?? cfg.sidecarHealthTimeoutMs, predicate });
    } catch (err) {
      stopChild(child);
      children.pop();
      record();
      throw err;
    }
    announce();
  }
}

export async function startEngines(cfg, { logDir, appVersion, preferredBackendPort }) {
  mkdirSync(logDir, { recursive: true });
  await killStalePids(logDir);

  const overrideMode = cfg.sidecarCmd != null && cfg.backendCmd != null;
  let env = process.env;
  let backendCwd = cfg.backendCwd ?? process.cwd();
  if (!overrideMode) {
    const kitEnv = parseEnvFile(readFileSync(join(cfg.kitDir, KIT_ENV), "utf8"));
    env = applyBinDir({ ...process.env, ...kitEnv });
    backendCwd = kitEnv.PERSODUB_APP_REPO_DIR;
  }
  // Tells the backend it is the desktop app rather than a plain server run, and which
  // version it is -- the two facts it reports to Perso (see app/perso_client.py). Set here,
  // after the kit env, so a stale kit.env can never override what this build actually is.
  env = { ...env, PERSODUB_CLIENT: "desktop", PERSODUB_APP_VERSION: appVersion ?? "" };

  const children = [];
  const packChildren = new Map();   // pack id -> the processes it owns
  const pids = () => children.map((c) => c.pid);
  const stopAll = () => children.forEach(stopChild);
  const record = () => writeFileSync(join(logDir, PIDS_FILE), JSON.stringify(pids()));
  const packOpts = { logDir, env, children, record };

  try {
    // Addresses from the last launch must not outlive it: a pack that was
    // removed since would otherwise still be announced.
    clearRuntime(cfg.kitDir, ["ollama_url", "tts_url"]);
    if (!overrideMode) {
      // Every pack already on this kit's disk starts now; a pack installed
      // later in the session starts through startPack below, the same way.
      // A kit with no engine pack simply has no sidecar yet: the backend
      // answers that the voice engine is not installed, and its preflight
      // asks for the pack before a local dub.
      for (const p of PACKS) {
        if (packInstalled(cfg.kitDir, p.id)) {
          packChildren.set(p.id, await startPackProcesses(cfg, p.id, packOpts));
        }
      }
    } else {
      // Dev and tests: the fake sidecar stands in for the engine pack, and
      // announces itself the same way so the backend finds it.
      const sidecarPort = cfg.sidecarPort === 0 ? await getFreePort() : cfg.sidecarPort;
      children.push(launch(substitute(cfg.sidecarCmd, sidecarPort), {
        cwd: process.cwd(), env, logPath: join(logDir, "sidecar.log"),
      }));
      record();
      await waitForHealth(`http://127.0.0.1:${sidecarPort}/health`, {
        timeoutMs: cfg.sidecarHealthTimeoutMs,
        predicate: (b) => b.status === "ok",
      });
      writeRuntime(cfg.kitDir, { tts_url: `http://127.0.0.1:${sidecarPort}` });
    }

    // Last launch's port when free (main.js remembers it), so the page keeps
    // the same origin -- and its localStorage -- from one launch to the next.
    const backendPort = await getPreferredPort(preferredBackendPort);
    const backendArgv = overrideMode
      ? substitute(cfg.backendCmd, backendPort)
      : [venvBin(join(cfg.kitDir, "app_venv"), "uvicorn"),
         "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)];
    children.push(launch(backendArgv, { cwd: backendCwd, env, logPath: join(logDir, "backend.log") }));
    record();
    await waitForHealth(`http://127.0.0.1:${backendPort}/health`, {
      timeoutMs: cfg.backendHealthTimeoutMs,
    });

    // The install-pack IPC (main.js) starts a pack's process the moment its
    // files are down; remove-pack stops it and withdraws its address.
    const startPack = async (id) => {
      if (overrideMode) return;
      // Started already and still announced: nothing to do. A pack whose
      // start failed earlier left no address behind, so it is tried again.
      const key = id === "engine" ? "tts_url" : "ollama_url";
      const alive = (packChildren.get(id) || []).some((c) => c && c.exitCode == null && !c.killed);
      if (alive && readRuntime(cfg.kitDir)[key]) return;
      // Not running (never started, or it died after announcing itself): its
      // stale address goes first, so nothing reads it while the new one comes up.
      for (const c of packChildren.get(id) || []) {
        const i = children.indexOf(c);
        if (i >= 0) children.splice(i, 1);
      }
      packChildren.delete(id);
      clearRuntime(cfg.kitDir, [key]);
      // A pack started right after its install imports torch cold, on a disk
      // that just wrote gigabytes: the boot's two minutes were not enough on
      // Windows (2026-09-07), and a start that gives up leaves the dub refused.
      packChildren.set(id, await startPackProcesses(cfg, id, { ...packOpts, healthTimeoutMs: 5 * 60 * 1000 }));
    };
    const stopPack = (id) => {
      for (const c of packChildren.get(id) || []) {
        stopChild(c);
        const i = children.indexOf(c);
        if (i >= 0) children.splice(i, 1);
      }
      packChildren.delete(id);
      record();
      clearRuntime(cfg.kitDir, id === "engine" ? ["tts_url"] : ["ollama_url"]);
    };

    return { url: `http://127.0.0.1:${backendPort}`, port: backendPort, pids: pids(), stopAll,
             startPack, stopPack };
  } catch (err) {
    stopAll();
    err.logDir = logDir;
    throw err;
  }
}
