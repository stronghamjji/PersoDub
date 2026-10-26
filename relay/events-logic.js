// The button presses and screens the app records (desktop/src/events.js), as
// decisions only: what a valid batch is, which computers are left out, and
// what GA4 and Amplitude are each sent. report-worker.js does the sending.
//
// A batch is one computer's, and every event in it is a name and a screen the
// app made from its own markup -- an element's id, never what a person typed
// or opened -- so the relay checks each against the shape the app writes and
// drops one that does not fit, rather than passing on whatever arrived.
//
// Web APIs only, like report-logic.js: the same code runs inside a Worker.

export const MAX_EVENTS_BYTES = 128 * 1024;
export const MAX_EVENTS = 500;
export const OSES = ["mac", "windows", "linux"];
export const EDITIONS = ["opensource", "production"];
// The page's own word for "the screen changed" (ui/src/events.mjs); every
// other name is a button, link, tab or menu item that was pressed.
export const SCREEN_EVENT = "app_screen";
export const PRESS_EVENT = "button_press";

// GA4 takes 25 events a request and nothing older than 72 hours.
const GA4_PER_REQUEST = 25;
const GA4_MAX_AGE_MS = 72 * 60 * 60 * 1000;
// An event dated further out than this is a clock that is wrong, not an event.
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SCREEN = /^[a-z0-9_]{0,32}$/;
const INSTALL = /^[0-9a-f]{32}$/;
const VERSION = /^\d+\.\d+\.\d+[\w.-]{0,16}$/;
const OS_VERSION = /^[\w. -]{0,32}$/;
// The signed-in account's id, filled once the production edition signs in;
// empty until then.
const USER = /^[\w.-]{0,64}$/;

/**
 * The batch rebuilt field by field, or why it was refused. The envelope must
 * be whole; an event that does not fit is dropped and the rest kept, so one
 * odd name never costs a computer everything it sent.
 */
export function validateEvents(raw, { now = Date.now() } = {}) {
  let given;
  try { given = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { ok: false, reason: "not json" }; }
  if (!given || typeof given !== "object") return { ok: false, reason: "not an object" };
  const { installId, userId = "", version, edition, os, osVersion = "", sessionId, events } = given;
  if (!INSTALL.test(String(installId))) return { ok: false, reason: "installId" };
  if (typeof userId !== "string" || !USER.test(userId)) return { ok: false, reason: "userId" };
  if (!VERSION.test(String(version))) return { ok: false, reason: "version" };
  if (!EDITIONS.includes(edition)) return { ok: false, reason: "edition" };
  if (!OSES.includes(os)) return { ok: false, reason: "os" };
  if (typeof osVersion !== "string" || !OS_VERSION.test(osVersion)) return { ok: false, reason: "osVersion" };
  if (!Number.isInteger(sessionId) || sessionId <= 0) return { ok: false, reason: "sessionId" };
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return { ok: false, reason: "events" };
  const kept = events
    .filter((e) => e && NAME.test(String(e.name)) && SCREEN.test(String(e.screen ?? ""))
      && Number.isInteger(e.t) && e.t > now - MAX_AGE_MS && e.t < now + MAX_AHEAD_MS)
    .map((e) => ({ name: e.name, screen: e.screen || "", t: e.t }));
  return { ok: true, batch: { installId, userId, version, edition, os, osVersion, sessionId, events: kept } };
}

/** The usable entries of EXCLUDED_DEVICES: install ids or their first twelve
 *  characters, comma separated, as the dashboard reads the same secret. */
export function excludedPrefixes(value) {
  return String(value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{12,32}$/.test(s));
}

/** One of the owner's own computers? Its batch is dropped whole. */
export const isExcluded = (installId, value) => excludedPrefixes(value).some((p) => installId.startsWith(p));

/**
 * GA4 Measurement Protocol bodies, 25 events each: the install id is the
 * client, the account the user when there is one. A press is one event name
 * with the button in a parameter, so the property's 500 event names are never
 * spent on buttons. `debug` marks them for DebugView.
 */
export function toGa4(batch, { now = Date.now(), debug = false } = {}) {
  const events = batch.events.filter((e) => e.t > now - GA4_MAX_AGE_MS).map((e) => ({
    name: e.name === SCREEN_EVENT ? SCREEN_EVENT : PRESS_EVENT,
    timestamp_micros: e.t * 1000,
    params: {
      ...(e.name === SCREEN_EVENT ? {} : { button: e.name }),
      screen: e.screen,
      app_version: batch.version,
      edition: batch.edition,
      os: batch.os,
      os_version: batch.osVersion,
      session_id: String(Math.floor(batch.sessionId / 1000)),
      engagement_time_msec: 1,
      ...(debug ? { debug_mode: 1 } : {}),
    },
  }));
  const bodies = [];
  for (let i = 0; i < events.length; i += GA4_PER_REQUEST) {
    bodies.push({
      client_id: batch.installId,
      ...(batch.userId ? { user_id: batch.userId } : {}),
      events: events.slice(i, i + GA4_PER_REQUEST),
    });
  }
  return bodies;
}

/** Amplitude's HTTP API events, the 2026-10-12 trial's shape (persodub-analytics
 *  src/amplitude.js): the same two event names and the same facts. */
export function toAmplitude(batch) {
  return batch.events.map((e) => ({
    event_type: e.name === SCREEN_EVENT ? SCREEN_EVENT : PRESS_EVENT,
    device_id: batch.installId,
    ...(batch.userId ? { user_id: batch.userId } : {}),
    session_id: batch.sessionId,
    time: e.t,
    platform: batch.os,
    os_name: batch.os,
    os_version: batch.osVersion,
    app_version: batch.version,
    event_properties: {
      ...(e.name === SCREEN_EVENT ? {} : { button: e.name }),
      screen: e.screen,
      edition: batch.edition,
    },
  }));
}
