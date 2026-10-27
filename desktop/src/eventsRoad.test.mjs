// Run with: node --test desktop/src/eventsRoad.test.mjs
// The whole road of a step, with nothing reaching the network: the page's
// collector (ui/src/events.mjs) hands its batch to the shell (events.js),
// which writes it down and posts it to the relay's own handler
// (relay/report-worker.js), which checks it and passes it to GA4 and
// Amplitude -- here stand-ins that keep what they were sent. The shell's own
// steps and the quit go the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEvents } from "./events.js";
import { record, startEvents } from "../../ui/src/events.mjs";
import worker from "../../relay/report-worker.js";

const DEVICE = "0123456789abcdef0123456789abcdef";
const settle = () => new Promise((r) => setTimeout(r, 30));

// The production edition, packaged, on a computer of its own: its kit and
// userData in a temp folder, the relay's handler in place of the network.
function theApp(t) {
  const base = mkdtempSync(join(tmpdir(), "odroad-"));
  const kitDir = join(base, "kit");
  const userData = join(base, "userData");
  mkdirSync(kitDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(kitDir, "kit.env"), "PERSO_API_KEY=\n");
  writeFileSync(join(userData, "analytics.json"), JSON.stringify({ device: DEVICE }));
  const app = { isPackaged: true, getVersion: () => "0.9.1", getPath: () => userData };

  // GA4 and Amplitude, as the relay reaches them.
  const outward = [];
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, init = {}) => {
    outward.push({ host: new URL(url).hostname, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  const env = { GA4_MEASUREMENT_ID: "G-TEST", GA4_API_SECRET: "s", AMPLITUDE_API_KEY: "amp" };
  const relayFetch = async (url, init) => {
    const waits = [];
    const res = await worker.fetch(new Request(url, { method: init.method, body: init.body }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  };
  const ctx = { bootedKitDir: kitDir, userId: "" };
  const shell = createEvents({ app, ctx, edition: "production", shellLog: () => {}, fetchImpl: relayFetch });

  // The page in the shell's window: its document, its screen and its clock.
  const listeners = {};
  let observer = null;
  const doc = { body: { dataset: { screen: "home" } }, visibilityState: "visible",
                addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const win = { MutationObserver: class { constructor(fn) { observer = fn; } observe() {} }, setInterval: () => {},
                addEventListener: (ev, fn) => { listeners[`win:${ev}`] = fn; } };
  startEvents({ doc, win, shell: { sendEvents: async (list) => shell.take(list) } });
  const go = (screen) => { doc.body.dataset.screen = screen; observer(); };
  const press = (id) => listeners.click({ target: { id, dataset: {}, closest() { return this; }, querySelector: () => null } });
  const handOver = async () => { listeners["win:pagehide"](); await settle(); };
  const sent = (host) => outward.filter((o) => o.host === host).flatMap((o) => o.body.events);
  return { shell, ctx, go, press, handOver, sent, listeners };
}

test("a person's way reaches GA4 and Amplitude under each step's own name, with its props and nothing typed", async (t) => {
  const a = theApp(t);
  await settle();
  a.shell.track("app_launch", { first_run: true });
  a.press("signInBtn");
  a.shell.track("sign_in_started", { method: "window" });
  a.listeners.drop({ dataTransfer: { files: [{ name: "My wedding.mp4", type: "video/mp4" }] } });
  record("dub_started", { mode: "local", target_lang: "ko", minutes: 3, speakers: 0, title: "My wedding" });
  a.go("running");
  await a.handOver();
  await a.shell.quit({ signed_in: false });

  const ga = a.sent("www.google-analytics.com");
  assert.deepEqual(ga.map((e) => e.name), ["app_launch", "sign_in_started", "app_screen", "button_press", "media_added",
    "dub_started", "app_screen", "app_quit"]);
  const byName = Object.fromEntries(ga.map((e) => [e.name, e.params]));
  assert.equal(byName.app_launch.first_run, "true");
  assert.equal(byName.dub_started.target_lang, "ko");
  assert.equal(byName.dub_started.title, undefined);
  assert.equal(ga.find((e) => e.name === "button_press").params.button, "sign_in_btn");
  assert.equal(ga.at(-2).params.previous_screen, "home");
  assert.deepEqual([byName.app_quit.last_screen, byName.app_quit.signed_in], ["running", "false"]);
  assert.equal(byName.app_quit.edition, "production");

  const amp = a.sent("api2.amplitude.com");
  assert.deepEqual(amp.map((e) => e.event_type), ga.map((e) => e.name), "the same names in both");
  assert.deepEqual(amp.find((e) => e.event_type === "media_added").event_properties,
    { source: "drop", kind: "video", screen: "home", edition: "production" });
  assert.ok(!JSON.stringify([ga, amp]).includes("wedding"), "no file name or title on the way");
});

test("the production edition with recording switched off sends nothing, the quit included", async (t) => {
  const a = theApp(t);
  writeFileSync(join(a.ctx.bootedKitDir, "kit.env"), "PERSODUB_EVENTS=0\n");
  await settle();
  a.shell.track("app_launch", { first_run: true });
  a.press("signInBtn");
  record("dub_started", { mode: "local" });
  await a.handOver();
  await a.shell.quit({ signed_in: false });
  assert.deepEqual([a.sent("www.google-analytics.com"), a.sent("api2.amplitude.com")], [[], []]);
});
