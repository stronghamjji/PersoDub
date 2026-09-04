// What the update pill says at each step. Pure, so the wording is tested
// without a shell: "found, downloading N%" first, then "ready" with a button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBannerView } from "./updateBanner.mjs";

test("while downloading: version, percent, no button", () => {
  assert.deepEqual(updateBannerView({ version: "0.5.2", phase: "downloading", pct: 42 }),
    { text: "Downloading PersoDub 0.5.2 · 42%", button: null });
});

test("at zero percent the pill still names the version", () => {
  assert.deepEqual(updateBannerView({ version: "0.5.2", phase: "downloading", pct: 0 }),
    { text: "Downloading PersoDub 0.5.2", button: null });
});

test("when ready: restart button", () => {
  assert.deepEqual(updateBannerView({ version: "0.5.2", phase: "ready", pct: 100 }),
    { text: "PersoDub 0.5.2 is ready.", button: "Restart to update" });
});

test("no state means no pill", () => {
  assert.equal(updateBannerView(null), null);
});
