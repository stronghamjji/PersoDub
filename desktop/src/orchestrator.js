import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, openSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./kitEnv.js";
import { getFreePort } from "./freePort.js";
import { waitForHealth } from "./health.js";

const PIDS_FILE = "pids.json";

// mac.env's PERSODUB_BIN_DIR (kit/bin: ffmpeg, ffprobe) must be visible to the
// backend's subprocesses; GUI apps start with a minimal PATH.
export function applyBinDir(env) {
  if (env.PERSODUB_BIN_DIR) env.PATH = `${env.PERSODUB_BIN_DIR}:${env.PATH || ""}`;
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
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(-pid, "SIGKILL"); } catch { /* group gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(path, { force: true });
}

function substitute(argv, port) {
  return argv.map((a) => a.replaceAll("{port}", String(port)));
}

function launch(argv, { cwd, env, logPath }) {
  const fd = openSync(logPath, "a");
  return spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* group gone */ }
  const killTimer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }, 3000);
  killTimer.unref();
}

export async function startEngines(cfg, { logDir, appVersion }) {
  mkdirSync(logDir, { recursive: true });
  await killStalePids(logDir);

  const overrideMode = cfg.sidecarCmd != null && cfg.backendCmd != null;
  let env = process.env;
  let backendCwd = cfg.backendCwd ?? process.cwd();
  if (!overrideMode) {
    const kitEnv = parseEnvFile(readFileSync(join(cfg.kitDir, "mac.env"), "utf8"));
    env = applyBinDir({ ...process.env, ...kitEnv });
    backendCwd = kitEnv.PERSODUB_APP_REPO_DIR;
  }
  // Tells the backend it is the desktop app rather than a plain server run, and which
  // version it is -- the two facts it reports to Perso (see app/perso_client.py). Set here,
  // after the kit env, so a stale mac.env can never override what this build actually is.
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
      const ollamaBin = join(cfg.kitDir, "ollama", "ollama");
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
      : [join(cfg.kitDir, "qwen_venv", "bin", "uvicorn"),
         "server:app", "--host", "127.0.0.1", "--port", String(sidecarPort)];
    children.push(launch(sidecarArgv, {
      cwd: overrideMode ? process.cwd() : join(cfg.kitDir, "sidecar"),
      env, logPath: join(logDir, "sidecar.log"),
    }));
    record();
    await waitForHealth(`http://127.0.0.1:${sidecarPort}/health`, {
      timeoutMs: cfg.sidecarHealthTimeoutMs,
      predicate: (b) => b.model_loaded === true,
    });

    const backendPort = await getFreePort();
    const backendArgv = overrideMode
      ? substitute(cfg.backendCmd, backendPort)
      : [join(cfg.kitDir, "app_venv", "bin", "uvicorn"),
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
