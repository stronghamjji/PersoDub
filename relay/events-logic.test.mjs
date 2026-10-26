import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EVENTS, excludedPrefixes, isExcluded, toAmplitude, toGa4, validateEvents } from "./events-logic.js";

// Run me: node --test relay/*.test.mjs

const NOW = Date.UTC(2026, 9, 26, 12);
const BATCH = {
  installId: "0123456789abcdef0123456789abcdef",
  userId: "",
  version: "0.9.1",
  edition: "production",
  os: "mac",
  osVersion: "15.5",
  sessionId: NOW - 60000,
  events: [
    { name: "app_screen", screen: "home", t: NOW - 5000 },
    { name: "home_nav_settings", screen: "home", t: NOW - 4000 },
  ],
};
const check = (over) => validateEvents(JSON.stringify({ ...BATCH, ...over }), { now: NOW });

test("a batch as the app writes it comes back whole", () => {
  const got = check({});
  assert.equal(got.ok, true);
  assert.deepEqual(got.batch, BATCH);
});

test("an envelope that does not fit is refused, and says which field", () => {
  for (const [over, reason] of [
    [{ installId: "abc" }, "installId"],
    [{ userId: "a@b c" }, "userId"],
    [{ version: "latest" }, "version"],
    [{ edition: "beta" }, "edition"],
    [{ os: "ios" }, "os"],
    [{ osVersion: "/Users/me" }, "osVersion"],
    [{ sessionId: "1" }, "sessionId"],
    [{ events: [] }, "events"],
    [{ events: Array(MAX_EVENTS + 1).fill(BATCH.events[0]) }, "events"],
  ]) assert.deepEqual(check(over), { ok: false, reason }, JSON.stringify(over));
  assert.deepEqual(validateEvents("{", { now: NOW }), { ok: false, reason: "not json" });
});

test("an event that does not fit is dropped and the rest kept: no text, no path, no stray field", () => {
  const got = check({ events: [
    ...BATCH.events,
    { name: "Hello world", screen: "home", t: NOW },          // a sentence, not an id
    { name: "x".repeat(41), screen: "home", t: NOW },          // too long
    { name: "save", screen: "/Users/me", t: NOW },             // a path for a screen
    { name: "save", screen: "home", t: NOW - 9 * 86400000 },   // a wrong clock
    { name: "save", screen: "home", t: NOW, text: "my title" },
  ] });
  assert.deepEqual(got.batch.events, [...BATCH.events, { name: "save", screen: "home", t: NOW }]);
});

test("EXCLUDED_DEVICES drops the owner's computers by their first twelve characters", () => {
  assert.deepEqual(excludedPrefixes(" 0123456789AB, a, zz0123456789ab "), ["0123456789ab"]);
  assert.equal(isExcluded(BATCH.installId, "fedcba987654,0123456789ab"), true);
  assert.equal(isExcluded(BATCH.installId, "fedcba987654"), false);
  assert.equal(isExcluded(BATCH.installId, undefined), false);
});

test("GA4 gets two event names, the button as a parameter, the install id as the client", () => {
  const [body, ...more] = toGa4({ ...BATCH, userId: "u-42" }, { now: NOW });
  assert.equal(more.length, 0);
  assert.equal(body.client_id, BATCH.installId);
  assert.equal(body.user_id, "u-42");
  assert.deepEqual(body.events.map((e) => [e.name, e.params.button, e.params.screen]),
    [["app_screen", undefined, "home"], ["button_press", "home_nav_settings", "home"]]);
  assert.deepEqual(body.events[1].params, {
    button: "home_nav_settings", screen: "home", app_version: "0.9.1", edition: "production", os: "mac",
    os_version: "15.5", session_id: String(Math.floor(BATCH.sessionId / 1000)), engagement_time_msec: 1,
  });
  assert.equal(body.events[1].timestamp_micros, (NOW - 4000) * 1000);
});

test("GA4: no user_id while nobody is signed in, debug_mode only when asked, 25 a request, nothing past 72 hours", () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ name: "save", screen: "home", t: NOW - i }));
  const old = { name: "save", screen: "home", t: NOW - 73 * 3600000 };
  const bodies = toGa4({ ...BATCH, events: [...events, old] }, { now: NOW, debug: true });
  assert.deepEqual(bodies.map((b) => b.events.length), [25, 5]);
  assert.equal("user_id" in bodies[0], false);
  assert.equal(bodies[0].events[0].params.debug_mode, 1);
  assert.equal("debug_mode" in toGa4(BATCH, { now: NOW })[0].events[0].params, false);
});

test("Amplitude gets the same events in the trial's shape", () => {
  assert.deepEqual(toAmplitude(BATCH)[1], {
    event_type: "button_press", device_id: BATCH.installId, session_id: BATCH.sessionId, time: NOW - 4000,
    platform: "mac", os_name: "mac", os_version: "15.5", app_version: "0.9.1",
    event_properties: { button: "home_nav_settings", screen: "home", edition: "production" },
  });
  assert.equal(toAmplitude({ ...BATCH, userId: "u-42" })[0].user_id, "u-42");
});
