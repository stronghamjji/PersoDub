import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { analyticsFile, savedDevice } from "./analytics.js";
import { envWithKit } from "./kitEnv.js";
import { REPORT_ENDPOINT } from "./reporting.js";
import { REPORT_EXT, partitionQueue, queueBase } from "./reportQueue.js";

// The buttons pressed and the screens shown, for the product's charts (GA4,
// and Amplitude later). The page records them (ui/src/events.mjs) and hands
// them over every 30 seconds; this adds what the page cannot know -- the
// computer's id, the version, the edition, the system -- writes them down and
// sends them to the relay's POST /events, which passes them on.
//
// What may leave is a name the page made from its own markup (an element's
// id, or its English label), the screen's name and the moment: never what a
// person typed, a file, a path or a link. The page is a web page, so its
// names are checked again here against the shape the relay accepts.
//
// A step of a person's way through the app (relay/events-logic.js STEPS: the
// launch, the sign-in, a dubbing's stages, the quit) also carries `props`, a
// few words, numbers and true-or-false values, never text. The shell's own
// steps (track: the launch, the sign-in, the quit) wait in memory for the
// page's next batch, or the quit, and go with it.
//
// The switch is PERSODUB_EVENTS in kit.env (Settings > Privacy writes it).
// With no line, the production build records and the open-source one does
// not (owner, 2026-10-25): the build's own edition, never the one a kit
// remembers (edition.js), which is a dub's default only.
export const EVENTS_ENDPOINT = `${REPORT_ENDPOINT}/events`;
export const EVENTS_KEY = "PERSODUB_EVENTS";
export const MAX_PER_POST = 500;
// Batches waiting for the network, at most: a week offline is two hundred
// of them, and the oldest go first.
const MAX_QUEUED = 200;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SCREEN = /^[a-z0-9_]{0,32}$/;
// A step's property: a short key, and a value that is true or false, a
// number, or one word the app chose (the relay holds each step to its list).
const PROP_KEY = /^[a-z][a-z0-9_]{0,23}$/;
const PROP_WORD = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const MAX_PROPS = 8;
// How long the quit waits for the last batch to reach the relay. Whatever has
// not gone by then stays in the queue for the next launch.
export const QUIT_WAIT_MS = 3000;

/** Whether this kit records: its kit.env line, or the edition's default. */
export function eventsOn(env, edition) {
  if (env[EVENTS_KEY] === "1") return true;
  if (env[EVENTS_KEY] === "0") return false;
  return edition === "production";
}

/**
 * - "off":   nothing is kept.
 * - "debug": kept and counted, and shell.log says how many would have gone,
 *            but nothing leaves: a from-source run, PERSODUB_EVENTS_DEBUG=1,
 *            and a kit with PERSODUB_NO_ANALYTICS=1 -- the usage counts'
 *            switch, which the owner's own computers carry -- all stop here.
 * - "on":    kept, written down and sent. PERSODUB_EVENTS_SEND=1 forces it,
 *            so a from-source run can be checked end to end in GA4 and
 *            Amplitude (docs/privacy.md); it is never set in a build.
 */
export function resolveEventsMode({ isPackaged, env, edition }) {
  if (!eventsOn(env, edition)) return "off";
  if (env.PERSODUB_EVENTS_SEND === "1") return "on";
  if (!isPackaged || env.PERSODUB_NO_ANALYTICS === "1" || env.PERSODUB_EVENTS_DEBUG === "1") return "debug";
  return "on";
}

/** A step's props in the shape they may have, or null when there are none
 *  (a press). A key or a value of another shape is left out. */
export function cleanProps(props) {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (Object.keys(out).length >= MAX_PROPS || !PROP_KEY.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "string" && PROP_WORD.test(v))) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v);
  }
  return out;
}

/** The page's events that have the shape an event has; anything else is dropped. */
export function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && NAME.test(String(e.name)) && SCREEN.test(String(e.screen ?? "")) && Number.isInteger(e.t))
    .map((e) => {
      const props = cleanProps(e.props);
      return { name: e.name, screen: e.screen || "", t: e.t, ...(props ? { props } : {}) };
    });
}

/** The signed-in account as analytics know it: a one-way hash of Perso's
 *  number for it, which nobody can read back to the account, or "" signed
 *  out. Never the number itself or the e-mail (owner, 2026-10-25). */
export function eventsUserId(accountId) {
  return accountId ? createHash("sha256").update(`persodub:${accountId}`).digest("hex").slice(0, 32) : "";
}

/** "mac", "windows" or "linux", as the relay names them. */
export const osName = (platform = process.platform) =>
  (platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux");

/**
 * The shell's half, for this app: take(list) answers the page's
 * persodubShell.sendEvents -- {on, kept, sent, recent} -- and an empty list
 * only asks. track(name, props) is a step of the shell's own, kept for the
 * next batch; quit(props) records app_quit and sends what is waiting before
 * the app goes, QUIT_WAIT_MS at most, once. `ctx.userId` is the signed-in
 * account's eventsUserId, empty until the production edition signs in
 * (authIpc.js keeps it).
 */
export function createEvents({ app, ctx, edition, shellLog, fetchImpl = fetch, now = Date.now }) {
  const dir = () => join(app.getPath("userData"), "events");
  const sessionId = now();
  const osVersion = (process.getSystemVersion ? process.getSystemVersion() : release()).slice(0, 32);
  let kept = 0;
  let sent = 0;
  let recent = [];
  let flushing = null;
  let again = false;
  // The shell's own steps, waiting for the page's next batch or the quit.
  let held = [];
  // The screen of the page's last event, which the shell's steps are recorded on.
  let lastScreen = "";
  let quitting = null;

  // The kit the boot found, or the one it is installing into: a step from
  // before the engines are up still follows that kit's switch.
  function mode() {
    return resolveEventsMode({ isPackaged: app.isPackaged, env: envWithKit(ctx.bootedKitDir || ctx.kitDir), edition });
  }

  // Written down before it is sent, as a failure report is: the last batch
  // comes as the window closes, and the app may be gone before the answer.
  function write(events) {
    const device = savedDevice(analyticsFile(app));
    if (!device) return;
    try {
      mkdirSync(dir(), { recursive: true });
      for (let i = 0; i < events.length; i += MAX_PER_POST) {
        const batch = {
          installId: device, userId: ctx.userId || "", version: app.getVersion(), edition,
          os: osName(), osVersion, sessionId, events: events.slice(i, i + MAX_PER_POST),
        };
        writeFileSync(join(dir(), `${queueBase(randomBytes(6).toString("hex"), now())}${REPORT_EXT}`), JSON.stringify(batch));
      }
    } catch { /* a batch that cannot be saved is a few presses lost, nothing more */ }
  }

  // Oldest first. A 2xx is delivered and a 4xx is a batch the relay will
  // never take, so both are done with; anything else stops the round and
  // waits for the next batch. A batch written while a round runs goes in
  // one more round, which the same promise waits for.
  function flush({ timeoutMs = 8000 } = {}) {
    if (mode() !== "on") return Promise.resolve();
    if (flushing) { again = true; return flushing; }
    flushing = (async () => {
      try {
        do { again = false; await round(timeoutMs); } while (again);
      } finally { flushing = null; }
    })();
    return flushing;
  }

  async function round(timeoutMs) {
    let names = [];
    try { names = readdirSync(dir()); } catch { return; }
    const { retry, expired } = partitionQueue(names, { now: now() });
    const over = Math.max(0, retry.length - MAX_QUEUED);
    for (const base of [...expired, ...retry.slice(0, over)]) rmSync(join(dir(), `${base}${REPORT_EXT}`), { force: true });
    for (const base of retry.slice(over)) {
      const file = join(dir(), `${base}${REPORT_EXT}`);
      let body = "";
      try { body = readFileSync(file, "utf8"); } catch { continue; }
      let status = 0;
      try {
        const res = await fetchImpl(EVENTS_ENDPOINT, {
          method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
      } catch { status = 0; }
      if (status >= 200 && status < 300) sent += JSON.parse(body).events.length;
      if (status >= 200 && status < 500) rmSync(file, { force: true });
      else break;
    }
  }

  // The page's events with the shell's waiting steps ahead of them: counted,
  // and in "on" written down. Answers the mode they were kept in.
  function keep(list) {
    const m = mode();
    const fromPage = cleanEvents(list);
    if (fromPage.length) lastScreen = fromPage[fromPage.length - 1].screen;
    const events = [...held, ...fromPage];
    held = [];
    if (m === "off") return m;
    kept += events.length;
    recent = [...recent, ...events.map((e) => e.name)].slice(-20);
    if (m === "debug" && events.length) shellLog(`PERSODUB_EVENTS would send ${events.length}`);
    if (m === "on" && events.length) write(events);
    return m;
  }

  function take(list) {
    const m = keep(list);
    if (m === "on") void flush().catch(() => {});
    return { on: m !== "off", kept, sent, recent };
  }

  /** A step of the shell's own, on the screen the page was last on. Nothing
   *  is kept while recording is off. */
  function track(name, props = {}) {
    if (mode() === "off") return;
    held.push(...cleanEvents([{ name, screen: lastScreen, t: now(), props }]));
  }

  /** app_quit, and everything waiting sent before the app goes: QUIT_WAIT_MS
   *  at most, whatever the network does. Once: a second call waits for the first. */
  function quit(props = {}, { waitMs = QUIT_WAIT_MS } = {}) {
    quitting ??= (async () => {
      track("app_quit", { last_screen: lastScreen, session_seconds: Math.round((now() - sessionId) / 1000), ...props });
      if (keep([]) !== "on") return;
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(resolve, waitMs); });
      try { await Promise.race([flush({ timeoutMs: waitMs }).catch(() => {}), late]); } finally { clearTimeout(timer); }
    })();
    return quitting;
  }

  return { take, flush, track, quit };
}
