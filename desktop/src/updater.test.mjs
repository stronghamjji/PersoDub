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
