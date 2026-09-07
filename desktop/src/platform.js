// Single place that knows how the kit layout differs between macOS and
// Windows. Every path/lifecycle difference the installer and orchestrator
// need is derived from here, so the rest of the code stays platform-neutral.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";

// Executable inside a Python venv. POSIX venvs put it in bin/<name>; Windows
// venvs put it in Scripts\<name>.exe.
export function venvBin(venvDir, name) {
  return IS_WIN ? join(venvDir, "Scripts", `${name}.exe`) : join(venvDir, "bin", name);
}

// The standalone interpreter inside the kit's downloaded "python" dir.
// python-build-standalone lays macOS/Linux out as python/bin/python3.11 and
// Windows as python\python.exe.
export function standalonePython(pythonDir) {
  return IS_WIN ? join(pythonDir, "python.exe") : join(pythonDir, "bin", "python3.11");
}

// A bare kit binary (ffmpeg, ffprobe, ollama) carries ".exe" on Windows.
export function exeName(name) {
  return IS_WIN ? `${name}.exe` : name;
}

// PATH list separator: ";" on Windows, ":" elsewhere.
export const PATH_SEP = IS_WIN ? ";" : ":";

// Default TTS device written into the generated kit env. "mps" is Apple's
// Metal backend; "auto" tells the sidecar to use CUDA when torch reports a
// GPU and fall back to CPU otherwise (see desktop/vendor/sidecar/server.py).
export const TTS_DEVICE = IS_WIN ? "auto" : "mps";

// Whether this Windows machine has an NVIDIA GPU: nvidia-smi.exe ships with
// every NVIDIA driver install, under %SystemRoot%\System32 and usually also
// on PATH, so its presence is a reliable, driver-level signal -- no need to
// query the GPU itself. `exists`/`env` are injectable so this can be unit
// tested without a real filesystem or Windows environment.
export function hasNvidiaGpu({ exists = existsSync, env = process.env } = {}) {
  const systemRoot = env.SystemRoot || "C:\\Windows";
  if (exists(join(systemRoot, "System32", "nvidia-smi.exe"))) return true;
  // PATH always uses ";" on Windows regardless of the host running this
  // check, so the separator here is not PATH_SEP (which follows this
  // process's own platform, ":" when a test runs on macOS/Linux).
  const pathVar = env.PATH || env.Path || "";
  return pathVar.split(";").some((dir) => dir && exists(join(dir, "nvidia-smi.exe")));
}

// Which torch build the installer's venv-engines step installs. Windows picks
// the small CPU-only wheel unless an NVIDIA GPU is present (installSpec.js
// uses this for both the pip index URL and the venv's disk-space budget);
// macOS always gets Apple's MPS backend, no CUDA/CPU split.
export const TORCH_VARIANT = IS_WIN ? (hasNvidiaGpu() ? "cu128" : "cpu") : "mps";
