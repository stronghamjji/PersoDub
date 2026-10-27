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
// How long an archive lives, set on the bucket itself by the expire-30d
// lifecycle rule. Nothing in this file counts the days any more; the note is
// here because the KV entry that remembers the object outlives it on purpose.
export const LOG_TTL_DAYS = 30;

// The published vocabularies, copied from the app deliberately and checked
// against it in the test: a label is public and permanent, so the relay
// refuses a word it has never heard rather than creating a label from
// whatever a request happened to contain.
export const KINDS = ["install", "dub", "erase", "agent", "unknown"];
export const ERROR_CODES = [
  "path-too-long", "disk-full", "network", "permission", "engine-start",
  // "timeout" arrived in 0.6.1: a stage that ran out of its allowance, which
  // until then was a crash with no word of its own.
  "out-of-memory", "timeout", "unsupported-format", "engine-crash", "step-failed",
  // The cloud service refused -- not the machine's fault, and worth its own
  // word so an outage cannot be read as a broken install. "cloud-refused" was
  // one word for all six until 0.6.0 and stays for as long as 0.5.4 and
  // earlier are still running.
  "cloud-refused", "perso-busy", "perso-credits", "perso-key", "perso-failed",
  // A video longer than the Perso plan allows (F4008; the free plan stops at
  // one minute). The user's plan, not our code (2026-10-19).
  "perso-length",
  // A voice model the Perso plan does not cover (VT40314; FINCH and NIGHTINGALE
  // need Pro). The user's plan, not our code (2026-10-19).
  "perso-plan",
  "gemini-busy", "gemini-quota",
  // Four families that were all "unknown" until 0.6.1.
  "model-download", "engine-500", "perso-bad-request", "translate-parse",
  // The app was closed while the job was still running, its own word so it
  // reads apart from a real crash (2026-09-18).
  "interrupted",
  // A certificate the computer's Python refused (2026-10-15).
  "certificate",
  "unknown",
];
// A finished job's record (POST /record, 0.8.8): the three kinds of job, and
// how long one took, by the names the app sends it under (its usage counts'
// own, desktop/src/analytics.js timingSeconds) -> the short ones the private
// dashboard reads off the stored archive (logSummary). Checked against the
// app in the test.
export const RECORD_KINDS = ["dub", "erase", "separate"];
export const TIMING_KEYS = {
  elapsed_seconds: "elapsed", sep_seconds: "sep", stt_seconds: "stt", translate_seconds: "translate", voice_seconds: "voice",
};
export const PLATFORM_KEYS = ["mac", "win-gpu", "win-cpu"];
export const EDITIONS = ["opensource", "production"];

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
// A Windows path inside a Python error is written with every backslash
// doubled (repr does that), and a doubled path matched none of the masks:
// four issues went up with a user's account name in C:\\Users\\<name>\\...
// (2026-09-15). Halved before anything looks at it.
const DOUBLED_SEP = /\\\\/g;
// The Perso workspace is the user's account, named in the job log by the
// stage that spends its credits. The backend masks it in the log tails; the
// message took another road and arrived with the name on it (#41).
// Name and number both (user decision, 2026-09-15): the number names one
// account as surely as the name does.
const WORKSPACE_RE = /(Perso workspace: )[^\n]*?\(#\d+\)/g;
// workspace/<day>/<project>: the project folder is named after the video,
// and the kit's paths are otherwise kept readable. The app's shell masks it
// from 0.6.1; this covers the 0.6.0 builds.
const WS_HEAD = "(workspace[\\\\/]\\d{4}-\\d{2}-\\d{2}[\\\\/])";
const WORKSPACE_PROJECT = [
  new RegExp(WS_HEAD + "[^\\\\/\\n]+?(?=[\\\\/])", "g"),
  new RegExp(WS_HEAD + "[^\\\\/\\s\"']+", "g"),
];

export function maskAgain(text) {
  let out = String(text ?? "")
    .replace(DOUBLED_SEP, "\\")
    .replace(WORKSPACE_RE, "$1*");
  for (const re of WORKSPACE_PROJECT) out = out.replace(re, "$1*");
  return out
    .replace(URL_RE, (url) => {
      const m = /^(https?:\/\/)([^/?#]+)/i.exec(url);
      return m ? `${m[1]}${m[2]}/...` : "[URL]";
    })
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bhf_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    // A report's device field inside a log tail, where the app's debug print
    // of a report leaves it: that field is for the private dashboard only.
    .replace(/("device":")[0-9a-f]{12}"/g, '$1[REDACTED]"')
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

// A log tail cut to fit keeps its end, which is the part that says what
// happened: cut from the start, a long tail lost its failure lines. A job
// log's opening lines, which the app keeps above a "...", go first.
function tailStr(value, max) {
  return typeof value === "string" ? maskAgain(value).slice(-max) : "";
}

// The app's error text is the tail of a job log, and a job log opens with
// the video's own name: a title, a link, a file name. A job that died in its
// first stages has that line at the top of the tail, and twelve issues went
// up with a user's video title in them (2026-09-15). 0.6.1 stops sending it;
// this is for every 0.6.0 still out there. Only the first line, only on a
// job's report: an install's message is one bare sentence and is the error.
// A line the app writes is a stage marker ("1/6 ..."), an indented detail,
// or one of a few bare words; a first line shaped like none of those is the
// name.
const KEPT_BARE = /^(?:\d{1,2}\/\d{1,2}\s|\s|\w*Error:|Done!|interrupted|Cancel|Perso |Warning:)/;
export function scrubMessage(text, kind) {
  const lines = String(text ?? "").split("\n");
  if ((kind === "dub" || kind === "erase") && lines.length && lines[0] !== "" && !KEPT_BARE.test(lines[0])) {
    lines.shift();
  }
  return lines.join("\n").trim();
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
// What the app's probes found (desktop/src/diagnostics.js), rebuilt here the
// way the rest of the report is: only the published probe names, keys that
// are a word or a host name, short strings, lists of ten at most, numbers
// and yes-or-no answers. Three levels deep, which is as deep as a probe goes.
export const PROBE_NAMES = ["network", "proxy", "antivirus", "kitWritable", "vcRuntime", "gpu", "memory"];
const DIAG_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;
function diagnostic(value, depth) {
  if (typeof value === "string") return scrubMessage(value.slice(0, 200), "unknown");
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => diagnostic(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => DIAG_KEY_RE.test(k))
      .map(([k, v]) => [k, diagnostic(v, depth + 1)]));
  }
  return null;
}
function diagnosticsOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(PROBE_NAMES.filter((n) => Object.hasOwn(raw, n)).map((n) => [n, diagnostic(raw[n], 1)]));
}

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
    // The first twelve characters of the app's usage id (0.8.7), sent while
    // its counts were on and, from 0.8.8, with every report and record.
    // logSummary carries it to the private dashboard; the issue, its title,
    // labels and tally never read it.
    device: typeof raw.device === "string" && /^[0-9a-f]{12}$/.test(raw.device) ? raw.device : "",
    fingerprint: raw.fingerprint,
    step: SAFE_ID_RE.test(raw.step || "") ? raw.step : "",
    stage: SAFE_ID_RE.test(raw.stage || "") ? raw.stage : "",
    stageMarker: /^\d{1,2}\/\d{1,2}$/.test(raw.stageMarker || "") ? raw.stageMarker : "",
    code: oneOf(raw.code, ERROR_CODES, "unknown"),
    message: scrubMessage(str(raw.message, 500), oneOf(raw.kind, KINDS, "unknown")),
    env: {
      platformKey: oneOf(env.platformKey, PLATFORM_KEYS, "unknown"),
      os: str(env.os, 60),
      // One line a person can read (desktop/src/report.js describeDevice); a table cell, so no | or line break.
      device: str(env.device, 200).replace(/[|\r\n]/g, " "),
      arch: str(env.arch, 20),
      cpu: str(env.cpu, 80),
      cores: Number.isInteger(env.cores) ? env.cores : 0,
      ramGb: Number.isFinite(env.ramGb) ? env.ramGb : null,
      freeDiskGb: Number.isFinite(env.freeDiskGb) ? env.freeDiskGb : null,
      appVersion: str(env.appVersion, 20),
      kitVersion: str(env.kitVersion, 20),
      torch: str(env.torch, 20),
      // The edition the kit runs as (desktop/src/edition.js), one of the two.
      edition: oneOf(env.edition, EDITIONS, ""),
    },
    packs: flatMap(raw.packs),
    // The user's own situation (desktop/src/report.js USER_SIDE_CODES): kept
    // for the dashboard, never an issue (report-worker.js handleReport).
    ...(raw.userSide === true ? { userSide: true } : {}),
    diagnostics: diagnosticsOf(raw.diagnostics),
    logTails: {
      shell: tailStr(tails.shell, 20000),
      app: tailStr(tails.app, 20000),
      job: tailStr(tails.job, 20000),
      // The engines' own console logs (desktop/src/reporting.js).
      backend: tailStr(tails.backend, 20000),
      sidecar: tailStr(tails.sidecar, 20000),
      ollama: tailStr(tails.ollama, 20000),
    },
  };
  if (JSON.stringify(report).length > maxBytes) return { ok: false, reason: "too large" };
  return { ok: true, report };
}

/**
 * A finished job's record (desktop/src/report.js, code "ok"), rebuilt the way
 * a report is and then held to what a record says: one of the three kinds of
 * job, the stage "done", the code "ok", and how long it took, whole seconds
 * under the names in TIMING_KEYS and nothing else. It never becomes an issue
 * (report-worker.js handleRecord).
 */
export function validateRecord(raw, opts = {}) {
  const checked = validateReport(raw, opts);
  if (!checked.ok) return checked;
  const given = typeof raw === "string" ? JSON.parse(raw) : raw;
  const timing = given.timing && typeof given.timing === "object" ? given.timing : {};
  return {
    ok: true,
    record: {
      ...checked.report,
      kind: oneOf(given.kind, RECORD_KINDS, "unknown"),
      stage: "done",
      code: "ok",
      timing: Object.fromEntries(Object.keys(TIMING_KEYS).filter((f) => Number.isInteger(timing[f]) && timing[f] >= 0)
        .map((f) => [f, timing[f]])),
    },
  };
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

/** What the private dashboard shows beside an archive, so a list of them can
 *  be read without opening any. Written when the report arrives (which is the
 *  only time these facts are in hand) and copied onto the stored object. Short
 *  strings only: this rides along as R2 metadata, which is capped.
 *  `priorState` is the state GitHub gave the issue a repeat was counted on
 *  ("open" or "closed"; empty for a new issue), and `reopened` whether this
 *  report reopened it (report-worker.js: only one closed as fixed).
 *  `userSide` is "true" for a failure that is the user's own situation, which
 *  has no issue (validateReport).
 *  `outcome` is "failed" for a failure and "ok" for a finished job's record
 *  (validateRecord, code "ok"), which also carries how long the job took:
 *  whole seconds under the short names in TIMING_KEYS, empty for a step that
 *  did not run (the dashboard's contract, 2026-10-22). */
export function logSummary(report, issue, { priorState = "", reopened = false } = {}) {
  const ok = report.code === "ok";
  return {
    issue: String(issue ?? ""),
    kind: report.kind || "unknown",
    stage: report.stage || report.step || "",
    marker: report.stageMarker || "",
    code: report.code || "unknown",
    platform: report.env.platformKey || "",
    os: report.env.os || "",
    cpu: String(report.env.cpu || "").slice(0, 60),
    ram: report.env.ramGb == null ? "" : String(report.env.ramGb),
    disk: report.env.freeDiskGb == null ? "" : String(report.env.freeDiskGb),
    version: report.version || "",
    device: report.device || "",
    priorState: String(priorState || ""),
    reopened: reopened ? "true" : "",
    outcome: ok ? "ok" : "failed",
    userSide: report.userSide ? "true" : "",
    ...(ok ? Object.fromEntries(Object.entries(TIMING_KEYS)
      .map(([field, key]) => [key, report.timing[field] == null ? "" : String(report.timing[field])])) : {}),
  };
}

// --- the summary ---------------------------------------------------------
// The few facts an issue is opened for, above everything else: where the run
// stopped, after how long, the error, what the run was given, how memory
// stood and what the probes found. Read off the masked log tails the app
// sends, whose structured lines (desktop/src/logLine.js, app/jobs.py) read
// "2026-10-15 22:31:05,494 - job-ab12cd34 - INFO - [Step 3/6] translate START".
// A tail from an older build has none of them, and its summary is the error.

// A tail's lines without their time, source and level. The head is matched
// whole rather than cut at the last " - ", which a message can contain; a
// line with no head (an older build's) is all message.
const LINE_HEAD = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - \S+ - [A-Z]+ - /;
export function tailMessages(text) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.replace(LINE_HEAD, "").trim()).filter(Boolean);
}

// "3/6 translate": where the run stopped -- the last step that started and
// neither finished nor was cancelled, or that FAILED. Past a "..." line (the
// app keeps a job log's first lines above one) the end of an earlier step may
// be among the lines left out, so a step open before it counts for nothing.
const STEP_LINE = /\[Step (\d+\/\d+)\] (\S+) (START|DONE|CANCELLED|FAILED)\b/;
export function openStep(messages) {
  let open = "";
  for (const m of messages) {
    if (m === "...") { open = ""; continue; }
    const hit = STEP_LINE.exec(m);
    if (!hit) continue;
    const step = `${hit[1]} ${hit[2]}`;
    if (hit[3] === "START" || hit[3] === "FAILED") open = step;
    else if (step === open) open = "";
  }
  return open;
}

// The seconds a failure took ("12.3"): the failed step's or engine's own
// FAILED line, else the whole run's JOB FAILED or INSTALL FAILED line.
export function failedAfter(messages) {
  const last = (re) => messages.map((m) => re.exec(m)).filter(Boolean).at(-1)?.[1] ?? "";
  return last(/FAILED \((\d+(?:\.\d+)?)s\)/) || last(/^(?:JOB|INSTALL) FAILED\b.*?\((\d+(?:\.\d+)?)s\)/);
}

// The last line that begins with `start` ("Inputs: ", "Mem["), whole.
export function lastStarting(messages, start) {
  return messages.filter((m) => m.startsWith(start)).at(-1) ?? "";
}

// What a job's log says under its failure (app/jobs.py): the error the failure
// was chained from, "Caused by: ValueError: y", and the stopped step's own
// Context line, "[Step 3/6] translate Context: translate_engine=gemma lines=12".
export function lastCause(messages) {
  return lastStarting(messages, "Caused by: ").slice("Caused by: ".length);
}
export function stepContext(messages, step) {
  const hit = /^(\d+\/\d+) (\S+)$/.exec(step || "");
  if (!hit) return "";
  const start = `[Step ${hit[1]}] ${hit[2]} Context: `;
  return lastStarting(messages, start).slice(start.length);
}

// The line of a message that names the error, else its first: a dub's message
// is the tail of its log, which opens with a stage line, not the error.
const ERROR_LINE = /^ERROR\b|[A-Za-z]+Error\b|\bError:/;

// A value set as code, so nothing a log line carries can turn into markup.
function inline(text) {
  return `\`${String(text).replaceAll("`", "'")}\``;
}

/** The Summary's bullets, each only when there is something to say. A job's
 *  report reads its own log; an install's, and an engine that did not start
 *  (reported as one), the shell's. Never the other's: an install's Inputs line
 *  is not a dub's. */
export function summaryLines(report) {
  const shellRun = report.kind === "install" || report.code === "engine-start";
  const jobTail = tailMessages(report.logTails.job);
  const tail = shellRun ? tailMessages(report.logTails.shell) : jobTail;
  const where = openStep(tail) || (whereFailed(report) === "unknown" ? "" : whereFailed(report));
  const after = failedAfter(tail);
  const inputs = lastStarting(tail, "Inputs: ").slice("Inputs: ".length);
  const memory = lastStarting(tail, "Mem[");
  // A job's own words about its failure; an install has no job log to say them.
  const cause = lastCause(jobTail);
  const context = stepContext(jobTail, where);
  const lines = String(report.message || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const error = lines.filter((l) => ERROR_LINE.test(l)).at(-1) || lines[0] || "";
  const diagnostics = Object.keys(report.diagnostics || {}).length ? JSON.stringify(report.diagnostics) : "";
  return [
    where && `- Stopped at: ${inline(where)}`,
    after && `- After: ${after}s`,
    `- Error: ${report.code}${error ? ` · ${inline(error)}` : ""}`,
    cause && `- Cause: ${inline(cause)}`,
    inputs && `- Inputs: ${inline(inputs)}`,
    context && `- Context: ${inline(context)}`,
    memory && `- Memory: ${inline(memory)}`,
    diagnostics && `- Diagnostics: ${inline(diagnostics)}`,
  ].filter(Boolean);
}

// GitHub refuses an issue body over 65,536 characters, and a report it
// refuses is never posted. Six tails can add up to that, so issueBody holds
// the body under this, leaving room for the tally line that grows into it.
export const MAX_BODY_CHARS = 60000;

/** The issue a first sighting opens. */
export function issueBody(report, { logsRef = "" } = {}) {
  const e = report.env;
  const packs = Object.entries(report.packs);
  const rows = [
    ...(e.device ? [["Device", e.device]] : []),
    ["OS", `${e.os || "?"} (${e.arch || "?"})`],
    ["CPU", `${e.cpu || "?"} · ${e.cores || "?"} cores`],
    ["RAM", e.ramGb == null ? "?" : `${e.ramGb} GB`],
    ["Free disk", e.freeDiskGb == null ? "?" : `${e.freeDiskGb} GB`],
    ["App / kit", `${e.appVersion || "?"} / ${e.kitVersion || "?"}`],
    ["Edition", e.edition || "?"],
    ["Torch", e.torch || "?"],
    ["Packs", packs.length ? packs.map(([id, s]) => `${id}=${s}`).join(", ") : "none"],
  ];
  const top = [
    `${article(report.kind)} ${report.kind} failed on PersoDub ${report.version}. Reported automatically by the app.`,
    "",
    "### Summary",
    "",
    ...summaryLines(report),
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
    ...(Object.keys(report.diagnostics || {}).length
      ? ["### Diagnostics", "", "```json", JSON.stringify(report.diagnostics, null, 2), "```", ""]
      : []),
  ];
  const bottom = [
    "",
    logsRef ? logsLine(logsRef) : "",
    `Fingerprint: \`${report.fingerprint}\``,
    "",
  ];
  const tails = [
    ["shell.log (tail)", report.logTails.shell],
    ["persodub.log (tail)", report.logTails.app],
    ["job log (tail)", report.logTails.job],
    ["backend.log (tail)", report.logTails.backend],
    ["sidecar.log (tail)", report.logTails.sidecar],
    ["ollama.log (tail)", report.logTails.ollama],
  ].map(([title, text]) => [title, String(text || "")]);
  const body = () => [...top, ...tails.map(([title, text]) => details(title, text)), ...bottom].join("\n");
  // Over the limit, the longest tail loses a fifth of its lines, oldest first,
  // until the body fits; everything above and below the tails is kept whole.
  let out = body();
  while (out.length > MAX_BODY_CHARS) {
    const longest = tails.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    if (!longest[1]) break;
    const lines = longest[1].split("\n");
    longest[1] = lines.slice(Math.max(1, Math.ceil(lines.length * 0.2))).join("\n");
    out = body();
  }
  return out;
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
export function commentText(report, { logsRef = "" } = {}) {
  const line = `+1 · ${envLine(report)} · ${report.version}`;
  return logsRef ? `${line}\n\n${logsLine(logsRef)}` : line;
}

/** The one comment a sighting on a closed issue adds, reopened or not
 *  (report-worker.js decides):
 *  "Seen again on 0.7.0, windows 10.0.26100, after the issue was closed."
 *  The version and the system and nothing else: the device number belongs to
 *  the private dashboard (2026-10-21). The system is kept to the characters a
 *  system's name has, because it comes from the request and a new comment
 *  that says "@someone" notifies them. */
export function seenAgainText(report) {
  const os = String(report.env.os || "").replace(/[^\w .()-]/g, "").trim();
  return `Seen again on ${[report.version, os].filter(Boolean).join(", ")}, after the issue was closed.`;
}

/** The issue is public, so it never carries a link to the archive: a signed
 *  URL written here would let anybody who reads the issue download somebody
 *  else's logs for as long as the signature lasts. It names the archive
 *  instead, and the operator fetches it from the private dashboard, which is
 *  already behind a password (2026-09-16). */
export function logsLine(logsRef) {
  return `Full logs: kept, id \`${logsRef}\``;
}

/** One line appended to an existing body or comment when the logs land after
 *  it was written. Idempotent by the caller: it checks for the line first. */
export function withLogsLine(text, logsRef) {
  return text.includes("Full logs:") ? text : `${text.trimEnd()}\n\n${logsLine(logsRef)}\n`;
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
 *  month, and by fingerprint under it so one bug's evidence sits together. A
 *  finished job's record has "ok" in the fingerprint's place (report-worker.js). */
export function logObjectKey({ fingerprint, id, now = Date.now() }) {
  return `${dayKey(now).slice(0, 7)}/${fingerprint}/${id}.tar.gz`;
}

// A signed download link used to live here, and the relay put it in the issue.
// The issue is public, so that link handed every reader a stranger's logs for
// as long as the signature lasted. Nothing signs or serves an archive now: the
// logs leave the bucket only through the private dashboard (2026-09-16).
