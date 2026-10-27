import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EVENTS, STEPS, excludedPrefixes, isExcluded, keyedUserId, stepProps, toAmplitude, toGa4, validateEvents } from "./events-logic.js";

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
  const [body, ...more] = toGa4(BATCH, { now: NOW, userId: "u-42" });
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
  assert.equal(toAmplitude(BATCH, { userId: "u-42" })[0].user_id, "u-42");
});

// sha256("42"), as the app sends a member number, keyed with a test key; the
// expected value is `printf %s <hash> | openssl dgst -sha256 -hmac relay-test-key`.
const HASHED = "73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";

test("the user id goes on keyed by EVENTS_USER_KEY: 32 hex characters, never the app's hash", async () => {
  const keyed = await keyedUserId(HASHED, "relay-test-key");
  assert.equal(keyed, "8c3d81a13a4f9581b3d2977b74b63840");
  assert.notEqual(await keyedUserId(HASHED, "another-key"), keyed);
  assert.equal(toGa4({ ...BATCH, userId: HASHED }, { now: NOW, userId: keyed })[0].user_id, keyed);
  assert.equal(toAmplitude({ ...BATCH, userId: HASHED }, { userId: keyed })[0].user_id, keyed);
});

test("without EVENTS_USER_KEY no user id at all, the device id kept; nobody signed in stays empty", async () => {
  for (const key of [undefined, ""]) assert.equal(await keyedUserId(HASHED, key), "");
  assert.equal(await keyedUserId("", "relay-test-key"), "");
  // The batch's own userId never reaches either side, even when nothing keys it.
  const batch = { ...BATCH, userId: HASHED };
  assert.equal("user_id" in toGa4(batch, { now: NOW })[0], false);
  assert.equal(toGa4(batch, { now: NOW })[0].client_id, BATCH.installId);
  assert.equal("user_id" in toAmplitude(batch)[0], false);
  assert.equal(toAmplitude(batch)[0].device_id, BATCH.installId);
});

// The steps of a person's way through the app (0.9.1): their own names, and
// only the properties STEPS lists, each of the kind it lists.
const step = (name, props, t = NOW - 1000) => ({ name, screen: "home", t, props });

test("a step keeps the properties STEPS lists, of the kind it lists, and nothing else", () => {
  const got = check({ events: [
    step("dub_started", { mode: "perso", target_lang: "ko", minutes: 3, video_seconds: 170, speakers: 2 }),
    step("dub_finished", { outcome: "failed", stage: "synthesize", reason: "out-of-memory", mode: "local", seconds: 412 }),
    step("app_quit", { last_screen: "home", signed_in: false, session_seconds: 95 }),
    step("update_available", { version: "0.9.2" }),
    step("key_page_opened", {}),
  ] });
  assert.deepEqual(got.batch.events.map((e) => [e.name, e.props]), [
    ["dub_started", { mode: "perso", target_lang: "ko", minutes: 3, video_seconds: 170, speakers: 2 }],
    ["dub_finished", { outcome: "failed", stage: "synthesize", reason: "out-of-memory", mode: "local", seconds: 412 }],
    ["app_quit", { last_screen: "home", signed_in: false, session_seconds: 95 }],
    ["update_available", { version: "0.9.2" }],
    ["key_page_opened", {}],
  ]);
});

test("a dubbing done on Perso has its own outcome, which only the dubbing's step takes", () => {
  assert.deepEqual(stepProps("dub_finished", { outcome: "on_perso", mode: "perso" }), { outcome: "on_perso", mode: "perso" });
  assert.deepEqual(stepProps("tool_finished", { tool: "erase", outcome: "on_perso" }), { tool: "erase" });
});

test("a step's text, file name, link or address has no way through: only words off its list", () => {
  assert.deepEqual(stepProps("media_added", { source: "my_video.mp4", kind: "video", title: "My wedding" }), { kind: "video" });
  assert.deepEqual(stepProps("dub_started", { target_lang: "Korean", minutes: -1, speakers: 2.5, mode: "cloud" }), {});
  assert.deepEqual(stepProps("app_quit", { last_screen: "/Users/me", signed_in: "yes", session_seconds: 1e12 }), {});
  assert.deepEqual(stepProps("inquiry_sent", { kind: "bug", email: "a@b.c", subject: "help" }), { kind: "bug" });
  assert.deepEqual(stepProps("update_installed", { version: "https://x.y/0.9.2" }), {});
  for (const [name, spec] of Object.entries(STEPS)) {
    for (const kind of Object.values(spec)) {
      if (Array.isArray(kind)) for (const w of kind) assert.match(w, /^[a-z0-9][a-z0-9_.-]{0,31}$/, `${name}: ${w}`);
    }
    assert.match(name, /^[a-z][a-z0-9_]{0,39}$/);
  }
});

test("a name that is not a step stays a press, props or not; a step without props is a press too", () => {
  const got = check({ events: [step("home_nav_settings", { mode: "local" }), { name: "sign_out", screen: "home", t: NOW - 1 }] });
  assert.deepEqual(got.batch.events, [{ name: "home_nav_settings", screen: "home", t: NOW - 1000 },
    { name: "sign_out", screen: "home", t: NOW - 1 }]);
  assert.deepEqual(toGa4(got.batch, { now: NOW })[0].events.map((e) => [e.name, e.params.button]),
    [["button_press", "home_nav_settings"], ["button_press", "sign_out"]]);
});

test("GA4 and Amplitude chart a step under its own name with its props; GA4 writes true and false as words", () => {
  const batch = check({ events: [
    step("sign_in_succeeded", { method: "browser", new_account: true, has_key: false }),
    step("app_screen", { previous_screen: "home", seconds_on_previous: 12 }),
    { name: "app_screen", screen: "done", t: NOW - 500 },
  ] }).batch;
  const [ga] = toGa4(batch, { now: NOW });
  assert.deepEqual(ga.events.map((e) => e.name), ["sign_in_succeeded", "app_screen", "app_screen"]);
  assert.deepEqual(ga.events[0].params, {
    method: "browser", new_account: "true", has_key: "false", screen: "home", app_version: "0.9.1",
    edition: "production", os: "mac", os_version: "15.5", session_id: String(Math.floor(BATCH.sessionId / 1000)),
    engagement_time_msec: 1,
  });
  assert.equal(ga.events[1].params.seconds_on_previous, 12);
  assert.equal("button" in ga.events[0].params, false);
  const amp = toAmplitude(batch);
  assert.deepEqual(amp.map((e) => e.event_type), ["sign_in_succeeded", "app_screen", "app_screen"]);
  assert.deepEqual(amp[0].event_properties, { method: "browser", new_account: true, has_key: false, screen: "home", edition: "production" });
  assert.deepEqual(amp[2].event_properties, { screen: "done", edition: "production" });
});
