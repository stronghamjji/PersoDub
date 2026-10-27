// The update check's wiring before it reaches electron-updater.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdater } from "./updateFlow.js";

// ...and tells the page, whose update window would otherwise say the app is
// up to date: nothing was checked (ui/src/updateWindow.mjs check-off).
test("a production build without an update address checks nothing, says so once in shell.log, and tells the page", async (t) => {
  // A test feed in this shell's environment (updater.js resolveFeed) would
  // give the build an address, and electron-updater a check to run.
  const was = process.env.PERSODUB_UPDATE_URL;
  delete process.env.PERSODUB_UPDATE_URL;
  t.after(() => { if (was !== undefined) process.env.PERSODUB_UPDATE_URL = was; });
  const lines = [];
  const sent = [];
  const ctx = {};
  const { startUpdater } = createUpdater({ app: { isPackaged: true }, ctx, shellLog: (l) => lines.push(l),
                                           edition: "production" });
  await startUpdater({ isDestroyed: () => false, webContents: { send: (ch, s) => sent.push([ch, s]) } }, null);
  assert.deepEqual(lines, ["UPDATE CHECK OFF: this production build has no update address (desktop/src/edition.js PRODUCTION_UPDATE_URL is empty)"]);
  assert.deepEqual(ctx.updateState, { phase: "check-off" });
  assert.deepEqual(sent, [["shell:update-state", { phase: "check-off" }]]);
});

// An update found is a step in the charts (events.js track): its version.
test("an update found is recorded with its version", async (t) => {
  const was = process.env.PERSODUB_UPDATE_URL;
  process.env.PERSODUB_UPDATE_URL = "http://127.0.0.1:9/feed";
  t.after(() => { if (was === undefined) delete process.env.PERSODUB_UPDATE_URL; else process.env.PERSODUB_UPDATE_URL = was; });
  const handlers = {};
  const autoUpdater = {
    on: (ev, fn) => { handlers[ev] = fn; },
    setFeedURL: () => {},
    checkForUpdates: async () => { await handlers["update-available"]({ version: "0.9.2", files: [] }); },
  };
  const web = { onResponseStarted: () => {}, onBeforeRedirect: () => {}, onErrorOccurred: () => {} };
  const load = async (name) => (name === "electron-updater"
    ? { default: { autoUpdater } }
    : { session: { fromPartition: () => ({ webRequest: web }) }, net: { fetch: async () => ({ ok: false }) } });
  const steps = [];
  const { startUpdater } = createUpdater({ app: { isPackaged: true, getVersion: () => "0.9.1" }, ctx: {}, shellLog: () => {},
                                           edition: "opensource", load, track: (name, props) => steps.push([name, props]) });
  await startUpdater({ isDestroyed: () => false, webContents: { send: () => {} } }, null);
  assert.deepEqual(steps, [["update_available", { version: "0.9.2" }]]);
});
