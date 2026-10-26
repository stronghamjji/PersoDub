// Decision logic for the auto-updater: when to check at all, and which feed
// to read. Kept pure so it tests without Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUpdateMode, resolveFeed, INSTALL_ON_QUIT, updateErrorText } from "./updater.js";

test("packaged app with no overrides updates automatically", () => {
  assert.equal(resolveUpdateMode({ isPackaged: true, env: {} }), "auto");
});

test("PERSODUB_DISABLE_UPDATE_CHECK=1 turns the check fully off", () => {
  // The README promises no phoning home beyond what it discloses; this switch
  // is the documented way back to fully-silent behaviour.
  assert.equal(
    resolveUpdateMode({ isPackaged: true, env: { PERSODUB_DISABLE_UPDATE_CHECK: "1" } }),
    "off",
  );
});

test("dev / from-source runs never update themselves", () => {
  // npm start runs a working tree; replacing it from a feed would clobber
  // uncommitted work. Decision 2026-08-11: packaged channel only, for now.
  assert.equal(resolveUpdateMode({ isPackaged: false, env: {} }), "off");
});

test("the default feed is the edition's own GitHub Releases", () => {
  // The bundled app-update.yml names one repository for both editions, so the
  // feed is always set from the edition (edition.js).
  assert.deepEqual(resolveFeed({}, "production"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
  assert.deepEqual(resolveFeed({}, "opensource"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
});

test("PERSODUB_UPDATE_URL points the updater at a test feed, whatever the edition", () => {
  // End-to-end testing serves latest-mac.yml + zip from a local HTTP server,
  // so the flow is provable without publishing anything to GitHub.
  assert.deepEqual(resolveFeed({ PERSODUB_UPDATE_URL: "http://127.0.0.1:8099" }, "production"), {
    provider: "generic",
    url: "http://127.0.0.1:8099",
  });
});

// The shell now announces an update in two steps -- "found, downloading" and
// "ready" -- and re-announces the current step whenever the page (re)loads.
// The bookkeeping between electron-updater's events and what the page shows
// is this pure reducer.
import { nextUpdateState } from "./updater.js";

test("update-available starts a downloading state with the version", () => {
  assert.deepEqual(nextUpdateState(null, "update-available", { version: "0.5.2" }),
    { version: "0.5.2", phase: "downloading", pct: 0 });
});

test("download-progress keeps the version and rounds the percent", () => {
  const s = nextUpdateState({ version: "0.5.2", phase: "downloading", pct: 0 },
    "download-progress", { percent: 41.6 });
  assert.deepEqual(s, { version: "0.5.2", phase: "downloading", pct: 42 });
});

test("update-downloaded becomes ready at 100 even if progress never fired", () => {
  const s = nextUpdateState(null, "update-downloaded", { version: "0.5.2" });
  assert.deepEqual(s, { version: "0.5.2", phase: "ready", pct: 100 });
});

test("unknown events and a missing version leave the state alone", () => {
  const prev = { version: "0.5.2", phase: "downloading", pct: 10 };
  assert.equal(nextUpdateState(prev, "update-not-available", {}), prev);
  assert.equal(nextUpdateState(null, "download-progress", { percent: 5 }), null,
    "progress before a version is known is noise");
});

test("a check that found no answer is its own state; a download that failed after it began is not", () => {
  // The window said "up to date" after a failed check (2026-10-20).
  assert.deepEqual(nextUpdateState(null, "check-failed"), { phase: "check-failed" });
  const downloading = { version: "0.5.2", phase: "downloading", pct: 10 };
  assert.equal(nextUpdateState(downloading, "check-failed"), downloading);
});

test("a download that broke keeps its version and says so, but never undoes one on disk", () => {
  // The button sat at its last percent with nothing said (A29).
  const downloading = { version: "0.5.2", phase: "downloading", pct: 37 };
  assert.deepEqual(nextUpdateState(downloading, "download-failed"), { version: "0.5.2", phase: "download-failed", pct: 37 });
  const ready = { version: "0.5.2", phase: "ready", pct: 100 };
  assert.equal(nextUpdateState(ready, "download-failed"), ready);
  assert.equal(nextUpdateState(null, "download-failed"), null);
});

test("progress that rounds to the same percent is not a new state", () => {
  const prev = { version: "0.5.2", phase: "downloading", pct: 42 };
  assert.equal(nextUpdateState(prev, "download-progress", { percent: 42.4 }), prev);
});

test("the release's date and notes ride along for the update window", () => {
  const info = { version: "0.7.1", releaseDate: "2026-09-30T12:00:00.000Z", releaseNotes: "<p>New</p>" };
  const found = nextUpdateState(null, "update-available", info);
  assert.deepEqual(found, { version: "0.7.1", phase: "downloading", pct: 0,
    releaseDate: "2026-09-30T12:00:00.000Z", releaseNotes: "<p>New</p>" });
  const moved = nextUpdateState(found, "download-progress", { percent: 50 });
  assert.equal(moved.releaseNotes, "<p>New</p>");
  // "update-downloaded" without the notes keeps the ones already known.
  const ready = nextUpdateState(moved, "update-downloaded", { version: "0.7.1" });
  assert.deepEqual(ready, { version: "0.7.1", phase: "ready", pct: 100,
    releaseDate: "2026-09-30T12:00:00.000Z", releaseNotes: "<p>New</p>" });
});

// shell.log names where an update comes from: the feed it checks, then the
// release file's full address, built the way electron-updater builds it.
import { feedText, updateFileUrl } from "./updater.js";

test("the update check names its feed, and the download the release file's full address", () => {
  const github = { provider: "github", owner: "stronghamjji", repo: "PersoDub" };
  assert.equal(feedText(github), "https://github.com/stronghamjji/PersoDub/releases (provider github)");
  const info = { version: "0.8.6", tag: "v0.8.6", files: [{ url: "PersoDub-0.8.6-arm64-mac.zip", size: 98_400_000 }] };
  assert.equal(updateFileUrl(github, info),
    "https://github.com/stronghamjji/PersoDub/releases/download/v0.8.6/PersoDub-0.8.6-arm64-mac.zip");
  // No tag in the info: the release's own naming, v<version>.
  assert.equal(updateFileUrl(github, { ...info, tag: undefined }),
    "https://github.com/stronghamjji/PersoDub/releases/download/v0.8.6/PersoDub-0.8.6-arm64-mac.zip");
  const local = { provider: "generic", url: "http://127.0.0.1:8099" };
  assert.equal(feedText(local), "http://127.0.0.1:8099 (provider generic)");
  assert.equal(updateFileUrl(local, info), "http://127.0.0.1:8099/PersoDub-0.8.6-arm64-mac.zip");
});

// The update window shows the new version's own list of changes in the app's
// language, read from its app/whats_new.json at the release tag: the GitHub
// release's description stays English only (owner, 2026-10-21).
import { whatsNewUrl, readWhatsNew } from "./updater.js";

const NOTES_URL = "https://raw.githubusercontent.com/stronghamjji/PersoDub/v0.8.7/app/whats_new.json";
// shell.log as a list, each line with its level.
const shellLines = () => {
  const lines = [];
  return { lines, log: (line, level = "INFO") => lines.push(`${level} ${line}`) };
};

test("the list is the new version's own whats_new.json, at its release tag in the edition's repository", () => {
  const github = { provider: "github", owner: "stronghamjji", repo: "PersoDub" };
  assert.equal(whatsNewUrl(github, { version: "0.8.7", tag: "v0.8.7" }), NOTES_URL);
  assert.equal(whatsNewUrl(github, { version: "0.8.7" }), NOTES_URL, "no tag in the info: v<version>");
  assert.equal(whatsNewUrl({ provider: "generic", url: "http://127.0.0.1:8099" }, { version: "0.8.7" }), null,
    "a test feed has no repository to read it from");
});

test("the list is read with a time limit, both languages kept for the page to pick from, each step in shell.log", async () => {
  const { lines, log } = shellLines();
  const asked = [];
  const body = JSON.stringify({ notes: ["Faster dubbing.", "", 7], notes_ko: ["더빙이 빨라졌어요."] });
  const fetch = async (url, init) => {
    asked.push([url, init.signal instanceof AbortSignal]);
    return { ok: true, status: 200, text: async () => body };
  };
  assert.deepEqual(await readWhatsNew(NOTES_URL, { fetch, log }),
    { notes: ["Faster dubbing."], notes_ko: ["더빙이 빨라졌어요."] });
  assert.deepEqual(asked, [[NOTES_URL, true]]);
  assert.equal(lines[0], `INFO DOWNLOAD START update notes from ${NOTES_URL}`);
  assert.equal(lines[1], `INFO CONNECTED update notes: HTTP 200 from ${NOTES_URL}`);
  assert.match(lines[2], /^INFO DOWNLOAD DONE update notes: \d+ B in \d+\.\ds, 1 English and 1 Korean lines$/);
});

test("a list that cannot be read is none, and the window keeps the release's own notes", async () => {
  const { lines, log } = shellLines();
  // No answer: the limit ends the wait (five seconds in the app, a moment here).
  // The wait is held open by a timer of its own: AbortSignal.timeout's keeps
  // nothing alive, and with nothing else to do Node 22's test run ended
  // before it fired (CI, 2026-10-26).
  const silent = (url, { signal }) => new Promise((ok, no) => {
    const held = setTimeout(() => {}, 1000);
    signal.addEventListener("abort", () => { clearTimeout(held); no(signal.reason); });
  });
  assert.equal(await readWhatsNew(NOTES_URL, { fetch: silent, log, timeoutMs: 20 }), null);
  const answers = [
    async () => ({ ok: false, status: 404, text: async () => "404: Not Found" }),    // no such file at that tag
    async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); },
    async () => ({ ok: true, status: 200, text: async () => "<html>" }),            // not the file
    async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ notes: [], notes_ko: [" "] }) }),
  ];
  for (const fetch of answers) assert.equal(await readWhatsNew(NOTES_URL, { fetch, log }), null);
  const failed = lines.filter((l) => l.startsWith(`WARNING DOWNLOAD FAILED update notes from ${NOTES_URL} after `));
  assert.equal(failed.length, 5);
  assert.match(failed[0], /timeout/);
  assert.match(failed[1], /: HTTP 404; the update window shows the release's own notes$/);
  assert.match(failed[2], /net::ERR_INTERNET_DISCONNECTED/);
  assert.match(failed[4], /the file has no lines/);
});

test("the list rides along with the update, and an update already on disk stays ready when the list comes", () => {
  const whatsNew = { notes: ["Faster dubbing."], notes_ko: ["더빙이 빨라졌어요."] };
  const found = nextUpdateState(null, "update-available", { version: "0.8.7", whatsNew });
  assert.deepEqual(found, { version: "0.8.7", phase: "downloading", pct: 0, whatsNew });
  assert.equal(nextUpdateState(found, "update-downloaded", { version: "0.8.7" }).whatsNew, whatsNew);
  // The update is announced once its list is read, which a download already
  // on disk can beat: what that said stands.
  const ready = nextUpdateState(null, "update-downloaded", { version: "0.8.7" });
  assert.deepEqual(nextUpdateState(ready, "update-available", { version: "0.8.7", whatsNew }),
    { version: "0.8.7", phase: "ready", pct: 100, whatsNew });
});

test("a downloaded update waits for Restart to update on every platform, quitting does not install it", () => {
  // The owner's rule (2026-10-06): the user chooses when the app changes. Mac
  // used to install on a plain quit while Windows waited for the button.
  assert.equal(INSTALL_ON_QUIT, false);
});

test("an update failure is one line: no response headers, no query, its code kept", () => {
  // electron-updater's HttpError puts the whole response's headers in its
  // message (cookies, a company network's own headers) -- none of it belongs
  // in shell.log, which a failure report carries out.
  const err = Object.assign(new Error('HttpError: 404 \n"method: GET url: https://github.com/o/r/releases.atom?token=abc"\n\nHeaders: {\n  "set-cookie": ["_gh_sess=secret"],\n  "x-proxy-id": "corp-7"\n}'), { code: "HTTP_ERROR_404" });
  assert.equal(updateErrorText(err), "HttpError: 404 [HTTP_ERROR_404]");
  const first = Object.assign(new Error("Cannot find latest-mac.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1/latest-mac.yml?sig=x): HttpError: 404\nHeaders: {}"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" });
  assert.equal(updateErrorText(first), "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1/latest-mac.yml?…): HttpError: 404 [ERR_UPDATER_CHANNEL_FILE_NOT_FOUND]");
  assert.equal(updateErrorText(new Error("net::ERR_INTERNET_DISCONNECTED")), "net::ERR_INTERNET_DISCONNECTED");
  assert.equal(updateErrorText(new Error("\n\n")), "unknown error");
  assert.equal(updateErrorText("plain words"), "plain words");
  assert.ok(updateErrorText(new Error("x".repeat(900))).length <= 300);
});
