import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// The file a running kit's pack processes announce their ports through:
// <kitDir>/runtime.json. Written by the shell (orchestrator.js) when a pack's
// process starts, read by the backend (app/runtime.py) on every URL lookup --
// so a pack installed and started mid-session is picked up without a restart.
const RUNTIME_FILE = "runtime.json";

/** The current runtime.json contents, or `{version: 1}` when the file is
 * missing or unreadable (never-installed kit, or a write caught mid-flight
 * despite the atomic rename below). */
export function readRuntime(kitDir) {
  const path = join(kitDir, RUNTIME_FILE);
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { version: 1, ...data };
  } catch {
    return { version: 1 };
  }
}

/** Merge `patch` into runtime.json (read-modify-write). Written to a temp
 * file in the same folder and renamed into place so a reader never sees a
 * half-written file. */
export function writeRuntime(kitDir, patch) {
  const next = { ...readRuntime(kitDir), ...patch };
  const path = join(kitDir, RUNTIME_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, path);
}

/** Remove `keys` from runtime.json (e.g. a pack was uninstalled). */
export function clearRuntime(kitDir, keys) {
  const next = readRuntime(kitDir);
  for (const key of keys) delete next[key];
  const path = join(kitDir, RUNTIME_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, path);
}
