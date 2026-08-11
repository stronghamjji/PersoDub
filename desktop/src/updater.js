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
