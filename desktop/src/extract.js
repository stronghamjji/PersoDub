import { mkdirSync } from "node:fs";
import { run } from "./exec.js";

export async function extractTarGz(file, destDir) {
  mkdirSync(destDir, { recursive: true });
  // bsdtar (macOS, and Windows 10 1803+) autodetects the compression format
  // from the archive itself, so a single "-xf" handles both the Python
  // .tar.gz and the Windows Ollama .zip -- no per-format branch needed.
  await run(["tar", "-xf", file, "-C", destDir]);
}
