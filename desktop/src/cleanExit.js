import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Did the last run end because somebody closed the app? A normal quit leaves
// this note on its way out; a crash, a kill or a power cut cannot. A dub the
// user closed the app on is not a fault, and six of the 23 issues after 0.6.5
// were exactly that (user, 2026-09-28). A crash still leaves no note, so an
// engine that takes the app down with it is still reported.
const NOTE = "clean-exit";

export function markCleanExit(logDir) {
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, NOTE), new Date().toISOString());
  } catch { /* nothing to do on the way out */ }
}

/** True when the last run left the note. Read once per launch: it is removed. */
export function takeCleanExit(logDir) {
  const file = join(logDir, NOTE);
  if (!existsSync(file)) return false;
  try { rmSync(file, { force: true }); } catch { /* read-only: still a clean exit */ }
  return true;
}
