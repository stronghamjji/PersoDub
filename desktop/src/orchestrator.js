import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, openSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, KIT_ENV } from "./kitEnv.js";
import { getFreePort } from "./freePort.js";
import { waitForHealth } from "./health.js";
import { IS_WIN, venvBin, exeName, PATH_SEP } from "./platform.js";

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

export async function startEngines(cfg, { logDir, appVersion }) {
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
  const pids = () => children.map((c) => c.pid);
  const stopAll = () => children.forEach(stopChild);
  const record = () => writeFileSync(join(logDir, PIDS_FILE), JSON.stringify(pids()));

  try {
    // Local Gemma translation runs through an Ollama server owned by this
    // app: kit-contained binary and models dir, free port (never fights a
    // user's own Ollama on 11434), killed with the other engines. Optional:
    // a kit installed before the gemma step existed simply has no binary,
    // and the backend then reports Gemma as unavailable -- boot never gates
    // on it.
    if (!overrideMode) {
      const ollamaBin = join(cfg.kitDir, "ollama", exeName("ollama"));
      if (existsSync(ollamaBin)) {
        const ollamaPort = await getFreePort();
        env = { ...env, OLLAMA_URL: `http://127.0.0.1:${ollamaPort}` };
        children.push(launch([ollamaBin, "serve"], {
          cwd: cfg.kitDir,
          env: { ...env, OLLAMA_HOST: `127.0.0.1:${ollamaPort}`, OLLAMA_MODELS: join(cfg.kitDir, "models", "ollama") },
          logPath: join(logDir, "ollama.log"),
        }));
        record();
      }
    }

    const sidecarPort = overrideMode && cfg.sidecarPort === 0 ? await getFreePort() : cfg.sidecarPort;
    const sidecarArgv = overrideMode
      ? substitute(cfg.sidecarCmd, sidecarPort)
      : [venvBin(join(cfg.kitDir, "qwen_venv"), "uvicorn"),
         "server:app", "--host", "127.0.0.1", "--port", String(sidecarPort)];
    children.push(launch(sidecarArgv, {
      cwd: overrideMode ? process.cwd() : join(cfg.kitDir, "sidecar"),
      env, logPath: join(logDir, "sidecar.log"),
    }));
    record();
    // Status ok is enough: the voice model may not be downloaded yet (it is
    // optional now, fetched through the in-app catalog), and the sidecar
    // lazy-loads it when the weights appear (vendor/sidecar/server.py) --
    // /synthesize answers 503 until then. Waiting on model_loaded here made
    // every model-less boot a 2-minute timeout and an error screen.
    await waitForHealth(`http://127.0.0.1:${sidecarPort}/health`, {
      timeoutMs: cfg.sidecarHealthTimeoutMs,
      predicate: (b) => b.status === "ok",
    });

    const backendPort = await getFreePort();
    const backendArgv = overrideMode
      ? substitute(cfg.backendCmd, backendPort)
      : [venvBin(join(cfg.kitDir, "app_venv"), "uvicorn"),
         "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)];
    children.push(launch(backendArgv, { cwd: backendCwd, env, logPath: join(logDir, "backend.log") }));
    record();
    await waitForHealth(`http://127.0.0.1:${backendPort}/health`, {
      timeoutMs: cfg.backendHealthTimeoutMs,
    });

    return { url: `http://127.0.0.1:${backendPort}`, pids: pids(), stopAll };
  } catch (err) {
    stopAll();
    err.logDir = logDir;
    throw err;
  }
}
