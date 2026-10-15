// Run with: node --test desktop/src/reporting.test.mjs
// The relay, the backend and the window are stand-ins: nothing here reaches
// the network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReporter, REPORT_ENDPOINT } from "./reporting.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const ISSUE = { id: "r1", issue: 142, url: "https://github.com/o/r/issues/142" };

// A packaged app with reports on, its kit and userData in a fresh temp folder.
// `relay(url, init)` answers every request the reporter makes, and `probes`
// stands in for the machine's own diagnostics (diagnostics.js).
function setup({ packaged = true, kitEnv = "PERSODUB_NO_REPORTS=0\nPERSODUB_REPORTS_DEBUG=0\n",
                 engines = null, relay = () => ok(ISSUE), probes = async () => ({}) } = {}) {
  const base = mkdtempSync(join(tmpdir(), "odreporting-"));
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
    calls.push({ url, method: init.method || "GET", body: init.body });
    return relay(url, init);
  };
  const reporter = createReporter({
    app, BrowserWindow: { getAllWindows: () => [win] }, ctx: { engines },
    shellLog: (line) => logged.push(line), fetchImpl, probeImpl: probes,
  });
  const queued = () => (existsSync(join(kitDir, "reports")) ? readdirSync(join(kitDir, "reports")).sort() : []);
  const readQueued = (name) => JSON.parse(readFileSync(join(kitDir, "reports", name), "utf8"));
  return { kitDir, userData, reporter, pushed, logged, calls, queued, readQueued };
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

test("a failure that is the user's own situation is logged, never sent", async () => {
  const s = setup();
  await s.reporter.sendReport({ kind: "install", kitDir: s.kitDir, code: "disk-full", message: "Needs 9 GB" });
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.logged, ["[persodub-report] not sent (disk-full): the user's own situation"]);
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
});
