import { readFileSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// The kit lived at ~/persodub_full_mac when macOS was the only platform. That
// name says "mac" on a Windows machine and the folder sits in plain view in
// the home directory, so new installs go to the per-user application-data
// directory each platform actually defines. An existing kit at the old path
// still wins: an update must never re-download 30+ GB to rename a folder.
const LEGACY_KIT_DIR_NAME = "persodub_full_mac";

export function defaultKitDir({ env = process.env, home = homedir(), platform = process.platform,
                                ignoreLegacy = false } = {}) {
  // ignoreLegacy is for the one caller that has decided the old kit is
  // unusable (main.js, on a version mismatch) and wants the fresh-install
  // location rather than the one already on disk.
  const legacy = join(home, LEGACY_KIT_DIR_NAME);
  if (!ignoreLegacy && existsSync(legacy)) return legacy;
  // LOCALAPPDATA, not APPDATA: on a domain-joined Windows machine the Roaming
  // half syncs to a server, and the kit is tens of gigabytes.
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "PersoDub");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "PersoDub");
  return join(home, ".persodub");  // Linux is not supported yet; the branch is
}                                  // here so adding it later is a one-liner.

// Windows refuses to open a path longer than this without both a manifest opt-in
// and a machine-wide registry switch, neither of which an unprivileged install
// can rely on.
export const WINDOWS_PATH_LIMIT = 260;
// How far below the kit root its deepest file sits. Measured 2026-08-13 on a
// full Windows kit: 157 characters, the longest being a __pycache__ entry under
// engines_venv/Lib/site-packages/onnxruntime. Rounded up for headroom, since a
// dependency upgrade can add a directory level without anyone noticing.
export const KIT_DEEPEST_RELATIVE = 175;

/** A sentence to show the user, or null when the path is fine.
 *
 * Called before the first byte is downloaded. Without it a too-long path fails
 * tens of gigabytes later, midway through unpacking a venv, as a FileNotFound
 * on a file whose name is itself too long to print usefully.
 */
export function kitPathTooLong(kitDir, platform = process.platform) {
  if (platform !== "win32") return null;
  const longest = kitDir.length + KIT_DEEPEST_RELATIVE;
  if (longest <= WINDOWS_PATH_LIMIT) return null;
  return `This folder's path is too long to install into (${kitDir.length} characters). `
    + `Windows cannot open files deeper than ${WINDOWS_PATH_LIMIT} characters, and the kit `
    + `needs about ${KIT_DEEPEST_RELATIVE} more than the folder you pick. `
    + `Choose somewhere shorter, such as C:\\PersoDub.`;
}

const GB = 1024 ** 3;
const gb = (bytes) => (bytes / GB).toFixed(1);

/** A sentence to show the user, or null when there is room.
 *
 * Counted against what is still MISSING, not the whole kit: a machine that
 * downloaded 15 GB and ran out at the end needs the remainder, and demanding
 * the full size again would lock out the very people this exists to help.
 */
export function notEnoughSpace(neededBytes, freeBytes) {
  // A null reading means the check could not run -- see freeSpaceAt.
  if (freeBytes === null || freeBytes >= neededBytes) return null;
  // No "not enough space" sentence here: the screen's heading says that, and
  // repeating it pushed the two figures -- the only part that tells you what
  // to do -- further down.
  return `  Needs:  ${gb(neededBytes)} GB\n`
    + `  Free:   ${gb(freeBytes)} GB\n\n`
    // Both numbers, not just "not enough space": without them the usual
    // outcome is clearing a little, retrying, and failing again.
    + `Free up about ${gb(neededBytes - freeBytes)} GB and start again.`;
}

/** Bytes free on the volume the kit will live on, or null if unreadable.
 *
 * Walks up to the nearest folder that exists: on a first install the kit
 * directory has not been created yet, and asking about it directly throws.
 * Returning null rather than throwing is deliberate -- a preflight that cannot
 * read the disk must not become the reason someone cannot install.
 */
export async function freeSpaceAt(dir, statfsImpl = statfs) {
  let at = dir;
  for (;;) {
    try {
      const fs = await statfsImpl(at);
      return fs.bavail * fs.bsize;
    } catch {
      const up = dirname(at);
      if (up === at) return null;  // reached the root without an answer
      at = up;
    }
  }
}

export const DEFAULTS = {
  kitDir: defaultKitDir(),
  sidecarPort: 3901,
  sidecarHealthTimeoutMs: 120000,
  backendHealthTimeoutMs: 60000,
  sidecarCmd: null,
  backendCmd: null,
  backendCwd: null,
};

export function loadConfig({ configPath, env = process.env } = {}) {
  const path = configPath ?? join(SRC_DIR, "..", "config.json");
  let fileCfg = {};
  if (existsSync(path)) fileCfg = JSON.parse(readFileSync(path, "utf8"));
  if (fileCfg.kitDir === "") delete fileCfg.kitDir;
  const cfg = { ...DEFAULTS, ...fileCfg };
  if (env.PERSODUB_KIT_DIR) cfg.kitDir = env.PERSODUB_KIT_DIR;
  return cfg;
}
