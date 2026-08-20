import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// Usage counts. The decisions live here as pure functions so they can be tested
// without Electron; main.js and the renderer do the wiring. What a payload is
// allowed to contain is fixed by buildPayload below and repeated in the
// README's "Usage counts" -- the two must not drift.

const DAILY_EVENTS = new Set(["app_launch"]);
const FAILURE_EVENTS = new Set(["dub_failure", "install_failure"]);

// The published list. An error code that is not on it becomes "unknown" rather
// than travelling verbatim -- that is what keeps a stray path or message, which
// is what real error text is full of, out of the request.
export const ERROR_CODES = new Set([
  "path-too-long", "disk-full", "network", "permission", "engine-start",
  "out-of-memory", "unsupported-format", "engine-crash",
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

/** The whole message. A field not named here cannot leave. */
export function buildPayload({ event, os, version, device, errorCode }) {
  const payload = { event, os, version, device };
  if (FAILURE_EVENTS.has(event)) {
    payload.error_code = ERROR_CODES.has(errorCode) ? errorCode : "unknown";
  }
  return payload;
}

/**
 * Post one payload. Resolves true only on a delivered 2xx; offline, DNS
 * failure, a hung endpoint and a rejected payload all resolve false. It never
 * rejects and never retries -- a usage count is not worth a second of the
 * user's time, and certainly not an error dialog.
 */
export async function report(payload, { url, timeoutMs = 3000, fetchImpl = fetch }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two things that have to outlive a restart: the install id, and the day a
 * launch was last counted.
 *
 * A missing id is minted here but NOT written -- saveState is the only thing
 * that touches disk. That ordering is deliberate: a run with reporting off
 * never calls this, so a user who turned it off never has an id generated for
 * them, and no file appears to say otherwise.
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
 * The single call the app makes. Everything a caller could get wrong -- the off
 * switches, the once-a-day rule, persistence, timeouts, failure -- is settled
 * here so a call site is one line that cannot misbehave.
 *
 * Resolves to whether anything was delivered. Callers ignore it; the tests do
 * not. It never throws: a count must never be able to break a launch or a dub.
 */
export async function countEvent(event, {
  mode, stateFile, url, os, version, errorCode,
  today = new Date().toISOString().slice(0, 10),
  timeoutMs, fetchImpl, log = console.log,
}) {
  // Before anything reads or writes disk: an install that reports nothing never
  // gets an id minted for it, and no file appears claiming otherwise.
  if (mode === "off") return false;

  const state = loadState(stateFile);
  if (!shouldReport({ event, lastDay: state.lastDay, today })) return false;

  const payload = buildPayload({ event, os, version, device: state.device, errorCode });

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
  [/ENOSPC|no space left/i,                          "disk-full"],
  [/EACCES|EPERM|permission denied/i,                "permission"],
  [/path is too long|too long to install/i,          "path-too-long"],
  [/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|download failed|sha256 mismatch/i, "network"],
  [/out of memory|ENOMEM|allocate/i,                 "out-of-memory"],
  [/unsupported|unrecognized codec|invalid data found/i, "unsupported-format"],
  [/did not become ready|exit \d+/i,                 "engine-crash"],
];

/** One published word for a whole error message. Never the message itself. */
export function classifyError(message) {
  if (typeof message !== "string" || message === "") return "unknown";
  for (const [pattern, code] of ERROR_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return "unknown";
}
