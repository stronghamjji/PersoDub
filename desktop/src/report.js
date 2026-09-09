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

// The four key shapes a log or an error message really does carry, plus the
// catch-all: a long unbroken run of token characters is a key, a hash or a
// session id, and none of them is worth the risk of publishing.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // OpenAI-style
  /\bAIza[A-Za-z0-9_-]{10,}/g,        // Google API keys
  /\bghp_[A-Za-z0-9_-]{8,}/g,         // GitHub personal access tokens
  /\bhf_[A-Za-z0-9_-]{8,}/g,          // Hugging Face tokens
];

// Anything else long enough to be a secret -- but only OUTSIDE a path. The
// guards on either side are the path characters: a run touching a slash, a
// backslash or a dot is part of a filename or a directory, and redacting those
// used to swallow whole model folders and leave a report nobody could read.
const LONG_TOKEN = /(?<![A-Za-z0-9_\-/\\.])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/\\.])/g;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The same path written the three ways a log can spell it. Windows libraries
// disagree with each other about the separator inside one process.
function separatorForms(p) {
  return [p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")];
}

function startsWithCI(text, prefix) {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * What is left of a path once its home half is gone: the folders and the file
 * name under a home directory are the user's own business -- a project name, a
 * client's name, what they were watching -- so only the extension survives.
 */
// A file name with spaces in it survives the collapse above, because a path
// stops at whitespace -- and it has to, or "could not open /Users/x/kit
// because the disk is full" would swallow the sentence. What gives such a
// name away is that it ends in an extension, so this second pass folds
// "~/... Q3 board review.mp4" into "~/.../*.mp4" and leaves prose alone.
const SPACED_FILENAME = /(~[\\/]\u2026)((?: [^\s\\/"']+)*\.[A-Za-z0-9]{1,8})(?=[\s"']|$)/g;

function collapseUnderHome(rest) {
  if (!rest) return "~";
  const sep = rest[0];
  const segments = rest.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1] || "";
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 && /^[A-Za-z0-9]{1,8}$/.test(last.slice(dot + 1)) ? last.slice(dot) : "";
  return ext ? `~${sep}\u2026${sep}*${ext}` : `~${sep}\u2026`;
}

/**
 * Everything a report or a log tail passes through before it leaves.
 *
 * Five rules, in this order because each depends on the one before:
 *  1. A URL becomes its own scheme and host. A download link can carry a
 *     signed token, and a YouTube link is the user's viewing history.
 *  2. The kit's own path keeps everything but the user's name. Which model,
 *     which venv, which folder a step died in is the diagnosis itself, so this
 *     runs first and takes those paths out of rule 3's way.
 *  3. Every other path under the home directory collapses to "~/.../*.ext".
 *     That is where the real name lives (/Users/<name>/, C:\Users\<name>\) and
 *     also where the video titles and project names live.
 *  4. The four key shapes go.
 *  5. What is left that is 32+ token characters, and is not part of a path, is
 *     redacted.
 * The paths are settled before the keys on purpose: done the other way round,
 * rule 5 ate the path segments rules 2 and 3 exist to keep readable.
 */
export function maskText(text, { home = "", kit = "" } = {}) {
  let out = String(text ?? "");
  out = out.replace(URL_PATTERN, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/...`;
    } catch {
      return "[URL]";
    }
  });
  if (kit) {
    // Both lists are built by the same transformation, so a kit path spelled
    // with one separator is replaced by a mask spelled with that separator.
    const forms = separatorForms(kit);
    const masks = home && startsWithCI(kit, home)
      ? separatorForms("~" + kit.slice(home.length))
      : forms;
    forms.forEach((form, i) => {
      out = out.replace(new RegExp(escapeRegExp(form), "gi"), () => masks[i]);
    });
  }
  if (home) {
    for (const form of new Set(separatorForms(home))) {
      const re = new RegExp(`${escapeRegExp(form)}((?:[\\\\/][^\\\\/\\s"']+)*)`, "gi");
      out = out.replace(re, (_match, rest) => collapseUnderHome(rest));
    }
    out = out.replace(SPACED_FILENAME, (_m, head, tail) =>
      `${head}${head[1]}*${tail.slice(tail.lastIndexOf("."))}`);
  }
  for (const p of KEY_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out.replace(LONG_TOKEN, "[REDACTED]");
}

/** The last MAX_LOG_LINES lines of a log, masked. Empty in, empty out. */
export function maskTail(text, { home = "", kit = "", maxLines = MAX_LOG_LINES } = {}) {
  const body = String(text ?? "");
  if (!body.trim()) return "";
  const lines = body.split(/\r?\n/);
  return maskText(lines.slice(-maxLines).join("\n"), { home, kit }).trim();
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
  kit = "",
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
    message: maskText(message, { home, kit }).slice(0, MAX_MESSAGE_CHARS),
    env: machine,
    packs: packs ?? envPacks ?? {},
    logTails: {
      shell: maskTail(logTails.shell, { home, kit }),
      app: maskTail(logTails.app, { home, kit }),
      job: maskTail(logTails.job, { home, kit }),
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

/** e.g. "[win-gpu] dub 4/6 synthesize: engine-crash (0.5.5)" */
export function issueTitle(report) {
  const key = (report.env && report.env.platformKey) || "unknown";
  const where = whereFailed(report);
  // The kind is always known ("dub", "install", "erase"); the stage often is
  // not. Without it a cloud failure came out as "[mac] unknown: unknown",
  // which cannot be told apart from the next one in a list of issues (user,
  // 2026-09-09).
  const what = where === "unknown" ? report.kind : `${report.kind} ${where}`;
  return `[${key}] ${what}: ${report.code} (${report.version || "?"})`;
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
