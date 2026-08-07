import { mkdirSync } from "node:fs";
import { run } from "./exec.js";

export async function extractTarGz(file, destDir) {
  mkdirSync(destDir, { recursive: true });
  await run(["tar", "-xzf", file, "-C", destDir]);
}
