import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CODES,
  KINDS,
  MAX_REPORT_BYTES,
  commentText,
  countSighting,
  dayKey,
  issueBody,
  issueTitle,
  labelsFor,
  logObjectKey,
  logSummary,
  logsLine,
  maskAgain,
  newId,
  rateDecision,
  seenAgainText,
  tallyLine,
  validateReport,
  withLogsLine,
  withTally,
  scrubMessage,
} from "./report-logic.js";
import { buildReport, collectEnvironment, issueTitle as appIssueTitle, REPORT_KINDS } from "../desktop/src/report.js";
import { ERROR_CODES as APP_ERROR_CODES } from "../desktop/src/analytics.js";

// Run me: node --test relay/*.test.mjs

const GOOD = {
  kind: "dub",
  version: "0.5.5",
  installId: "0123456789abcdef0123456789abcdef",
  fingerprint: "0123456789ab",
  step: "",
  stage: "synthesize",
  stageMarker: "4/6",
  code: "engine-crash",
  message: "RuntimeError: the voice engine exited",
  env: {
    platformKey: "win-gpu", os: "windows 10.0.26100", arch: "x64", cpu: "Intel i7",
    cores: 8, ramGb: 32, freeDiskGb: 42, appVersion: "0.5.5", kitVersion: "0.5.5", torch: "cu128",
  },
  packs: { engine: "ready" },
  logTails: { shell: "PERSODUB_READY", app: "boom", job: "4/6 synthesize" },
};

// ---- validation --------------------------------------------------------

test("a well-formed report is accepted whole", () => {
  const { ok, report } = validateReport(GOOD);
  assert.ok(ok);
  assert.equal(report.code, "engine-crash");
  assert.equal(report.env.platformKey, "win-gpu");
  assert.equal(report.packs.engine, "ready");
});

test("a report is rebuilt, so a field nobody named cannot get through", () => {
  const { report } = validateReport({ ...GOOD, videoTitle: "Q3 results", contactEmail: "a@b.c" });
  const text = JSON.stringify(report);
  assert.ok(!text.includes("Q3 results"));
  assert.ok(!text.includes("a@b.c"));
});

test("junk is refused rather than half-accepted", () => {
  for (const bad of [null, "", "[]", 5, { ...GOOD, fingerprint: "nope" }, { ...GOOD, installId: "x" }, { ...GOOD, version: "" }]) {
    assert.equal(validateReport(bad).ok, false, JSON.stringify(bad));
  }
});

test("a report over the size limit is refused", () => {
  const fat = { ...GOOD, logTails: { shell: "x".repeat(MAX_REPORT_BYTES + 10), app: "", job: "" } };
  assert.equal(validateReport(JSON.stringify(fat)).ok, false);
});

test("a word that is not on a published list becomes unknown", () => {
  const { report } = validateReport({ ...GOOD, kind: "screenshot", code: "ENOSPC", env: { ...GOOD.env, platformKey: "linux" } });
  assert.equal(report.kind, "unknown");
  assert.equal(report.code, "unknown");
  assert.equal(report.env.platformKey, "unknown");
});

test("a made-up step or stage is dropped", () => {
  const { report } = validateReport({ ...GOOD, step: "rm -rf /", stage: "Q3.mp4" });
  assert.equal(report.step, "");
  assert.equal(report.stage, "");
});

test("the relay masks again, for the sake of the builds it cannot fix", () => {
  const { report } = validateReport({
    ...GOOD,
    message: "Error: at /Users/jane/kit with sk-abcd1234efgh5678",
    logTails: { shell: "GET https://cdn.example.com/a/b?token=zzz", app: "", job: "" },
  });
  assert.equal(report.message, "Error: at ~/kit with [REDACTED]");
  assert.equal(report.logTails.shell, "GET https://cdn.example.com/...");
});

test("masking again handles Windows and Linux home directories too", () => {
  assert.equal(maskAgain("C:\\Users\\Jane\\kit"), "~\\kit");
  assert.equal(maskAgain("/home/jane/kit"), "~/kit");
});

test("masking again redacts the other two token shapes", () => {
  assert.equal(maskAgain("ghp_abcd1234efgh5678ijkl"), "[REDACTED]");
  assert.equal(maskAgain("hf_abcd1234efgh5678ijkl"), "[REDACTED]");
});

test("masking again leaves the kit paths the app kept on purpose", () => {
  // The app keeps these readable because they are the diagnosis; a blunt
  // 32-character rule here would take them away again.
  const line = "no such file: ~/kit/models/Qwen3TTS12BInstructInt8Quantized/config.json";
  assert.equal(maskAgain(line), line);
});

// ---- labels ------------------------------------------------------------

test("a dub failure earns five labels, all of them from a published list", () => {
  const { report } = validateReport(GOOD);
  assert.deepEqual(labelsFor(report).sort(), [
    "env:win-gpu", "err:engine-crash", "kind:dub", "stage:synthesize", "ver:0.5.5",
  ]);
});

test("an install failure is labelled by step instead of stage", () => {
  const { report } = validateReport({ ...GOOD, kind: "install", stage: "", step: "venv-engines" });
  assert.ok(labelsFor(report).includes("step:venv-engines"));
  assert.ok(!labelsFor(report).some((l) => l.startsWith("stage:")));
});

// The relay keeps its own copy of the app's vocabularies on purpose -- it must
// refuse a word it has never heard rather than create a label from whatever a
// request contained. A copy that drifts is worse than no copy: the app would
// send a code and the relay would file it as "unknown". Adding "cloud-refused"
// by hand to both lists (2026-09-09) is exactly the drift this catches.
test("the relay's vocabularies are the app's, word for word", () => {
  assert.deepEqual([...ERROR_CODES].sort(), [...APP_ERROR_CODES].sort());
  assert.deepEqual([...KINDS].sort(), [...REPORT_KINDS, "unknown"].sort());
});

// ---- what it writes ----------------------------------------------------

test("the relay and the app spell one failure's title the same way", () => {
  // Both sides render a title: the app for the copy it saves when it cannot
  // send, the relay for the issue. Two spellings would read as two bugs.
  const built = buildReport({
    kind: "dub", stage: "synthesize", stageMarker: "4/6", code: "engine-crash",
    version: "0.5.5", installId: GOOD.installId, message: GOOD.message,
    env: collectEnvironment({
      sys: { platform: "win32", release: "10.0.26100", arch: "x64", cpuModel: "Intel i7", cores: 8, totalMemBytes: 32 * 1024 ** 3 },
      torchVariant: "cu128", appVersion: "0.5.5", kitVersion: "0.5.5",
    }),
  });
  const { report } = validateReport(JSON.parse(JSON.stringify(built)));
  assert.equal(issueTitle(report), appIssueTitle(built));
  assert.equal(issueTitle(report), "[win-gpu] dub 4/6 synthesize: engine-crash (0.5.5)");
});

// A cloud dub dies before any stage of the local pipeline is reached, and the
// service's own refusal is not a fact about the machine: without the kind in
// front, every one of them arrived as "[mac] unknown: unknown" (user,
// 2026-09-09).
test("a failure with no stage still says what was being done", () => {
  const built = buildReport({
    kind: "dub", code: "cloud-refused", version: "0.5.5", installId: GOOD.installId,
    message: "Perso's server is temporarily unavailable.",
    env: collectEnvironment({
      sys: { platform: "darwin", release: "25.5.0", arch: "arm64", cpuModel: "Apple M4", cores: 10, totalMemBytes: 24 * 1024 ** 3 },
      torchVariant: "mps", appVersion: "0.5.5", kitVersion: "0.5.5",
    }),
  });
  const { report } = validateReport(JSON.parse(JSON.stringify(built)));
  assert.equal(issueTitle(report), appIssueTitle(built));
  assert.equal(issueTitle(report), "[mac] dub: cloud-refused (0.5.5)");
  assert.ok(labelsFor(report).includes("err:cloud-refused"),
    "the relay knows the code, so the label is a real one rather than err:unknown");
});

test("the body carries the machine, the error and the fingerprint", () => {
  const body = issueBody(validateReport(GOOD).report);
  assert.match(body, /\| RAM \| 32 GB \|/);
  assert.match(body, /\| Packs \| engine=ready \|/);
  assert.match(body, /the voice engine exited/);
  assert.match(body, /Fingerprint: `0123456789ab`/);
  assert.ok(!body.includes("Full logs:"));
});

test("a body written with an archive says so", () => {
  const body = issueBody(validateReport(GOOD).report, { logsRef: "a".repeat(32) });
  assert.match(body, /Full logs: kept, id `a{32}`/);
});

test("a repeat is one line naming the machine and the version", () => {
  assert.equal(commentText(validateReport(GOOD).report), "+1 · win-gpu · windows 10.0.26100 · cu128 · 0.5.5");
});

test("the log line is appended once, however often the logs land", () => {
  const once = withLogsLine("body", "a".repeat(32));
  assert.match(once, /Full logs: kept, id `a{32}`/);
  assert.equal(withLogsLine(once, "b".repeat(32)), once);
});

// ---- rate limits -------------------------------------------------------

test("five a day per machine, then no more", () => {
  assert.equal(rateDecision({ installCount: 4 }).ok, true);
  assert.equal(rateDecision({ installCount: 5 }).ok, false);
});

test("an address is capped even when the install ids differ", () => {
  assert.equal(rateDecision({ installCount: 0, ipCount: 5 }).reason, "per address");
});

test("the day itself has a ceiling", () => {
  assert.equal(rateDecision({ totalCount: 200 }).reason, "daily total");
});

test("the caps are configurable, because the owner sets them in the dashboard", () => {
  assert.equal(rateDecision({ installCount: 5 }, { perDay: 10 }).ok, true);
});

// ---- ids, keys and signed links ----------------------------------------

test("an id is 32 hex characters, and not the same one twice", () => {
  const a = newId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newId());
});

test("a log object is filed by month and fingerprint", () => {
  const key = logObjectKey({ fingerprint: "0123456789ab", id: "a".repeat(32), now: Date.UTC(2026, 8, 9) });
  assert.equal(key, `2026-09/0123456789ab/${"a".repeat(32)}.tar.gz`);
});

test("a day key is the UTC date", () => {
  assert.equal(dayKey(Date.UTC(2026, 8, 9, 23, 30)), "2026-09-09");
});

test("the log line names the archive and carries no link", () => {
  const line = logsLine("a".repeat(32));
  assert.equal(line, `Full logs: kept, id \`${"a".repeat(32)}\``);
  assert.ok(!/https?:/.test(line));
});

test("a body written with a log reference carries no link either", () => {
  const body = issueBody(validateReport(GOOD).report, { logsRef: "a".repeat(32) });
  assert.ok(!/https?:\/\//.test(body.split("\n").find((l) => l.startsWith("Full logs:"))));
});

// "A erase failed" was what an erase report said (2026-09-10). Three of the
// five kinds begin with a vowel, so the article is chosen, not written in.
test("the first line takes the article the kind needs", () => {
  const line = (kind) => issueBody({ ...validateReport({ ...GOOD, kind }).report }).split("\n")[0];
  assert.match(line("dub"), /^A dub failed on PersoDub /);
  assert.match(line("erase"), /^An erase failed on PersoDub /);
  assert.match(line("install"), /^An install failed on PersoDub /);
  assert.match(line("agent"), /^An agent failed on PersoDub /);
  assert.match(line("unknown"), /^An unknown failed on PersoDub /);
});

// --- the tally line ------------------------------------------------------
// One issue per failure, and the repeats counted in its body rather than
// piled up as comments: a bot account's reaction cannot count past one, and
// a hundred "+1" comments bury the report they are about (user, 2026-09-10).

test("the tally says how many times and on what, newest counts included", () => {
  const t1 = tallyLine({ count: 1, envs: ["win-gpu · windows 10.0.26100 · cu128"], versions: ["0.5.5"] });
  assert.equal(t1, "Seen 1 time · win-gpu · windows 10.0.26100 · cu128 · 0.5.5");
  const t47 = tallyLine({ count: 47, envs: ["win-gpu · win 10", "mac · mac 24"], versions: ["0.5.4", "0.5.5"] });
  assert.equal(t47, "Seen 47 times · win-gpu · win 10, mac · mac 24 · 0.5.4, 0.5.5");
});

test("the tally replaces the one before it and never stacks", () => {
  const body = "An erase failed on PersoDub 0.5.5. Reported automatically by the app.\n\n### Environment\n";
  const once = withTally(body, { count: 2, envs: ["mac · mac 24"], versions: ["0.5.5"] });
  assert.match(once, /Seen 2 times/);
  assert.ok(once.startsWith("An erase failed"), "the report itself stays first");
  assert.ok(once.includes("### Environment"), "and the rest of the body is untouched");
  const twice = withTally(once, { count: 3, envs: ["mac · mac 24"], versions: ["0.5.5"] });
  assert.match(twice, /Seen 3 times/);
  assert.equal(twice.match(/Seen \d+ time/g).length, 1, "one tally, not two");
});

test("a body written before tallies existed grows one", () => {
  const old = "An erase failed on PersoDub 0.5.5.\n\n### Environment\n| OS | mac |\n";
  const out = withTally(old, { count: 5, envs: ["mac · mac 24"], versions: ["0.5.5"] });
  assert.match(out, /Seen 5 times/);
  assert.ok(out.includes("| OS | mac |"));
});

test("what a repeat adds to what was already counted", () => {
  const seen = { count: 4, envs: ["mac · mac 24"], versions: ["0.5.4"] };
  const { report } = validateReport(GOOD);
  const next = countSighting(seen, report);
  assert.equal(next.count, 5);
  assert.deepEqual(next.envs, ["mac · mac 24", "win-gpu · windows 10.0.26100 · cu128"]);
  assert.deepEqual(next.versions, ["0.5.4", "0.5.5"]);
  // The same machine again adds to the count and to nothing else.
  const again = countSighting(next, report);
  assert.equal(again.count, 6);
  assert.deepEqual(again.envs, next.envs);
  assert.deepEqual(again.versions, next.versions);
});

test("the first sighting starts the tally at one", () => {
  const { report } = validateReport(GOOD);
  const first = countSighting(null, report);
  assert.equal(first.count, 1);
  assert.deepEqual(first.versions, ["0.5.5"]);
});

// ---- what a message may still carry -------------------------------------

// The tail of a job log opens with the video's own name when the job died
// early, and that name reached twelve public issues (2026-09-15).
test("a video's name is dropped from the message, the stages and the error stay", () => {
  const raw = [
    "Uzak Şehir 29. Bölüm (run again)",
    "1/6 Separating background audio locally (Demucs)…",
    "   Perso workspace: mahop072 (#603412)",
    "Error: RuntimeError: Voice separation failed on this computer. Check the video file.",
    "interrupted",
  ].join("\n");
  const out = scrubMessage(raw, "dub");
  assert.ok(!out.includes("Uzak"), out);
  assert.ok(out.startsWith("1/6 Separating"), out);
  assert.ok(out.includes("   Perso workspace"), out);
  assert.ok(out.includes("Error: RuntimeError"), out);
  assert.ok(out.endsWith("interrupted"), out);
});

test("a message with only the name in it becomes empty rather than the name", () => {
  assert.equal(scrubMessage("my holiday.mp4", "dub"), "");
  assert.equal(scrubMessage("https://youtu.be/abc", "erase"), "");
});

test("an install's one-line message is the error and is kept whole", () => {
  assert.equal(scrubMessage("spawn UNKNOWN", "install"), "spawn UNKNOWN");
  assert.equal(scrubMessage("Health check timed out after 120000ms", "install"),
               "Health check timed out after 120000ms");
});

test("validateReport scrubs the message before anything reads it", () => {
  const r = validateReport({ ...GOOD, message: "Secret Title\n2/6 Transcribing…\n   Error: x" });
  assert.ok(r.ok);
  assert.ok(!r.report.message.includes("Secret Title"));
  assert.ok(r.report.message.includes("2/6 Transcribing"));
});

// Four issues carried a Windows account name because Python doubles the
// backslashes in a path and the masks only knew the single kind (2026-09-15).
test("a doubled-backslash Windows path is still a home path", () => {
  const out = maskAgain("Command '['C:\\\\Users\\\\yonav\\\\AppData\\\\Local\\\\PersoDub\\\\x.exe']");
  assert.ok(!out.includes("yonav"), out);
  assert.ok(out.includes("~\\AppData"), out);
});

test("the Perso workspace name and number are both masked", () => {
  assert.equal(maskAgain("   Perso workspace: mahop072 (#603412)"), "   Perso workspace: *");
});

test("the workspace project folder, named after the video, is masked on the way past", () => {
  const out = maskAgain("at ~\\AppData\\Local\\PersoDub\\app\\workspace\\2026-09-11\\Secret Show 29_ko\\input.mp4");
  assert.ok(!out.includes("Secret"), out);
  assert.ok(out.includes("2026-09-11\\*\\input.mp4"), out);
});

// The private dashboard lists a month of archives without opening any of
// them, so what it shows has to be written down when the report arrives.
test("an archive carries enough to be listed without being opened", () => {
  const s = logSummary(validateReport(GOOD).report, 72);
  assert.equal(s.issue, "72");
  assert.equal(s.kind, "dub");
  assert.equal(s.stage, "synthesize");
  assert.equal(s.code, "engine-crash");
  assert.equal(s.platform, "win-gpu");
  assert.equal(s.version, "0.5.5");
  // R2 metadata is strings only, and a number would arrive back as one anyway.
  for (const v of Object.values(s)) assert.equal(typeof v, "string");
});

// A sighting on a closed issue reopens it (report-worker.js); the dashboard
// shows which archives did, and what state they found their issue in.
test("an archive's summary says what state its issue was in and whether the report reopened it", () => {
  const { report } = validateReport(GOOD);
  const fresh = logSummary(report, 72);
  assert.deepEqual([fresh.priorState, fresh.reopened], ["", ""], "a new issue had no state before");
  const again = logSummary(report, 72, { priorState: "closed", reopened: true });
  assert.deepEqual([again.priorState, again.reopened], ["closed", "true"]);
  for (const v of Object.values(again)) assert.equal(typeof v, "string");
});

test("the seen-again comment names the version and the system, and nobody can be mentioned through it", () => {
  const { report } = validateReport({ ...GOOD, version: "0.7.0" });
  assert.equal(seenAgainText(report), "Seen again on 0.7.0, windows 10.0.26100, after the issue was closed.");
  assert.equal(seenAgainText({ ...report, env: { ...report.env, os: "" } }), "Seen again on 0.7.0, after the issue was closed.");
  const forged = validateReport({ ...GOOD, env: { ...GOOD.env, os: "@someone #12 <img src=x>" } }).report;
  assert.doesNotMatch(seenAgainText(forged), /[@#<>]/);
});

test("diagnostics survive validation only in the published shape", () => {
  const { report } = validateReport({ ...GOOD, diagnostics: {
    network: { "pypi.org": { reachable: true, issuer: "ALYac Web Security", root: "ALYac Web Security", chainLength: 2 } },
    proxy: { env: false, system: "direct" },
    madeUp: { anything: 1 },
    antivirus: { products: ["ALYac", "Windows Defender"], "bad key!": "x" },
  } });
  assert.deepEqual(Object.keys(report.diagnostics), ["network", "proxy", "antivirus"]);
  assert.equal(report.diagnostics.network["pypi.org"].issuer, "ALYac Web Security");
  assert.deepEqual(report.diagnostics.antivirus, { products: ["ALYac", "Windows Defender"] });
  assert.deepEqual(validateReport(GOOD).report.diagnostics, {});
});

test("the body shows the diagnostics when there are any, and no section when there are none", () => {
  const { report } = validateReport({ ...GOOD, diagnostics: { proxy: { env: false, system: "direct" } } });
  const body = issueBody(report);
  assert.ok(body.includes("### Diagnostics"), body);
  assert.ok(body.includes('"system": "direct"'), body);
  assert.ok(!issueBody(validateReport(GOOD).report).includes("### Diagnostics"));
});

// ---- the summary ---------------------------------------------------------
// The issue's first section, read off the structured lines the app's logs
// carry (desktop/src/logLine.js, app/jobs.py), each bullet only when the tails
// say something. Hand-written tails, the way the app sends them.
import { tailMessages, openStep, failedAfter, lastStarting, summaryLines } from "./report-logic.js";

const head = (source, level = "INFO") => `2026-10-15 22:31:05,494 - ${source} - ${level} - `;
const job = (...lines) => lines.map(([level, m]) => head("job-ab12cd34", level) + m).join("\n");
const JOB_OK = job(
  ["INFO", "JOB START (dub)"],
  ["INFO", 'Inputs: {"kind":"dub","language":"ko","note":"a - b"}'],
  ["INFO", "##############################"],
  ["INFO", "[Step 1/6] separate START"],
  ["INFO", "[Step 1/6] separate DONE (12.3s)"],
  ["INFO", "Mem[Host total 24576M free 3120M | shell 142M | backend 310M | engine 2875M]"],
  ["INFO", "JOB ALL DONE (240.0s)"],
);
const JOB_FAILED = job(
  ["INFO", 'Inputs: {"kind":"dub","language":"ko"}'],
  ["INFO", "[Step 2/6] transcribe START"],
  ["INFO", "[Step 2/6] transcribe DONE (30.0s)"],
  ["INFO", "[Step 3/6] translate START"],
  ["INFO", "Mem[Host total 24576M free 900M | shell 142M | backend 9310M]"],
  ["ERROR", "[Step 3/6] translate FAILED (1.2s): RuntimeError"],
  ["ERROR", "JOB FAILED at step 3/6 translate (43.5s): RuntimeError: the model refused (5.0s)"],
);
const OLD_TAIL = "1/6 Separating…\n2/6 Transcribing…\n   Error: RuntimeError: x";

test("a tail's messages are its lines without time, source and level, and an older line is all message", () => {
  assert.deepEqual(tailMessages(`${head("shell")}Inputs: {"a":"x - y"}\r\n\n2026-10-10T00:00:00.000Z PERSODUB_VERSION 0.7.1`),
    ['Inputs: {"a":"x - y"}', "2026-10-10T00:00:00.000Z PERSODUB_VERSION 0.7.1"]);
});

test("where a run stopped, after how long, and what it was given, from the structured lines", () => {
  const ok = tailMessages(JOB_OK);
  assert.equal(openStep(ok), "", "every step that started finished");
  assert.equal(failedAfter(ok), "");
  assert.equal(lastStarting(ok, "Inputs: "), 'Inputs: {"kind":"dub","language":"ko","note":"a - b"}');
  assert.match(lastStarting(ok, "Mem["), /^Mem\[Host total 24576M/);

  const failed = tailMessages(JOB_FAILED);
  assert.equal(openStep(failed), "3/6 translate", "a step that FAILED is where it stopped");
  assert.equal(failedAfter(failed), "1.2", "the step's own seconds, not the job's");
  const between = tailMessages(job(["ERROR", "JOB FAILED at step ? (5.0s): OSError: x (9.9s)"]));
  assert.equal(failedAfter(between), "5.0", "between steps: the job's seconds, the first after FAILED");
  assert.equal(openStep(tailMessages(job(["INFO", "[Step 2/6] transcribe START"], ["INFO", "[Step 2/6] transcribe CANCELLED (3.0s)"]))), "");
  assert.equal(openStep(tailMessages(job(["ERROR", "[Step 2/6] transcribe FAILED (9.0s): OSError"]))), "2/6 transcribe",
    "a FAILED line names its step even when its START is out of the tail");
  // The app's "..." stands for lines left out: the step open before it may
  // have ended among them.
  const gap = [`${head("job-ab12cd34")}[Step 1/6] separate START`, "...", `${head("job-ab12cd34")}3/6 Translating… 40%`].join("\n");
  assert.equal(openStep(tailMessages(gap)), "");

  const old = tailMessages(OLD_TAIL);
  assert.deepEqual([openStep(old), failedAfter(old), lastStarting(old, "Inputs: "), lastStarting(old, "Mem[")], ["", "", "", ""]);
});

test("the issue opens with a summary: the step it stopped in, its seconds, the error, the inputs, the memory", () => {
  const { report } = validateReport({ ...GOOD, logTails: { shell: "", app: "", job: JOB_FAILED } });
  const body = issueBody(report);
  assert.ok(body.indexOf("### Summary") < body.indexOf("### Environment"), body);
  assert.deepEqual(summaryLines(report), [
    "- Stopped at: `3/6 translate`",
    "- After: 1.2s",
    "- Error: engine-crash · `RuntimeError: the voice engine exited`",
    '- Inputs: `{"kind":"dub","language":"ko"}`',
    "- Memory: `Mem[Host total 24576M free 900M | shell 142M | backend 9310M]`",
  ]);
  assert.ok(body.includes("- Stopped at: `3/6 translate`\n- After: 1.2s\n"), body);
});

test("an install's summary comes from the shell's tail", () => {
  const shell = [
    `${head("shell")}INSTALL START (install): 6 steps, 0.9 GB to download`,
    `${head("shell")}Inputs: {"edition":"opensource","steps":["payload","python"]}`,
    `${head("shell")}[Step 1/6] payload START`,
    `${head("shell", "ERROR")}[Step 1/6] payload FAILED (0.4s): ENOENT: no such file`,
    `${head("shell", "ERROR")}INSTALL FAILED at step 1/6 payload (0.5s): unknown`,
  ].join("\n");
  const { report } = validateReport({ ...GOOD, kind: "install", stage: "", stageMarker: "", step: "payload",
    code: "step-failed", message: "ENOENT: no such file", logTails: { shell, app: "", job: "" } });
  assert.deepEqual(summaryLines(report), [
    "- Stopped at: `1/6 payload`",
    "- After: 0.4s",
    "- Error: step-failed · `ENOENT: no such file`",
    '- Inputs: `{"edition":"opensource","steps":["payload","python"]}`',
  ]);
});

test("with no structured lines the summary is the error, and the stage when the report names one", () => {
  const bare = { ...GOOD, stage: "", stageMarker: "", message: OLD_TAIL, logTails: { shell: "PERSODUB_READY", app: "", job: OLD_TAIL } };
  assert.deepEqual(summaryLines(validateReport(bare).report), ["- Error: engine-crash · `Error: RuntimeError: x`"],
    "the line that names the error, not the first one");
  assert.deepEqual(summaryLines(validateReport({ ...bare, stage: "synthesize", stageMarker: "4/6" }).report)[0],
    "- Stopped at: `4/6 synthesize`");
});

test("a job's summary reads only the job's log, and an install's only the shell's", () => {
  const shell = [
    `${head("shell")}Inputs: {"edition":"opensource"}`,
    `${head("shell")}Mem[Host total 1M free 1M | shell 1M]`,
    `${head("shell")}[Step 1/6] payload START`,
  ].join("\n");
  // A dub whose own log has no structured lines: nothing comes over from the shell's.
  const dub = validateReport({ ...GOOD, stage: "", stageMarker: "", logTails: { shell, app: "", job: OLD_TAIL } }).report;
  assert.deepEqual(summaryLines(dub), ["- Error: engine-crash · `RuntimeError: the voice engine exited`"]);
  // An engine that did not start is reported as an install: the shell's log, never a job's.
  const engine = validateReport({ ...GOOD, kind: "install", stage: "", stageMarker: "", code: "engine-start",
    logTails: { shell, app: "", job: JOB_FAILED } }).report;
  assert.deepEqual(summaryLines(engine), [
    "- Stopped at: `1/6 payload`",
    "- Error: engine-start · `RuntimeError: the voice engine exited`",
    '- Inputs: `{"edition":"opensource"}`',
    "- Memory: `Mem[Host total 1M free 1M | shell 1M]`",
  ]);
});

// The relay keeps 20,000 characters of a tail. It kept the first of them, so
// a long tail went up without its last lines, the ones naming the failure.
test("a tail cut to fit keeps its end", () => {
  const long = [...Array.from({ length: 3000 }, (_, i) => `line ${i} of a long log`), "THE END"].join("\n");
  const { report } = validateReport({ ...GOOD, logTails: { shell: long, app: "", job: long } });
  assert.equal(report.logTails.shell.length, 20000);
  assert.ok(report.logTails.shell.endsWith("\nTHE END"));
  assert.ok(report.logTails.job.endsWith("\nTHE END"));
});

test("the probes' findings join the summary on one line", () => {
  const { report } = validateReport({ ...GOOD, diagnostics: { proxy: { env: false, system: "direct" } } });
  assert.equal(summaryLines(report).at(-1), '- Diagnostics: `{"proxy":{"env":false,"system":"direct"}}`');
});

// ---- the engines' console logs, the body's size, a failure's own words ----
import { lastCause, stepContext, MAX_BODY_CHARS } from "./report-logic.js";

test("the engines' console logs are accepted, cut to their end, and shown after the other three when they have anything", () => {
  const long = [...Array.from({ length: 3000 }, (_, i) => `line ${i} of a long log`), "THE END"].join("\n");
  const { report } = validateReport({ ...GOOD, logTails: { ...GOOD.logTails, backend: long, sidecar: "RuntimeError: out of memory", ollama: "" } });
  assert.equal(report.logTails.backend.length, 20000);
  assert.ok(report.logTails.backend.endsWith("\nTHE END"));
  assert.equal(report.logTails.ollama, "");
  const body = issueBody(report);
  const at = (title) => body.indexOf(`<details><summary>${title}</summary>`);
  assert.ok(at("job log (tail)") >= 0 && at("job log (tail)") < at("backend.log (tail)"), "after the other three");
  assert.ok(at("backend.log (tail)") < at("sidecar.log (tail)"));
  assert.ok(body.includes("RuntimeError: out of memory"));
  assert.equal(at("ollama.log (tail)"), -1, "an empty log has no section");
  assert.ok(!issueBody(validateReport(GOOD).report).includes("backend.log"), "an app that sends none reads as before");
});

// GitHub refuses a body over 65,536 characters, and the report would then
// never be posted: six full tails add up to more than that.
test("a body that would pass GitHub's limit loses its longest tails' oldest lines until it fits", () => {
  const fat = (name) => Array.from({ length: 800 }, (_, i) => `${name} line ${i} ${"x ".repeat(10)}`).join("\n");
  const { report } = validateReport(GOOD);
  const names = ["shell", "app", "job", "backend", "sidecar", "ollama"];
  const body = issueBody({ ...report, logTails: Object.fromEntries(names.map((n) => [n, fat(n)])) });
  assert.ok(body.length <= MAX_BODY_CHARS, `${body.length} characters`);
  for (const n of names) assert.ok(body.includes(`${n} line 799 `), `${n} keeps its last line`);
  assert.ok(body.includes("### Summary"));
  assert.ok(body.endsWith(`Fingerprint: \`${report.fingerprint}\`\n`), "everything below the tails is kept");
});

test("the summary names the error a failure was chained from, and the stopped step's context", () => {
  const tail = [
    job(["INFO", 'Inputs: {"kind":"dub"}'],
      ["INFO", "[Step 2/6] transcribe Context: engine=whisper model=small"],
      ["INFO", "[Step 3/6] translate START"],
      ["INFO", "[Step 3/6] translate Context: translate_engine=gemma lines=12 target=English source=ko"],
      ["ERROR", "[Step 3/6] translate FAILED (1.2s): RuntimeError"],
      ["ERROR", "  Caused by: OSError: x"]),
    "  Caused by: ValueError: y",   // a traceback's own line, under the one with the head
    job(["ERROR", "JOB FAILED at step 3/6 translate (43.5s): RuntimeError: the model refused"]),
  ].join("\n");
  const messages = tailMessages(tail);
  assert.equal(lastCause(messages), "ValueError: y");
  assert.equal(stepContext(messages, "3/6 translate"), "translate_engine=gemma lines=12 target=English source=ko");
  assert.equal(stepContext(messages, "venv-engines"), "", "only a numbered step has a Context line");
  assert.deepEqual(summaryLines(validateReport({ ...GOOD, logTails: { shell: "", app: "", job: tail } }).report), [
    "- Stopped at: `3/6 translate`",
    "- After: 1.2s",
    "- Error: engine-crash · `RuntimeError: the voice engine exited`",
    "- Cause: `ValueError: y`",
    '- Inputs: `{"kind":"dub"}`',
    "- Context: `translate_engine=gemma lines=12 target=English source=ko`",
  ]);
  // An install has no job log: a "Caused by:" a tool printed into shell.log is not a job's cause.
  const install = validateReport({ ...GOOD, kind: "install", stage: "", stageMarker: "", code: "step-failed",
    logTails: { shell: `${head("shell", "ERROR")}  Caused by: NewConnectionError`, app: "", job: "" } }).report;
  assert.ok(!summaryLines(install).some((l) => l.startsWith("- Cause") || l.startsWith("- Context")));
});

test("the edition is kept when it is one of the two, dropped otherwise, and shown in the issue", () => {
  const { report } = validateReport({ ...GOOD, env: { ...GOOD.env, edition: "production" } });
  assert.equal(report.env.edition, "production");
  assert.ok(issueBody(report).includes("| Edition | production |"), issueBody(report));
  assert.equal(validateReport({ ...GOOD, env: { ...GOOD.env, edition: "<b>x</b>" } }).report.env.edition, "");
  assert.ok(issueBody(validateReport(GOOD).report).includes("| Edition | ? |"));
});

// ---- the device ------------------------------------------------------------
// The first twelve characters of the app's usage id (0.8.7) are for the private
// dashboard: the archive's summary carries them, and nothing the public issue is
// made of does (owner decision, 2026-10-21).
const DEVICE = "fedcba987654";

test("a device of twelve hex characters is kept, anything else is dropped and the report still goes", () => {
  assert.equal(validateReport({ ...GOOD, device: DEVICE }).report.device, DEVICE);
  for (const bad of ["fedcba9876543210fedcba9876543210", "FEDCBA987654", "fedcba98765", "<b>x</b>", 123456789012, null]) {
    const { ok, report } = validateReport({ ...GOOD, device: bad });
    assert.ok(ok, String(bad));
    assert.equal(report.device, "", String(bad));
  }
  assert.equal(validateReport(GOOD).report.device, "", "an app before 0.8.7 sends none");
});

test("the device reaches the archive's summary and nothing the public issue is made of", () => {
  const { report } = validateReport({ ...GOOD, device: DEVICE });
  assert.equal(logSummary(report, 72).device, DEVICE);
  assert.equal(logSummary(validateReport(GOOD).report, 72).device, "");
  const pub = [issueTitle(report), issueBody(report, { logsRef: "a".repeat(32) }), ...summaryLines(report),
               commentText(report), seenAgainText(report), ...labelsFor(report), tallyLine(countSighting(null, report))].join("\n");
  assert.ok(!pub.includes(DEVICE), pub);
});

test("a device field the app's debug print left in a log tail is masked on the way past", () => {
  const shell = `[persodub-report] would send: {"kind":"dub","device":"${DEVICE}","code":"unknown"}`;
  const { report } = validateReport({ ...GOOD, device: DEVICE, logTails: { ...GOOD.logTails, shell } });
  assert.match(report.logTails.shell, /"device":"\[REDACTED\]"/);
  assert.ok(!issueBody(report).includes(DEVICE));
  assert.equal(logSummary(report, 72).device, DEVICE, "the summary keeps its own copy");
});

// ---- a finished job's record (POST /record, 0.8.8) -----------------------

import { RECORD_KINDS, TIMING_KEYS, validateRecord } from "./report-logic.js";
import { RECORD_KINDS as APP_RECORD_KINDS } from "../desktop/src/report.js";
import { timingSeconds } from "../desktop/src/analytics.js";

test("a record's kinds and timing names are the app's, word for word", () => {
  assert.deepEqual([...RECORD_KINDS].sort(), [...APP_RECORD_KINDS].sort());
  const every = timingSeconds({ elapsed_seconds: 1, stage_seconds: { separate: 1, transcribe: 1, translate: 1, synthesize: 1 } });
  assert.deepEqual(Object.keys(TIMING_KEYS).sort(), Object.keys(every).sort());
});

// What the app sends for a finished dub (desktop/src/report.js, code "ok").
const APP_RECORD = buildReport({
  kind: "dub", code: "ok", version: "0.8.8", installId: "0123456789abcdef0123456789abcdef", device: DEVICE,
  env: collectEnvironment({ appVersion: "0.8.8", freeDiskBytes: 180 * 1024 ** 3,
    sys: { platform: "darwin", release: "24.6.0", arch: "arm64", cpuModel: "Apple M4", cores: 10, totalMemBytes: 24 * 1024 ** 3 } }),
  timing: { started_hour: 9, elapsed_seconds: 80, stage_seconds: { separate: 10, transcribe: 20, translate: 5, synthesize: 40, build: 3 } },
});

// The dashboard knows a finished job by "ok/" in its key or outcome "ok", and
// reads its times under the short names (its contract, 2026-10-22).
test("the app's record passes the relay's check and becomes the summary the dashboard reads", () => {
  const { ok, record } = validateRecord(JSON.stringify(APP_RECORD));
  assert.ok(ok);
  assert.deepEqual(logSummary(record, ""), {
    issue: "", kind: "dub", stage: "done", marker: "", code: "ok", platform: "mac", os: "mac 24.6.0",
    cpu: "Apple M4", ram: "24", disk: "180", version: "0.8.8", device: DEVICE, priorState: "", reopened: "",
    outcome: "ok", elapsed: "80", sep: "10", stt: "20", translate: "5", voice: "40",
  });
});

test("a record is held to the three kinds and to whole seconds, and a step that did not run is empty", () => {
  const { record } = validateRecord({ ...APP_RECORD, kind: "install", device: "",
    timing: { elapsed_seconds: 41, sep_seconds: -1, stt_seconds: 2.5, translate_seconds: "5", voice_seconds: null, title: 7 } });
  assert.deepEqual([record.kind, record.stage, record.code, record.timing], ["unknown", "done", "ok", { elapsed_seconds: 41 }]);
  const summary = logSummary(record, "");
  assert.deepEqual([summary.elapsed, summary.sep, summary.stt, summary.translate, summary.voice, summary.device],
    ["41", "", "", "", "", ""]);
  for (const v of Object.values(summary)) assert.equal(typeof v, "string");
  assert.equal(validateRecord({ ...APP_RECORD, installId: "" }).ok, false, "an install id to limit by, as a report needs");
});

test("a failure's summary says it failed and carries no times", () => {
  const s = logSummary(validateReport(GOOD).report, 72);
  assert.equal(s.outcome, "failed");
  for (const key of Object.values(TIMING_KEYS)) assert.equal(key in s, false, key);
});
