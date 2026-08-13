import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// The kit's single settings file. It was mac.env while macOS was the only
// platform; a Windows machine should not carry a file called "mac". The old
// name still exists on every kit installed before the rename.
export const KIT_ENV = "kit.env";
export const LEGACY_KIT_ENV = "mac.env";

/** Rename an old kit's mac.env to kit.env. Returns whether it did.
 *
 * Must run before checkKit: kit.env is on its required-files list, so an
 * installed kit that still has the old name would read as "not installed" and
 * be re-downloaded in full. A rename (not a copy-and-write) because the file
 * holds the user's API keys and nothing here should be able to lose them.
 */
export function migrateKitEnv(kitDir) {
  if (!kitDir) return false;
  const legacy = join(kitDir, LEGACY_KIT_ENV);
  if (!existsSync(legacy) || existsSync(join(kitDir, KIT_ENV))) return false;
  renameSync(legacy, join(kitDir, KIT_ENV));
  return true;
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
