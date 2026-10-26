// Run with: node --test desktop/src/events.test.mjs
// The relay is a stand-in: nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EVENTS_ENDPOINT, MAX_PER_POST, cleanEvents, createEvents, eventsOn, eventsUserId, osName, resolveEventsMode } from "./events.js";

const DEVICE = "0123456789abcdef0123456789abcdef";
const press = (name, t = 1793000000000) => ({ name, screen: "home", t });

// A packaged app, its kit and userData in a fresh temp folder; `relay` answers
// every post with a status.
function setup({ kitEnv = "PERSODUB_EVENTS=1\n", packaged = true, relay = () => 204, edition = "opensource" } = {}) {
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
    const status = relay();
    if (status === 0) throw new Error("offline");
    posts.push({ url, body: JSON.parse(init.body) });
    return { status };
  };
  const logged = [];
  const ctx = { bootedKitDir: kitDir, userId: "" };
  const events = createEvents({ app, ctx, edition, shellLog: (l) => logged.push(l), fetchImpl });
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
