// Run with: node --test desktop/src/reporting.test.mjs
// The relay, the backend and the window are stand-ins: nothing here reaches
// the network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { createReporter, REPORT_ENDPOINT } from "./reporting.js";
import { describeDevice } from "./report.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const ISSUE = { id: "r1", issue: 142, url: "https://github.com/o/r/issues/142" };
// The support web app Customer support's inquiries go to (PERSODUB_INQUIRY_URL).
const INQUIRY_URL = "https://script.example/macros/s/abc/exec";

// A packaged app with reports on, its kit and userData in a fresh temp folder
// -- or in an earlier setup's `base`, which is that app's next launch.
// `relay(url, init)` answers every request the reporter makes, and `probes`
// stands in for the machine's own diagnostics (diagnostics.js).
function setup({ packaged = true, kitEnv = "PERSODUB_NO_REPORTS=0\nPERSODUB_REPORTS_DEBUG=0\n",
                 engines = null, relay = () => ok(ISSUE), probes = async () => ({}), inquiryUrl = INQUIRY_URL,
                 account = undefined, base = mkdtempSync(join(tmpdir(), "odreporting-")) } = {}) {
  const kitDir = join(base, "kit");
  const userData = join(base, "userData");
  mkdirSync(kitDir, { recursive: true });
  mkdirSync(join(userData, "logs"), { recursive: true });
  writeFileSync(join(kitDir, "kit.env"), kitEnv);
  writeFileSync(join(userData, "logs", "shell.log"), "2026-10-10T00:00:00.000Z PERSODUB_VERSION 0.7.1\n");
  const app = { isPackaged: packaged, getVersion: () => "0.7.1", getPath: (name) => (name === "userData" ? userData : base) };
  const pushed = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, value) => pushed.push([channel, value]) } };
  const logged = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body, headers: init.headers });
    return relay(url, init);
  };
  const ctx = { engines };
  const reporter = createReporter({
    app, BrowserWindow: { getAllWindows: () => [win] }, ctx,
    shellLog: (line) => logged.push(line), inquiryUrl, account, fetchImpl, probeImpl: probes,
  });
  const queued = () => (existsSync(join(kitDir, "reports")) ? readdirSync(join(kitDir, "reports")).sort() : []);
  const readQueued = (name) => JSON.parse(readFileSync(join(kitDir, "reports", name), "utf8"));
  return { base, ctx, kitDir, userData, reporter, pushed, logged, calls, queued, readQueued };
}

test("a failure goes to the relay with the backend's half, then its logs, and the page hears the issue", async () => {
  const s = setup({
    engines: { url: "http://backend" },
    relay: (url) => {
      if (url === "http://backend/api/report/bundle?job=abc123") {
        return ok({ job: { stage: "synthesize", stageMarker: "4/6" }, logTails: { app: "app tail", job: "job tail" } });
      }
      return url.endsWith("/report") ? ok(ISSUE) : { ok: true, status: 200 };
    },
  });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom", jobId: "abc123" });

  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [
    "GET http://backend/api/report/bundle?job=abc123",
    `POST ${REPORT_ENDPOINT}/report`,
    `POST ${REPORT_ENDPOINT}/report/r1/logs`,
  ]);
  const sent = JSON.parse(s.calls[1].body);
  assert.equal(sent.kind, "dub");
  assert.equal(sent.message, "boom");
  assert.equal(sent.stage, "synthesize");
  assert.equal(sent.stageMarker, "4/6");
  assert.equal(sent.logTails.job, "job tail");
  // The id is minted and kept before the report is built: the two match.
  assert.equal(sent.installId, JSON.parse(readFileSync(join(s.userData, "reports.json"), "utf8")).device);
  const announced = { ...ISSUE, dedup: false };
  assert.deepEqual(s.pushed, [["shell:report-sent", announced]]);
  assert.deepEqual(s.reporter.lastReport(), announced);
  assert.deepEqual(s.queued(), [], "nothing left to retry");
  assert.ok(s.logged.includes(`[persodub-report] sent id r1 issue #142 (${ISSUE.url})`), s.logged.join("\n"));
});

// The backend's tail of a long job has lost the job's opening; its whole log,
// which it sends for the archive, has not.
test("a job's report is cut from the job's whole log, so its opening lines go too", async () => {
  const full = ["JOB START (dub)", "Inputs: {}", ...Array.from({ length: 400 }, (_, i) => `line ${i}`)].join("\n");
  const s = setup({
    engines: { url: "http://backend" },
    relay: (url) => (url === "http://backend/api/report/bundle?job=abc123"
      ? ok({ job: {}, logTails: { job: full.split("\n").slice(-200).join("\n") }, logs: { job: full } })
      : url.endsWith("/report") ? ok(ISSUE) : { ok: true, status: 200 }),
  });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom", jobId: "abc123" });
  const job = JSON.parse(s.calls[1].body).logTails.job.split("\n");
  assert.deepEqual([job[0], job[1], job[25], job.at(-1)], ["JOB START (dub)", "Inputs: {}", "...", "line 399"]);
});

// The engines' console logs, beside shell.log: where a voice engine or Ollama
// that crashed says why. In the report their last 80 lines, masked; in the
// archive their last 2 MB; a log that is not there is in neither.
test("a report carries the engines' console logs that are there, masked, in the report and the archive", async () => {
  const s = setup();
  const home = dirname(s.userData);   // what the stand-in app answers for "home"
  const logs = join(s.userData, "logs");
  const request = `"GET /api/subtitles?video_path=${encodeURIComponent(join(home, "Secret Show.mp4"))} HTTP/1.1" 200`;
  writeFileSync(join(logs, "backend.log"), [...Array.from({ length: 300 }, (_, i) => `backend ${i}`), request].join("\n"));
  writeFileSync(join(logs, "sidecar.log"), `Traceback (most recent call last):\nRuntimeError: no memory at ${join(home, "kit", "x")}\n`);
  await s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "engine-start", message: "boom" });

  const { logTails } = JSON.parse(s.calls[0].body);
  assert.equal(logTails.backend.split("\n").length, 80);
  assert.equal(logTails.backend.split("\n").at(-1), '"GET /api/subtitles?… HTTP/1.1" 200');
  assert.ok(!logTails.backend.includes("Secret"), "the encoded video path is gone");
  assert.match(logTails.sidecar, /^Traceback \(most recent call last\):\nRuntimeError: no memory at ~/);
  assert.equal(logTails.ollama, "", "no ollama.log, no tail");
  const archive = gunzipSync(Buffer.from(s.calls[1].body)).toString("latin1");
  assert.ok(archive.includes("backend.log") && archive.includes("sidecar.log"), "both are in the archive");
  assert.ok(!archive.includes("ollama.log"));
  assert.ok(!archive.includes("Secret"), "the archive's copy is cleaned and masked too");
});

test("with the relay out of reach the report waits in the kit, and goes out on the next launch", async () => {
  let up = false;
  const s = setup({
    relay: (url) => {
      if (!up) throw new TypeError("fetch failed");
      return url.endsWith("/report") ? ok({ id: "r2", issue: 7 }) : { ok: true, status: 200 };
    },
  });
  await s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "network", step: "python", message: "fetch failed" });
  const waiting = s.queued();
  assert.equal(waiting.length, 2);
  assert.match(waiting[0], /^[0-9a-f]{12}-\d+\.json$/);
  assert.equal(waiting[1], waiting[0].replace(/\.json$/, ".tar.gz"), "the logs wait beside it");
  assert.equal(s.readQueued(waiting[0]).id, null);
  assert.deepEqual(s.pushed, []);

  up = true;
  s.calls.length = 0;
  await s.reporter.flushReports(s.kitDir);
  assert.deepEqual(s.calls.map((c) => c.url), [`${REPORT_ENDPOINT}/report`, `${REPORT_ENDPOINT}/report/r2/logs`]);
  assert.deepEqual(s.queued(), []);
  assert.equal(s.pushed.length, 1);
});

test("a report whose logs did not follow keeps its id, and only the upload is tried again", async () => {
  let logs = { ok: false, status: 503 };
  const s = setup({ relay: (url) => (url.endsWith("/report") ? ok({ id: "r3", issue: 9 }) : logs) });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  const [json] = s.queued();
  assert.equal(s.readQueued(json).id, "r3");

  logs = { ok: true, status: 200 };
  s.calls.length = 0;
  await s.reporter.flushReports(s.kitDir);
  assert.deepEqual(s.calls.map((c) => c.url), [`${REPORT_ENDPOINT}/report/r3/logs`], "the issue is not opened twice");
  assert.deepEqual(s.queued(), []);
});

test("logs the relay has refused for good are dropped rather than asked about every launch", async () => {
  let logs = { ok: false, status: 503 };
  const s = setup({ relay: (url) => (url.endsWith("/report") ? ok({ id: "r4" }) : logs) });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  assert.equal(s.queued().length, 2);
  logs = { ok: false, status: 404 };   // the relay forgot the id
  await s.reporter.flushReports(s.kitDir);
  assert.deepEqual(s.queued(), []);
});

// A person who closes the error screen at once quits the app while its report
// is still being gathered or sent: an install that ran out of memory was
// counted and never reported (2026-10-20). The failure is on disk before the
// first await, so the launch can die anywhere after the call and the next one
// still builds the report and sends it.
test("a failure is on disk before anything is gathered, and the next launch sends what a dead one left", async () => {
  // This launch dies with its report out: the relay never answers it.
  const s = setup({ relay: () => new Promise(() => {}) });
  void s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "out-of-memory", step: "venv-engines", message: "MemoryError" });
  const [json, ...rest] = s.queued();   // not awaited: on disk as the call returns
  assert.deepEqual(rest, [], "the failure alone, no logs gathered yet");
  const { failure, at } = s.readQueued(json);
  assert.deepEqual(failure, { kind: "install", code: "out-of-memory", step: "venv-engines", message: "MemoryError" });
  assert.match(json, new RegExp(`^[0-9a-f]{12}-${at}\\.json$`), "named for the moment it failed");

  const next = setup({ base: s.base });
  await next.reporter.flushReports(next.kitDir);
  assert.deepEqual(next.calls.map((c) => `${c.method} ${c.url}`),
    [`POST ${REPORT_ENDPOINT}/report`, `POST ${REPORT_ENDPOINT}/report/r1/logs`]);
  const sent = JSON.parse(next.calls[0].body);
  assert.deepEqual([sent.kind, sent.code, sent.step, sent.message], ["install", "out-of-memory", "venv-engines", "MemoryError"]);
  assert.equal(sent.installId, JSON.parse(readFileSync(join(s.userData, "reports.json"), "utf8")).device);
  assert.deepEqual(next.queued(), []);
  assert.equal(next.pushed.length, 1, "the page hears the issue");
});

// A dub's stage comes from the backend; built while the engines are still
// starting, the report would fingerprint as a failure nobody had seen.
test("a failure written down with a job waits for the engines, which know its stage", async () => {
  const s = setup({ relay: () => new Promise(() => {}) });
  void s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom", jobId: "abc123" });

  const next = setup({
    base: s.base,
    relay: (url) => (url === "http://backend/api/report/bundle?job=abc123" ? ok({ job: { stage: "synthesize", stageMarker: "4/6" } })
      : url.endsWith("/report") ? ok(ISSUE) : { ok: true, status: 200 }),
  });
  await next.reporter.flushReports(next.kitDir);   // as the launch starts
  assert.deepEqual(next.calls, []);
  assert.equal(next.queued().length, 1);

  next.ctx.engines = { url: "http://backend" };   // and once the app is up
  await next.reporter.flushReports(next.kitDir);
  assert.equal(next.calls[0].url, "http://backend/api/report/bundle?job=abc123");
  assert.equal(JSON.parse(next.calls[1].body).stage, "synthesize");
  assert.deepEqual(next.queued(), []);
});

// Flushes overlap: the one as a launch starts, the one after an install
// stopped, the one once the app is up. A report sent twice counts twice and
// spends two of the five a day the relay takes from one machine.
test("a flush leaves alone the report sendReport has in hand", async () => {
  let answer;
  const relayUp = new Promise((resolve) => { answer = resolve; });
  const s = setup({ relay: async (url) => { await relayUp; return url.endsWith("/report") ? ok(ISSUE) : { ok: true, status: 200 }; } });
  const sending = s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "unknown", step: "payload", message: "boom" });
  const flushing = s.reporter.flushReports(s.kitDir);   // the install's error screen is up
  answer();
  await Promise.all([sending, flushing]);
  assert.equal(s.calls.filter((c) => c.url === `${REPORT_ENDPOINT}/report`).length, 1);
  assert.deepEqual(s.queued(), []);
});

test("two flushes at once send a waiting report once", async () => {
  let up = false;
  let answer;
  const relayUp = new Promise((resolve) => { answer = resolve; });
  const s = setup({
    relay: async (url) => {
      if (!up) throw new TypeError("fetch failed");
      await relayUp;
      return url.endsWith("/report") ? ok(ISSUE) : { ok: true, status: 200 };
    },
  });
  await s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "unknown", step: "payload", message: "boom" });
  assert.equal(s.queued().length, 2);

  up = true;
  s.calls.length = 0;
  const both = [s.reporter.flushReports(s.kitDir), s.reporter.flushReports(s.kitDir)];
  answer();
  await Promise.all(both);
  assert.deepEqual(s.calls.map((c) => c.url), [`${REPORT_ENDPOINT}/report`, `${REPORT_ENDPOINT}/report/r1/logs`]);
  assert.deepEqual(s.queued(), []);
});

test("a certificate failure carries what the probes found about this machine", async () => {
  const asked = [];
  const s = setup({
    probes: async (names, opts) => {
      asked.push([names, opts.kitDir]);
      return { network: { "pypi.org": { reachable: true, issuer: "ALYac Web Security", root: "ALYac Web Security", chainLength: 2 } },
               proxy: { env: false, system: "direct" } };
    },
  });
  const message = "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain";
  await s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "certificate", step: "venv-app", message });
  assert.deepEqual(asked, [[["network", "proxy"], s.kitDir]]);
  assert.ok(s.logged.includes("PERSODUB_REPORT diagnostics network, proxy"), s.logged.join("\n"));
  const sent = JSON.parse(s.calls.find((c) => c.url === `${REPORT_ENDPOINT}/report`).body);
  assert.equal(sent.code, "certificate");
  assert.equal(sent.diagnostics.network["pypi.org"].issuer, "ALYac Web Security");
  assert.deepEqual(sent.diagnostics.proxy, { env: false, system: "direct" });
});

test("a failure no probe speaks to runs none", async () => {
  let ran = false;
  const s = setup({ probes: async () => { ran = true; return {}; } });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  assert.equal(ran, false);
  assert.deepEqual(JSON.parse(s.calls[0].body).diagnostics, {});
});

test("a failure that is the user's own situation is sent with its logs, marked userSide, for the dashboard; the page hears of no issue", async () => {
  for (const code of ["disk-full", "cloud-refused", "perso-busy", "perso-credits", "perso-key", "perso-length", "perso-plan", "gemini-busy", "gemini-quota"]) {
    const s = setup({ relay: (url) => (url.endsWith("/report") ? ok({ id: "u1" }) : { ok: true, status: 200 }) });
    await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code, message: "Needs 9 GB" });
    assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [`POST ${REPORT_ENDPOINT}/report`, `POST ${REPORT_ENDPOINT}/report/u1/logs`], code);
    const sent = JSON.parse(s.calls[0].body);
    assert.deepEqual([sent.code, sent.userSide], [code, true], code);
    assert.deepEqual(s.logged, ["[persodub-report] sent (no issue: the user's own situation) id u1"], code);
    assert.deepEqual(s.pushed, [], code);
    assert.deepEqual(s.queued(), [], code);
  }
  const fixable = setup();
  await fixable.reporter.sendReport({ kind: "dub", kitDir: fixable.kitDir, code: "unknown", message: "boom" });
  assert.equal(JSON.parse(fixable.calls[0].body).userSide, undefined);
});

test("with reports off nothing is gathered, sent, queued or minted", async () => {
  for (const s of [setup({ packaged: false }), setup({ kitEnv: "PERSODUB_NO_REPORTS=1\n" })]) {
    assert.equal(s.reporter.reportMode(s.kitDir), "off");
    await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.logged, []);
    assert.deepEqual(s.queued(), []);
    assert.equal(existsSync(join(s.userData, "reports.json")), false);
  }
});

test("debug prints what would leave and sends nothing", async () => {
  const s = setup({ kitEnv: "PERSODUB_REPORTS_DEBUG=1\nPERSODUB_NO_REPORTS=0\n" });
  assert.equal(s.reporter.reportMode(s.kitDir), "debug");
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  assert.deepEqual(s.calls, []);
  assert.match(s.logged[0], /^\[persodub-report\] would send: \{"kind":"dub"/);
  assert.match(s.logged[1], /^\[persodub-report\] would attach \d+ bytes of logs$/);
  assert.equal(existsSync(join(s.userData, "reports.json")), false, "no id on disk for a run that sends nothing");
  assert.deepEqual(s.queued(), [], "and no failure written down for a later launch to send");
});

// ---- a finished job's record (code "ok") ----

// A finished dub as the backend tells it: the job's whole log, its first line
// (the video's name) already replaced by the backend (app/api/report.py).
const DONE_BUNDLE = { job: { kind: "dub", status: "done", stage: "build", stageMarker: "6/6", error: "" },
                      logs: { job: "[video]\nJOB START (dub)\nJOB ALL DONE (80.2s)", app: "app log" } };
const TIMING = { started_hour: 9, elapsed_seconds: 80,
                 stage_seconds: { separate: 10, transcribe: 20, translate: 5, synthesize: 40, build: 3 } };

test("a finished job sends its record to /record with its timings and its masked logs, and the page hears nothing", async () => {
  const s = setup({
    engines: { url: "http://backend" },
    relay: (url) => (url === "http://backend/api/report/bundle?job=abc123" ? ok(DONE_BUNDLE)
      : url.endsWith("/record") ? ok({ id: "k1" }) : { ok: true, status: 200 }),
  });
  const home = dirname(s.userData);   // what the stand-in app answers for "home"
  writeFileSync(join(s.userData, "logs", "shell.log"),
    `opened ${join(home, "Movies", "Secret Show.mp4")} from https://www.youtube.com/watch?v=abcdefghijk\n`);
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "ok", jobId: "abc123", timing: TIMING });

  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [
    "GET http://backend/api/report/bundle?job=abc123",
    `POST ${REPORT_ENDPOINT}/record`,
    `POST ${REPORT_ENDPOINT}/report/k1/logs`,
  ]);
  const sent = JSON.parse(s.calls[1].body);
  assert.deepEqual([sent.outcome, sent.kind, sent.code, sent.stage, sent.stageMarker, sent.message],
    ["ok", "dub", "ok", "done", "", ""]);
  assert.deepEqual(sent.timing, { elapsed_seconds: 80, sep_seconds: 10, stt_seconds: 20, translate_seconds: 5, voice_seconds: 40 });
  assert.deepEqual(sent.logTails, {}, "no tails: a record never becomes an issue");
  assert.equal(sent.installId, JSON.parse(readFileSync(join(s.userData, "reports.json"), "utf8")).device);
  const archive = gunzipSync(Buffer.from(s.calls[2].body)).toString("utf8");
  assert.ok(archive.includes("JOB ALL DONE (80.2s)"), "the job's own log is in the archive");
  for (const name of ["Secret Show", "Movies", "watch?v", "abcdefghijk"]) assert.ok(!archive.includes(name), name);
  // The mask is spelled with the path's own separator, so on Windows it reads ~\…\*.mp4.
  assert.ok(archive.includes(`~${sep}…${sep}*.mp4`) && archive.includes("https://www.youtube.com/..."), "masked as a failure's logs are");
  assert.deepEqual(s.pushed, [], "nothing broke, nothing to announce");
  assert.equal(s.reporter.lastReport(), null);
  assert.deepEqual(s.queued(), []);
});

test("with reports off a finished job sends nothing and writes nothing down; debug only prints it", async () => {
  for (const s of [setup({ packaged: false }), setup({ kitEnv: "PERSODUB_NO_REPORTS=1\n" })]) {
    await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "ok", jobId: "abc123", timing: TIMING });
    assert.deepEqual([s.calls, s.logged, s.queued()], [[], [], []]);
  }
  const d = setup({ kitEnv: "PERSODUB_REPORTS_DEBUG=1\n" });
  await d.reporter.sendReport({ kind: "erase", kitDir: d.kitDir, code: "ok", jobId: "abc123", timing: { elapsed_seconds: 41 } });
  assert.deepEqual(d.calls, []);
  assert.match(d.logged[0], /^\[persodub-report\] would send: .*"outcome":"ok","timing":\{"elapsed_seconds":41\}/);
  assert.deepEqual(d.queued(), []);
});

// The same queue-first rule as a failure's: written down before anything is
// gathered, so a launch that ends at once leaves it for the next to send.
test("a finished job written down by a launch that died goes to /record from the next, timings and all", async () => {
  const s = setup({ relay: () => new Promise(() => {}) });
  void s.reporter.sendReport({ kind: "separate", kitDir: s.kitDir, code: "ok", jobId: "abc123", timing: { elapsed_seconds: 12 } });
  const [json] = s.queued();
  assert.deepEqual(s.readQueued(json).failure,
    { kind: "separate", code: "ok", jobId: "abc123", timing: { elapsed_seconds: 12 } });

  const next = setup({
    base: s.base, engines: { url: "http://backend" },
    relay: (url) => (url === "http://backend/api/report/bundle?job=abc123" ? ok(DONE_BUNDLE)
      : url.endsWith("/record") ? ok({ id: "k2" }) : { ok: true, status: 200 }),
  });
  await next.reporter.flushReports(next.kitDir);
  assert.deepEqual(next.calls.map((c) => c.url), ["http://backend/api/report/bundle?job=abc123",
    `${REPORT_ENDPOINT}/record`, `${REPORT_ENDPOINT}/report/k2/logs`]);
  const sent = JSON.parse(next.calls[1].body);
  assert.deepEqual([sent.kind, sent.outcome, sent.timing], ["separate", "ok", { elapsed_seconds: 12 }]);
  assert.deepEqual(next.queued(), []);
  assert.deepEqual(next.pushed, []);
});

// The computer's id (analytics.json, made by the launch: analytics.js
// keepDevice) is the dashboard's name for a computer. Every report and job
// record carries its first twelve characters, counts on or off, and the report
// path never makes one (owner, 2026-10-22).
const COUNTS_ID = "0123456789abcdef0123456789abcdef";

test("a report and a record carry the first twelve characters of the computer's id, counts on or off, and mint none", async () => {
  const s = setup({ relay: (url) => (url.endsWith("/report") ? ok(ISSUE) : url.endsWith("/record") ? ok({ id: "k3" }) : { ok: true, status: 200 }) });
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  assert.equal(JSON.parse(s.calls[0].body).device, "", "no saved id, no device");
  assert.equal(existsSync(join(s.userData, "analytics.json")), false, "nothing minted for it");

  writeFileSync(join(s.userData, "analytics.json"), JSON.stringify({ device: COUNTS_ID, lastDay: null }));
  for (const kitEnv of ["", "PERSODUB_NO_ANALYTICS=1\n"]) {
    writeFileSync(join(s.kitDir, "kit.env"), kitEnv);
    s.calls.length = 0;
    await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
    await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "ok", jobId: "abc123", timing: TIMING });
    const sent = s.calls.filter((c) => /\/(report|record)$/.test(c.url)).map((c) => [c.url.split("/").pop(), JSON.parse(c.body).device]);
    assert.deepEqual(sent, [["report", "0123456789ab"], ["record", "0123456789ab"]], kitEnv || "counts on");
  }

  const d = setup({ kitEnv: "PERSODUB_REPORTS_DEBUG=1\nPERSODUB_NO_ANALYTICS=1\n" });
  writeFileSync(join(d.userData, "analytics.json"), JSON.stringify({ device: COUNTS_ID, lastDay: null }));
  await d.reporter.sendReport({ kind: "dub", kitDir: d.kitDir, code: "unknown", message: "boom" });
  assert.match(d.logged[0], /"device":"0123456789ab"/, "the debug print shows it");
});

test("a report queued while the counts were on still names the computer once they are off", async () => {
  let up = false;
  const s = setup({
    relay: (url) => {
      if (!up) throw new TypeError("fetch failed");
      return url.endsWith("/report") ? ok({ id: "r5", issue: 3 }) : { ok: true, status: 200 };
    },
  });
  writeFileSync(join(s.userData, "analytics.json"), JSON.stringify({ device: COUNTS_ID, lastDay: null }));
  await s.reporter.sendReport({ kind: "dub", kitDir: s.kitDir, code: "unknown", message: "boom" });
  assert.equal(s.readQueued(s.queued()[0]).report.device, "0123456789ab");

  writeFileSync(join(s.kitDir, "kit.env"), "PERSODUB_NO_ANALYTICS=1\n");
  up = true;
  s.calls.length = 0;
  await s.reporter.flushReports(s.kitDir);
  assert.equal(s.calls[0].url, `${REPORT_ENDPOINT}/report`);
  assert.equal(JSON.parse(s.calls[0].body).device, "0123456789ab");
});

// ---- a Service inquiry (production, 0.9.1) ---------------------------------
// Straight to the support web app, never through the relay (owner, 2026-10-27).

const FORM = { type: "bug", subject: " Export stops ", details: "At 90%, every time.", replyTo: "me@example.com", locale: "ko" };
const FACTS = { os: "mac", osVersion: "15.1.0" };
const SENT = (id) => ok({ ok: true, id });
const posted = (call) => JSON.parse(call.body);

test("a bug inquiry goes to the support web app with the app, the computer and the newest job's masked logs inside it, reports off or not", async () => {
  const s = setup({
    kitEnv: "PERSODUB_NO_REPORTS=1\n",
    engines: { url: "http://backend" },
    relay: (url) => {
      if (url === "http://backend/api/dub/jobs") return ok({ jobs: [{ id: "new1" }, { id: "old1" }] });
      if (url === "http://backend/api/report/bundle?job=new1") return ok({ job: {}, logs: { app: "app log", job: "job log of new1" } });
      return url === INQUIRY_URL ? SENT("7C2E91AB") : { ok: false, status: 404 };
    },
  });
  writeFileSync(join(s.userData, "analytics.json"), JSON.stringify({ device: COUNTS_ID, lastDay: null }));
  writeFileSync(join(s.kitDir, "kit.env"), "PERSODUB_NO_REPORTS=1\nPERSODUB_EDITION=production\n");
  const answer = await s.reporter.sendInquiry(FORM, { kitDir: s.kitDir, ...FACTS });

  assert.deepEqual(answer, { id: "7C2E91AB" });
  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [
    "GET http://backend/api/dub/jobs",
    "GET http://backend/api/report/bundle?job=new1",
    `POST ${INQUIRY_URL}`,
  ], "nothing goes to the relay");
  assert.equal(s.calls[2].headers["content-type"], "application/json");
  const { logs, ...fields } = posted(s.calls[2]);
  assert.deepEqual(fields, {
    type: "bug", subject: "Export stops", details: "At 90%, every time.", replyTo: "me@example.com",
    accountEmail: "", accountId: "",
    installId: COUNTS_ID, version: "0.7.1", edition: "production", os: "mac", osVersion: "15.1.0",
    device: describeDevice({ installed: true, edition: "production" }), locale: "ko",
  });
  assert.match(fields.device, / · installed · production$/);
  const archive = gunzipSync(Buffer.from(logs, "base64")).toString("utf8");
  assert.match(archive, /job log of new1/);
  assert.match(archive, /PERSODUB_VERSION 0\.7\.1/, "shell.log too");
  assert.deepEqual(s.logged.filter((l) => l.includes("inquiry")), ["[persodub-report] inquiry sent 7C2E91AB"]);
  assert.deepEqual(s.queued(), []);
  assert.deepEqual(s.pushed, [], "no failure report announced");
});

test("an inquiry of another kind carries no logs, and a form the web app would refuse is not sent", async () => {
  const s = setup({ engines: { url: "http://backend" }, relay: () => SENT("Q2Q2Q2Q2") });
  assert.deepEqual(await s.reporter.sendInquiry({ ...FORM, type: "payment" }, { kitDir: s.kitDir, ...FACTS }), { id: "Q2Q2Q2Q2" });
  assert.deepEqual(s.calls.map((c) => c.url), [INQUIRY_URL]);
  assert.equal("logs" in posted(s.calls[0]), false);
  s.calls.length = 0;
  assert.equal(await s.reporter.sendInquiry({ ...FORM, type: "Bug report" }, { kitDir: s.kitDir, ...FACTS }), null);
  assert.equal(await s.reporter.sendInquiry({ ...FORM, subject: "  " }, { kitDir: s.kitDir, ...FACTS }), null);
  assert.deepEqual(s.calls, []);
});

test("an inquiry carries the signed-in account's full e-mail and Perso number, and empty strings signed out", async () => {
  let signedIn = { email: "someone@example.com", id: "1001" };
  const s = setup({ relay: () => SENT("A1A1A1A1"), account: () => signedIn });
  await s.reporter.sendInquiry({ ...FORM, type: "other", replyTo: "" }, { kitDir: s.kitDir, ...FACTS });
  assert.deepEqual([posted(s.calls[0]).accountEmail, posted(s.calls[0]).accountId, posted(s.calls[0]).replyTo],
    ["someone@example.com", "1001", ""]);
  signedIn = null;
  await s.reporter.sendInquiry({ ...FORM, type: "other" }, { kitDir: s.kitDir, ...FACTS });
  assert.deepEqual([posted(s.calls[1]).accountEmail, posted(s.calls[1]).accountId], ["", ""]);
});

// An account signed in through Google or Microsoft may have no e-mail: with
// no Reply-to either, nobody could answer, so the form is asked for one.
test("with no Reply-to and no account e-mail the shell asks for an address, and sends and keeps nothing", async () => {
  for (const account of [() => ({ email: "", id: "1001" }), () => null]) {
    const s = setup({ relay: () => SENT("N0N0N0N0"), account });
    for (const replyTo of ["", "   ", undefined]) {
      assert.deepEqual(await s.reporter.sendInquiry({ ...FORM, type: "other", replyTo }, { kitDir: s.kitDir, ...FACTS }), { needReplyTo: true });
    }
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.queued(), []);
  }
  const typed = setup({ relay: () => SENT("N1N1N1N1"), account: () => ({ email: "", id: "1001" }) });
  assert.deepEqual(await typed.reporter.sendInquiry({ ...FORM, type: "other" }, { kitDir: typed.kitDir, ...FACTS }), { id: "N1N1N1N1" });
  const fromAccount = setup({ relay: () => SENT("N2N2N2N2"), account: () => ({ email: "someone@example.com", id: "1001" }) });
  assert.deepEqual(await fromAccount.reporter.sendInquiry({ ...FORM, type: "other", replyTo: "" }, { kitDir: fromAccount.kitDir, ...FACTS }),
    { id: "N2N2N2N2" });
});

test("a build with no web app sends nothing, says so, and leaves a waiting inquiry where it is", async () => {
  const s = setup({ inquiryUrl: "" });
  assert.equal(await s.reporter.sendInquiry(FORM, { kitDir: s.kitDir, ...FACTS }), null);
  assert.deepEqual(s.logged, ["[persodub-report] inquiry no destination"]);
  assert.deepEqual(s.queued(), []);
  mkdirSync(join(s.kitDir, "reports"));
  writeFileSync(join(s.kitDir, "reports", `bbbbbbbbbbbb-${Date.now()}.json`),
    JSON.stringify({ inquiry: { type: "other", subject: "s", details: "d" }, id: null }));
  await s.reporter.flushReports(s.kitDir);
  assert.deepEqual(s.calls, [], "and never the relay instead");
  assert.equal(s.queued().length, 1);
});

test("an inquiry the web app did not take waits in the kit and goes to the web app on the next launch, reports off, alone", async () => {
  let answer = () => { throw new TypeError("fetch failed"); };
  const s = setup({ kitEnv: "PERSODUB_NO_REPORTS=1\n", relay: () => answer() });
  assert.deepEqual(await s.reporter.sendInquiry({ ...FORM, type: "other" }, { kitDir: s.kitDir, ...FACTS }), { queued: true });
  const [json] = s.queued();
  assert.deepEqual([s.readQueued(json).inquiry.subject, s.readQueued(json).id], ["Export stops", null]);
  // A failure report waiting beside it stays: its switch is off.
  writeFileSync(join(s.kitDir, "reports", `aaaaaaaaaaaa-${Date.now()}.json`), JSON.stringify({ report: { kind: "dub" }, id: null }));

  // The web app's refusal, and an answer that is not a 2xx, leave it waiting too.
  for (const refused of [ok({ error: "rate limited" }), { ok: false, status: 500, json: async () => ({ ok: true, id: "NOPE" }) }]) {
    answer = () => refused;
    await s.reporter.flushReports(s.kitDir);
    assert.equal(s.queued().length, 2);
  }
  answer = () => SENT("Q3Q3Q3Q3");
  s.calls.length = 0;
  await s.reporter.flushReports(s.kitDir);
  assert.deepEqual(s.calls.map((c) => c.url), [INQUIRY_URL]);
  assert.equal(s.queued().length, 1);
  assert.ok(s.queued()[0].startsWith("aaaaaaaaaaaa-"), "the report is still there");
  assert.deepEqual(s.logged.filter((l) => l.includes("inquiry")), [
    "[persodub-report] inquiry queued", "[persodub-report] inquiry queued", "[persodub-report] inquiry queued",
    "[persodub-report] inquiry sent Q3Q3Q3Q3",
  ]);
});

// A waiting inquiry holds the signed-in account's full e-mail: once the
// account has left this computer, so has every inquiry still waiting.
test("signing out drops the inquiries still waiting, their logs too, and keeps the failure reports", async () => {
  const s = setup({ engines: { url: "http://backend" }, account: () => ({ email: "someone@example.com", id: "1001" }),
    relay: (url) => (url === INQUIRY_URL ? (() => { throw new TypeError("fetch failed"); })() : ok({ jobs: [] })) });
  assert.deepEqual(await s.reporter.sendInquiry(FORM, { kitDir: s.kitDir, ...FACTS }), { queued: true });
  assert.deepEqual(await s.reporter.sendInquiry({ ...FORM, type: "other" }, { kitDir: s.kitDir, ...FACTS }), { queued: true });
  writeFileSync(join(s.kitDir, "reports", `aaaaaaaaaaaa-${Date.now()}.json`), JSON.stringify({ report: { kind: "dub" }, id: null }));
  assert.ok(s.queued().some((n) => n.endsWith(".tar.gz")), "the bug inquiry's logs wait beside it");
  assert.equal(s.queued().length, 4);

  s.reporter.dropInquiries(s.kitDir);
  assert.equal(s.queued().length, 1);
  assert.ok(s.queued()[0].startsWith("aaaaaaaaaaaa-"), "the failure report stays");
  assert.ok(!s.logged.join("\n").includes("someone@example.com"));
  s.reporter.dropInquiries(null);
  s.reporter.dropInquiries(join(s.base, "no-kit"));
});

// What 0.9.1's first cut queued, for the relay: no account fields and a bug's
// logs beside it -- and one the relay had taken whose logs had not followed.
test("an inquiry queued for the relay goes to the web app with its logs as base64, and one the relay took is dropped", async () => {
  const s = setup({ kitEnv: "PERSODUB_NO_REPORTS=1\n", relay: () => SENT("Q4Q4Q4Q4") });
  const reports = join(s.kitDir, "reports");
  mkdirSync(reports);
  const old = { type: "bug", subject: "Export stops", details: "At 90%.", replyTo: "", installId: COUNTS_ID,
                version: "0.9.1", edition: "production", os: "mac", osVersion: "15.1.0", locale: "ko" };
  const at = Date.now();
  writeFileSync(join(reports, `cccccccccccc-${at}.json`), JSON.stringify({ inquiry: old, id: null }));
  writeFileSync(join(reports, `cccccccccccc-${at}.tar.gz`), gzipSync("old logs"));
  writeFileSync(join(reports, `dddddddddddd-${at}.json`), JSON.stringify({ inquiry: old, id: "q1" }));
  writeFileSync(join(reports, `dddddddddddd-${at}.tar.gz`), gzipSync("taken"));
  await s.reporter.flushReports(s.kitDir);

  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [`POST ${INQUIRY_URL}`]);
  const { logs, ...fields } = posted(s.calls[0]);
  assert.deepEqual(fields, old);
  assert.equal(gunzipSync(Buffer.from(logs, "base64")).toString("utf8"), "old logs");
  assert.deepEqual(s.queued(), []);
});

test("logs past 20 MB as base64 are left out, and the details say so inside their 4,000 characters", async () => {
  const s = setup({ relay: () => SENT("Q5Q5Q5Q5") });
  const reports = join(s.kitDir, "reports");
  mkdirSync(reports);
  const at = Date.now();
  writeFileSync(join(reports, `eeeeeeeeeeee-${at}.json`),
    JSON.stringify({ inquiry: { type: "bug", subject: "Big", details: "x".repeat(4000), replyTo: "" }, id: null }));
  writeFileSync(join(reports, `eeeeeeeeeeee-${at}.tar.gz`), Buffer.alloc(16 * 1024 * 1024));   // 21.3 MB as base64
  await s.reporter.flushReports(s.kitDir);

  const body = posted(s.calls[0]);
  assert.equal("logs" in body, false);
  assert.equal(body.details.length, 4000);
  assert.ok(body.details.endsWith("x\n\n(logs too large, not attached)"));
  assert.deepEqual(s.queued(), []);
});
