// Run with: node --test desktop/src/usageIpc.test.mjs
// The count and the report are recorded, not sent; the backend's job records
// come from a local stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isJobId, registerUsageIpc } from "./usageIpc.js";

// Serves GET /api/dub/jobs/<id> out of `jobs`, the way the backend does.
async function backend(jobs) {
  const srv = createServer((req, res) => {
    const job = jobs[req.url.split("/").pop()];
    if (!job) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(job));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

function setup({ engines = null, lastRunClosedByUser = false } = {}) {
  const on = {};
  const counted = [];
  const reported = [];
  const logged = [];
  registerUsageIpc({
    ipcMain: { on: (channel, fn) => { on[channel] = fn; } },
    ctx: { engines, bootedKitDir: "/kit" },
    countUsage: (...args) => counted.push(args),
    sendReport: (opts) => reported.push(opts),
    shellLog: (line) => logged.push(line),
    lastRunClosedByUser,
  });
  return { on, counted, reported, logged };
}

test("a job id is held to the shape the backend gives one before it goes near a URL", () => {
  assert.equal(isJobId("abc123"), true);
  assert.equal(isJobId("0123456789abcdef0123456789abcdef"), true);
  for (const bad of ["abc12", "ABC123", "../../etc", "abc123?x=1", "", undefined, null]) {
    assert.equal(isJobId(bad), false, String(bad));
  }
});

test("a failed dub is counted and reported once, however often the page draws it", async () => {
  const s = setup();
  const msg = { status: "error", detail: "ENOSPC: no space left on device", job: "abc123" };
  await s.on["shell:count-dub"]({}, msg);
  await s.on["shell:count-dub"]({}, msg);
  assert.deepEqual(s.counted, [["dub_failure", "/kit", "disk-full", undefined, {}]]);
  assert.deepEqual(s.reported,
    [{ kind: "dub", kitDir: "/kit", code: "disk-full", message: "ENOSPC: no space left on device", jobId: "abc123" }]);
});

test("a cancel is neither counted nor reported; a success is counted with the job's own facts and sends its record once", async () => {
  const be = await backend({ fedcba: { stt_engine: "whisper", separation: "demucs", dub_mode: "perso", perso_credits: 3, duration: 12.4,
                                       started_hour: 9, elapsed_seconds: 80, stage_seconds: { transcribe: 20 } } });
  try {
    const s = setup({ engines: { url: be.url } });
    await s.on["shell:count-dub"]({}, { status: "cancelled", job: "0a0a0a" });
    await s.on["shell:count-dub"]({}, { status: "done", job: "fedcba" });
    await s.on["shell:count-dub"]({}, { status: "done", job: "fedcba" });   // drawn again
    const timing = { started_hour: 9, elapsed_seconds: 80, stage_seconds: { transcribe: 20 } };
    assert.deepEqual(s.counted, [["dub_success", "/kit", undefined, undefined,
      { engines: { stt_engine: "whisper", separation: "demucs", dub_mode: "perso" }, credits: 3, seconds: 12, timing }]]);
    assert.deepEqual(s.reported, [{ kind: "dub", kitDir: "/kit", code: "ok", jobId: "fedcba", timing }]);
  } finally {
    be.close();
  }
});

test("a dub the app stopped under is counted as interrupted, and reported only when the app did not quit normally", async () => {
  const be = await backend({ abc123: { error: "interrupted" } });
  try {
    const closed = setup({ engines: { url: be.url }, lastRunClosedByUser: true });
    await closed.on["shell:count-dub"]({}, { status: "error", detail: "", job: "abc123" });
    assert.equal(closed.counted[0][2], "interrupted");
    assert.deepEqual(closed.reported, []);
    assert.deepEqual(closed.logged, ["[persodub-report] not sent (interrupted): the app was closed normally"]);

    const crashed = setup({ engines: { url: be.url }, lastRunClosedByUser: false });
    await crashed.on["shell:count-dub"]({}, { status: "error", detail: "", job: "abc123" });
    assert.deepEqual(crashed.reported, [{ kind: "dub", kitDir: "/kit", code: "interrupted",
      message: "The app stopped without a normal quit while this job was still running.", jobId: "abc123" }]);
  } finally {
    be.close();
  }
});

test("an erase is counted, and a failed one reported without a job id that is not one", () => {
  const s = setup();
  s.on["shell:count-erase"]({}, { status: "error", detail: "exit 1", job: "../../etc" });
  s.on["shell:count-erase"]({}, { status: "done" });
  s.on["shell:count-erase"]({}, { status: "cancelled" });
  assert.deepEqual(s.counted, [["erase_failure", "/kit", "engine-crash"], ["erase_success", "/kit", undefined]]);
  assert.deepEqual(s.reported, [{ kind: "erase", kitDir: "/kit", code: "engine-crash", message: "exit 1", jobId: undefined }],
    "a finished erase the page could not name sends no record");
});

// An erase is timed as a whole only: its record carries what the job's own
// record says.
test("a finished erase sends its record with the job's timing", async () => {
  const be = await backend({ e1e1e1: { kind: "erase", elapsed_seconds: 41 } });
  try {
    const s = setup({ engines: { url: be.url } });
    await s.on["shell:count-erase"]({}, { status: "done", job: "e1e1e1" });
    assert.deepEqual(s.counted, [["erase_success", "/kit", undefined]]);
    const timing = (elapsed) => ({ started_hour: undefined, elapsed_seconds: elapsed, stage_seconds: undefined });
    assert.deepEqual(s.reported, [
      { kind: "erase", kitDir: "/kit", code: "ok", jobId: "e1e1e1", timing: timing(41) },
    ]);
  } finally {
    be.close();
  }
});
