import { createHash } from "node:crypto";
import { arch as osArch, cpus, platform as osPlatform, release, totalmem } from "node:os";
import { ERROR_CODES, INSTALL_STEPS } from "./analytics.js";

// Automatic failure reports. A usage count (analytics.js) says a dub failed;
// this says WHY -- the machine, the step, the error, and the tail of the three
// logs -- so a crash on someone else's computer arrives as a GitHub issue
// instead of as "it didn't work".
//
// Same shape of file as analytics.js, and for the same reason: every decision
// about what may leave is a pure function here, main.js is only the wiring.
// The rule it inherits is the important one -- buildReport below is an
// ALLOW-LIST. A field nobody named cannot travel, however it arrives.
//
// The switch is PERSODUB_NO_REPORTS=1 in kit.env (Settings writes it, the
// shell re-reads it before every report), and it is separate from the usage
// counts' switch: turning one off leaves the other alone.

export const REPORT_KINDS = new Set(["install", "dub", "erase", "agent"]);

// One report, whole, must fit in a GitHub issue body with room to spare.
// Everything above this is cut out of the log tails (trimToSize below).
export const MAX_BYTES = 64 * 1024;
// A log tail is the end of the story, never the whole of it.
export const MAX_LOG_LINES = 200;
// The error sentence. Longer than this is a transcript, and the tails are
// where a transcript belongs.
export const MAX_MESSAGE_CHARS = 500;

/**
 * Should this run send reports?
 *  - "off":   never. A from-source run is always off (a developer's own
 *             failures are not news), and a packaged build is silenced by
 *             PERSODUB_NO_REPORTS=1 -- the Settings switch writes it.
 *  - "debug": print the bundle instead of sending it, so anyone can see
 *             exactly what would leave. PERSODUB_REPORTS_DEBUG=1.
 *  - "on":    send.
 * An off switch beats debug, the same way it does for the counts.
 */
export function resolveReportMode({ isPackaged, env }) {
  if (!isPackaged) return "off";
  if ((env.PERSODUB_NO_REPORTS || "") === "1") return "off";
  if ((env.PERSODUB_REPORTS_DEBUG || "") === "1") return "debug";
  return "on";
}

// --- Masking -----------------------------------------------------------

// Two shapes of key that a log or an error message really does carry, plus the
// catch-all: a long unbroken run of letters and digits is a token, a hash or a
// session id, and none of the three is worth the risk of publishing.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // OpenAI-style
  /\bAIza[A-Za-z0-9_-]{10,}/g,        // Google API keys
  /\b[A-Za-z0-9]{32,}\b/g,            // anything else long enough to be a secret
];

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Everything a report or a log tail passes through before it leaves.
 *
 * Four rules, in this order because each depends on the one before:
 *  1. A URL becomes its own scheme and host. A download link can carry a
 *     signed token, and a YouTube link is the user's viewing history.
 *  2. The two key shapes above go, while their surroundings are still intact.
 *  3. The home directory becomes "~". A path is where the user's real name
 *     lives -- /Users/<name>/, C:\Users\<name>\ -- and it appears in almost
 *     every traceback.
 *  4. What is left that is 32+ letters and digits is redacted.
 * Rule 4 runs last on purpose: before rule 3 it would have eaten the home
 * path's own segments and left a report nobody could read.
 */
export function maskText(text, { home = "" } = {}) {
  let out = String(text ?? "");
  out = out.replace(URL_PATTERN, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/...`;
    } catch {
      return "[URL]";
    }
  });
  for (const p of KEY_PATTERNS.slice(0, 2)) out = out.replace(p, "[REDACTED]");
  if (home) {
    // Both separators, because a Windows log prints the home directory each
    // way depending on which library wrote the line, and case-insensitively,
    // because Windows paths are.
    const both = [home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")];
    for (const form of [...new Set(both)]) {
      out = out.replace(new RegExp(escapeRegExp(form), "gi"), "~");
    }
  }
  out = out.replace(KEY_PATTERNS[2], "[REDACTED]");
  return out;
}

/** The last MAX_LOG_LINES lines of a log, masked. Empty in, empty out. */
export function maskTail(text, { home = "", maxLines = MAX_LOG_LINES } = {}) {
  const body = String(text ?? "");
  if (!body.trim()) return "";
  const lines = body.split(/\r?\n/);
  return maskText(lines.slice(-maxLines).join("\n"), { home }).trim();
}

// --- Fingerprint -------------------------------------------------------

/**
 * The error line with everything machine-specific taken out: paths, numbers,
 * case. What is left is the shape of the failure, which is what makes two
 * users' crashes the same crash.
 */
export function normalizeLine(line) {
  return String(line ?? "")
    .replace(/[A-Za-z]:\\[^\s"']*/g, " ")        // C:\Users\...\thing
    .replace(/(?:\/[^\s"':/]+)+\/?/g, " ")       // /Users/.../thing
    .replace(/\d+/g, "")                          // ports, sizes, line numbers, times
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Twelve hex characters that name one failure. Two machines that broke the
 * same way produce the same twelve, which is what lets the relay put a hundred
 * users on one issue instead of opening a hundred issues.
 */
export function fingerprint({ platformKey = "", step = "", code = "", lastLine = "" } = {}) {
  const parts = [platformKey, step, code, normalizeLine(lastLine)].join("\n");
  return createHash("sha256").update(parts).digest("hex").slice(0, 12);
}

// --- The environment ---------------------------------------------------

/** What node knows about this machine. Separated so collectEnvironment stays
 *  a pure function the tests can hand any machine they like. */
export function systemFacts() {
  const list = cpus() || [];
  return {
    platform: osPlatform(),
    release: release(),
    arch: osArch(),
    cpuModel: (list[0] && list[0].model) || "",
    cores: list.length,
    totalMemBytes: totalmem(),
  };
}

const GB = 1024 * 1024 * 1024;
function gb(bytes) {
  return typeof bytes === "number" && bytes >= 0 ? Math.round(bytes / GB) : null;
}

/**
 * The machine, in the words the rest of the app already uses.
 *
 * platformKey is the same three-way answer app/models.py's platform_key gives
 * ("mac", "win-gpu", "win-cpu"), derived the same way from the torch variant,
 * because it is what the pack sizes, the labels and the issue title are all
 * keyed on -- one machine must not be two names.
 */
export function collectEnvironment({
  appVersion = "",
  kitVersion = "",
  torchVariant = "",
  packs = {},
  freeDiskBytes = null,
  sys = systemFacts(),
} = {}) {
  const isWin = String(sys.platform || "").startsWith("win");
  return {
    platformKey: isWin ? (torchVariant === "cpu" ? "win-cpu" : "win-gpu") : "mac",
    os: `${isWin ? "windows" : sys.platform === "darwin" ? "mac" : sys.platform} ${sys.release || ""}`.trim(),
    arch: sys.arch || "",
    cpu: sys.cpuModel || "",
    cores: sys.cores || 0,
    ramGb: gb(sys.totalMemBytes),
    freeDiskGb: gb(freeDiskBytes),
    appVersion,
    kitVersion,
    torch: torchVariant,
    packs,
  };
}

// --- The bundle --------------------------------------------------------

// A stage or a step id is a label on a public issue, so it is held to the
// shape ids in this app have rather than passed through.
function safeId(value) {
  const s = String(value ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,29}$/.test(s) ? s : "";
}

/**
 * The whole message, and the only thing that can become one.
 *
 * Every field is named here. That is the point: a caller that grows a new
 * property -- a filename, a URL, a whole job record -- cannot make it travel
 * by accident, because nothing reads the caller's object except this list.
 *
 * `packs` is lifted out of env rather than repeated: collectEnvironment
 * gathers it with the rest of the machine, and the report carries it once, at
 * the top, where the labels and the issue table both look for it.
 */
export function buildReport({
  kind,
  env = {},
  step,
  stage,
  stageMarker = "",
  code,
  message = "",
  packs,
  logTails = {},
  version = "",
  installId = "",
  home = "",
} = {}, { maxBytes = MAX_BYTES } = {}) {
  const { packs: envPacks, ...machine } = env;
  const isInstall = kind === "install";
  const report = {
    kind: REPORT_KINDS.has(kind) ? kind : "unknown",
    version: String(version || ""),
    installId: String(installId || ""),
    // Install failures name a step out of installSpec's twelve; everything
    // else names a stage out of app/stages.py. Both are held to the published
    // shape for the same reason error codes are (analytics.js).
    step: isInstall ? (INSTALL_STEPS.has(step) ? step : "") : "",
    stage: isInstall ? "" : safeId(stage),
    stageMarker: /^\d{1,2}\/\d{1,2}$/.test(String(stageMarker || "")) ? String(stageMarker) : "",
    code: ERROR_CODES.has(code) ? code : "unknown",
    message: maskText(message, { home }).slice(0, MAX_MESSAGE_CHARS),
    env: machine,
    packs: packs ?? envPacks ?? {},
    logTails: {
      shell: maskTail(logTails.shell, { home }),
      app: maskTail(logTails.app, { home }),
      job: maskTail(logTails.job, { home }),
    },
  };
  report.fingerprint = fingerprint({
    platformKey: machine.platformKey || "",
    step: report.step || report.stage,
    code: report.code,
    lastLine: report.message,
  });
  return trimToSize(report, maxBytes);
}

/** Serialized size in bytes -- what the relay's limit is measured in. */
export function reportBytes(report) {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * Cut the report down to the size limit, taking it out of the log tails --
 * the longest one first, oldest lines first, since the end of a log is the
 * part that says what happened. The message is only touched when dropping
 * every log line was not enough, which no real report has managed.
 */
export function trimToSize(report, maxBytes = MAX_BYTES) {
  const tails = report.logTails;
  while (reportBytes(report) > maxBytes) {
    const longest = ["job", "shell", "app"]
      .map((k) => [k, (tails[k] ? tails[k].split("\n") : [])])
      .filter(([, lines]) => lines.length > 0)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!longest) break;
    const [key, lines] = longest;
    tails[key] = lines.slice(Math.max(1, Math.ceil(lines.length * 0.2))).join("\n");
  }
  if (reportBytes(report) > maxBytes) {
    report.message = report.message.slice(0, 200);
  }
  return report;
}

// --- How it reads as an issue ------------------------------------------

/** Where the failure happened, in one phrase: "4/6 synthesize", "venv-engines". */
export function whereFailed(report) {
  if (report.step) return report.step;
  return [report.stageMarker, report.stage].filter(Boolean).join(" ") || "unknown";
}

/** e.g. "[win-gpu] 4/6 synthesize: engine-crash (0.5.5)" */
export function issueTitle(report) {
  const key = (report.env && report.env.platformKey) || "unknown";
  return `[${key}] ${whereFailed(report)}: ${report.code} (${report.version || "?"})`;
}

/** The one-line summary the relay repeats on a duplicate: "win-gpu · windows 10.0.26100 · cu128". */
export function envLine(report) {
  const e = report.env || {};
  return [e.platformKey, e.os, e.torch].filter(Boolean).join(" \u00b7 ");
}

function packLine(packs) {
  const entries = Object.entries(packs || {});
  return entries.length ? entries.map(([id, state]) => `${id}=${state}`).join(", ") : "none";
}

function details(title, body) {
  if (!body) return "";
  return `<details><summary>${title}</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>\n`;
}

/** The issue body: what broke, on what machine, with the ends of the logs. */
export function issueBody(report) {
  const e = report.env || {};
  const rows = [
    ["OS", `${e.os || "?"} (${e.arch || "?"})`],
    ["CPU", `${e.cpu || "?"} \u00b7 ${e.cores || "?"} cores`],
    ["RAM", e.ramGb == null ? "?" : `${e.ramGb} GB`],
    ["Free disk", e.freeDiskGb == null ? "?" : `${e.freeDiskGb} GB`],
    ["App / kit", `${e.appVersion || "?"} / ${e.kitVersion || "?"}`],
    ["Torch", e.torch || "?"],
    ["Packs", packLine(report.packs)],
  ];
  return [
    `A ${report.kind} failed on PersoDub ${report.version || "?"}.`,
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
    `Fingerprint: \`${report.fingerprint}\` \u00b7 sent automatically by PersoDub.`,
    "",
  ].join("\n");
}
