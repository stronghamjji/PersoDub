import { randomBytes } from "node:crypto";
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

/** The page's events that have the shape an event has; anything else is dropped. */
export function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && NAME.test(String(e.name)) && SCREEN.test(String(e.screen ?? "")) && Number.isInteger(e.t))
    .map((e) => ({ name: e.name, screen: e.screen || "", t: e.t }));
}

/** "mac", "windows" or "linux", as the relay names them. */
export const osName = (platform = process.platform) =>
  (platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux");

/**
 * The shell's half, for this app: take(list) answers the page's
 * persodubShell.sendEvents -- {on, kept, sent, recent} -- and an empty list
 * only asks. `ctx.userId` is the signed-in account's id, empty until the
 * production edition signs in.
 */
export function createEvents({ app, ctx, edition, shellLog, fetchImpl = fetch, now = Date.now }) {
  const dir = () => join(app.getPath("userData"), "events");
  const sessionId = now();
  const osVersion = (process.getSystemVersion ? process.getSystemVersion() : release()).slice(0, 32);
  let kept = 0;
  let sent = 0;
  let recent = [];
  let flushing = false;

  function mode() {
    return resolveEventsMode({ isPackaged: app.isPackaged, env: envWithKit(ctx.bootedKitDir), edition });
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
  // waits for the next batch.
  async function flush() {
    if (flushing || mode() !== "on") return;
    flushing = true;
    try {
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
            method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000),
          });
          status = res.status;
        } catch { status = 0; }
        if (status >= 200 && status < 300) sent += JSON.parse(body).events.length;
        if (status >= 200 && status < 500) rmSync(file, { force: true });
        else break;
      }
    } finally {
      flushing = false;
    }
  }

  function take(list) {
    const m = mode();
    if (m !== "off") {
      const events = cleanEvents(list);
      kept += events.length;
      recent = [...recent, ...events.map((e) => e.name)].slice(-20);
      if (m === "debug" && events.length) shellLog(`PERSODUB_EVENTS would send ${events.length}`);
      if (m === "on") {
        if (events.length) write(events);
        void flush().catch(() => {});
      }
    }
    return { on: m !== "off", kept, sent, recent };
  }

  return { take, flush };
}
