// The parts of the report relay that are only decisions: what a valid report
// is, what labels it earns, what the issue says, how a log link is signed and
// when a sender has had enough for one day.
//
// Split out of report-worker.js so all of it can be run under `node --test`
// (relay/report-logic.test.mjs) without a Cloudflare account. Nothing here
// touches KV, R2, GitHub or the clock -- every one of those arrives as an
// argument, which is what makes the rules testable.
//
// Web APIs only (crypto.subtle, TextEncoder, atob/btoa): the same code has to
// run inside a Worker, where node: modules do not exist.

export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
// How long a signed log link stays good for. The same 30 days the bucket's
// lifecycle rule deletes the object after, so a live link never points at a
// file that has already gone.
export const LOG_TTL_DAYS = 30;

// The published vocabularies, copied from the app deliberately and checked
// against it in the test: a label is public and permanent, so the relay
// refuses a word it has never heard rather than creating a label from
// whatever a request happened to contain.
export const KINDS = ["install", "dub", "erase", "agent", "unknown"];
export const ERROR_CODES = [
  "path-too-long", "disk-full", "network", "permission", "engine-start",
  "out-of-memory", "unsupported-format", "engine-crash", "step-failed",
  // The cloud service refused -- not the machine's fault, and worth its own
  // word so an outage cannot be read as a broken install. "cloud-refused" was
  // one word for all six until 0.6.0 and stays for as long as 0.5.4 and
  // earlier are still running.
  "cloud-refused", "perso-busy", "perso-credits", "perso-key", "perso-failed",
  "gemini-busy", "gemini-quota",
  "unknown",
];
export const PLATFORM_KEYS = ["mac", "win-gpu", "win-cpu"];

const ID_RE = /^[0-9a-f]{32}$/;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;
const VERSION_RE = /^[0-9][0-9a-z.-]{0,15}$/i;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

// --- masking, once more --------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;
const HOME_RE = /(\/(?:Users|home)\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/gi;

/**
 * The app masks before it sends (desktop/src/report.js). This masks again.
 *
 * Not because the app is untrusted -- because an OLD app is: a build from
 * before a rule existed keeps sending for as long as people run it, and the
 * issue it opens is public forever. The relay is the one place that can be
 * fixed for every version at once.
 */
export function maskAgain(text) {
  return String(text ?? "")
    .replace(URL_RE, (url) => {
      const m = /^(https?:\/\/)([^/?#]+)/i.exec(url);
      return m ? `${m[1]}${m[2]}/...` : "[URL]";
    })
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bhf_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(HOME_RE, "~")
    // Only outside a path, the same guard the app uses: the app deliberately
    // keeps the kit's own paths readable (which model, which venv), and a
    // blunt rule here would redact them again on the way past.
    .replace(/(?<![A-Za-z0-9_\-/\\.])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/\\.])/g, "[REDACTED]");
}

// --- what a report has to be ---------------------------------------------

function str(value, max) {
  return typeof value === "string" ? maskAgain(value).slice(0, max) : "";
}

function oneOf(value, list, fallback) {
  return list.includes(value) ? value : fallback;
}

function flatMap(value, maxKeys = 12) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, maxKeys)) {
    if (SAFE_ID_RE.test(k) && typeof v === "string" && SAFE_ID_RE.test(v)) out[k] = v;
  }
  return out;
}

/**
 * The report the relay will act on, rebuilt field by field from the request.
 *
 * Rebuilt, not checked and passed along: whatever else the body contained --
 * an extra key an old build sent, something a script tried on the endpoint --
 * simply has no way through, because nothing copies it. The app's own
 * allow-list already works this way; this is the same rule enforced again on
 * the far side of the network, where it cannot be bypassed by editing the app.
 */
export function validateReport(raw, { maxBytes = MAX_REPORT_BYTES } = {}) {
  if (typeof raw === "string") {
    if (raw.length > maxBytes) return { ok: false, reason: "too large" };
    try { raw = JSON.parse(raw); } catch { return { ok: false, reason: "not JSON" }; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };
  if (!FINGERPRINT_RE.test(raw.fingerprint || "")) return { ok: false, reason: "no fingerprint" };
  if (!VERSION_RE.test(raw.version || "")) return { ok: false, reason: "no version" };
  if (!ID_RE.test(raw.installId || "")) return { ok: false, reason: "no install id" };

  const env = (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) ? raw.env : {};
  const tails = (raw.logTails && typeof raw.logTails === "object") ? raw.logTails : {};
  const report = {
    kind: oneOf(raw.kind, KINDS, "unknown"),
    version: raw.version,
    installId: raw.installId,
    fingerprint: raw.fingerprint,
    step: SAFE_ID_RE.test(raw.step || "") ? raw.step : "",
    stage: SAFE_ID_RE.test(raw.stage || "") ? raw.stage : "",
    stageMarker: /^\d{1,2}\/\d{1,2}$/.test(raw.stageMarker || "") ? raw.stageMarker : "",
    code: oneOf(raw.code, ERROR_CODES, "unknown"),
    message: str(raw.message, 500),
    env: {
      platformKey: oneOf(env.platformKey, PLATFORM_KEYS, "unknown"),
      os: str(env.os, 60),
      arch: str(env.arch, 20),
      cpu: str(env.cpu, 80),
      cores: Number.isInteger(env.cores) ? env.cores : 0,
      ramGb: Number.isFinite(env.ramGb) ? env.ramGb : null,
      freeDiskGb: Number.isFinite(env.freeDiskGb) ? env.freeDiskGb : null,
      appVersion: str(env.appVersion, 20),
      kitVersion: str(env.kitVersion, 20),
      torch: str(env.torch, 20),
    },
    packs: flatMap(raw.packs),
    logTails: {
      shell: str(tails.shell, 20000),
      app: str(tails.app, 20000),
      job: str(tails.job, 20000),
    },
  };
  if (JSON.stringify(report).length > maxBytes) return { ok: false, reason: "too large" };
  return { ok: true, report };
}

/** "An" before erase, install, agent and unknown; "A" before dub. Three of
 *  the five kinds begin with a vowel, and the line read "A erase failed"
 *  (2026-09-10). */
function article(word) {
  return /^[aeiou]/i.test(String(word || "")) ? "An" : "A";
}

// --- labels, title, body, comment ----------------------------------------

/** The labels one report earns. Every one comes from a list above, so the set
 *  of labels this repository can ever grow is finite and known. */
export function labelsFor(report) {
  const out = [
    `kind:${report.kind}`,
    `env:${report.env.platformKey}`,
    `err:${report.code}`,
    `ver:${report.version}`,
  ];
  if (report.step) out.push(`step:${report.step}`);
  if (report.stage) out.push(`stage:${report.stage}`);
  return out;
}

/** Where it broke, in one phrase. */
export function whereFailed(report) {
  if (report.step) return report.step;
  return [report.stageMarker, report.stage].filter(Boolean).join(" ") || "unknown";
}

/** e.g. "[win-gpu] dub 4/6 synthesize: engine-crash (0.5.5)".
 *  Pinned equal to the app's own issueTitle by the test -- the app writes this
 *  title into the bundle it saves for a manual report, and two spellings of
 *  one failure would look like two failures. The kind leads it because a
 *  failure the app could not place used to leave "[mac] unknown: unknown". */
export function issueTitle(report) {
  const where = whereFailed(report);
  const what = where === "unknown" ? report.kind : `${report.kind} ${where}`;
  return `[${report.env.platformKey}] ${what}: ${report.code} (${report.version})`;
}

export function envLine(report) {
  return [report.env.platformKey, report.env.os, report.env.torch].filter(Boolean).join(" · ");
}

function details(title, body) {
  return body ? `<details><summary>${title}</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>\n` : "";
}

/** The issue a first sighting opens. */
export function issueBody(report, { logsUrl = "" } = {}) {
  const e = report.env;
  const packs = Object.entries(report.packs);
  const rows = [
    ["OS", `${e.os || "?"} (${e.arch || "?"})`],
    ["CPU", `${e.cpu || "?"} · ${e.cores || "?"} cores`],
    ["RAM", e.ramGb == null ? "?" : `${e.ramGb} GB`],
    ["Free disk", e.freeDiskGb == null ? "?" : `${e.freeDiskGb} GB`],
    ["App / kit", `${e.appVersion || "?"} / ${e.kitVersion || "?"}`],
    ["Torch", e.torch || "?"],
    ["Packs", packs.length ? packs.map(([id, s]) => `${id}=${s}`).join(", ") : "none"],
  ];
  return [
    `${article(report.kind)} ${report.kind} failed on PersoDub ${report.version}. Reported automatically by the app.`,
    "",
    "### Environment",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "### Where it failed",
    "",
    whereFailed(report),
    "",
    "### Error",
    "",
    "```",
    report.message || "(no message)",
    "```",
    "",
    details("shell.log (tail)", report.logTails.shell),
    details("persodub.log (tail)", report.logTails.app),
    details("job log (tail)", report.logTails.job),
    "",
    logsUrl ? `Full logs: ${logsUrl}` : "",
    `Fingerprint: \`${report.fingerprint}\``,
    "",
  ].join("\n");
}

// --- the tally -----------------------------------------------------------
// The hundredth machine to hit one bug should not add the hundredth comment.
// A reaction cannot say it either: reactions are one per account, and every
// report arrives as the same bot, so the thumb would read 1 forever. The
// count lives in the body instead, rewritten in place (user, 2026-09-10).

const TALLY_MARK = "<!-- tally -->";

/** "Seen 47 times · win-gpu · win 10, mac · mac 24 · 0.5.4, 0.5.5" */
export function tallyLine({ count = 0, envs = [], versions = [] } = {}) {
  const times = `Seen ${count} time${count === 1 ? "" : "s"}`;
  return [times, envs.join(", "), versions.join(", ")].filter(Boolean).join(" · ");
}

/** The body with its tally brought up to date -- the line replaced where it
 *  already stands, or added under the first paragraph where it does not.
 *  Everything else in the body is left exactly as it was. */
export function withTally(body, tally) {
  const text = String(body ?? "");
  const line = `${TALLY_MARK}\n${tallyLine(tally)}`;
  const at = text.indexOf(TALLY_MARK);
  if (at >= 0) {
    const rest = text.indexOf("\n", text.indexOf("\n", at) + 1);
    return text.slice(0, at) + line + (rest >= 0 ? text.slice(rest) : "\n");
  }
  const para = text.indexOf("\n\n");
  return para < 0 ? `${text}\n\n${line}\n`
    : `${text.slice(0, para)}\n\n${line}\n${text.slice(para)}`;
}

/** The tally after one more sighting. A machine already counted adds to the
 *  number and to nothing else, so the lists stay the set of what is affected
 *  rather than a log of who reported when. */
export function countSighting(seen, report) {
  const envs = [...((seen && seen.envs) || [])];
  const versions = [...((seen && seen.versions) || [])];
  const env = envLine(report);
  if (env && !envs.includes(env)) envs.push(env);
  if (report.version && !versions.includes(report.version)) versions.push(report.version);
  return { count: ((seen && seen.count) || 0) + 1, envs, versions };
}

/** What a second (and hundredth) sighting adds to the issue that exists. */
export function commentText(report, { logsUrl = "" } = {}) {
  const line = `+1 · ${envLine(report)} · ${report.version}`;
  return logsUrl ? `${line}\n\nFull logs: ${logsUrl}` : line;
}

/** One line appended to an existing body or comment when the logs land after
 *  it was written. Idempotent by the caller: it checks for the line first. */
export function withLogsLine(text, logsUrl) {
  return text.includes("Full logs:") ? text : `${text.trimEnd()}\n\nFull logs: ${logsUrl}\n`;
}

// --- rate limits ---------------------------------------------------------

/** "2026-09-09" in UTC -- the bucket every count below is kept in. */
export function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether this sender may open another report today.
 *
 * Three limits rather than one: an install id caps the machine that is failing
 * in a loop, the IP caps someone forging install ids, and the daily total caps
 * the day itself -- so the worst case is a bounded number of issues, whatever
 * anyone does with the endpoint. Over the line is not an error the user is
 * told about; the app keeps its copy either way.
 */
export function rateDecision({ installCount = 0, ipCount = 0, totalCount = 0 }, { perDay = 5, totalPerDay = 200 } = {}) {
  if (totalCount >= totalPerDay) return { ok: false, reason: "daily total" };
  if (installCount >= perDay) return { ok: false, reason: "per install" };
  if (ipCount >= perDay) return { ok: false, reason: "per address" };
  return { ok: true, reason: "" };
}

// --- ids, keys and signed links ------------------------------------------

/** A report id: what the log upload and the log link are addressed by. */
export function newId(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where one report's logs live in the bucket: "2026-09/<fingerprint>/<id>.tar.gz".
 *  By month first so a lifecycle rule (or a person) can see and drop a whole
 *  month, and by fingerprint under it so one bug's evidence sits together. */
export function logObjectKey({ fingerprint, id, now = Date.now() }) {
  return `${dayKey(now).slice(0, 7)}/${fingerprint}/${id}.tar.gz`;
}

function base64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

/** The signature on a log link. Over both the id and the expiry, so neither
 *  can be changed without the secret -- an expiry that could be edited would
 *  be no expiry at all. */
export async function signLog(id, exp, secret) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(`${id}.${exp}`));
  return base64url(mac);
}

/** Whether a link is this relay's, and still good. Compared in constant time
 *  by length-then-xor: a comparison that returns early leaks the signature one
 *  character at a time. */
export async function verifyLog(id, exp, sig, secret, now = Date.now()) {
  if (!ID_RE.test(String(id || ""))) return false;
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || expiry * 1000 < now) return false;
  const expected = await signLog(id, expiry, secret);
  const a = String(sig || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The link that goes in the issue: this Worker's own, not the bucket's. */
export function logUrl(base, id, exp, sig) {
  return `${String(base).replace(/\/+$/, "")}/logs/${id}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

/** When a link signed now should stop working. */
export function logExpiry(now = Date.now(), days = LOG_TTL_DAYS) {
  return Math.floor((now + days * 24 * 60 * 60 * 1000) / 1000);
}
