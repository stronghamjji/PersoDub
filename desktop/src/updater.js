// Auto-update decision logic. Pure functions -- the Electron wiring lives in
// updateFlow.js; everything testable without Electron lives here.
import { editionFeed } from "./edition.js";
import { urlText } from "./logLine.js";

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
 * Whether a downloaded update installs when the app is simply quit. Never: the
 * user picks the moment with "Restart to update" on every platform (owner's
 * rule, 2026-10-06). Windows had always waited for the button -- its NSIS run
 * fails, after the window is gone, whenever another program holds a file in
 * the install folder -- and Mac now waits for it too.
 */
export const INSTALL_ON_QUIT = false;

/**
 * Which feed to read: the edition's GitHub Releases (edition.js), set at run
 * time rather than taken from the bundled app-update.yml, so one build.publish
 * entry serves both editions. A PERSODUB_UPDATE_URL override points at a
 * generic HTTP feed instead -- how the update flow is tested against a local
 * server without publishing anything.
 */
export function resolveFeed(env, edition) {
  const url = env.PERSODUB_UPDATE_URL;
  if (url) return { provider: "generic", url };
  return editionFeed(edition);
}

/** The feed as shell.log's UPDATE CHECK line names it: the edition's GitHub
 *  Releases page, or the test feed's own address, with the provider. */
export function feedText(feed) {
  const where = feed.provider === "github" ? `https://github.com/${feed.owner}/${feed.repo}/releases` : feed.url;
  return `${where} (provider ${feed.provider})`;
}

/**
 * The full address electron-updater downloads an update's file from, for its
 * DOWNLOAD lines: on GitHub under the release's tag (GitHubProvider's rule,
 * with the tag it read off the releases feed), else beside the feed's address.
 */
export function updateFileUrl(feed, info) {
  const file = info.files[0].url;
  if (feed.provider === "github") {
    return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${info.tag ?? `v${info.version}`}/${file}`;
  }
  return new URL(file, feed.url.endsWith("/") ? feed.url : `${feed.url}/`).href;
}

// What the page's update window shows beside the version: the release's
// date and notes, as electron-updater's UpdateInfo carries them (the notes
// may be HTML, plain text or a list; the page reduces them to text lines).
// Only what is present, so a state without them stays as small as before.
function about(info) {
  return {
    ...(info?.releaseDate ? { releaseDate: info.releaseDate } : {}),
    ...(info?.releaseNotes ? { releaseNotes: info.releaseNotes } : {}),
  };
}

/**
 * The update as the page should see it, folded from electron-updater's
 * events: {version, phase: "downloading" | "ready", pct, releaseDate?,
 * releaseNotes?}. Kept outside
 * updateFlow.js so the two-step announcement ("found, downloading" first, "ready"
 * once the file is on disk) is testable. Returns `prev` unchanged for events
 * that carry nothing new -- progress before a version is known, or an event
 * this shell does not announce.
 */
export function nextUpdateState(prev, event, info) {
  if (event === "update-available" && info?.version) {
    return { version: info.version, phase: "downloading", pct: 0, ...about(info) };
  }
  if (event === "download-progress" && prev?.version) {
    // electron-updater reports progress many times a second; only a whole
    // percent that actually moved is worth an IPC message to the page.
    const pct = Math.round(Number(info?.percent) || 0);
    return pct === prev.pct ? prev : { ...prev, pct };
  }
  if (event === "update-downloaded" && (info?.version || prev?.version)) {
    return { ...prev, version: info?.version || prev.version, phase: "ready", pct: 100, ...about(info) };
  }
  return prev;
}

/**
 * An update failure as one line of shell.log: the error's first line, every
 * address in it without its query, and its code. electron-updater's HttpError
 * writes the whole response's headers into its message -- cookies, a company
 * network's own headers -- and shell.log goes out with a failure report.
 */
export function updateErrorText(err) {
  const message = String(err?.message ?? err ?? "");
  const first = message.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "unknown error";
  const code = typeof err?.code === "string" && err.code ? ` [${err.code}]` : "";
  return urlText(first).slice(0, 300 - code.length) + code;
}
