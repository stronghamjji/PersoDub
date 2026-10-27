// The button presses and screens the app records (desktop/src/events.js), as
// decisions only: what a valid batch is, which computers are left out, and
// what GA4 and Amplitude are each sent. report-worker.js does the sending.
//
// A batch is one computer's, and every event in it is a name and a screen the
// app made from its own markup -- an element's id, never what a person typed
// or opened -- or one of the app's steps (STEPS) with its few properties, so
// the relay checks each against the shape the app writes and drops one that
// does not fit, rather than passing on whatever arrived.
//
// Web APIs only, like report-logic.js: the same code runs inside a Worker.

export const MAX_EVENTS_BYTES = 128 * 1024;
export const MAX_EVENTS = 500;
export const OSES = ["mac", "windows", "linux"];
export const EDITIONS = ["opensource", "production"];
// The page's own word for "the screen changed" (ui/src/events.mjs); every
// other name is a button, link, tab or menu item that was pressed, unless it
// is one of the steps below.
export const SCREEN_EVENT = "app_screen";
export const PRESS_EVENT = "button_press";

// The steps of a person's way through the app (0.9.2): the launch, the
// sign-in, a video brought in, a dubbing and its stages, the tools, credits
// and keys, support, updates and the quit. Each arrives with `props` and goes
// to GA4 and Amplitude under its own name, with exactly the properties listed
// here: true or false (B), a whole number (N), a screen's name (S), a version
// (V), a two-letter language (L), or one word of a list. Anything else in
// `props` is dropped, so a title, a file name, a link or an address has no
// way through.
const B = "bool", N = "count", S = "screen", V = "version", L = "lang";
const METHODS = ["window", "browser"];
const MODES = ["local", "perso"];
const OUTCOMES = ["done", "failed", "cancelled"];
// A dubbing's stages by the engine's own names (app/stages.py), and a Perso
// API dubbing's three (app/perso_client.py).
const STAGES = ["separate", "transcribe", "translate", "synthesize", "check", "build",
  "upload", "perso-dubbing", "download"];
// The one word for why a job or an install stopped: desktop/src/analytics.js
// ERROR_CODES, word for word (desktop/src/events.test.mjs keeps them together).
export const REASONS = ["path-too-long", "disk-full", "network", "permission", "engine-start",
  "out-of-memory", "timeout", "unsupported-format", "engine-crash", "step-failed", "cloud-refused",
  "perso-busy", "perso-credits", "perso-key", "perso-failed", "perso-length", "perso-plan",
  "gemini-busy", "gemini-quota", "model-download", "engine-500", "perso-bad-request",
  "translate-parse", "interrupted", "certificate", "unknown"];
// The popups ui/src/runningScreen.mjs opens, by the notice that opened them.
const NOTICES = ["perso_credit_exhausted", "perso_duration_limit", "perso_plan_required",
  "perso_invalid_key", "perso_unavailable", "gemini_quota_exhausted", "chatgpt_signed_out",
  "chatgpt_limit", "gemini_unavailable"];
const TOOLS = ["erase", "burn", "export"];
export const STEPS = {
  app_screen: { previous_screen: S, seconds_on_previous: N },
  app_launch: { first_run: B },
  app_quit: { last_screen: S, signed_in: B, session_seconds: N },
  kit_install_started: { mode: ["install", "update"], gigabytes: N },
  kit_install_finished: { outcome: OUTCOMES, reason: REASONS, seconds: N },
  error_shown: { code: REASONS, where: ["install", "start"] },
  sign_in_shown: { face: ["start", "wait", "nokey"] },
  sign_in_started: { method: METHODS },
  sign_in_handoff: { provider: ["google", "microsoft", "other"] },
  sign_in_succeeded: { method: METHODS, new_account: B, has_key: B },
  sign_in_cancelled: { method: METHODS },
  sign_in_failed: { method: METHODS, reason: ["timeout", "window", "port", "denied", "token", "network"] },
  sign_out: { reason: ["user", "refresh_refused"] },
  key_fetched: { present: B, ok: B },
  key_page_opened: {},
  key_saved: { ok: B, kind: ["perso", "gemini"] },
  media_added: { source: ["file", "link", "drop"], kind: ["video", "audio"] },
  draft_opened: {},
  dub_started: { mode: MODES, target_lang: L, minutes: N, video_seconds: N, speakers: N, again: B },
  dub_stage: { stage: STAGES, state: ["start", "done", "failed"], seconds: N, mode: MODES },
  dub_cancelled: { stage: STAGES, mode: MODES },
  // on_perso: a free-plan workspace's Perso dubbing, made and seen on Perso's
  // site (desktop/src/usageIpc.js dubFinishedProps).
  dub_finished: { outcome: [...OUTCOMES, "on_perso"], stage: STAGES, reason: REASONS, mode: MODES, minutes: N,
    video_seconds: N, seconds: N },
  tool_started: { tool: TOOLS, from: ["draft", "dub", "erase", "captions"], files: N },
  tool_finished: { tool: TOOLS, outcome: OUTCOMES, files: N },
  credit_popup_shown: { reason: NOTICES },
  recharge_opened: { from: ["draft", "settings", "popup"] },
  signup_link_opened: { from: ["settings", "key_window"] },
  inquiry_sent: { kind: ["problem", "bug", "payment", "other"], queued: B },
  inquiry_failed: { reason: ["need_reply_to", "failed"] },
  update_available: { version: V },
  update_installed: { version: V },
};
// A whole number this large is a clock or a bug, not a count of anything.
const MAX_COUNT = 10_000_000;

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
const LANG = /^[a-z]{2}$/;

/** One value against its kind in STEPS: the value, or undefined. */
function propValue(kind, v) {
  if (Array.isArray(kind)) return kind.includes(v) ? v : undefined;
  if (kind === B) return typeof v === "boolean" ? v : undefined;
  if (kind === N) return Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : undefined;
  if (kind === S) return typeof v === "string" && SCREEN.test(v) ? v : undefined;
  if (kind === V) return typeof v === "string" && VERSION.test(v) ? v : undefined;
  return typeof v === "string" && LANG.test(v) ? v : undefined;
}

/** A step's properties as STEPS lists them: the rest, and a value of the
 *  wrong kind, left out. */
export function stepProps(name, props) {
  const out = {};
  for (const [key, kind] of Object.entries(STEPS[name])) {
    const v = propValue(kind, props[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// A step is a name in STEPS that came with its props; anything else is a
// press, or the screen as an app before 0.9.2 sends it.
const isStep = (e) => Object.hasOwn(STEPS, e.name) && !!e.props && typeof e.props === "object" && !Array.isArray(e.props);
// The name GA4 and Amplitude chart an event under: a step's own, the screen's,
// or one name for every press.
const chartName = (e) => (e.props ? e.name : e.name === SCREEN_EVENT ? SCREEN_EVENT : PRESS_EVENT);
const isPress = (e) => chartName(e) === PRESS_EVENT;

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
    .map((e) => ({ name: e.name, screen: e.screen || "", t: e.t, ...(isStep(e) ? { props: stepProps(e.name, e.props) } : {}) }));
  return { ok: true, batch: { installId, userId, version, edition, os, osVersion, sessionId, events: kept } };
}

/** The usable entries of EXCLUDED_DEVICES: install ids or their first twelve
 *  characters, comma separated, as the dashboard reads the same secret. */
export function excludedPrefixes(value) {
  return String(value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{12,32}$/.test(s));
}

/** One of the owner's own computers? Its batch is dropped whole. */
export const isExcluded = (installId, value) => excludedPrefixes(value).some((p) => installId.startsWith(p));

// The app's userId is the sha256 of the Perso member number, and member
// numbers count up from 1: hashing 1..N gives every one of them back. So the
// relay never passes it on as it came. GA4 and Amplitude get the HMAC-SHA256
// of it under EVENTS_USER_KEY, a secret only the relay holds (its first 32 hex
// characters), and without that secret no user id at all: the install id
// still counts the computer.
const USER_ID_HEX = 32;

/** The user id GA4 and Amplitude may see: keyed by the secret, or "" when
 *  there is no secret or nobody is signed in. Web Crypto, as in a Worker. */
export async function keyedUserId(userId, key) {
  if (!userId || !key) return "";
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(userId)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, USER_ID_HEX);
}

/**
 * GA4 Measurement Protocol bodies, 25 events each: the install id is the
 * client, `userId` (keyedUserId's, never the batch's own) the user when there
 * is one. A press is one event name
 * with the button in a parameter, so the property's 500 event names are never
 * spent on buttons; a step goes under its own name with its props as
 * parameters, true and false as the words (GA4 takes no booleans). `debug`
 * marks them for DebugView.
 */
export function toGa4(batch, { now = Date.now(), debug = false, userId = "" } = {}) {
  const events = batch.events.filter((e) => e.t > now - GA4_MAX_AGE_MS).map((e) => ({
    name: chartName(e),
    timestamp_micros: e.t * 1000,
    params: {
      ...Object.fromEntries(Object.entries(e.props || {}).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v])),
      ...(isPress(e) ? { button: e.name } : {}),
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
      ...(userId ? { user_id: userId } : {}),
      events: events.slice(i, i + GA4_PER_REQUEST),
    });
  }
  return bodies;
}

/** Amplitude's HTTP API events, the 2026-10-12 trial's shape (persodub-analytics
 *  src/amplitude.js): the same event names and the same facts as GA4's, and
 *  the same keyed `userId`. */
export function toAmplitude(batch, { userId = "" } = {}) {
  return batch.events.map((e) => ({
    event_type: chartName(e),
    device_id: batch.installId,
    ...(userId ? { user_id: userId } : {}),
    session_id: batch.sessionId,
    time: e.t,
    platform: batch.os,
    os_name: batch.os,
    os_version: batch.osVersion,
    app_version: batch.version,
    event_properties: {
      ...e.props,
      ...(isPress(e) ? { button: e.name } : {}),
      screen: e.screen,
      edition: batch.edition,
    },
  }));
}
