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
