// Decision logic for the auto-updater: when to check at all, and which feed
// to read. Kept pure so it tests without Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUpdateMode, resolveFeed } from "./updater.js";

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

test("default feed is the app's bundled config (null override)", () => {
  assert.equal(resolveFeed({}), null);
});

test("PERSODUB_UPDATE_URL points the updater at a test feed", () => {
  // End-to-end testing serves latest-mac.yml + zip from a local HTTP server,
  // so the flow is provable without publishing anything to GitHub.
  assert.deepEqual(resolveFeed({ PERSODUB_UPDATE_URL: "http://127.0.0.1:8099" }), {
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
