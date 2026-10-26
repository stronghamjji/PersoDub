// Auto-update decision logic. Pure functions -- the Electron wiring lives in
// updateFlow.js; everything testable without Electron lives here.
import { editionFeed } from "./edition.js";
import { secondsSince, sizeText, urlText } from "./logLine.js";

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
 * Which feed to read: the edition's (edition.js editionFeed), set at run time
 * rather than taken from the bundled app-update.yml -- the open-source
 * edition's GitHub Releases, or the production edition's PRODUCTION_UPDATE_URL.
 * Null for the production edition while that address is empty: it does not
 * check for updates, and never reads the public releases (0.8.3). A
 * PERSODUB_UPDATE_URL in the environment points at a generic HTTP feed
 * instead -- how the update flow is tested against a local server without
 * publishing anything.
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

// The new version's own list of changes, for the update window in the app's
// language: the GitHub release's description stays in English only (owner,
// 2026-10-21). It is that version's app/whats_new.json, the file its What's
// new shows, in the repository at its release tag. A test feed (generic) has
// no repository: null.
export function whatsNewUrl(feed, info) {
  if (feed.provider !== "github" || !info?.version) return null;
  return `https://raw.githubusercontent.com/${feed.owner}/${feed.repo}/${info.tag ?? `v${info.version}`}/app/whats_new.json`;
}

/**
 * Read that file: its English and Korean lists as app/whats_new.json names
 * them, {notes, notes_ko}, for the page to pick from in its own language -- or
 * null when it has no line, or no answer came in `timeoutMs`; the window then
 * shows the release's own notes, as before. Each step is a line of shell.log.
 */
export async function readWhatsNew(url, { fetch, log, timeoutMs = 5000 }) {
  const from = Date.now();
  log(`DOWNLOAD START update notes from ${urlText(url)}`);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    log(`CONNECTED update notes: HTTP ${r.status} from ${urlText(url)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const data = JSON.parse(text);
    const lines = (list) => (Array.isArray(list) ? list.filter((l) => typeof l === "string" && l.trim()) : []);
    const lists = { notes: lines(data?.notes), notes_ko: lines(data?.notes_ko) };
    if (!lists.notes.length && !lists.notes_ko.length) throw new Error("the file has no lines");
    log(`DOWNLOAD DONE update notes: ${sizeText(Buffer.byteLength(text))} in ${secondsSince(from)}s, `
      + `${lists.notes.length} English and ${lists.notes_ko.length} Korean lines`);
    return lists;
  } catch (err) {
    log(`DOWNLOAD FAILED update notes from ${urlText(url)} after ${secondsSince(from)}s: ${updateErrorText(err)}; `
      + "the update window shows the release's own notes", "WARNING");
    return null;
  }
}

// What the page's update window shows beside the version: the release's
// date and notes, as electron-updater's UpdateInfo carries them (the notes
// may be HTML, plain text or a list; the page reduces them to text lines),
// and the new version's own list when it was read (readWhatsNew).
// Only what is present, so a state without them stays as small as before.
function about(info) {
  return {
    ...(info?.releaseDate ? { releaseDate: info.releaseDate } : {}),
    ...(info?.releaseNotes ? { releaseNotes: info.releaseNotes } : {}),
    ...(info?.whatsNew ? { whatsNew: info.whatsNew } : {}),
  };
}

/**
 * The update as the page should see it, folded from electron-updater's
 * events: {version, phase: "downloading" | "ready" | "download-failed", pct,
 * releaseDate?, releaseNotes?, whatsNew?}, or {phase: "check-failed"} when the check itself found no
 * answer -- the window said "up to date" then, which nobody knew. A download
 * that broke keeps its version and says so: the button sat at its last
 * percent with nothing said (A29). Kept outside
 * updateFlow.js so the two-step announcement ("found, downloading" first, "ready"
 * once the file is on disk) is testable. Returns `prev` unchanged for events
 * that carry nothing new -- progress before a version is known, or an event
 * this shell does not announce.
 */
export function nextUpdateState(prev, event, info) {
  if (event === "update-available" && info?.version) {
    // Announced once the version's list is read, which a download already on
    // disk can beat: what that announced stands, with the list added.
    if (prev?.version === info.version) return { ...prev, ...about(info) };
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
  // Only before an update is known: a download that fails after it began is
  // not a check that failed.
  if (event === "check-failed" && !prev?.version) return { phase: "check-failed" };
  if (event === "download-failed" && prev?.phase === "downloading") return { ...prev, phase: "download-failed" };
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
