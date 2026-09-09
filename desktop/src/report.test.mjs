import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BYTES,
  buildReport,
  collectEnvironment,
  fingerprint,
  issueBody,
  issueTitle,
  maskTail,
  maskText,
  normalizeLine,
  reportBytes,
  resolveReportMode,
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
    "code", "env", "fingerprint", "installId", "kind", "logTails", "message",
    "packs", "stage", "stageMarker", "step", "version",
  ]);
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
