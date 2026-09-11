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
  logExpiry,
  logObjectKey,
  logUrl,
  maskAgain,
  newId,
  rateDecision,
  signLog,
  tallyLine,
  validateReport,
  verifyLog,
  withLogsLine,
  withTally,
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
    message: "at /Users/jane/kit with sk-abcd1234efgh5678",
    logTails: { shell: "GET https://cdn.example.com/a/b?token=zzz", app: "", job: "" },
  });
  assert.equal(report.message, "at ~/kit with [REDACTED]");
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

test("a body written with a log link says so", () => {
  const body = issueBody(validateReport(GOOD).report, { logsUrl: "https://r/logs/x" });
  assert.match(body, /Full logs: https:\/\/r\/logs\/x/);
});

test("a repeat is one line naming the machine and the version", () => {
  assert.equal(commentText(validateReport(GOOD).report), "+1 · win-gpu · windows 10.0.26100 · cu128 · 0.5.5");
});

test("the log line is appended once, however often the logs land", () => {
  const once = withLogsLine("body", "https://r/logs/x");
  assert.match(once, /Full logs: https:\/\/r\/logs\/x/);
  assert.equal(withLogsLine(once, "https://r/logs/y"), once);
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

test("a signed link verifies, and only that one", async () => {
  const id = "b".repeat(32);
  const exp = logExpiry(Date.now());
  const sig = await signLog(id, exp, "secret");
  assert.equal(await verifyLog(id, exp, sig, "secret"), true);
  assert.equal(await verifyLog(id, exp, sig, "other secret"), false);
  assert.equal(await verifyLog("c".repeat(32), exp, sig, "secret"), false);
  assert.equal(await verifyLog(id, exp + 1, sig, "secret"), false);
  assert.equal(await verifyLog(id, exp, "", "secret"), false);
});

test("an expired link stops working", async () => {
  const id = "b".repeat(32);
  const exp = Math.floor(Date.now() / 1000) - 1;
  assert.equal(await verifyLog(id, exp, await signLog(id, exp, "secret"), "secret"), false);
});

test("a link that is thirty days old is still inside its life", async () => {
  const now = Date.now();
  const exp = logExpiry(now);
  assert.equal(await verifyLog("b".repeat(32), exp, await signLog("b".repeat(32), exp, "s"), "s", now + 29 * 86400000), true);
});

test("the link points at the relay, never at the bucket", () => {
  assert.equal(logUrl("https://relay.example/", "a".repeat(32), 123, "sig+/"),
    `https://relay.example/logs/${"a".repeat(32)}?exp=123&sig=sig%2B%2F`);
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
