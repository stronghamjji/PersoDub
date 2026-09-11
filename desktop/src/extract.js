import { existsSync, mkdirSync } from "node:fs";
import { win32 } from "node:path";
import { run } from "./exec.js";

// Which tar to run. On Windows the system's own bsdtar, by its full path:
// a bare "tar" found GNU tar first on a machine with Git Bash on PATH, and
// GNU tar reads "C:\..." as host:path ("tar: Cannot connect to C: resolve
// failed", 2026-09-07). Elsewhere "tar" is bsdtar already.
export function tarBinary({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return "tar";
  const system = win32.join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return exists(system) ? system : "tar";
}

// strip: how many leading path parts to drop, for an archive that wraps its
// contents in one folder (GitHub's source zips: video-subtitle-remover-<sha>/)
// -- so destDir ends up holding that folder's contents, not the folder.
export async function extractTarGz(file, destDir, { strip = 0 } = {}) {
  mkdirSync(destDir, { recursive: true });
  // bsdtar (macOS, and Windows 10 1803+) autodetects the compression format
  // from the archive itself, so a single "-xf" handles both the Python
  // .tar.gz and the Windows Ollama .zip -- no per-format branch needed.
  await run([tarBinary(), "-xf", file, "-C", destDir,
             ...(strip ? ["--strip-components", String(strip)] : [])]);
}
