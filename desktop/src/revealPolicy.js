// Which files the page may ask the computer's own file window to show.
//
// "Saved to Downloads · Show" is the only reason this door exists, and a door
// that opens on any path a page names is a door onto the whole disk. So the
// page names a path and this decides: it is shown only if it lies inside the
// user's Downloads folder or inside the app's own kit -- the two places this
// app ever writes a file the user is told about. Everything else is refused,
// and the shell says so in its log rather than to the page.
//
// Free of fs and electron so the node:test unit tests run with nothing else
// present -- the caller passes the two folders (see desktop/main.js).
import { resolve, sep } from "node:path";

/** Is `target` that folder, or something inside it? */
export function isInside(target, folder) {
  if (!folder) return false;
  const dir = resolve(String(folder));
  const path = resolve(String(target));
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * May this path be shown? `folders` are the ones the app writes into --
 * Downloads and the kit.
 *
 * A path is compared as it is written, not as the disk would resolve it: a
 * symbolic link inside Downloads that points elsewhere would still be shown,
 * which is the user's own doing and shows a file rather than opening one.
 * What this stops is a page (or anything that got into one) naming
 * ~/.ssh/id_rsa and having the app reveal it.
 */
export function revealAllowed(target, folders) {
  if (typeof target !== "string" || !target.trim()) return false;
  // A NUL byte truncates a path in whatever C library gets it last, so the
  // path checked here would not be the path opened.
  if (target.includes("\0")) return false;
  return (folders || []).some((folder) => isInside(target, folder));
}
