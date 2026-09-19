import { test } from "node:test";
import assert from "node:assert/strict";
import { runInstall, downloadInterrupted, DOWNLOAD_INTERRUPTED } from "./installer.js";

function step(id, { done = false, fail = false, completes = true } = {}, log) {
  let ran = false;
  return {
    id,
    title: id,
    isDone: () => done || (ran && completes),
    run: async (report) => {
      ran = true;
      log.push(`run:${id}`);
      report(50, "halfway");
      if (fail) throw new Error(`${id} blew up`);
    },
  };
}

test("runs steps in order, skipping completed ones", async () => {
  const log = [];
  const events = [];
  await runInstall(
    [step("a", { done: true }, log), step("b", {}, log), step("c", {}, log)],
    { onProgress: (e) => events.push(`${e.stepId}:${e.state}`) },
  );
  assert.deepEqual(log, ["run:b", "run:c"]);
  assert.ok(events.includes("a:skipped"));
  assert.ok(events.includes("b:start") && events.includes("b:progress") && events.includes("b:done"));
  assert.ok(events.indexOf("b:done") < events.indexOf("c:start"));
});

test("failing step emits error and halts", async () => {
  const log = [];
  const events = [];
  await assert.rejects(
    runInstall([step("a", { fail: true }, log), step("b", {}, log)], { onProgress: (e) => events.push(`${e.stepId}:${e.state}`) }),
    /blew up/,
  );
  assert.deepEqual(log, ["run:a"]);
  assert.ok(events.includes("a:error"));
  assert.ok(!events.includes("b:start"));
});

test("step whose run finishes but isDone stays false throws", async () => {
  const log = [];
  await assert.rejects(
    runInstall([step("a", { completes: false }, log)], {}),
    /did not complete/,
  );
});

test("every progress event carries the step's bytes, so the screen can add up what it has received", async () => {
  const log = [];
  const events = [];
  const a = step("a", { done: true }, log);
  a.bytes = 5;
  const b = step("b", {}, log);
  b.bytes = 7;
  await runInstall([a, b], { onProgress: (e) => events.push(e) });
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.bytes, e.stepId === "a" ? 5 : 7);
  }
});

// A kit can pass the boot check (files present, version matching) with an
// install still open: the payload step writes KIT_VERSION first, and a venv
// step interrupted after it left the engines half-built (Windows, 2026-09-04).
// The step markers are the truth; this is what boot asks before skipping the
// installer.
import { openSteps } from "./installer.js";

test("openSteps names the steps still to run, ignoring housekeeping ones", async () => {
  const steps = [
    { id: "payload", isDone: () => true },
    { id: "venv-engines", isDone: async () => false },
    { id: "cleanup", verify: false, isDone: () => false },
    { id: "kit-env", isDone: () => true },
  ];
  assert.deepEqual((await openSteps(steps)).map((s) => s.id), ["venv-engines"]);
});

test("openSteps is empty for a finished kit", async () => {
  assert.deepEqual(await openSteps([{ id: "a", isDone: () => true }]), []);
});

import { packPercent } from "./installer.js";

test("packPercent weighs the steps by size and moves from step to step even without an inner percent", () => {
  const steps = [{ id: "venv-engines", bytes: 800 }, { id: "models", bytes: 150 }, { id: "nonverbal-weights", bytes: 50 }];
  assert.equal(packPercent(steps, new Set(), "venv-engines", null), 0);
  assert.equal(packPercent(steps, new Set(["venv-engines"]), "models", null), 80);
  assert.equal(packPercent(steps, new Set(["venv-engines"]), "models", 50), 88);   // 800 + 75 of 1000
  assert.equal(packPercent(steps, new Set(["venv-engines", "models", "nonverbal-weights"]), null, null), 100);
  assert.equal(packPercent([{ id: "x", bytes: 0 }], new Set(), "x", 10), null, "no sizes, no figure");
});

test("a download that broke mid-way is reported as interrupted, other failures keep their own text", () => {
  const hf = "AI engine: requests.exceptions.ChunkedEncodingError: ('Connection broken: IncompleteRead(50682952 bytes read, 33342488 more expected)', IncompleteRead(...))";
  assert.equal(downloadInterrupted(hf), true);
  assert.equal(downloadInterrupted("Error: getaddrinfo ENOTFOUND huggingface.co"), true);
  assert.equal(downloadInterrupted("ERROR: No matching distribution found for torch==2.8.0"), false);
  assert.equal(downloadInterrupted(""), false);
  assert.match(DOWNLOAD_INTERRUPTED, /Download and Start/);
});

// Issues #92 (503 "Backend is unhealthy" from GitHub's file host) and #89
// (IncompleteRead mid-download): a passing network error gets the step tried
// again; the waits are injected so these tests do not wait.
function flaky(errors, log) {
  let calls = 0;
  let ran = false;
  return {
    id: "ffmpeg",
    title: "ffmpeg",
    isDone: () => ran,
    run: async () => {
      calls++;
      log.push(calls);
      if (calls <= errors.length) throw new Error(errors[calls - 1]);
      ran = true;
    },
  };
}
const noWait = { sleep: async () => {}, retryDelaysMs: [5, 20] };

test("a 503 twice then success runs the step three times and reports the retries", async () => {
  const log = [];
  const events = [];
  const busy = "requests.exceptions.HTTPError: 503 Server Error: Backend is unhealthy for url: https://media.githubusercontent.com/x";
  await runInstall([flaky([busy, "download failed 503: https://x"], log)], { ...noWait, onProgress: (e) => events.push(e) });
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(events.filter((e) => /retrying/.test(e.detail || "")).map((e) => e.detail),
    ["Connection problem, retrying (2/3)", "Connection problem, retrying (3/3)"]);
  assert.ok(!events.some((e) => e.state === "error"));
  assert.equal(events.at(-1).state, "done");
});

test("IncompleteRead three times gives up after three tries with the last error", async () => {
  const log = [];
  const events = [];
  const cut = (n) => `urllib3.exceptions.ProtocolError: ('Connection broken: IncompleteRead(${n} bytes read)')`;
  await assert.rejects(
    runInstall([flaky([cut(1), cut(2), cut(3)], log)], { ...noWait, onProgress: (e) => events.push(e) }),
    (err) => err.message === cut(3),
  );
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(events.filter((e) => e.state === "error").map((e) => e.detail), [cut(3)]);
});

test("a failure that is not the network is not tried again", async () => {
  for (const message of ["sha256 mismatch for https://x: got abc", "download failed 404: https://x", "File \"x.py\", line 503, in main\nValueError: bad"]) {
    const log = [];
    await assert.rejects(runInstall([flaky([message], log)], noWait));
    assert.deepEqual(log, [1], message);
  }
});

test("a step that ran but left no artifacts is not tried again", async () => {
  const log = [];
  await assert.rejects(runInstall([step("a", { completes: false }, log)], noWait), /did not complete/);
  assert.deepEqual(log, ["run:a"]);
});

test("a cancelled install is not tried again, even when the killed process read like a network error", async () => {
  const log = [];
  await assert.rejects(
    runInstall([flaky(["requests.exceptions.ConnectionError: aborted"], log)], { ...noWait, stop: () => true }),
    /ConnectionError/,
  );
  assert.deepEqual(log, [1]);
});

test("a cancel during the wait ends the install without another try", async () => {
  const log = [];
  let cancelled = false;
  await assert.rejects(
    runInstall([flaky(["ECONNRESET"], log)], { retryDelaysMs: [5, 20], sleep: async () => { cancelled = true; }, stop: () => cancelled }),
    /ECONNRESET/,
  );
  assert.deepEqual(log, [1]);
});

import { missingVcRuntime, vcRuntimeFailure, VC_RUNTIME_MISSING, VC_RUNTIME_URL } from "./installer.js";

test("the Visual C++ runtime check names the missing files on Windows only, and never blocks when it cannot look", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const sys32 = "C:\\Windows\\System32";
  const all = [sys32, ...["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"].map((f) => `${sys32}\\${f}`)];
  const has = (paths) => (p) => paths.includes(p);
  assert.deepEqual(missingVcRuntime({ platform: "win32", env, exists: has(all) }), []);
  assert.deepEqual(missingVcRuntime({ platform: "win32", env, exists: has([sys32, `${sys32}\\vcruntime140.dll`]) }),
    ["msvcp140.dll", "vcruntime140_1.dll"]);
  assert.equal(missingVcRuntime({ platform: "win32", env: { windir: "C:\\Windows" }, exists: has([sys32]) }).length, 3);
  // No Windows folder to look in is not a verdict.
  assert.deepEqual(missingVcRuntime({ platform: "win32", env: {}, exists: () => false }), []);
  assert.deepEqual(missingVcRuntime({ platform: "win32", env, exists: () => false }), []);
  const looked = [];
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(missingVcRuntime({ platform, env, exists: (p) => { looked.push(p); return false; } }), []);
  }
  assert.deepEqual(looked, [], "Mac and Linux never look");
});

test("a pack that died for want of the Visual C++ runtime says so, other failures do not", () => {
  const i101 = "Microsoft Visual C++ Redistributable is not installed, this may lead to the DLL load failure.\n"
    + "OSError: [WinError 126] The specified module could not be found. Error loading \"C:\\PersoDub\\engines_venv\\Lib\\site-packages\\torch\\lib\\c10.dll\" or one of its dependencies.";
  const i103 = "ImportError: DLL load failed while importing _multiarray_umath: A dynamic link library (DLL) initialization routine failed.";
  assert.equal(vcRuntimeFailure(i101), true);
  assert.equal(vcRuntimeFailure(i103), true);
  assert.equal(vcRuntimeFailure("requests.exceptions.ConnectionError: Max retries exceeded with url: /x"), false);
  assert.equal(vcRuntimeFailure("sha256 mismatch for https://example.com/a.zip: got 00ff"), false);
  assert.equal(vcRuntimeFailure(""), false);
  assert.equal(VC_RUNTIME_MISSING, "Windows needs Microsoft Visual C++ to run the AI engine. Install it, then try again.");
  assert.equal(VC_RUNTIME_URL, "https://aka.ms/vc14/vc_redist.x64.exe");
});
