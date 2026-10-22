import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./report-worker.js";

// Run me: node --test relay/*.test.mjs
// The handler itself, against stand-ins: KV is a Map, GitHub is one issue,
// and nothing here reaches the network.

const DEVICE = "fedcba987654";
const REPORT = {
  kind: "install",
  version: "0.7.0",
  installId: "0123456789abcdef0123456789abcdef",
  device: DEVICE,
  fingerprint: "0123456789ab",
  step: "venv-engines",
  code: "out-of-memory",
  message: "MemoryError",
  env: { platformKey: "win-cpu", os: "windows 10.0.26100", torch: "cpu" },
  packs: {},
  logTails: { shell: "", app: "", job: "" },
};

// The relay's KV namespace, with #106 already known for the report's fingerprint.
function reports() {
  const map = new Map([["fp:0123456789ab", JSON.stringify({
    issue: 106, url: "https://github.com/o/r/issues/106", count: 3, envs: ["win-cpu · windows 10.0.22631 · cpu"], versions: ["0.6.5"],
  })]]);
  return {
    map,
    async get(key, type) { const v = map.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { map.set(key, value); },
  };
}

// GitHub with issue #106 as given. Every request is kept, and a PATCH changes the issue.
function github(t, issue) {
  const calls = [];
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: new URL(url).pathname, body });
    if (method === "PATCH") Object.assign(issue, body);
    return method === "POST" ? Response.json({ id: 1 }, { status: 201 }) : Response.json(issue);
  };
  return calls;
}

async function send(REPORTS) {
  const waits = [];
  const request = new Request("https://relay.test/report", { method: "POST", body: JSON.stringify(REPORT) });
  const res = await worker.fetch(request, { REPORTS, GITHUB_REPO: "o/r", GITHUB_TOKEN: "token" }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res.json();
}

// #106 was closed as fixed in 0.8.1, and a 0.7.0 app reported it again; only
// the count in its body changed, and nobody saw it (2026-10-22).
test("a sighting on an issue closed as fixed reopens it with one comment, counts it, and tells the dashboard", async (t) => {
  const issue = { number: 106, state: "closed", state_reason: "completed", labels: [], body: "An install failed.\n\nMore." };
  const calls = github(t, issue);
  const REPORTS = reports();
  const answer = await send(REPORTS);

  assert.deepEqual([answer.issue, answer.dedup], [106, true]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /repos/o/r/issues/106",
    "PATCH /repos/o/r/issues/106",
    "POST /repos/o/r/issues/106/comments",
    "PATCH /repos/o/r/issues/106",
  ]);
  assert.deepEqual(calls[1].body, { state: "open" });
  assert.deepEqual(calls[2].body, { body: "Seen again on 0.7.0, windows 10.0.26100, after the issue was closed." });
  assert.match(calls[3].body.body, /^Seen 4 times · .* · 0\.6\.5, 0\.7\.0$/m);
  assert.equal(issue.state, "open");
  assert.ok(!JSON.stringify(calls).includes(DEVICE), "the device number never goes to GitHub");

  const { summary } = JSON.parse(REPORTS.map.get(`id:${answer.id}`));
  assert.deepEqual([summary.priorState, summary.reopened, summary.device], ["closed", "true", DEVICE]);
});

// Closed as not planned, or labelled a duplicate, was a decision rather than a
// fix: it stays closed, and the comment alone says it was seen again.
async function staysClosed(t, issue) {
  const calls = github(t, issue);
  const REPORTS = reports();
  const answer = await send(REPORTS);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /repos/o/r/issues/106",
    "POST /repos/o/r/issues/106/comments",
    "PATCH /repos/o/r/issues/106",
  ]);
  assert.deepEqual(calls[1].body, { body: "Seen again on 0.7.0, windows 10.0.26100, after the issue was closed." });
  assert.deepEqual(Object.keys(calls[2].body), ["body"], "the count, and no state");
  assert.match(calls[2].body.body, /^Seen 4 times/m);
  assert.equal(issue.state, "closed");
  const { summary } = JSON.parse(REPORTS.map.get(`id:${answer.id}`));
  assert.deepEqual([summary.priorState, summary.reopened], ["closed", ""]);
}

test("a sighting on an issue closed as not planned comments and counts, and leaves it closed", (t) =>
  staysClosed(t, { number: 106, state: "closed", state_reason: "not_planned", labels: [], body: "An install failed." }));

test("a sighting on an issue labelled a duplicate comments and counts, and leaves it closed", (t) =>
  staysClosed(t, { number: 106, state: "closed", state_reason: "completed", labels: [{ name: "duplicate" }], body: "An install failed." }));

test("a sighting on an open issue only counts it", async (t) => {
  const issue = { number: 106, state: "open", body: "An install failed." };
  const calls = github(t, issue);
  const REPORTS = reports();
  const answer = await send(REPORTS);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /repos/o/r/issues/106", "PATCH /repos/o/r/issues/106"]);
  assert.deepEqual(Object.keys(calls[1].body), ["body"]);
  const { summary } = JSON.parse(REPORTS.map.get(`id:${answer.id}`));
  assert.deepEqual([summary.priorState, summary.reopened], ["open", ""]);
});

// ---- a finished job's record (POST /record, 0.8.8) ------------------------

// What the app sends for a finished dub (desktop/src/report.js, code "ok").
const RECORD = {
  kind: "dub", version: "0.8.8", installId: REPORT.installId, device: DEVICE, fingerprint: "0123456789ab",
  stage: "done", code: "ok", outcome: "ok", message: "", packs: {}, logTails: {},
  env: { platformKey: "mac", os: "mac 24.6.0", cpu: "Apple M4", ramGb: 24, freeDiskGb: 180 },
  timing: { elapsed_seconds: 80, sep_seconds: 10, stt_seconds: 20, translate_seconds: 5, voice_seconds: 40 },
};

// The bucket, as a list of what was put in it.
function bucket() {
  const stored = [];
  return { stored, async put(key, body, opts) { stored.push({ key, meta: opts.customMetadata }); } };
}

async function post(path, body, env) {
  const waits = [];
  const res = await worker.fetch(new Request(`https://relay.test${path}`, { method: "POST", body }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

test("a finished job's record is kept under ok/ with the summary the dashboard reads, and GitHub never hears of it", async (t) => {
  const calls = github(t, { number: 106, state: "open", body: "An install failed." });
  const REPORTS = reports();
  const tally = REPORTS.map.get("fp:0123456789ab");
  const LOGS = bucket();
  const env = { REPORTS, LOGS, GITHUB_REPO: "o/r", GITHUB_TOKEN: "token" };

  const res = await post("/record", JSON.stringify(RECORD), env);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal((await post(`/report/${id}/logs`, new Uint8Array([31, 139, 8, 0]), env)).status, 200);

  assert.deepEqual(calls, [], "no issue, no comment, no label");
  assert.equal(LOGS.stored.length, 1);
  assert.match(LOGS.stored[0].key, new RegExp(`^\\d{4}-\\d{2}/ok/${id}\\.tar\\.gz$`));
  const meta = LOGS.stored[0].meta;
  assert.deepEqual([meta.outcome, meta.kind, meta.stage, meta.version, meta.platform, meta.cpu, meta.ram, meta.disk, meta.device],
    ["ok", "dub", "done", "0.8.8", "mac", "Apple M4", "24", "180", DEVICE]);
  assert.deepEqual([meta.elapsed, meta.sep, meta.stt, meta.translate, meta.voice], ["80", "10", "20", "5", "40"]);
  assert.equal(REPORTS.map.get("fp:0123456789ab"), tally, "the failure's issue and tally are untouched");
  assert.ok(![...REPORTS.map.keys()].some((k) => k.startsWith("log:")), "nothing names it for an issue");
});

test("records count against limits of their own, so finished jobs never use up a failure's", async (t) => {
  github(t, { number: 106, state: "open", body: "An install failed." });
  const REPORTS = reports();
  const env = { REPORTS, LOGS: bucket(), GITHUB_REPO: "o/r", GITHUB_TOKEN: "token", MAX_PER_DAY: "1", MAX_RECORDS_PER_DAY: "1" };
  assert.equal((await post("/record", JSON.stringify(RECORD), env)).status, 200);
  assert.equal((await post("/record", JSON.stringify(RECORD), env)).status, 429, "one record a day from this machine, here");
  assert.equal((await post("/report", JSON.stringify(REPORT), env)).status, 200, "the failure still goes");
  const day = new Date().toISOString().slice(0, 10);
  const keys = [...REPORTS.map.keys()].filter((k) => k.startsWith("rl:")).map((k) => k.replace(/:[0-9a-f]{16}:/, ":<address>:")).sort();
  assert.deepEqual(keys, [
    `rl:a:<address>:${day}`, `rl:i:${REPORT.installId}:${day}`,
    `rl:ok:a:<address>:${day}`, `rl:ok:i:${REPORT.installId}:${day}`, `rl:ok:t:${day}`, `rl:t:${day}`,
  ]);
});
