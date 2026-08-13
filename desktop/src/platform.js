// Single place that knows how the kit layout differs between macOS and
// Windows. Every path/lifecycle difference the installer and orchestrator
// need is derived from here, so the rest of the code stays platform-neutral.
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
