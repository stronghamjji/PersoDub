import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BYTES,
  buildReport,
  collectEnvironment,
  describeDevice,
  fingerprint,
  issueBody,
  issueTitle,
  maskTail,
  maskText,
  messageForReport,
  normalizeLine,
  reportBytes,
  resolveReportMode,
  withoutEncodedNames,
  worthReporting,
} from "./report.js";

// ---- the off switches --------------------------------------------------

test("a from-source run never sends a report", () => {
  assert.equal(resolveReportMode({ isPackaged: false, env: {} }), "off");
});

test("PERSODUB_NO_REPORTS=1 turns reports off", () => {
  assert.equal(resolveReportMode({ isPackaged: true, env: { PERSODUB_NO_REPORTS: "1" } }), "off");
});

test("PERSODUB_REPORTS_DEBUG=1 prints instead of sending", () => {
  assert.equal(resolveReportMode({ isPackaged: true, env: { PERSODUB_REPORTS_DEBUG: "1" } }), "debug");
});

test("the off switch beats debug mode", () => {
  const env = { PERSODUB_REPORTS_DEBUG: "1", PERSODUB_NO_REPORTS: "1" };
  assert.equal(resolveReportMode({ isPackaged: true, env }), "off");
});

test("a packaged run with nothing set sends", () => {
  assert.equal(resolveReportMode({ isPackaged: true, env: {} }), "on");
});

test("the counts' switch does not silence reports", () => {
  // Two switches, two answers: someone who turned the usage counts off still
  // gets their crash reported, and vice versa.
  assert.equal(resolveReportMode({ isPackaged: true, env: { PERSODUB_NO_ANALYTICS: "1" } }), "on");
});

// ---- masking -----------------------------------------------------------

test("a file under the home directory keeps only its extension", () => {
  // The folder names and the file name under a home directory are the user's
  // own business -- a client, a project, what they were watching.
  const out = maskText("cannot open /Users/jane/Movies/Q3 board review.mp4", { home: "/Users/jane" });
  assert.equal(out, "cannot open ~/\u2026/*.mp4");
});

test("a sentence about a home path is still a sentence", () => {
  // The reason a path stops at whitespace: without that, the words after it
  // would be swallowed along with the folder names.
  assert.equal(maskText("could not open /Users/jane/kit because the disk is full", { home: "/Users/jane" }),
    "could not open ~/\u2026 because the disk is full");
});

test("a Windows home directory is masked with either separator, any case", () => {
  const home = "C:\\Users\\Jane";
  assert.equal(maskText("at C:\\Users\\Jane\\Videos\\clip.mov", { home }), "at ~\\\u2026\\*.mov");
  assert.equal(maskText("at c:/users/jane/Videos/clip.mov", { home }), "at ~/\u2026/*.mov");
});

test("a home path with no file on the end is just the home mark", () => {
  assert.equal(maskText("at /Users/jane/Documents", { home: "/Users/jane" }), "at ~/\u2026");
  assert.equal(maskText("at /Users/jane", { home: "/Users/jane" }), "at ~");
});

test("a Korean home directory is masked like any other", () => {
  const home = "/Users/\ud64d\uae38\ub3d9";
  const out = maskText("FileNotFoundError: /Users/\ud64d\uae38\ub3d9/\uc601\uc0c1/\uc81c\ubaa9.mp4", { home });
  assert.equal(out, "FileNotFoundError: ~/\u2026/*.mp4");
});

test("the kit's own paths stay readable -- they are the diagnosis", () => {
  const home = "/Users/jane";
  const kit = "/Users/jane/Library/Application Support/PersoDub/kit";
  const out = maskText(`no such file: ${kit}/models/qwen3-tts/model.safetensors`, { home, kit });
  assert.equal(out, "no such file: ~/Library/Application Support/PersoDub/kit/models/qwen3-tts/model.safetensors");
});

test("a kit path is recognised however the log spelled its separators", () => {
  const home = "C:\\Users\\Jane";
  const kit = "C:\\Users\\Jane\\AppData\\Local\\PersoDub\\kit";
  assert.equal(maskText("at c:/users/jane/appdata/local/persodub/kit/engines_venv", { home, kit }),
    "at ~/AppData/Local/PersoDub/kit/engines_venv");
});

test("a kit outside the home directory is left exactly as it is", () => {
  const out = maskText("no such file: /Volumes/Big/kit/models/x.bin", { home: "/Users/jane", kit: "/Volumes/Big/kit" });
  assert.equal(out, "no such file: /Volumes/Big/kit/models/x.bin");
});

test("an OpenAI-style key is redacted", () => {
  assert.equal(maskText("key sk-abcd1234efgh5678"), "key [REDACTED]");
});

test("a Google API key is redacted", () => {
  assert.equal(maskText("AIzaSyA1b2C3d4E5f6G7h8"), "[REDACTED]");
});

test("any long run of token characters is redacted", () => {
  const token = "a".repeat(20) + "1".repeat(20);
  assert.equal(maskText(`token=${token} done`), "token=[REDACTED] done");
});

test("a GitHub or Hugging Face token is redacted", () => {
  assert.equal(maskText("ghp_abcd1234efgh5678ijkl"), "[REDACTED]");
  assert.equal(maskText("hf_abcd1234efgh5678ijkl"), "[REDACTED]");
});

test("a long name inside a path is not mistaken for a secret", () => {
  // The 32-character rule used to swallow model folders whole, which is how a
  // report lost the one line saying which model was missing.
  const line = "no such file: /kit/models/Qwen3TTS12BInstructInt8Quantized/config.json";
  assert.equal(maskText(line), line);
});

test("a short word is not redacted", () => {
  assert.equal(maskText("engine crashed after 30s"), "engine crashed after 30s");
});

test("a URL keeps its host and loses everything else", () => {
  const out = maskText("downloading https://cdn.example.com/models/x.bin?token=abc123");
  assert.equal(out, "downloading https://cdn.example.com/...");
});

test("masking survives an unparseable URL", () => {
  assert.equal(maskText("see http://[not-a-host"), "see [URL]");
});

test("a log tail keeps only its last lines, masked", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} in /Users/jane/kit`);
  const tail = maskTail(lines.join("\n"), { home: "/Users/jane", maxLines: 5 });
  assert.equal(tail.split("\n").length, 5);
  assert.ok(tail.includes("~/\u2026"));
  assert.ok(!tail.includes("/Users/jane"));
});

test("an empty log is an empty tail, not a blank line", () => {
  assert.equal(maskTail("   \n\n"), "");
});

// ---- fingerprint -------------------------------------------------------

test("the same failure on two machines has one fingerprint", () => {
  const a = fingerprint({
    platformKey: "win-gpu", step: "synthesize", code: "engine-crash",
    lastLine: "RuntimeError: model at C:\\Users\\Jane\\kit\\models\\qwen failed after 12 tries",
  });
  const b = fingerprint({
    platformKey: "win-gpu", step: "synthesize", code: "engine-crash",
    lastLine: "RuntimeError: model at C:\\Users\\Bob\\dub\\models\\qwen failed after 3 tries",
  });
  assert.equal(a, b);
});

test("POSIX paths and line numbers drop out of a fingerprint too", () => {
  const a = fingerprint({ platformKey: "mac", step: "build", code: "unknown", lastLine: "failed at /Users/jane/a/b.py line 41" });
  const b = fingerprint({ platformKey: "mac", step: "build", code: "unknown", lastLine: "failed at /home/bob/x/y.py line 9" });
  assert.equal(a, b);
});

// A helper's own words are cut to their last 400 characters, and where that
// cut lands moves with the length of the path inside them. The same broken
// file, sent twice, came out as two fingerprints (0.6.2 full test, 2026-09-17).
test("the same failure is one fingerprint however its detail was cut", () => {
  const sample = (cut) => buildReport({
    ...SAMPLE, kind: "dub", code: "unknown",
    message: "1/6 Separating background audio locally (Demucs)…\n"
      + "Error: RuntimeError: Voice separation failed on this computer. Check the video file. "
      + `(local separation exited with an error (${cut} input file ~/x/input.mp4.\n`
      + "Error opening input files: Invalid data found when processing input\n"
      + `__SEPARATE_ERROR__ Command '['ffmpeg', '-y', '-v', 'error', '-i', '~/x/input.mp4', ${cut === "g" ? "'-ac', '2', )" : "'-ar)"}`,
  });
  assert.equal(sample("ening").fingerprint, sample("g").fingerprint);
});

test("a different step is a different fingerprint", () => {
  const base = { platformKey: "mac", code: "network", lastLine: "download failed" };
  assert.notEqual(fingerprint({ ...base, step: "models" }), fingerprint({ ...base, step: "python" }));
});

test("a fingerprint is twelve hex characters", () => {
  assert.match(fingerprint({ platformKey: "mac", step: "models", code: "network", lastLine: "x" }), /^[0-9a-f]{12}$/);
});

test("normalizeLine leaves the words and nothing else", () => {
  assert.equal(normalizeLine("ERROR: pip install failed with exit 2 in /tmp/x/y"), "error: pip install failed with exit in");
});

// ---- the environment ---------------------------------------------------

const MAC = { platform: "darwin", release: "24.6.0", arch: "arm64", cpuModel: "Apple M4", cores: 10, totalMemBytes: 24 * 1024 ** 3 };
const WIN = { platform: "win32", release: "10.0.26100", arch: "x64", cpuModel: "Intel i7", cores: 8, totalMemBytes: 32 * 1024 ** 3 };

test("a mac is always the mac platform key", () => {
  const env = collectEnvironment({ sys: MAC, torchVariant: "mps", appVersion: "0.5.5" });
  assert.equal(env.platformKey, "mac");
  assert.equal(env.os, "mac 24.6.0");
  assert.equal(env.ramGb, 24);
});

test("Windows splits by torch build, the way the pack sizes do", () => {
  assert.equal(collectEnvironment({ sys: WIN, torchVariant: "cpu" }).platformKey, "win-cpu");
  assert.equal(collectEnvironment({ sys: WIN, torchVariant: "cu128" }).platformKey, "win-gpu");
});

test("the device line names Windows by its build, a Mac by its product version and chip, then the CPU, memory and how the app runs", () => {
  const win = (build) => describeDevice({ sys: { ...WIN, release: `10.0.${build}` } }).split(" · ")[0];
  assert.deepEqual([26200, 26300, 26100, 22631, 22621, 22000, 19045, 19044, 19041].map(win), [
    "Windows 11 25H2 (build 26200)", "Windows 11 25H2 (build 26300)", "Windows 11 24H2 (build 26100)", "Windows 11 23H2 (build 22631)",
    "Windows 11 22H2 (build 22621)", "Windows 11 21H2 (build 22000)", "Windows 10 22H2 (build 19045)", "Windows 10 21H2 (build 19044)",
    "Windows 10/11 (build 19041)",
  ]);
  assert.equal(describeDevice({ sys: { ...WIN, release: "10.0.26200" }, installed: true, edition: "production" }),
    "Windows 11 25H2 (build 26200) · Intel i7 (8 cores) · 32 GB RAM · installed · production");
  const mac = (product, arch = "arm64") => describeDevice({ sys: { ...MAC, product, arch }, edition: "opensource" });
  assert.equal(mac("26.5.2"), "macOS 26.5.2 (Tahoe) · Apple Silicon · Apple M4 (10 cores) · 24 GB RAM · from source · opensource");
  assert.deepEqual(["15.1", "14.7.2", "13.0", "12.7", "11.2", "27.0"].map((v) => mac(v).split(" · ")[0]),
    ["macOS 15.1 (Sequoia)", "macOS 14.7.2 (Sonoma)", "macOS 13.0 (Ventura)", "macOS 12.7 (Monterey)", "macOS 11.2 (Big Sur)", "macOS 27.0"]);
  assert.equal(mac("14.7.2", "x64").split(" · ")[1], "Intel");
  assert.equal(describeDevice({ sys: MAC }).split(" · ")[0], "macOS (Darwin 24.6.0)", "sw_vers unread");
  assert.equal(describeDevice({ sys: { ...MAC, platform: "linux", product: "Ubuntu 24.04 LTS", arch: "x64" } }).split(" · ")[0], "Linux Ubuntu 24.04 LTS");
  const env = collectEnvironment({ sys: { ...WIN, release: "10.0.26200" }, installed: true, edition: "production" });
  assert.equal(env.device, "Windows 11 25H2 (build 26200) · Intel i7 (8 cores) · 32 GB RAM · installed · production");
  assert.equal(env.os, "windows 10.0.26200", "the old field as it was");
});

test("free disk is rounded to whole gigabytes, and unknown stays unknown", () => {
  assert.equal(collectEnvironment({ sys: MAC, freeDiskBytes: 42.4 * 1024 ** 3 }).freeDiskGb, 42);
  assert.equal(collectEnvironment({ sys: MAC }).freeDiskGb, null);
});

// ---- the allow-list ----------------------------------------------------

const SAMPLE = {
  kind: "dub",
  env: collectEnvironment({ sys: WIN, torchVariant: "cu128", appVersion: "0.5.5", kitVersion: "0.5.5", freeDiskBytes: 42 * 1024 ** 3, packs: { engine: "ready" } }),
  stage: "synthesize",
  stageMarker: "4/6",
  code: "engine-crash",
  message: "RuntimeError: the voice engine exited (exit 1)",
  version: "0.5.5",
  installId: "0123456789abcdef0123456789abcdef",
  logTails: { shell: "PERSODUB_READY", app: "boom", job: "4/6 synthesize" },
};

test("a field nobody named cannot leave", () => {
  const report = buildReport({
    ...SAMPLE,
    videoTitle: "Q3 results, internal only",
    apiKey: "sk-secret",
    workspace: "/Users/jane/PersoDub/workspace",
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes("Q3 results"));
  assert.ok(!text.includes("sk-secret"));
  assert.ok(!text.includes("/Users/jane"));
  assert.deepEqual(Object.keys(report).sort(), [
    "code", "device", "diagnostics", "env", "fingerprint", "installId", "kind", "logTails", "message",
    "packs", "stage", "stageMarker", "step", "version",
  ]);
});

// The usage counts' id travels as its first twelve characters (0.8.7). A whole
// id, or anything else, is not one of those and stays behind.
test("the device is twelve hex characters or nothing", () => {
  assert.equal(buildReport({ ...SAMPLE, device: "0123456789ab" }).device, "0123456789ab");
  for (const bad of ["0123456789abcdef0123456789abcdef", "0123456789AB", "0123456789a", "<b>x</b>", null]) {
    assert.equal(buildReport({ ...SAMPLE, device: bad }).device, "", String(bad));
  }
  assert.equal(buildReport(SAMPLE).device, "");
});

// A debug print of a report lands in shell.log, and the next report sends that
// log's tail into the public issue. The device is for the private dashboard.
test("a device field a debug print left in a log is masked", () => {
  const shell = '[persodub-report] would send: {"kind":"dub","device":"0123456789ab","code":"unknown"}';
  const report = buildReport({ ...SAMPLE, logTails: { ...SAMPLE.logTails, shell } });
  assert.ok(!report.logTails.shell.includes("0123456789ab"), report.logTails.shell);
  assert.match(report.logTails.shell, /"device":"\[REDACTED\]"/);
});

// ---- a finished job's record ------------------------------------------

test("a finished job's record says what ran, on what and for how long, and nothing about a failure", () => {
  const timing = { started_hour: 9, elapsed_seconds: 12, stage_seconds: { separate: 11, build: 1 } };
  const record = buildReport({ ...SAMPLE, kind: "separate", code: "ok", device: "0123456789ab", timing });
  assert.deepEqual(Object.keys(record).sort(), [
    "code", "device", "diagnostics", "env", "fingerprint", "installId", "kind", "logTails", "message",
    "outcome", "packs", "stage", "stageMarker", "step", "timing", "version",
  ]);
  assert.deepEqual([record.outcome, record.kind, record.code, record.stage, record.stageMarker, record.message],
    ["ok", "separate", "ok", "done", "", ""]);
  assert.deepEqual(record.timing, { elapsed_seconds: 12, sep_seconds: 11 }, "whole seconds, the four steps by their count names");
  assert.deepEqual([record.logTails, record.diagnostics], [{}, {}]);
  assert.deepEqual([record.device, record.env.platformKey, record.env.ramGb], ["0123456789ab", "win-gpu", 32]);
  assert.deepEqual(buildReport({ ...SAMPLE, code: "ok", timing: { elapsed_seconds: -1, stage_seconds: "x" } }).timing, {});
  assert.equal(buildReport({ ...SAMPLE, kind: "install", code: "ok" }).kind, "unknown", "an install is not a job");
  assert.equal(buildReport({ ...SAMPLE, kind: "separate" }).kind, "unknown", "a failure keeps the report's own kinds");
  assert.equal("outcome" in buildReport(SAMPLE), false, "a failure report is as it was");
});

// ---- what the probes found --------------------------------------------

test("only a published probe travels, and only as plain facts", () => {
  const report = buildReport({
    ...SAMPLE,
    home: "/Users/jane",
    diagnostics: {
      network: { "pypi.org": { reachable: true, issuer: "ALYac Web Security", root: "ALYac Web Security", chainLength: 2 } },
      antivirus: { products: Array.from({ length: 15 }, (_, i) => `Product ${i}`) },
      gpu: { nvidia: "RTX ".repeat(125) },
      kitWritable: { writable: false, error: "cannot write /Users/jane/Movies/secret.mp4" },
      memory: { totalGB: 15.8, freeGB: Infinity, "a key with /Users/jane in it": 1 },
      clipboard: { text: "what the user copied" },
    },
  });
  const d = report.diagnostics;
  assert.deepEqual(Object.keys(d).sort(), ["antivirus", "gpu", "kitWritable", "memory", "network"]);
  assert.ok(!JSON.stringify(report).includes("what the user copied"));
  assert.equal(d.network["pypi.org"].issuer, "ALYac Web Security");
  assert.equal(d.network["pypi.org"].chainLength, 2);
  assert.equal(d.antivirus.products.length, 10);
  assert.equal(d.gpu.nvidia.length, 200);
  assert.equal(d.kitWritable.error, "cannot write ~/\u2026/*.mp4");
  assert.deepEqual(d.memory, { totalGB: 15.8, freeGB: null });
});

test("a report with no probes carries an empty diagnostics", () => {
  assert.deepEqual(buildReport(SAMPLE).diagnostics, {});
});

test("an unpublished error code becomes unknown rather than travelling", () => {
  assert.equal(buildReport({ ...SAMPLE, code: "ENOSPC while writing /Users/jane/x" }).code, "unknown");
});

test("a made-up stage id is dropped", () => {
  assert.equal(buildReport({ ...SAMPLE, stage: "Q3 results.mp4" }).stage, "");
});

test("an install report carries a published step and no stage", () => {
  const report = buildReport({ ...SAMPLE, kind: "install", step: "venv-engines", stage: "synthesize" });
  assert.equal(report.step, "venv-engines");
  assert.equal(report.stage, "");
  assert.equal(buildReport({ ...SAMPLE, kind: "install", step: "made-up" }).step, "");
});

test("an unknown kind is not passed through", () => {
  assert.equal(buildReport({ ...SAMPLE, kind: "screenshot" }).kind, "unknown");
});

test("the message and the log tails are masked", () => {
  const report = buildReport({
    ...SAMPLE,
    home: "/Users/jane",
    message: "cannot write /Users/jane/kit/models",
    logTails: { shell: "at /Users/jane/kit", app: "key sk-abcd1234efgh5678", job: "" },
  });
  assert.equal(report.message, "cannot write ~/\u2026");
  assert.equal(report.logTails.shell, "at ~/\u2026");
  assert.equal(report.logTails.app, "key [REDACTED]");
  assert.equal(report.logTails.job, "");
});

test("a log tail is cut to 200 lines", () => {
  const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const report = buildReport({ ...SAMPLE, logTails: { shell: long, app: "", job: "" } });
  assert.equal(report.logTails.shell.split("\n").length, 200);
});

// A long job's last 200 lines no longer reach its JOB START and Inputs lines
// (app/jobs.py), so the job's log keeps its first 25 as well, and only the job's.
test("a job log keeps its first lines and its last, one line standing for those left out", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
  const tail = maskTail(lines.join("\n"), { headLines: 25 }).split("\n");
  assert.equal(tail.length, 226);
  assert.deepEqual([tail[0], tail[24], tail[25], tail[26], tail.at(-1)], ["line 0", "line 24", "...", "line 200", "line 399"]);
  const whole = lines.slice(0, 225).join("\n");
  assert.equal(maskTail(whole, { headLines: 25 }), whole, "nothing left out, so no ...");

  const log = (name) => [`${name} START`, "Inputs: {}", ...Array.from({ length: 400 }, (_, i) => `${name} ${i}`)].join("\n");
  const report = buildReport({ ...SAMPLE, logTails: { shell: log("shell"), app: log("app"), job: log("job") } });
  const job = report.logTails.job.split("\n");
  assert.deepEqual([job[0], job[1], job[25], job.at(-1)], ["job START", "Inputs: {}", "...", "job 399"]);
  for (const k of ["shell", "app"]) {
    assert.equal(report.logTails[k].split("\n").length, 200, k);
    assert.ok(!report.logTails[k].includes("START"), `${k} keeps only its end`);
  }
});

test("a job log in that shape is still trimmed to the cap, oldest lines first", () => {
  // Spaced filler: one long run of letters would be masked down to [REDACTED].
  const fat = Array.from({ length: 600 }, (_, i) => `${i} ${"x ".repeat(150)}`).join("\n");
  const report = buildReport({ ...SAMPLE, logTails: { shell: fat, app: "", job: fat } });
  assert.ok(reportBytes(report) <= MAX_BYTES, `${reportBytes(report)} bytes`);
  const job = report.logTails.job.split("\n");
  assert.ok(job.at(-1).startsWith("599 "), "the end of the story survives");
  assert.ok(!job[0].startsWith("0 "), "the opening goes first");
});

// The engines' console logs: where a voice engine or Ollama that crashed says
// why. Their web requests carry a video's path percent-encoded, where the masks
// cannot see it, so the query and any encoded segment go first.
test("a request's query and percent-encoded names leave an engine's log, its path stays", () => {
  assert.equal(withoutEncodedNames('INFO: 127.0.0.1 - "GET /api/subtitles?video_path=%2FUsers%2Fjane%2FMy%20Show.mp4&engine=x HTTP/1.1" 200 OK'),
    'INFO: 127.0.0.1 - "GET /api/subtitles?… HTTP/1.1" 200 OK');
  assert.equal(withoutEncodedNames('"GET /api/videos/My%20Show.mp4/thumb HTTP/1.1"'), '"GET /api/videos/…/thumb HTTP/1.1"');
  assert.equal(withoutEncodedNames("loading 45% done, 100%|####|"), "loading 45% done, 100%|####|");
});

test("a report carries the last 80 lines of each engine's console log, masked", () => {
  const log = (name) => Array.from({ length: 300 }, (_, i) => `${name} ${i} at /Users/jane/x`).join("\n");
  const encoded = '"GET /api/subtitles?video_path=%2FUsers%2Fjane%2FSecret.mp4 HTTP/1.1" 200';
  const report = buildReport({ ...SAMPLE, home: "/Users/jane",
    logTails: { backend: `${log("backend")}\n${encoded}`, sidecar: log("sidecar"), ollama: "" } });
  const backend = report.logTails.backend.split("\n");
  assert.equal(backend.length, 80);
  assert.equal(backend.at(-1), '"GET /api/subtitles?… HTTP/1.1" 200');
  assert.ok(!report.logTails.backend.includes("jane") && !report.logTails.backend.includes("Secret"), report.logTails.backend);
  assert.equal(report.logTails.sidecar.split("\n").length, 80);
  assert.ok(report.logTails.sidecar.endsWith("sidecar 299 at ~/…"));
  assert.equal(report.logTails.ollama, "", "a log that is not there is an empty tail");
});

test("an engine's tail is trimmed like the others when the report is too big, longest first", () => {
  const fat = (n) => Array.from({ length: n }, (_, i) => `${i} ${"x ".repeat(400)}`).join("\n");
  const report = buildReport({ ...SAMPLE, logTails: { backend: fat(80), sidecar: fat(80), ollama: fat(80) } });
  assert.ok(reportBytes(report) <= MAX_BYTES, `${reportBytes(report)} bytes`);
  for (const k of ["backend", "sidecar", "ollama"]) {
    const lines = report.logTails[k].split("\n");
    assert.ok(lines.length < 80 && lines.at(-1).startsWith("79 "), `${k}: ${lines.length} lines, end kept`);
  }
});

test("the same failure builds the same fingerprint through buildReport", () => {
  const a = buildReport(SAMPLE).fingerprint;
  const b = buildReport({ ...SAMPLE, message: "RuntimeError: the voice engine exited (exit 9)" }).fingerprint;
  assert.equal(a, b);
});

// ---- the size cap ------------------------------------------------------

test("a huge report is trimmed to the cap, log tails first", () => {
  const fat = Array.from({ length: 200 }, (_, i) => `${i} ` + "x".repeat(2000)).join("\n");
  const report = buildReport({ ...SAMPLE, logTails: { shell: fat, app: fat, job: fat } });
  assert.ok(reportBytes(report) <= MAX_BYTES, `${reportBytes(report)} bytes`);
  // Trimmed, not emptied: the end of the story is what survives.
  assert.ok(report.logTails.job.length > 0);
  assert.equal(report.message, SAMPLE.message);
});

test("a report that is all message still comes in under the cap", () => {
  const report = buildReport({ ...SAMPLE, message: "y".repeat(100000), logTails: {} });
  assert.ok(reportBytes(report) <= MAX_BYTES);
});

// ---- how it reads ------------------------------------------------------

test("the title names the machine, what was being done, the step, the error and the version", () => {
  assert.equal(issueTitle(buildReport(SAMPLE)), "[win-gpu] dub 4/6 synthesize: engine-crash (0.5.5)");
});

test("an install failure titles itself by step", () => {
  const report = buildReport({ ...SAMPLE, kind: "install", step: "venv-engines", code: "network" });
  assert.equal(issueTitle(report), "[win-gpu] install venv-engines: network (0.5.5)");
});

// Nothing placed it -- a cloud dub that never reached a local stage. The kind
// is all there is, and a title without it read "[win-gpu] unknown: unknown"
// (user, 2026-09-09).
test("a failure with no step and no stage is still named by what was being done", () => {
  const report = buildReport({ ...SAMPLE, kind: "dub", stage: "", stageMarker: "", code: "cloud-refused" });
  assert.equal(issueTitle(report), "[win-gpu] dub: cloud-refused (0.5.5)");
});

test("the body carries the environment table, the error and the fingerprint", () => {
  const body = issueBody(buildReport(SAMPLE));
  assert.match(body, /### Environment/);
  assert.match(body, /\| RAM \| 32 GB \|/);
  assert.match(body, /\| Packs \| engine=ready \|/);
  assert.match(body, /### Where it failed/);
  assert.match(body, /4\/6 synthesize/);
  assert.match(body, /the voice engine exited/);
  assert.match(body, /<details><summary>shell\.log \(tail\)<\/summary>/);
  assert.match(body, /Fingerprint: `[0-9a-f]{12}`/);
});

test("a missing log tail leaves out its whole details block", () => {
  const body = issueBody(buildReport({ ...SAMPLE, logTails: { shell: "one line", app: "", job: "" } }));
  assert.match(body, /shell\.log \(tail\)/);
  assert.ok(!body.includes("persodub.log (tail)"));
});

// Every failure is classified and counted. Only the ones somebody here could
// act on become a GitHub issue -- an issue is a thing a person has to read
// and close, and there is nothing to change in the code when a disk is full
// (user, 2026-09-11).
test("a failure the user can only fix themselves does not become an issue", () => {
  assert.equal(worthReporting("disk-full"), false);
  assert.equal(worthReporting("cloud-refused"), false);
  for (const code of ["perso-busy", "perso-credits", "perso-key", "perso-length", "perso-plan", "gemini-busy", "gemini-quota"]) {
    assert.equal(worthReporting(code), false, code);
  }
});

// A project Perso accepted and then gave up on is not the user's wallet or
// their key: it may well be the shape of what we sent (user, 2026-09-11).
test("a job Perso itself gave up on is still worth hearing about", () => {
  assert.equal(worthReporting("perso-failed"), true);
});

test("everything else is still worth hearing about", () => {
  for (const code of ["engine-crash", "engine-start", "step-failed", "out-of-memory",
                      "unsupported-format", "path-too-long", "permission"]) {
    assert.equal(worthReporting(code), true, code);
  }
  // A download that will not come is as often our URL or our checksum as it
  // is their wifi.
  assert.equal(worthReporting("network"), true);
  // And the whole point of the thing: a failure nobody has seen before.
  assert.equal(worthReporting("unknown"), true);
  assert.equal(worthReporting(undefined), true);
});

// Python writes a Windows path with every backslash doubled, and the masks
// only knew the single kind: the account name went out on four reports
// (2026-09-15).
test("a doubled-backslash Windows path is masked like a single one", () => {
  const home = "C:\\Users\\Jane";
  const out = maskText("Command '['C:\\\\Users\\\\Jane\\\\Videos\\\\clip.mov']", { home });
  assert.ok(!out.includes("Jane"), out);
  assert.ok(out.includes("~\\\u2026\\*.mov"), out);
});

test("the Perso workspace name is masked in the message too", () => {
  assert.equal(maskText("   Perso workspace: mahop072 (#603412)"), "   Perso workspace: *");
});

// perso_client logs the workspace by number alone, and the rule above only
// knew the job log's "name (#number)" line: the number went out in the app
// log tail (0.6.2 full test, 2026-09-17).
test("the Perso workspace number is masked wherever the app log names it", () => {
  assert.equal(maskText("Perso dubbing project 777 (workspace 123456)"),
    "Perso dubbing project 777 (workspace *)");
  assert.equal(maskText("Could not read credits for Perso workspace 123456 (HTTPError)"),
    "Could not read credits for Perso workspace * (HTTPError)");
});

// The kit's paths stay readable on purpose, but workspace/<day>/<project> is
// named after the video. The backend masked it; the shell did not, and the
// error message the page hands over only ever passes the shell (2026-09-15).
test("the project folder under the kit's workspace is masked, the rest of the path kept", () => {
  const kit = "C:\\Users\\Jane\\AppData\\Local\\PersoDub";
  const home = "C:\\Users\\Jane";
  const out = maskText("FileNotFoundError: " + kit + "\\app\\workspace\\2026-09-11\\My Holiday Video_ko\\input.mp4", { home, kit });
  assert.ok(!out.includes("Holiday"), out);
  assert.ok(out.includes("workspace\\2026-09-11\\*\\input.mp4"), out);
  const mac = maskText("open /Users/jane/Library/Application Support/PersoDub/app/workspace/2026-09-11/secret_erase/erased.mp4",
                       { home: "/Users/jane", kit: "/Users/jane/Library/Application Support/PersoDub" });
  assert.ok(!mac.includes("secret"), mac);
  assert.ok(mac.includes("workspace/2026-09-11/*/erased.mp4"), mac);
});

// ---- the message keeps the reason -------------------------------------
// Five translation failures in four days arrived as "Error: Translation
// failed (Oll" and stopped there: the tail of a job log was cut from the
// front, so the progress lines above survived and the reason did not
// (2026-09-15).

test("a message that fits is left alone", () => {
  assert.equal(messageForReport("  Error: it broke  "), "Error: it broke");
});

test("the failing line survives the cut, the progress above it gives way", () => {
  const filler = "WARNING line 7: no candidate fit the window, using the fullest available";
  const log = [filler, filler, filler, filler, filler, filler, filler, filler,
               "Error: Translation failed (Ollama hy-mt2:1.8b): Could not find a JSON array"].join("\n");
  const out = messageForReport(log, { max: 200 });
  assert.ok(out.length <= 200, out.length);
  assert.ok(out.includes("Could not find a JSON array"), out);
});

test("as much context as fits comes with it, oldest lines dropped first", () => {
  const out = messageForReport(["first", "second", "Error: the reason"].join("\n"), { max: 26 });
  assert.equal(out, "second\nError: the reason");
});

test("with no failing line to find, the end is kept rather than the start", () => {
  const out = messageForReport("aaaa\nbbbb\ncccc", { max: 9 });
  assert.equal(out, "bbbb\ncccc");
});

test("a single line longer than the budget is cut but still leads with itself", () => {
  const out = messageForReport("Error: " + "x".repeat(400), { max: 50 });
  assert.equal(out.length, 50);
  assert.ok(out.startsWith("Error: "), out);
});

test("masking hides a sign-in token and an e-mail address (review 2026-09-23)", () => {
  const out = maskText("auth eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl for someone@example.co.kr failed");
  assert.ok(!out.includes("eyJ") && !out.includes("@example") && out.includes("failed"));
});

test("a Windows path logged as a Python list is masked", () => {
  // Doubled backslashes: the account name and project folder survived (2026-09-25).
  const home = "C:\\Users\\EST-INFRA";
  const kit = home + "\\AppData\\Local\\PersoDub";
  const line = "Command '['ffmpeg', '-i', 'C:\\\\Users\\\\EST-INFRA\\\\AppData\\\\Local\\\\PersoDub\\\\app\\\\workspace\\\\2026-09-25\\\\broken-test_ko\\\\input.mp4', '-ac', '2']'";
  const out = maskText(line, { home, kit });
  assert.ok(!out.includes("EST-INFRA"), out);
  assert.ok(!out.includes("broken-test_ko"), out);
  assert.ok(out.includes("input.mp4"), out);
});

test("the environment names the edition the kit runs as, and nothing when unknown", () => {
  assert.equal(collectEnvironment({ sys: MAC, edition: "production" }).edition, "production");
  assert.equal(collectEnvironment({ sys: MAC }).edition, "");
});
