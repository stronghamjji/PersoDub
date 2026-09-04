// Auto-update decision logic. Pure functions -- the Electron wiring lives in
// main.js; everything testable without Electron lives here.

/**
 * Should this run check for updates at all?
 *  - "auto": check, download in background, apply on restart (packaged apps).
 *  - "off":  never touch the network. Dev / from-source runs are always off
 *            (their "app" is a working tree, not replaceable), and the
 *            documented PERSODUB_DISABLE_UPDATE_CHECK=1 switch turns the
 *            packaged check off too -- the README's no-telemetry promise
 *            needs an escape hatch that actually silences everything.
 */
export function resolveUpdateMode({ isPackaged, env }) {
  if (!isPackaged) return "off";
  if ((env.PERSODUB_DISABLE_UPDATE_CHECK || "") === "1") return "off";
  return "auto";
}

/**
 * Which feed to read. null = the app's bundled app-update.yml (GitHub
 * Releases, written by electron-builder from build.publish). A
 * PERSODUB_UPDATE_URL override points at a generic HTTP feed -- how the
 * update flow is tested against a local server without publishing anything.
 */
export function resolveFeed(env) {
  const url = env.PERSODUB_UPDATE_URL;
  if (url) return { provider: "generic", url };
  return null;
}

/**
 * The update as the page should see it, folded from electron-updater's
 * events: {version, phase: "downloading" | "ready", pct}. Kept outside
 * main.js so the two-step announcement ("found, downloading" first, "ready"
 * once the file is on disk) is testable. Returns `prev` unchanged for events
 * that carry nothing new -- progress before a version is known, or an event
 * this shell does not announce.
 */
export function nextUpdateState(prev, event, info) {
  if (event === "update-available" && info?.version) {
    return { version: info.version, phase: "downloading", pct: 0 };
  }
  if (event === "download-progress" && prev?.version) {
    // electron-updater reports progress many times a second; only a whole
    // percent that actually moved is worth an IPC message to the page.
    const pct = Math.round(Number(info?.percent) || 0);
    return pct === prev.pct ? prev : { ...prev, pct };
  }
  if (event === "update-downloaded" && (info?.version || prev?.version)) {
    return { version: info?.version || prev.version, phase: "ready", pct: 100 };
  }
  return prev;
}
