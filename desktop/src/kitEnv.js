import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// The environment the user's own switches live in: this process's, with the
// kit's kit.env laid over it. Read fresh at every call, because Settings
// writes those switches into that file and turning one off has to take effect
// on the very next event rather than at the next restart. A GUI app's
// process.env never carries them, which is why the file is read at all.
export function envWithKit(kitDir) {
  try {
    const kitEnvPath = kitDir ? join(kitDir, KIT_ENV) : null;
    if (kitEnvPath && existsSync(kitEnvPath)) {
      return { ...process.env, ...parseEnvFile(readFileSync(kitEnvPath, "utf8")) };
    }
  } catch { /* unreadable kit.env: fall back to process.env */ }
  return process.env;
}

/** kit.env text with KEY=value in force, written the way the engine's own
 * writer does it (app/settings_env.py update_env_text): every line for the
 * key, commented out or not, becomes that line, and a key that has none is
 * added at the end. Every other line stays as it is -- the file holds the
 * user's API keys. An empty value is a line too ("KEY="): the engine started
 * with the old value in its environment, and only kit.env saying otherwise
 * outranks it (app/settings_env.py current_value). */
export function withKitEnvValue(text, key, value) {
  let seen = false;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const out = lines.map((line) => {
    if (!line.trim().replace(/^#+/, "").trim().startsWith(`${key}=`)) return line;
    seen = true;
    return `${key}=${value}`;
  });
  if (!seen) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/** Set KEY=value in the kit's kit.env, the file as it was kept beside it as
 * kit.env.bak, as the engine's writer keeps it. Throws without a kit.env, and
 * for a value that is not one line of text: a line break in it would write
 * lines of its own into the engine's settings. */
export function setKitEnvValue(kitDir, key, value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${key} must be one line of text`);
  const path = join(kitDir, KIT_ENV);
  const text = readFileSync(path, "utf8");
  copyFileSync(path, `${path}.bak`);
  writeFileSync(path, withKitEnvValue(text, key, value));
}
