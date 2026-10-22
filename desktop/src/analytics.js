import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { STEP_IDS } from "./installSpec.js";

// Usage counts. The decisions live here as pure functions so they can be tested
// without Electron; usageIpc.js and the renderer do the wiring. What a payload is
// allowed to contain is fixed by buildPayload below and repeated in
// docs/privacy.md's "Usage counts" -- the two must not drift. The count worker
// (not in this repository) accepts exactly these names; a dub's are stt,
// separation, mode, credits, seconds and, from 0.8.6, started_hour,
// elapsed_seconds, sep_seconds, stt_seconds, translate_seconds, voice_seconds.

const DAILY_EVENTS = new Set(["app_launch"]);
const FAILURE_EVENTS = new Set(["dub_failure", "install_failure", "erase_failure"]);

// The published list. An error code that is not on it becomes "unknown" rather
// than travelling verbatim -- that is what keeps a stray path or message, which
// is what real error text is full of, out of the request.
// The install steps, imported from the one place they live (installSpec.js,
// same main process) -- a copy here once drifted on a rename and the failing
// step travelled as "unknown".
export const INSTALL_STEPS = new Set(STEP_IDS);

export const ERROR_CODES = new Set([
  "path-too-long", "disk-full", "network", "permission", "engine-start",
  "out-of-memory", "timeout", "unsupported-format", "engine-crash", "step-failed",
  // One per service and reason. "cloud-refused" is what 0.5.4 and earlier send
  // and stays on the list for as long as they are running -- dropping it would
  // turn every one of their refusals into "unknown".
  "cloud-refused", "perso-busy", "perso-credits", "perso-key", "perso-failed",
  // A video longer than the Perso plan allows (F4008; the free plan stops at
  // one minute). The user's plan, not our code (2026-10-19).
  "perso-length",
  // A voice model the Perso plan does not cover (VT40314; FINCH and NIGHTINGALE
  // need Pro). The user's plan, not our code (2026-10-19).
  "perso-plan",
  "gemini-busy", "gemini-quota",
  // Four families that were all "unknown" until 0.6.1. Every one of them was
  // a real, repeated failure nobody could see (2026-09-15).
  "model-download", "engine-500", "perso-bad-request", "translate-parse",
  // The app was closed while the job was still running (app/jobs.py marks it
  // on restore). Its own word so it reads apart from a real crash (2026-09-18).
  "interrupted",
  // A certificate the computer's Python refused: something on the machine or
  // the company network signing HTTPS itself (2026-10-15).
  "certificate",
  "unknown",
]);

/**
 * Should this run report at all?
 *  - "off":   never touch the network. A from-source run is always off (its
 *             counts would be the developer's own), and a packaged build is
 *             silenced by either the Settings switch or PERSODUB_NO_ANALYTICS=1.
 *  - "debug": print the payload instead of sending it, so anyone can see
 *             exactly what would leave. PERSODUB_ANALYTICS_DEBUG=1.
 *  - "on":    send.
 * An off switch wins over debug: someone who asked for silence gets silence,
 * not a printed copy of the thing they turned off.
 */
export function resolveAnalyticsMode({ isPackaged, env, settingOff = false }) {
  if (!isPackaged) return "off";
  if (settingOff) return "off";
  if ((env.PERSODUB_NO_ANALYTICS || "") === "1") return "off";
  if ((env.PERSODUB_ANALYTICS_DEBUG || "") === "1") return "debug";
  return "on";
}

/**
 * A launch counts once a day, so the number tracks machines rather than how
 * often someone restarts. A dub counts every time, because "how many did they
 * actually finish" is the question those events exist to answer.
 */
export function shouldReport({ event, lastDay, today }) {
  if (!DAILY_EVENTS.has(event)) return true;
  return lastDay !== today;
}

const DUB_EVENTS = new Set(["dub_success", "dub_failure"]);

// Which side a stage ran on, off the job's own engine field. "perso" is the
// one word that means Perso; any other engine the job could name is this
// machine, and the engine's name itself never travels.
const persoOrLocal = (v) => (v === "perso" ? "perso" : "local");
// A count that is a count: a whole, non-negative number. Anything else is left
// out of the message, and the table stores NULL for it.
const isCount = (n) => Number.isInteger(n) && n >= 0;

// A step's seconds by the name the job's record keeps it under (app/jobs.py
// timed_step, app/stages.py) -> the name it travels as. Only these four leave.
const STAGE_FIELDS = [["separate", "sep_seconds"], ["transcribe", "stt_seconds"],
                      ["translate", "translate_seconds"], ["synthesize", "voice_seconds"]];

/** How long a job ran, off its record (dubFacts' timing), by the names the
 *  count sends it under: its whole seconds and each of the four steps'. Whole
 *  numbers only, and a step that did not run is left out rather than sent as
 *  0. A finished job's record (report.js) carries the same. */
export function timingSeconds(timing) {
  const out = {};
  if (!timing) return out;
  if (isCount(timing.elapsed_seconds)) out.elapsed_seconds = timing.elapsed_seconds;
  for (const [stage, field] of STAGE_FIELDS) {
    const n = (timing.stage_seconds || {})[stage];
    if (isCount(n)) out[field] = n;
  }
  return out;
}

/** The whole message. A field not named here cannot leave. */
export function buildPayload({ event, os, version, device, errorCode, step,
                               engines, credits, seconds, timing, persoKey }) {
  const payload = { event, os, version, device };
  if (FAILURE_EVENTS.has(event)) {
    payload.error_code = ERROR_CODES.has(errorCode) ? errorCode : "unknown";
  }
  // Which of the twelve steps died. Only install failures have one, and only a
  // published id travels -- the same rule as error codes, for the same reason.
  // A failure before any step has run (a path or space preflight) carries none.
  if (event === "install_failure" && step !== undefined) {
    payload.step = INSTALL_STEPS.has(step) ? step : "unknown";
  }
  // Which parts of a dub went through Perso, what that one job cost, and how
  // long the video was in seconds (0.6.4; 0.6.2 and 0.6.3 sent minutes) -- read
  // off the job's record (dubFacts), so a dub the shell could not look up says
  // nothing rather than "local". Two words for the stages and two whole
  // numbers: no engine name, no balance, no title.
  if (DUB_EVENTS.has(event)) {
    if (engines) {
      payload.stt = persoOrLocal(engines.stt_engine);
      payload.separation = persoOrLocal(engines.separation);
      payload.mode = persoOrLocal(engines.dub_mode);
    }
    if (isCount(credits)) payload.credits = credits;
    if (isCount(seconds)) payload.seconds = seconds;
    // When it started (the computer's hour, 0-23), how long it ran, and each
    // step's seconds (0.8.6): whole numbers only, and a step that did not run
    // is left out rather than sent as 0.
    if (timing) {
      if (isCount(timing.started_hour) && timing.started_hour < 24) payload.started_hour = timing.started_hour;
      Object.assign(payload, timingSeconds(timing));
    }
  }
  // Whether a Perso key is set when the app starts -- yes or no, never the key.
  if (event === "app_launch" && typeof persoKey === "boolean") {
    payload.perso_key = persoKey ? "yes" : "no";
  }
  return payload;
}

/**
 * What a job's own record tells the count: its engine fields, the Perso
 * credits it spent, its length in seconds, and how long it ran (the record's
 * started_hour, elapsed_seconds and stage_seconds, app/jobs.py). A record the
 * shell could not fetch gives nothing, and buildPayload then sends nothing for it.
 *
 * Seconds, not minutes. 0.6.2 and 0.6.3 sent whole minutes and two thirds of
 * what they sent read 0, because most of the videos people put in are under
 * thirty seconds and a rounded minute is 0 for all of them -- the length was
 * there and the rounding threw it away.
 */
export function dubFacts(job) {
  if (!job || typeof job !== "object") return {};
  const { stt_engine, separation, dub_mode } = job;
  return {
    engines: { stt_engine, separation, dub_mode },
    credits: job.perso_credits,
    seconds: Number.isFinite(job.duration) ? Math.round(job.duration) : undefined,
    timing: { started_hour: job.started_hour, elapsed_seconds: job.elapsed_seconds,
              stage_seconds: job.stage_seconds },
  };
}

/**
 * Post one payload. Resolves true only on a delivered 2xx; offline, DNS
 * failure, a hung endpoint and a rejected payload all resolve false. It never
 * rejects and never retries -- a usage count is not worth a second of the
 * user's time, and certainly not an error dialog.
 */
export async function report(payload, { url, timeoutMs = 3000, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The two things that have to outlive a restart: the install id, and the day a
 * launch was last counted.
 *
 * A missing id is minted here but NOT written -- saveState is the only thing
 * that touches disk, and the launch keeps one from the first run on
 * (keepDevice), counts on or off.
 *
 * A state file that cannot be parsed is treated as absent rather than fatal.
 * Losing a count is nothing; refusing to launch over a corrupt counter file
 * would be absurd.
 */
export function loadState(file) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    saved = {};
  }
  const device = /^[0-9a-f]{32}$/.test(saved?.device)
    ? saved.device
    : randomBytes(16).toString("hex");
  const lastDay = typeof saved?.lastDay === "string" ? saved.lastDay : null;
  return { device, lastDay };
}

/** Persist state. Like everything else here, a failure is not worth a word. */
export function saveState(file, { device, lastDay = null }) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ device, lastDay }));
  } catch {
    // A read-only or full disk costs a count, not a launch.
  }
}

/**
 * The computer's id as saved, or "" -- never a new one. Every report and job
 * record names the computer by it (reporting.js), and only the launch makes
 * one (keepDevice).
 */
export function savedDevice(file) {
  try {
    const { device } = JSON.parse(readFileSync(file, "utf8"));
    return /^[0-9a-f]{32}$/.test(device) ? device : "";
  } catch {
    return "";
  }
}

/** Where the id and the last counted day live: userData, which outlives every
 *  kit and every update. */
export const analyticsFile = (app) => join(app.getPath("userData"), "analytics.json");

/**
 * This computer's id, made on its first launch and kept from then on (main.js
 * asks on every launch). It is the one number the private dashboard tells
 * computers apart by, so every report and job record carries it, counts on or
 * off (owner, 2026-10-22). Making it sends nothing: the counts still leave
 * only while their switch is on.
 */
export function keepDevice(file) {
  const saved = savedDevice(file);
  if (saved) return saved;
  const state = loadState(file);
  saveState(file, state);
  return state.device;
}

/**
 * The single call the app makes. Everything a caller could get wrong -- the off
 * switches, the once-a-day rule, persistence, timeouts, failure -- is settled
 * here so a call site is one line that cannot misbehave.
 *
 * Resolves to whether anything was delivered. Callers ignore it; the tests do
 * not. It never throws: a count must never be able to break a launch or a dub.
 */
export async function countEvent(event, {
  mode, stateFile, url, os, version, errorCode, step,
  engines, credits, seconds, timing, persoKey,
  today = new Date().toISOString().slice(0, 10),
  timeoutMs, fetchImpl, log = console.log,
}) {
  // Before anything reads or writes disk: off sends nothing and writes
  // nothing. The id is the launch's to make (keepDevice), counts on or off.
  if (mode === "off") return false;

  const state = loadState(stateFile);
  if (!shouldReport({ event, lastDay: state.lastDay, today })) return false;

  const payload = buildPayload({ event, os, version, device: state.device, errorCode, step,
                                 engines, credits, seconds, timing, persoKey });

  if (mode === "debug") {
    log(`[persodub-analytics] would send: ${JSON.stringify(payload)}`);
    return false;
  }

  const delivered = await report(payload, { url, timeoutMs, fetchImpl });

  // The day advances only on a delivered launch. An offline machine therefore
  // tries again next launch instead of quietly dropping itself from the count.
  // The id is written either way, so one machine keeps being one machine.
  saveState(stateFile, {
    device: state.device,
    lastDay: delivered && DAILY_EVENTS.has(event) ? today : state.lastDay,
  });
  return delivered;
}

// Real failure text is full of things that must not travel: home directories,
// project filenames, download URLs, sometimes a signed URL's token. Each rule
// matches on the machine-readable part -- an errno, a status word -- and throws
// the rest away. A message nobody has taught this table about becomes
// "unknown", which is the safe answer, not a reason to send the text instead.
const ERROR_PATTERNS = [
  [/ENOSPC|no space left|not enough space/i,         "disk-full"],
  [/EACCES|EPERM|permission denied/i,                "permission"],
  [/path is too long|too long to install/i,          "path-too-long"],
  // pip and Python's ssl refusing a certificate. Ahead of "network" because
  // the answer is the machine's security software, not its connection: two
  // Windows laptops failed pip with "self-signed certificate in certificate
  // chain" and both reports said only "step-failed" (2026-10-15).
  [/CERTIFICATE_VERIFY_FAILED|SSLCertVerificationError|self.signed certificate|unable to get local issuer certificate/i, "certificate"],
  // Both spellings of a connection that went away: node and curl print the
  // errno (ECONNREFUSED), Python prints the sentence ("[Errno 61] Connection
  // refused"). Only the errno was listed, so the commonest local failure of all
  // -- a dub reaching a voice engine that is not running -- was counted as
  // "unknown". Found by rebuilding a real failed job as a report, 2026-09-09.
  // Widening a rule can only move a message from "unknown" to "network"; no
  // message that already had a code can change, because every rule above this
  // one is tried first.
  [/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection refused|connection reset|download failed|sha256 mismatch/i, "network"],
  // A stage the machine could not finish in the time it was given. Its own
  // word, because the answer is a faster machine or a shorter video, and
  // lumping it in with a crash hid the commonest failure of all: twenty of
  // the thirty-two reports in the four days after 0.6.0 were this, every one
  // of them counted as "unknown" (2026-09-15).
  [/timed out after|timed out|TimeoutExpired/i,      "timeout"],
  // "not enough memory" is torch's own wording (DefaultCPUAllocator), which
  // the /allocate/ rule below never matched -- it says "Allocator". Windows'
  // "paging file is too small" is os error 1455, in the computer's own
  // language around the number (issue #187).
  [/out of memory|not enough memory|ENOMEM|allocate|os error 1455|paging file/i, "out-of-memory"],
  [/unsupported|unrecognized codec|invalid data found/i, "unsupported-format"],
  [/did not become ready|exit \d+/i,                 "engine-crash"],
  // The cloud service saying no. These sentences are the app's own published
  // words (app/pipeline.py's _NOTICE_ERRORS), and none of them is a fact about
  // the user's machine -- counting them as "unknown" made a service outage look
  // like a broken install (found rebuilding a real failed job as a report,
  // 2026-09-09).
  //
  // One word each, not a shared "cloud-refused": the counts are read a day at a
  // time, and "Perso was overloaded on the 11th" is the sentence they have to be
  // able to say. Lumped together, an outage and a used-up wallet were the same
  // word (user, 2026-09-11).
  //
  // Last in the table on purpose: every machine-side rule above is tried first.
  [/temporarily unavailable/i,        "perso-busy"],
  [/credits are used up/i,            "perso-credits"],
  [/rejected the api key/i,           "perso-key"],
  [/longer than your perso plan allows/i, "perso-length"],
  [/needs a higher perso plan/i,     "perso-plan"],
  [/could not finish this job/i,      "perso-failed"],
  [/temporarily overloaded/i,         "gemini-busy"],
  [/quota is used up/i,               "gemini-quota"],

  // Last of all, and deliberately so. Each of these is a family that arrived
  // as "unknown" through the four days after 0.6.0; with "timeout" above they
  // account for every unclassified report of 2026-09-11..15. They sit below
  // the cloud rules because a translation that failed because Gemini's quota
  // ran out is news about Gemini, not about our parser.
  //
  // Model files that never arrived: huggingface_hub says "cannot find the
  // appropriate snapshot folder" and asks the reader to check their internet
  // connection, which matched none of the network spellings above (5 reports).
  [/huggingface|hf download|snapshot folder|LocalEntryNotFound/i, "model-download"],
  // The voice engine answering 500 on this machine's own port. Pinned to the
  // loopback address so a cloud service's 500 cannot be read as ours.
  [/(server error '5\d\d|http 5\d\d)[\s\S]{0,120}(127\.0\.0\.1|localhost)/i, "engine-500"],
  // Perso refusing the request itself, as opposed to being out of credit or
  // overloaded -- both of which have their own words above.
  [/perso[^\n]{0,80}client error '4\d\d/i, "perso-bad-request"],
  // A 1.8B model asked for JSON and answering with something else.
  [/translation failed|could not find a json array|line count mismatch/i, "translate-parse"],
];

/** One published word for a whole error message. Never the message itself.
 *
 * `install` splits the catch-all in two. "engine-crash" was written for a
 * running engine dying mid-dub, but its pattern (a nonzero exit) also matches
 * every pip install and model download that fails during setup -- so install
 * failures arrived claiming an engine had crashed when none had started yet.
 */
export function classifyError(message, { install = false } = {}) {
  if (typeof message !== "string" || message === "") return "unknown";
  for (const [pattern, code] of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return install && code === "engine-crash" ? "step-failed" : code;
    }
  }
  return "unknown";
}
