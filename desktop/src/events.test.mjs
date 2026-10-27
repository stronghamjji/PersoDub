// Run with: node --test desktop/src/events.test.mjs
// The relay is a stand-in: nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EVENTS_ENDPOINT, MAX_PER_POST, cleanEvents, cleanProps, createEvents, eventsOn, eventsUserId, osName, resolveEventsMode } from "./events.js";

const DEVICE = "0123456789abcdef0123456789abcdef";
const press = (name, t = 1793000000000) => ({ name, screen: "home", t });

// A packaged app, its kit and userData in a fresh temp folder; `relay` answers
// every post with a status.
function setup({ kitEnv = "PERSODUB_EVENTS=1\n", packaged = true, relay = () => 204, edition = "opensource", now = Date.now } = {}) {
  const base = mkdtempSync(join(tmpdir(), "odevents-"));
  const kitDir = join(base, "kit");
  const userData = join(base, "userData");
  mkdirSync(kitDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(kitDir, "kit.env"), kitEnv);
  writeFileSync(join(userData, "analytics.json"), JSON.stringify({ device: DEVICE }));
  const app = { isPackaged: packaged, getVersion: () => "0.9.1", getPath: () => userData };
  const posts = [];
  const fetchImpl = async (url, init) => {
    const status = await relay();
    if (status === 0) throw new Error("offline");
    // A relay that never answers: only the request's own timeout ends it.
    if (status === "hang") {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    posts.push({ url, body: JSON.parse(init.body) });
    return { status };
  };
  const logged = [];
  const ctx = { bootedKitDir: kitDir, userId: "" };
  const events = createEvents({ app, ctx, edition, shellLog: (l) => logged.push(l), fetchImpl, now });
  const queued = () => (existsSync(join(userData, "events")) ? readdirSync(join(userData, "events")) : []);
  return { events, ctx, posts, logged, queued, userData };
}

test("the switch: kit.env's line wins, and with none the production edition records and the open-source one does not", () => {
  assert.equal(eventsOn({}, "production"), true);
  assert.equal(eventsOn({}, "opensource"), false);
  assert.equal(eventsOn({ PERSODUB_EVENTS: "1" }, "opensource"), true);
  assert.equal(eventsOn({ PERSODUB_EVENTS: "0" }, "production"), false);
});

test("recorded is not sent: a from-source run, the debug line and the usage counts' switch keep them here", () => {
  const on = { PERSODUB_EVENTS: "1" };
  assert.equal(resolveEventsMode({ isPackaged: true, env: on }), "on");
  assert.equal(resolveEventsMode({ isPackaged: false, env: on }), "debug");
  assert.equal(resolveEventsMode({ isPackaged: true, env: { ...on, PERSODUB_NO_ANALYTICS: "1" } }), "debug");
  assert.equal(resolveEventsMode({ isPackaged: true, env: { ...on, PERSODUB_EVENTS_DEBUG: "1" } }), "debug");
  assert.equal(resolveEventsMode({ isPackaged: true, env: { PERSODUB_EVENTS: "0", PERSODUB_EVENTS_DEBUG: "1" } }), "off");
});

test("only the shape an event has gets through: no sentence, no path, no extra field", () => {
  assert.deepEqual(cleanEvents([press("save"), { ...press("save"), text: "my title" }, press("My video.mp4"),
    { name: "save", screen: "/Users/me", t: 1 }, { name: "save", screen: "home", t: "now" }, null]),
  [press("save"), press("save")]);
  assert.deepEqual(cleanEvents("save"), []);
  assert.deepEqual([osName("win32"), osName("darwin"), osName("linux")], ["windows", "mac", "linux"]);
});

test("a batch is written down, posted with what the page cannot know, and taken off once the relay has it", async () => {
  const s = setup();
  const answer = s.events.take([press("home_nav_settings"), press("settings_tab_privacy")]);
  assert.deepEqual(answer, { on: true, kept: 2, sent: 0, recent: ["home_nav_settings", "settings_tab_privacy"] });
  await s.events.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.posts.length, 1);
  const { url, body } = s.posts[0];
  assert.equal(url, EVENTS_ENDPOINT);
  assert.deepEqual({ ...body, osVersion: "", sessionId: 0 }, {
    installId: DEVICE, userId: "", version: "0.9.1", edition: "opensource", os: osName(), osVersion: "", sessionId: 0,
    events: [press("home_nav_settings"), press("settings_tab_privacy")],
  });
  assert.ok(Number.isInteger(body.sessionId) && body.sessionId > 0);
  assert.deepEqual(s.queued(), []);
  assert.equal(s.events.take([]).sent, 2);
});

test("the signed-in account goes as userId once the login fills it", async () => {
  const s = setup();
  s.ctx.userId = "u-42";
  s.events.take([press("save")]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posts[0].body.userId, "u-42");
});

// The owner's rule (2026-10-25): analytics key a user by a value nobody can
// read back to the account, never Perso's number or the e-mail.
test("the account goes to analytics as a one-way hash of Perso's number, and as nothing signed out", () => {
  const expected = createHash("sha256").update("persodub:1001").digest("hex").slice(0, 32);
  assert.equal(eventsUserId("1001"), expected);
  assert.match(eventsUserId("1001"), /^[0-9a-f]{32}$/);
  assert.ok(!eventsUserId("1001").includes("1001"));
  assert.notEqual(eventsUserId("1002"), expected);
  for (const none of ["", null, undefined]) assert.equal(eventsUserId(none), "");
});

test("offline keeps the batch for the next one, and a refusal is dropped rather than retried forever", async () => {
  let status = 0;
  const s = setup({ relay: () => status });
  s.events.take([press("save")]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.queued().length, 1);
  status = 400;
  s.events.take([]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.queued(), []);
  assert.equal(s.events.take([]).sent, 0);
});

test("more than 500 at once go as two posts", async () => {
  const s = setup();
  s.events.take(Array.from({ length: MAX_PER_POST + 3 }, () => press("save")));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.posts.map((p) => p.body.events.length).sort((a, b) => a - b), [3, MAX_PER_POST]);
});

test("off keeps nothing and writes nothing; debug counts and says so, and nothing leaves", async () => {
  const off = setup({ kitEnv: "PERSODUB_EVENTS=0\n" });
  assert.deepEqual(off.events.take([press("save")]), { on: false, kept: 0, sent: 0, recent: [] });
  const debug = setup({ kitEnv: "PERSODUB_EVENTS=1\nPERSODUB_NO_ANALYTICS=1\n" });
  assert.equal(debug.events.take([press("save"), press("cancel")]).kept, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([off.posts, off.queued(), debug.posts, debug.queued()], [[], [], [], []]);
  assert.deepEqual(debug.logged, ["PERSODUB_EVENTS would send 2"]);
});

test("the production edition records with no line in kit.env", () => {
  assert.equal(setup({ kitEnv: "", edition: "production" }).events.take([press("save")]).on, true);
  assert.equal(setup({ kitEnv: "", edition: "opensource" }).events.take([press("save")]).on, false);
});

// A 0.8.4 or 0.8.5 production install later updated to the public build
// keeps PERSODUB_EDITION=production in kit.env, for its dubs' default only:
// what records, and the edition a batch names, is the build's.
test("the build's edition decides the default and the batch's edition, never the kit's remembered one", async () => {
  assert.equal(setup({ kitEnv: "PERSODUB_EDITION=production\n", edition: "opensource" }).events.take([press("save")]).on, false);
  const s = setup({ kitEnv: "PERSODUB_EDITION=opensource\n", edition: "production" });
  assert.equal(s.events.take([press("save")]).on, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posts[0].body.edition, "production");
  const chosen = setup({ kitEnv: "PERSODUB_EDITION=production\nPERSODUB_EVENTS=1\n", edition: "opensource" });
  chosen.events.take([press("save")]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chosen.posts[0].body.edition, "opensource");
});

// A check of the whole road from a from-source run: the override sends even
// where a developer's run would only count.
test("PERSODUB_EVENTS_SEND=1 sends from a from-source run, and is nothing when unset", () => {
  assert.equal(resolveEventsMode({ isPackaged: false, env: { PERSODUB_EVENTS: "1", PERSODUB_EVENTS_SEND: "1" }, edition: "opensource" }), "on");
  assert.equal(resolveEventsMode({ isPackaged: false, env: { PERSODUB_EVENTS: "1" }, edition: "opensource" }), "debug");
  assert.equal(resolveEventsMode({ isPackaged: false, env: { PERSODUB_EVENTS: "0", PERSODUB_EVENTS_SEND: "1" }, edition: "production" }), "off");
});

// ---- The steps (0.9.1): a few words and numbers beside a name, never text ----

test("a step's props keep their shape: true or false, a whole number, one short word", () => {
  assert.deepEqual(cleanProps({ ok: true, minutes: 2.6, stage: "perso-dubbing", version: "0.9.2" }),
    { ok: true, minutes: 3, stage: "perso-dubbing", version: "0.9.2" });
  assert.deepEqual(cleanProps({ title: "My wedding video", file: "a b.mp4", link: "https://x.y", Bad: 1, n: Infinity, o: {} }), {});
  assert.equal(Object.keys(cleanProps(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])))).length, 8);
  assert.equal(cleanProps(undefined), null, "a press has none");
  assert.deepEqual(cleanEvents([{ name: "dub_stage", screen: "running", t: 1, props: { stage: "separate", note: "Hello there" } }]),
    [{ name: "dub_stage", screen: "running", t: 1, props: { stage: "separate" } }]);
});

test("the shell's own step waits for the page's next batch, on the page's last screen, and goes with it", async () => {
  const s = setup();
  s.events.take([{ ...press("sign_in_btn"), screen: "home" }]);
  s.events.track("sign_in_started", { method: "window" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posts.length, 1, "nothing goes on its own");
  const answer = s.events.take([]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.posts[1].body.events.map((e) => [e.name, e.screen, e.props]), [["sign_in_started", "home", { method: "window" }]]);
  assert.equal(answer.recent.at(-1), "sign_in_started");
});

test("off keeps no step; before the engines are up the kit being installed decides, and with none the edition", () => {
  const off = setup({ kitEnv: "PERSODUB_EVENTS=0\n", edition: "production" });
  off.events.track("app_launch", { first_run: true });
  assert.equal(off.events.take([]).kept, 0, "a production kit with the switch off");
  const installing = setup({ kitEnv: "PERSODUB_EVENTS=0\n", edition: "production" });
  installing.ctx.kitDir = installing.ctx.bootedKitDir;
  installing.ctx.bootedKitDir = null;
  installing.events.track("app_launch", { first_run: true });
  assert.equal(installing.events.take([]).kept, 0, "the kit the boot is installing into");
  const none = setup({ kitEnv: "PERSODUB_EVENTS=0\n", edition: "production" });
  none.ctx.bootedKitDir = null;
  none.events.track("app_launch", { first_run: true });
  assert.equal(none.events.take([]).kept, 1, "no kit known yet: the production edition records");
});

test("the quit records app_quit and sends it before it resolves, once", async () => {
  let clock = 1793000000000;
  const s = setup({ now: () => clock });
  s.events.take([{ ...press("home_nav_settings"), screen: "settings" }]);
  await new Promise((r) => setTimeout(r, 20));
  clock += 95_400;
  await s.events.quit({ signed_in: false });
  const last = s.posts.at(-1).body.events;
  assert.deepEqual(last.map((e) => [e.name, e.screen, e.props]),
    [["app_quit", "settings", { last_screen: "settings", session_seconds: 95, signed_in: false }]]);
  assert.deepEqual(s.queued(), []);
  await s.events.quit({ signed_in: true });
  assert.equal(s.posts.flatMap((p) => p.body.events).filter((e) => e.name === "app_quit").length, 1, "the second quit adds nothing");
});

test("a relay that does not answer holds the quit up for the wait at most, and the batch stays for the next launch", async () => {
  const s = setup({ relay: () => "hang" });
  const from = Date.now();
  await s.events.quit({}, { waitMs: 150 });
  assert.ok(Date.now() - from < 1000, `waited ${Date.now() - from} ms`);
  assert.equal(s.queued().length, 1);
  assert.match(readFileSync(join(s.userData, "events", s.queued()[0]), "utf8"), /"app_quit"/);
});

test("the quit's batch goes even while an earlier round is still out", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  // The first post is held back until the quit has written its own batch.
  const s = setup({ relay: () => (++calls === 1 ? gate.then(() => 204) : 204) });
  s.events.take([press("save")]);
  const quitting = s.events.quit({}, { waitMs: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await quitting;
  assert.deepEqual(s.posts.map((p) => p.body.events.map((e) => e.name)), [["save"], ["app_quit"]]);
  assert.deepEqual(s.queued(), []);
});

test("debug counts the quit and says so, and nothing leaves", async () => {
  const s = setup({ kitEnv: "PERSODUB_EVENTS=1\nPERSODUB_NO_ANALYTICS=1\n" });
  await s.events.quit({ signed_in: false });
  assert.deepEqual([s.posts, s.queued()], [[], []]);
  assert.deepEqual(s.logged, ["PERSODUB_EVENTS would send 1"]);
});

// The relay holds a step's reason to the usage counts' error codes: a code
// added there and not here would reach GA4 and Amplitude as nothing.
test("the relay's reasons are the usage counts' error codes, word for word", async () => {
  const { ERROR_CODES } = await import("./analytics.js");
  const { REASONS } = await import("../../relay/events-logic.js");
  assert.deepEqual([...REASONS].sort(), [...ERROR_CODES].sort());
});
