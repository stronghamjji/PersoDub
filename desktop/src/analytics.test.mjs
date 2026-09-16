import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getFreePort } from "./freePort.js";
import { resolveAnalyticsMode, shouldReport, buildPayload, dubFacts, report } from "./analytics.js";

// A server that records what it was posted. Real HTTP, no mocks -- the point of
// these tests is that a request actually leaves (or actually does not).
function collector(port) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, body: JSON.parse(body || "{}") });
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) =>
    srv.listen(port, "127.0.0.1", () => resolve({ srv, seen })),
  );
}

// ---- resolveAnalyticsMode: the off switches must actually be off ----

test("a from-source run never reports", () => {
  assert.equal(resolveAnalyticsMode({ isPackaged: false, env: {} }), "off");
});

test("PERSODUB_NO_ANALYTICS=1 turns reporting off", () => {
  const mode = resolveAnalyticsMode({ isPackaged: true, env: { PERSODUB_NO_ANALYTICS: "1" } });
  assert.equal(mode, "off");
});

test("the settings switch turns reporting off", () => {
  assert.equal(resolveAnalyticsMode({ isPackaged: true, env: {}, settingOff: true }), "off");
});

test("PERSODUB_ANALYTICS_DEBUG=1 prints instead of sending", () => {
  const mode = resolveAnalyticsMode({ isPackaged: true, env: { PERSODUB_ANALYTICS_DEBUG: "1" } });
  assert.equal(mode, "debug");
});

test("an off switch beats debug mode", () => {
  const env = { PERSODUB_ANALYTICS_DEBUG: "1", PERSODUB_NO_ANALYTICS: "1" };
  assert.equal(resolveAnalyticsMode({ isPackaged: true, env }), "off");
});

test("a packaged run with nothing set reports", () => {
  assert.equal(resolveAnalyticsMode({ isPackaged: true, env: {} }), "on");
});

// ---- shouldReport: launches are daily, dubs are every time ----

test("a second launch on the same day is not reported", () => {
  assert.equal(shouldReport({ event: "app_launch", lastDay: "2026-08-19", today: "2026-08-19" }), false);
});

test("a launch on a new day is reported", () => {
  assert.equal(shouldReport({ event: "app_launch", lastDay: "2026-08-19", today: "2026-08-20" }), true);
});

test("the first launch ever is reported", () => {
  assert.equal(shouldReport({ event: "app_launch", lastDay: null, today: "2026-08-19" }), true);
});

test("every dub is reported, however many land on one day", () => {
  const same = { lastDay: "2026-08-19", today: "2026-08-19" };
  assert.equal(shouldReport({ event: "dub_success", ...same }), true);
  assert.equal(shouldReport({ event: "dub_failure", ...same }), true);
  assert.equal(shouldReport({ event: "install_failure", ...same }), true);
});

// ---- buildPayload: nothing but the agreed fields may leave ----

test("an unlisted error code leaves as unknown", () => {
  const p = buildPayload({
    event: "dub_failure", os: "mac", version: "0.3.2", device: "a".repeat(32),
    errorCode: "/Users/someone/private video.mp4",
  });
  assert.equal(p.error_code, "unknown");
});

test("a listed error code leaves as itself", () => {
  const p = buildPayload({
    event: "install_failure", os: "windows", version: "0.3.2", device: "a".repeat(32),
    errorCode: "path-too-long",
  });
  assert.equal(p.error_code, "path-too-long");
});

test("an install step that merely exited nonzero is not called an engine crash", () => {
  // "engine-crash" means a running engine died, which is a dub-time event. A
  // pip install or an hf download that exits 1 is not that -- and calling it
  // that is what made the first four real install failures unreadable.
  assert.equal(classifyError("Command failed: pip install ... exit 1", { install: true }), "step-failed");
});

test("a dub-time engine death keeps the name it was made for", () => {
  assert.equal(classifyError("worker exit 1"), "engine-crash");
  assert.equal(classifyError("sidecar did not become ready"), "engine-crash");
});

test("every other cause reads the same during an install", () => {
  // Only the catch-all changes. A real disk-full or permission error is
  // already named correctly and must not be relabelled.
  for (const [msg, code] of [["ENOSPC", "disk-full"], ["EACCES", "permission"],
                             ["ETIMEDOUT", "network"], ["ENOMEM", "out-of-memory"]]) {
    assert.equal(classifyError(msg, { install: true }), code, msg);
  }
});

test("step-failed is on the published list and travels as itself", () => {
  const p = buildPayload({
    event: "install_failure", os: "windows", version: "0.3.6", device: "a".repeat(32),
    errorCode: "step-failed", step: "models",
  });
  assert.equal(p.error_code, "step-failed");
});

test("an install failure records which step it died in", () => {
  // "engine-crash" on its own means "somewhere in ten steps" -- four real
  // failures arrived that way and none of them could be acted on. The step is
  // what turns a count into something fixable.
  const p = buildPayload({
    event: "install_failure", os: "windows", version: "0.3.5", device: "a".repeat(32),
    errorCode: "disk-full", step: "ollama-runtime",
  });
  assert.equal(p.step, "ollama-runtime");
});

test("an unlisted step leaves as unknown", () => {
  // Same rule as error codes: only the published list travels, so a path or a
  // message can never reach the table through this field.
  const p = buildPayload({
    event: "install_failure", os: "mac", version: "0.3.5", device: "a".repeat(32),
    errorCode: "disk-full", step: "C:\\Users\\someone\\video.mp4",
  });
  assert.equal(p.step, "unknown");
});

test("only install failures carry a step", () => {
  for (const event of ["app_launch", "dub_success", "dub_failure"]) {
    const p = buildPayload({
      event, os: "mac", version: "0.3.5", device: "a".repeat(32),
      errorCode: "out-of-memory", step: "ollama-runtime",
    });
    assert.equal(p.step, undefined, event);
  }
});

test("a success carries no error code and no extra fields", () => {
  const p = buildPayload({
    event: "dub_success", os: "mac", version: "0.3.2", device: "a".repeat(32),
    errorCode: "out-of-memory",
  });
  assert.equal(p.error_code, undefined);
  assert.deepEqual(Object.keys(p).sort(), ["device", "event", "os", "version"]);
});

// ---- report: delivers, and never takes the app down with it ----

test("delivers the payload to the endpoint", async () => {
  const port = await getFreePort();
  const { srv, seen } = await collector(port);
  const payload = buildPayload({ event: "app_launch", os: "mac", version: "0.3.2", device: "b".repeat(32) });

  const delivered = await report(payload, { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 });

  assert.equal(delivered, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body.event, "app_launch");
  srv.close();
});

test("resolves false instead of throwing when the endpoint is unreachable", async () => {
  const port = await getFreePort(); // nothing listening
  const payload = buildPayload({ event: "app_launch", os: "mac", version: "0.3.2", device: "c".repeat(32) });

  const delivered = await report(payload, { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 });

  assert.equal(delivered, false);
});

test("gives up on a hung endpoint instead of waiting forever", async () => {
  const port = await getFreePort();
  const srv = createServer(() => {}); // accepts, never answers
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const payload = buildPayload({ event: "app_launch", os: "mac", version: "0.3.2", device: "d".repeat(32) });

  const started = Date.now();
  const delivered = await report(payload, { url: `http://127.0.0.1:${port}/`, timeoutMs: 300 });
  const waited = Date.now() - started;

  assert.equal(delivered, false);
  assert.ok(waited < 2000, `gave up after ${waited}ms -- the timeout did not fire`);
  srv.close();
});

test("a server error is not treated as delivery", async () => {
  const port = await getFreePort();
  const srv = createServer((req, res) => res.writeHead(400).end());
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const payload = buildPayload({ event: "app_launch", os: "mac", version: "0.3.2", device: "e".repeat(32) });

  assert.equal(await report(payload, { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 }), false);
  srv.close();
});

// ---- state: the install id and the last day reported ----

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./analytics.js";

function tempStateFile() {
  return join(mkdtempSync(join(tmpdir(), "persodub-analytics-")), "analytics.json");
}

test("a fresh install gets an id of the shape the endpoint accepts", () => {
  const { device } = loadState(tempStateFile());
  assert.match(device, /^[0-9a-f]{32}$/);
});

test("two fresh installs do not share an id", () => {
  assert.notEqual(loadState(tempStateFile()).device, loadState(tempStateFile()).device);
});

test("the id survives a restart once saved", () => {
  const file = tempStateFile();
  const first = loadState(file);
  saveState(file, first);
  assert.equal(loadState(file).device, first.device);
});

test("the last reported day is remembered", () => {
  const file = tempStateFile();
  saveState(file, { ...loadState(file), lastDay: "2026-08-19" });
  assert.equal(loadState(file).lastDay, "2026-08-19");
});

test("a fresh install has no last day yet", () => {
  assert.equal(loadState(tempStateFile()).lastDay, null);
});

test("a corrupt state file is replaced, not crashed on", () => {
  const file = tempStateFile();
  writeFileSync(file, "{ this is not json");
  const { device, lastDay } = loadState(file);
  assert.match(device, /^[0-9a-f]{32}$/);
  assert.equal(lastDay, null);
});

test("reading state does not create a file -- silence leaves no trace", () => {
  const file = tempStateFile();
  loadState(file);
  assert.equal(existsSync(file), false);
});

// ---- countEvent: the one call the app makes, and the switches it must obey ----

import { countEvent } from "./analytics.js";

function recorder() {
  const sent = [];
  return {
    sent,
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true };
    },
  };
}

const BASE = { os: "mac", version: "0.3.2", url: "http://127.0.0.1:1/", today: "2026-08-19", timeoutMs: 500 };

test("reporting off sends nothing and leaves no file behind", async () => {
  const file = tempStateFile();
  const { sent, fetchImpl } = recorder();

  await countEvent("app_launch", { ...BASE, mode: "off", stateFile: file, fetchImpl });

  assert.deepEqual(sent, []);
  assert.equal(existsSync(file), false, "an install that reports nothing should not get an id file");
});

test("debug mode shows the payload and still sends nothing", async () => {
  const file = tempStateFile();
  const { sent, fetchImpl } = recorder();
  const printed = [];

  await countEvent("app_launch", { ...BASE, mode: "debug", stateFile: file, fetchImpl, log: (m) => printed.push(m) });

  assert.deepEqual(sent, []);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /app_launch/);
});

test("a launch is sent once and the day is remembered", async () => {
  const file = tempStateFile();
  const { sent, fetchImpl } = recorder();

  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: file, fetchImpl });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "app_launch");
  assert.equal(loadState(file).lastDay, "2026-08-19");
});

test("a second launch the same day sends nothing", async () => {
  const file = tempStateFile();
  const { sent, fetchImpl } = recorder();
  const opts = { ...BASE, mode: "on", stateFile: file, fetchImpl };

  await countEvent("app_launch", opts);
  await countEvent("app_launch", opts);

  assert.equal(sent.length, 1);
});

test("every dub is sent even when several land on one day", async () => {
  const file = tempStateFile();
  const { sent, fetchImpl } = recorder();
  const opts = { ...BASE, mode: "on", stateFile: file, fetchImpl };

  await countEvent("dub_success", opts);
  await countEvent("dub_success", opts);
  await countEvent("dub_failure", { ...opts, errorCode: "out-of-memory" });

  assert.equal(sent.length, 3);
});

test("an undelivered launch is retried next time rather than silently lost", async () => {
  const file = tempStateFile();
  const offline = async () => { throw new Error("offline"); };

  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: file, fetchImpl: offline });
  assert.equal(loadState(file).lastDay, null, "a launch that never arrived must not count as sent");

  const { sent, fetchImpl } = recorder();
  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: file, fetchImpl });
  assert.equal(sent.length, 1);
});

test("the install id survives a failed send, so one machine stays one machine", async () => {
  const file = tempStateFile();
  const offline = async () => { throw new Error("offline"); };

  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: file, fetchImpl: offline });
  const first = loadState(file).device;
  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: file, fetchImpl: offline });

  assert.equal(loadState(file).device, first);
});

test("countEvent never throws, whatever the network does", async () => {
  const explode = async () => { throw new Error("boom"); };
  await countEvent("app_launch", { ...BASE, mode: "on", stateFile: tempStateFile(), fetchImpl: explode });
});

// ---- classifyError: real error text in, one published word out ----

import { classifyError, ERROR_CODES } from "./analytics.js";

test("a full disk is recognised", () => {
  assert.equal(classifyError("ENOSPC: no space left on device, write '/Users/x/kit/model.pth'"), "disk-full");
});

test("a dropped download is recognised", () => {
  assert.equal(classifyError("download failed 503: https://huggingface.co/some/model.onnx"), "network");
  assert.equal(classifyError("getaddrinfo ENOTFOUND huggingface.co"), "network");
  assert.equal(classifyError("connect ETIMEDOUT 1.2.3.4:443"), "network");
});

// The twenty reports of 2026-09-11..15 that arrived as "unknown". Both
// sentences are real: the first is app/run_errors.py's, the second is what
// torch says when the machine has no room left to allocate in.
test("a stage that ran out of time is its own word, not a crash", () => {
  assert.equal(classifyError("local separation timed out after 900 seconds"), "timeout");
  assert.equal(classifyError("local STT timed out after 900 seconds"), "timeout");
  // A connection that timed out is still the network's business, because that
  // rule is tried first.
  assert.equal(classifyError("connect ETIMEDOUT 1.2.3.4:443"), "network");
});

test("torch's own wording for a machine with no memory left is recognised", () => {
  assert.equal(
    classifyError("DefaultCPUAllocator: not enough memory: you tried to allocate 2147483648 bytes"),
    "out-of-memory",
  );
});

// The cloud saying no is not the machine failing. These sentences are the
// app's own (app/pipeline.py's _NOTICE_ERRORS), and the first is what a real
// failed dub carried on 2026-09-09 -- counted as "unknown" until now, so an
// outage on Perso's side looked exactly like a broken install. One word each,
// because the counts are read a day at a time and an outage and a used-up
// wallet are not the same news (user, 2026-09-11).
test("a cloud service that refused is named by service and reason", () => {
  assert.equal(classifyError("Perso's server is temporarily unavailable. Wait a few minutes, then run this job again. Ask Perso if it keeps happening."), "perso-busy");
  assert.equal(classifyError("Perso credits are used up. Recharge to continue."), "perso-credits");
  assert.equal(classifyError("Perso rejected the API key. Open Settings and check the key."), "perso-key");
  assert.equal(classifyError("Perso could not finish this job. Try again, or check the project on Perso. Perso said: FAILED (E_TTS_TIMEOUT) Ask Perso if it keeps happening."), "perso-failed");
  assert.equal(classifyError("Google's Gemini server is temporarily overloaded. Wait a few minutes, then run this job again. Ask Google if it keeps happening."), "gemini-busy");
  assert.equal(classifyError("Gemini quota is used up. Upgrade the key's plan, or try again after the daily reset."), "gemini-quota");
  // A machine-side rule still wins: those are tried first, in order.
  assert.equal(classifyError("ENOSPC: no space left while the service was temporarily unavailable"), "disk-full");
});

test("a refused connection is recognised in either spelling", () => {
  // The engines fail through Python, which writes the sentence rather than the
  // errno. The first line here is what a real dub left behind on 2026-08-26
  // when the voice engine was not running -- the commonest local failure of
  // all, and it used to count as "unknown".
  assert.equal(classifyError("ConnectError: [Errno 61] Connection refused"), "network");
  assert.equal(classifyError("ConnectionResetError(54, 'Connection reset by peer')"), "network");
  assert.equal(classifyError("connect ECONNREFUSED 127.0.0.1:51801"), "network");
});

test("a blocked write is recognised", () => {
  assert.equal(classifyError("EACCES: permission denied, mkdir '/Users/x/Library/PersoDub'"), "permission");
});

test("the Windows path-length message is recognised", () => {
  const real = "This folder's path is too long to install into (281 characters). "
    + "Windows cannot open files deeper than 260 characters, and the kit adds 175.";
  assert.equal(classifyError(real), "path-too-long");
});

test("a model that did not fit in memory is recognised", () => {
  assert.equal(classifyError("RuntimeError: CUDA out of memory. Tried to allocate 2.20 GiB"), "out-of-memory");
});

test("an unreadable video is recognised", () => {
  assert.equal(classifyError("Unsupported codec for '/Users/x/Movies/family trip.mov'"), "unsupported-format");
});

test("anything unrecognised is unknown, never passed through", () => {
  assert.equal(classifyError("some brand new failure nobody has seen"), "unknown");
});

test("a missing or empty message is unknown, not a crash", () => {
  assert.equal(classifyError(undefined), "unknown");
  assert.equal(classifyError(null), "unknown");
  assert.equal(classifyError(""), "unknown");
  assert.equal(classifyError({ not: "a string" }), "unknown");
});

test("no error text can ever survive classification", () => {
  // The whole point of the function: whatever goes in, what comes out is one of
  // the published words and nothing else. A username, a path or a URL in the
  // message must not be able to ride along.
  const messages = [
    "ENOSPC: no space left on device, write '/Users/hong.gildong/secret project.mp4'",
    "python exit 1\n  File \"/Users/hong.gildong/PersoDub/kit/venv/lib/whisper.py\", line 42",
    "download failed 404: https://example.com/token=abcd1234",
    "totally unrecognised",
    "",
  ];
  for (const m of messages) {
    const code = classifyError(m);
    assert.ok(ERROR_CODES.has(code), `${code} is not a published code`);
    assert.ok(!/[/\\]|hong|token|http/i.test(code), `"${code}" carried text out of the message`);
  }
});

test("an install that finished but whose engines never started is its own code", () => {
  // Not derived from the message: this code says WHERE it failed, which is the
  // whole reason it exists. Such a machine fires no other event -- install
  // succeeded, so install_failure's other codes do not apply, and it never
  // reaches PERSODUB_READY, so app_launch never fires. Without this it is
  // invisible.
  const p = buildPayload({
    event: "install_failure", os: "mac", version: "0.3.2",
    device: "f".repeat(32), errorCode: "engine-start",
  });
  assert.equal(p.error_code, "engine-start");
});


test("the failing step travels all the way to the wire", async () => {
  const { sent, fetchImpl } = recorder();
  await countEvent("install_failure", {
    ...BASE, mode: "on", stateFile: tempStateFile(), fetchImpl,
    errorCode: "disk-full", step: "ollama-runtime",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].step, "ollama-runtime");
  assert.equal(sent[0].error_code, "disk-full");
});

// ---- the four families that used to arrive as "unknown" ----------------
// Every sentence below is real text from an issue filed between 2026-09-11
// and 2026-09-15, when thirty of thirty-two reports were classified
// "unknown" and the dashboard could say nothing about any of them.

test("model files that never arrived are named", () => {
  assert.equal(classifyError(
    "RuntimeError: hf download exited 1: huggingface_hub.errors.LocalEntryNotFoundError: An error " +
    "happened while trying to locate the files on the Hub"), "model-download");
});

test("the voice engine's own 500 is ours; a cloud 500 is not", () => {
  assert.equal(classifyError(
    "HTTPStatusError: Server error '500 Internal Server Error' for url 'http://127.0.0.1:8731/clone'"),
    "engine-500");
  // Same status from somewhere that is not this machine stays unclassified
  // rather than being blamed on the local engine.
  assert.equal(classifyError("Server error '500 Internal Server Error' for url 'https://api.perso.ai/x'"),
    "unknown");
});

test("Perso refusing the request is not Perso being out of credit", () => {
  assert.equal(classifyError("RuntimeError: Perso STT failed (Client error '400 Bad Request')"),
    "perso-bad-request");
  assert.equal(classifyError("Perso credits are used up. Recharge to continue."), "perso-credits");
});

test("a translation that came back as something other than JSON is named", () => {
  assert.equal(classifyError(
    "Translation failed (Ollama (local LLM) - hy-mt2:1.8b): Could not find a JSON array in the response"),
    "translate-parse");
  assert.equal(classifyError("Translated line count mismatch: got 0, need 1"), "translate-parse");
  // But a translation that failed because the cloud said no is news about the
  // cloud: those rules are tried first.
  assert.equal(classifyError("Translation failed: Gemini's quota is used up"), "gemini-quota");
});


// ---- the Perso columns (0.6.2): two words, two counts, one yes/no ----

test("a dub names which parts went through Perso, in two words only", () => {
  const p = buildPayload({
    event: "dub_success", os: "mac", version: "0.6.2", device: "a".repeat(32),
    engines: { stt_engine: "perso", separation: "demucs", dub_mode: "local" },
    credits: 12, minutes: 3,
  });
  assert.equal(p.stt, "perso");
  assert.equal(p.separation, "local");   // never "demucs": the engine's name stays home
  assert.equal(p.mode, "local");
  assert.equal(p.credits, 12);
  assert.equal(p.minutes, 3);
});

test("a dub the shell could not look up says nothing, not local", () => {
  const p = buildPayload({ event: "dub_success", os: "mac", version: "0.6.2", device: "a".repeat(32) });
  assert.equal("stt" in p, false);
  assert.equal("mode" in p, false);
  assert.equal("credits" in p, false);
});

test("a count that is not a whole non-negative number is left out", () => {
  const base = { event: "dub_success", os: "mac", version: "0.6.2", device: "a".repeat(32) };
  assert.equal("credits" in buildPayload({ ...base, credits: -1 }), false);
  assert.equal("credits" in buildPayload({ ...base, credits: 1.5 }), false);
  assert.equal("minutes" in buildPayload({ ...base, minutes: "3" }), false);
  assert.equal(buildPayload({ ...base, minutes: 0 }).minutes, 0);
});

test("a launch says whether a Perso key is set, as yes or no, and nothing else does", () => {
  const base = { os: "mac", version: "0.6.2", device: "a".repeat(32) };
  assert.equal(buildPayload({ ...base, event: "app_launch", persoKey: true }).perso_key, "yes");
  assert.equal(buildPayload({ ...base, event: "app_launch", persoKey: false }).perso_key, "no");
  assert.equal("perso_key" in buildPayload({ ...base, event: "app_launch" }), false);
  assert.equal("perso_key" in buildPayload({ ...base, event: "dub_success", persoKey: true }), false);
  // An erase carries none of the Perso columns whatever it is handed.
  const e = buildPayload({ ...base, event: "erase_success", engines: { stt_engine: "perso" }, credits: 5 });
  assert.deepEqual(Object.keys(e).sort(), ["device", "event", "os", "version"]);
});

test("dubFacts reads a job's record and rounds its length to minutes", () => {
  const f = dubFacts({ stt_engine: "whisper", separation: "perso", dub_mode: "local",
                       perso_credits: 7, duration: 150.2, title: "my private video" });
  assert.deepEqual(f.engines, { stt_engine: "whisper", separation: "perso", dub_mode: "local" });
  assert.equal(f.credits, 7);
  assert.equal(f.minutes, 3);
  assert.equal("title" in f, false);
  assert.deepEqual(dubFacts(null), {});
  assert.equal(dubFacts({ stt_engine: "perso" }).minutes, undefined);
});
