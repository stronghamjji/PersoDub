// The update check's wiring before it reaches electron-updater.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdater } from "./updateFlow.js";

// ...and tells the page, whose update window would otherwise say the app is
// up to date: nothing was checked (ui/src/updateWindow.mjs check-off).
test("a production build checks Perso's folder for updates, not the public releases", async (t) => {
  // A test feed in this shell's environment (updater.js resolveFeed) would
  // replace the build's own address.
  const was = process.env.PERSODUB_UPDATE_URL;
  delete process.env.PERSODUB_UPDATE_URL;
  t.after(() => { if (was !== undefined) process.env.PERSODUB_UPDATE_URL = was; });
  const lines = [];
  const feeds = [];
  const autoUpdater = { on: () => {}, setFeedURL: (f) => feeds.push(f), checkForUpdates: async () => {} };
  const web = { onResponseStarted: () => {}, onBeforeRedirect: () => {}, onErrorOccurred: () => {} };
  const load = async (name) => (name === "electron-updater"
    ? { default: { autoUpdater } }
    : { session: { fromPartition: () => ({ webRequest: web }) }, net: { fetch: async () => ({ ok: false }) } });
  const { startUpdater } = createUpdater({ app: { isPackaged: true, getVersion: () => "0.9.1" }, ctx: {}, shellLog: (l) => lines.push(l),
                                           edition: "production", load });
  await startUpdater({ isDestroyed: () => false, webContents: { send: () => {} } }, null);
  assert.deepEqual(feeds, [{ provider: "generic", url: "https://portal-static.perso.ai/public/app/desktop/" }]);
  assert.ok(!lines.some((l) => l.startsWith("UPDATE CHECK OFF")), lines.join("\n"));
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
