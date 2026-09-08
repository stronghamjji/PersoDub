// The models controller talks to /api/models and paints real elements, so the
// tests give it a paper-thin page: elements that are plain objects, a fetch
// that answers from a script, and a setTimeout that records the poll instead
// of running it (the real one would keep polling for the life of the test).
// What is asserted is what a user would see or the engine would receive: the
// dialog's words, which endpoints were called, and when the dub restarts.
//
// Run with: node --test ui/src/modelsDialog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initModelsUi } from "./modelsDialog.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", className: "", hidden: false, open: false,
    style: {}, dataset: {}, children: [], listeners: {}, onclick: null, type: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    replaceChildren: function () { this.children = []; },
    append: function (...kids) { this.children.push(...kids); },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click: function () { for (const fn of this.listeners.click || []) fn(); },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** A page, a fetch log and a stopped clock. `fetchModels` is the rows the next
 * GET /api/models answers with; `write` records every other call. */
function harness({ rows = [], shell = null } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { rows, calls: [], timers: [], started: 0, settings: 0, painted: [] };

  const realFetch = globalThis.fetch;
  const realDocument = globalThis.document;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.document = { createElement: (tag) => makeEl(tag) };
  globalThis.setTimeout = (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; };
  globalThis.fetch = async (url, opts) => {
    state.calls.push(`${(opts && opts.method) || "GET"} ${url}`);
    if (url === "/api/models") return { ok: true, json: async () => ({ models: state.rows }) };
    return state.responses?.[url] ?? { ok: true, json: async () => ({}) };
  };
  state.restore = () => {
    globalThis.fetch = realFetch;
    globalThis.document = realDocument;
    globalThis.setTimeout = realSetTimeout;
  };

  const api = initModelsUi({
    $,
    onStartDubbing: () => { state.started += 1; },
    onOpenSettings: () => { state.settings += 1; },
    onRowsChanged: (r) => { state.painted.push(r); },
    shell,
    keepPolling: () => state.keepPolling === true,
  });
  return { $, api, state };
}

/** A stand-in for window.persodubShell: records what the page asked of the
 * desktop app, answers installs from a script, and can send progress. */
function fakeShell({ install = async () => ({ ok: true }) } = {}) {
  const shell = { asked: [], progress: null };
  shell.installPack = async (id) => { shell.asked.push(`install ${id}`); return install(id); };
  shell.cancelPack = async (id) => { shell.asked.push(`cancel ${id}`); };
  shell.removePack = async (id) => { shell.asked.push(`remove ${id}`); return { ok: true }; };
  shell.onInstallProgress = (cb) => { shell.progress = cb; };
  return shell;
}

const ENGINE = { id: "engine", role: "pack", name: "AI engine", bytes: 2e9, state: "not_downloaded" };
const WHISPER = { id: "whisper", role: "stt", name: "Whisper", bytes: 2.9e9, state: "not_downloaded" };
const PACK_409 = { missing: [
  { id: "engine", kind: "pack", name: "AI engine", bytes: 2e9 },
  { id: "whisper", kind: "model", name: "Whisper", bytes: 2.9e9 },
] };

/** Let the module's own awaits run out (its fetches resolve immediately). */
const settle = () => new Promise((r) => setImmediate(r));

const DETAIL_TWO = {
  missing: [{ id: "whisper", name: "Whisper", bytes: 1.5 * 1024 ** 3 },
            { id: "qwen3-tts", name: "Qwen3 TTS", bytes: 2.5 * 1024 ** 3 }],
  total_bytes: 4 * 1024 ** 3,
};
const ready = (id, name, bytes) => ({ id, name, bytes, state: "ready", progress: 100 });
const downloading = (id, name, bytes, progress) => ({ id, name, bytes, state: "downloading", progress });

test("refreshModels stores the rows and hands them to the page's repaint", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1024 ** 3)] });
  t.after(h.state.restore);

  const rows = await h.api.refreshModels();

  assert.deepEqual(h.state.calls, ["GET /api/models"]);
  assert.equal(rows.length, 1);
  assert.equal(h.api.modelRow("whisper").name, "Whisper");
  assert.equal(h.api.modelRow("nope"), null);
  assert.equal(h.state.painted.length, 1);
  assert.deepEqual(h.state.painted[0], rows);
});

test("a failed /api/models keeps the rows it already had", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1024 ** 3)] });
  t.after(h.state.restore);
  await h.api.refreshModels();

  globalThis.fetch = async () => { throw new Error("engine down"); };
  await h.api.refreshModels();

  assert.equal(h.api.modelRow("whisper").name, "Whisper");
});

test("showModelsDialog paints the 409's title and line and opens the overlay", async (t) => {
  const h = harness();
  t.after(h.state.restore);

  h.api.showModelsDialog(DETAIL_TWO);

  assert.equal(h.$("mnTitle").textContent, "Download 4.0 GB of AI models to dub this video?");
  assert.equal(h.$("mnLine").textContent, "They are saved on this computer and only download once.");
  assert.equal(h.$("mnError").textContent, "");
  assert.equal(h.$("mnProgress").hidden, true);
  assert.equal(h.$("mnDownload").hidden, false);
  assert.equal(h.$("mnHide").hidden, true);
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), true);
});

test("one missing model is named in the title instead of totalled", (t) => {
  const h = harness();
  t.after(h.state.restore);

  h.api.showModelsDialog({ missing: [{ id: "hunyuan", name: "Hunyuan", bytes: 1.1 * 1024 ** 3 }] });

  assert.equal(h.$("mnTitle").textContent, "Download Hunyuan (1.1 GB) to dub this video?");
});

test("Download and Start fetches only what is missing and swaps the buttons", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1.5 * 1024 ** 3)] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.state.calls.length = 0;
  h.api.showModelsDialog(DETAIL_TWO);

  h.$("mnDownload").click();
  await settle();

  // Whisper is already on disk; only the voice model is asked for.
  assert.deepEqual(h.state.calls.slice(0, 1), ["POST /api/models/qwen3-tts/download"]);
  assert.equal(h.$("mnDownload").hidden, true);
  assert.equal(h.$("mnSettings").hidden, true);
  assert.equal(h.$("mnHide").hidden, false);
  assert.equal(h.$("mnProgress").hidden, false);
});

test("the dialog polls every 2s while the download runs, then stops", async (t) => {
  const h = harness({ rows: [downloading("whisper", "Whisper", 1.5 * 1024 ** 3, 40),
                             downloading("qwen3-tts", "Qwen3 TTS", 2.5 * 1024 ** 3, 0)] });
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);

  h.$("mnDownload").click();
  await settle();

  assert.deepEqual(h.state.timers.map((x) => x.ms), [2000]);
  assert.equal(h.$("mnTitle").textContent, "Downloading AI models");
  // 40% of 1.5GB out of 4GB = 15%, byte-weighted.
  assert.equal(h.$("mnLine").textContent, "15%. Dubbing starts when they finish.");
  assert.equal(h.$("mnBar").style.width, "15%");

  // The next tick finds them both on disk: no further timer, and no dub yet
  // started before that moment.
  assert.equal(h.state.started, 0);
  h.state.rows = [ready("whisper", "Whisper", 1.5 * 1024 ** 3),
                  ready("qwen3-tts", "Qwen3 TTS", 2.5 * 1024 ** 3)];
  await h.state.timers.pop().fn();
  await settle();

  assert.equal(h.state.started, 1);
  assert.deepEqual(h.state.timers, []);
});

test("the dub restarts exactly once when every pending model is ready", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1.5 * 1024 ** 3),
                             ready("qwen3-tts", "Qwen3 TTS", 2.5 * 1024 ** 3)] });
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);
  h.$("mnDownload").click();
  await settle();

  assert.equal(h.state.started, 1);
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), false);

  // Later refreshes have no pending dub left to start.
  await h.api.refreshModels();
  await h.api.refreshModels();
  assert.equal(h.state.started, 1);
});

test("a stalled model says so in the dialog without cancelling the dub", async (t) => {
  const h = harness({ rows: [downloading("whisper", "Whisper", 1.5 * 1024 ** 3, 50),
                             { id: "qwen3-tts", name: "Qwen3 TTS", bytes: 2.5 * 1024 ** 3,
                               state: "paused", error: "no space" }] });
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);

  h.$("mnDownload").click();
  await settle();

  assert.equal(h.$("mnError").textContent,
    "Qwen3 TTS stopped (no space). Resume it from the line under its dropdown.");
  assert.equal(h.state.started, 0);
});

test("Cancel stops the downloads that are running and closes the dialog", async (t) => {
  const h = harness({ rows: [downloading("whisper", "Whisper", 1.5 * 1024 ** 3, 20),
                             { id: "qwen3-tts", name: "Qwen3 TTS", bytes: 2.5 * 1024 ** 3,
                               state: "paused" }] });
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);
  h.$("mnDownload").click();
  await settle();
  h.state.calls.length = 0;

  h.$("mnCancel").click();
  await settle();

  // Only the live download is cancelled; the paused one keeps its pieces.
  assert.deepEqual(h.state.calls.filter((c) => c.includes("/cancel")),
                   ["POST /api/models/whisper/cancel"]);
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), false);
  // With the dub gone, a later refresh must not start it.
  h.state.rows = [ready("whisper", "Whisper", 1.5 * 1024 ** 3),
                  ready("qwen3-tts", "Qwen3 TTS", 2.5 * 1024 ** 3)];
  await h.api.refreshModels();
  assert.equal(h.state.started, 0);
});

test("Cancel before any download started asks the engine for nothing", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);

  h.$("mnCancel").click();

  assert.deepEqual(h.state.calls, []);
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), false);
});

test("Hide leaves the dub pending, and the topbar chip brings the dialog back", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.api.showModelsDialog(DETAIL_TWO);

  h.$("mnHide").click();
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), false);

  h.api.reopenDialogOrSettings();
  assert.equal(h.$("modelsNeededOverlay").classList.contains("open"), true);
  assert.equal(h.state.settings, 0);

  // With nothing pending the same chip opens the Settings catalog instead.
  h.$("mnCancel").click();
  h.api.reopenDialogOrSettings();
  assert.equal(h.state.settings, 1);
});

test("Open Settings from the dialog hands off to the page", (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.$("mnSettings").click();
  assert.equal(h.state.settings, 1);
});

test("the Settings catalog lists a row per model with the right button", async (t) => {
  const h = harness({ rows: [
    ready("whisper", "Whisper", 1.5 * 1024 ** 3),
    downloading("qwen3-tts", "Qwen3 TTS", 2.5 * 1024 ** 3, 30),
    { id: "hunyuan", name: "Hunyuan", bytes: 1.1 * 1024 ** 3, state: "paused" },
    { id: "gemma", name: "Gemma", bytes: 3 * 1024 ** 3, state: "not_downloaded" },
  ] });
  t.after(h.state.restore);

  await h.api.refreshModels();

  const rows = h.$("modelsList").children;
  assert.equal(rows.length, 4);
  const cells = (i) => rows[i].children.map((c) => c.textContent);
  assert.deepEqual(cells(0), ["Whisper", "1.5 GB", "Ready", "Remove"]);
  assert.deepEqual(cells(1), ["Qwen3 TTS", "2.5 GB", "Downloading Qwen3 TTS… 30%", "Cancel"]);
  assert.deepEqual(cells(2), ["Hunyuan", "1.1 GB", "Paused", "Resume"]);
  // Nothing downloaded yet reads as its size alone, with no status beside it.
  assert.deepEqual(cells(3), ["Gemma", "3.0 GB", "", "Download"]);
  assert.equal(h.$("modelsSummary").textContent,
    "4 models · 1.5 GB on this computer · attention needed");
  assert.equal(h.$("modelsFold").open, true);
});

test("a quiet catalog counts what is on disk and stays folded", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1.5 * 1024 ** 3),
                             { id: "gemma", name: "Gemma", bytes: 3 * 1024 ** 3, state: "not_downloaded" }] });
  t.after(h.state.restore);

  await h.api.refreshModels();

  assert.equal(h.$("modelsSummary").textContent, "2 models · 1.5 GB on this computer");
  assert.equal(h.$("modelsFold").open, false);
});

test("a catalog row's button calls the endpoint it is labelled with", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1024 ** 3)] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.state.calls.length = 0;

  h.$("modelsList").children[0].children[3].onclick();   // Remove
  await settle();

  assert.equal(h.state.calls[0], "DELETE /api/models/whisper");
});

test("a refused Remove shows the engine's own sentence", async (t) => {
  const h = harness({ rows: [ready("whisper", "Whisper", 1024 ** 3)] });
  t.after(h.state.restore);
  const pass = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "DELETE") {
      return { ok: false, json: async () => ({ detail: "It is in use by a running job." }) };
    }
    return pass(url, opts);
  };

  await h.api.removeModel("whisper");

  assert.equal(h.$("modelsError").textContent, "It is in use by a running job.");
});

test("Remove with the engine gone says to check the engine", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  globalThis.fetch = async () => { throw new Error("offline"); };

  await h.api.removeModel("whisper");

  assert.equal(h.$("modelsError").textContent, "Could not remove it. Is the engine running?");
});

test("downloadModel and cancelModel hit their endpoints and start the poll", async (t) => {
  const h = harness({ rows: [downloading("whisper", "Whisper", 1024 ** 3, 5)] });
  t.after(h.state.restore);

  await h.api.downloadModel("whisper");
  await settle();
  assert.equal(h.state.calls[0], "POST /api/models/whisper/download");
  assert.deepEqual(h.state.timers.map((x) => x.ms), [2000]);

  // The poll is a single loop: a second operation does not add a second one.
  h.state.timers.length = 0;
  await h.api.cancelModel("whisper");
  await settle();
  assert.equal(h.state.calls.includes("POST /api/models/whisper/cancel"), true);
  assert.deepEqual(h.state.timers, []);
});


// ── packs: the desktop app installs them, then the models download ─────────
test("Download and Start installs the packs through the desktop app first, then downloads the models", async (t) => {
  const shell = fakeShell({ install: async (id) => {
    // The pack lands on disk: the next GET /api/models says so.
    h.state.rows = [{ ...ENGINE, state: "ready" }, WHISPER];
    return { ok: true };
  } });
  const h = harness({ rows: [ENGINE, WHISPER], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog(PACK_409);
  assert.equal(h.$("mnTitle").textContent, "Download 4.6 GB to dub this video?");   // 4.9e9 bytes
  h.$("mnDownload").click();
  await settle(); await settle(); await settle();
  assert.deepEqual(shell.asked, ["install engine"]);
  // The model's download went out only after the pack was in.
  const order = h.state.calls.filter((c) => c.startsWith("POST"));
  assert.deepEqual(order, ["POST /api/models/whisper/download"]);
  assert.equal(h.state.started, 0, "the dub waits for the model");
});

test("while a pack installs the dialog shows its progress line, and Cancel stops it through the desktop app", async (t) => {
  let finish;
  const shell = fakeShell({ install: () => new Promise((r) => { finish = r; }) });
  const h = harness({ rows: [ENGINE], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog({ missing: [PACK_409.missing[0]] });
  h.$("mnDownload").click();
  await settle();
  assert.equal(h.$("mnTitle").textContent, "Installing AI engine");
  shell.progress({ pack: "engine", stepId: "venv-engines", title: "Installing AI engines", state: "progress", detail: "torch 40%", pct: 40 });
  assert.equal(h.$("mnLine").textContent, "Installing AI engines: torch 40%");
  assert.equal(h.$("mnBar").style.width, "40%", "the bar follows the pack's percent, not the engine's row");
  h.$("mnCancel").click();
  assert.deepEqual(shell.asked, ["install engine", "cancel engine"]);
  finish({ ok: false, reason: "Cancelled." });
  await settle(); await settle();
});

test("a pack the desktop app could not install stops the dub and says why, with the button back", async (t) => {
  const shell = fakeShell({ install: async () => ({ ok: false, reason: "Not enough space: needs 2.0 GB." }) });
  const h = harness({ rows: [ENGINE, WHISPER], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog(PACK_409);
  h.$("mnDownload").click();
  await settle(); await settle(); await settle();
  assert.equal(h.$("mnError").textContent, "AI engine: Not enough space: needs 2.0 GB.");
  assert.equal(h.$("mnDownload").hidden, false);
  assert.ok(!h.state.calls.some((c) => c.startsWith("POST")), "no model download was started");
});

test("without the desktop app a pack cannot be installed from the page, and the dialog says so", async (t) => {
  const h = harness({ rows: [ENGINE, WHISPER] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog(PACK_409);
  h.$("mnDownload").click();
  await settle(); await settle();
  assert.equal(h.$("mnError").textContent, "AI engine: Installed by the desktop app.");
  assert.ok(!h.state.calls.some((c) => c.startsWith("POST")));
});

test("the Settings catalog's pack rows ask the desktop app to install or remove, and are read-only without it", async (t) => {
  const shell = fakeShell();
  const h = harness({ rows: [ENGINE, { ...ENGINE, id: "ollama-runtime", name: "Translation runtime", state: "ready" }], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  const [engineRow, runtimeRow] = h.$("modelsList").children;
  const btn = (row) => row.children[3];
  assert.equal(btn(engineRow).textContent, "Download");
  btn(engineRow).onclick();
  await settle(); await settle();
  assert.equal(btn(runtimeRow).textContent, "Remove");
  // Remove asks the engine first (it knows whether a dub is running); its
  // "packs are the desktop app's" refusal is the all-clear.
  h.state.responses = { "/api/models/ollama-runtime": { ok: false, json: async () => ({ detail: "Packs are installed by the desktop app" }) } };
  btn(runtimeRow).onclick();
  await settle(); await settle(); await settle();
  assert.deepEqual(shell.asked, ["install engine", "remove ollama-runtime"]);
  assert.ok(h.state.calls.includes("DELETE /api/models/ollama-runtime"));

  // A dub in progress: the engine's sentence is shown and the desktop app is not asked.
  h.state.responses = { "/api/models/ollama-runtime": { ok: false, json: async () => ({ detail: "A dub is running right now. Wait for it to finish, then remove the model." }) } };
  btn(runtimeRow).onclick();
  await settle(); await settle(); await settle();
  assert.deepEqual(shell.asked, ["install engine", "remove ollama-runtime"], "not asked again");
  assert.match(h.$("modelsError").textContent, /A dub is running/);

  const bare = harness({ rows: [ENGINE] });
  t.after(bare.state.restore);
  await bare.api.refreshModels();
  const row = bare.$("modelsList").children[0];
  assert.equal(btn(row).disabled, true);
  assert.equal(row.children[2].textContent, "Installed by the desktop app");
});

test("an Ollama pull that failed before it began is told in the dialog, not polled at 0% forever", async (t) => {
  const h = harness({ rows: [{ id: "hunyuan", role: "translate", name: "Hunyuan", bytes: 1.1e9, state: "not_downloaded" }] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog({ missing: [{ id: "hunyuan", kind: "model", name: "Hunyuan", bytes: 1.1e9 }] });
  h.$("mnDownload").click();
  await settle();
  // The runtime refused the connection: no pieces on disk, so not "paused" -- just failed.
  h.state.rows = [{ id: "hunyuan", role: "translate", name: "Hunyuan", bytes: 1.1e9, state: "not_downloaded", error: "connection refused" }];
  await h.api.refreshModels();
  assert.match(h.$("mnError").textContent, /Hunyuan stopped \(connection refused\)/);
});

test("a download the engine refuses shows its sentence instead of starting nothing", async (t) => {
  const h = harness({ rows: [{ id: "hunyuan", role: "translate", name: "Hunyuan", bytes: 1.1e9, state: "not_downloaded" }] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.state.responses = { "/api/models/hunyuan/download": { ok: false, json: async () => ({ detail: "Install the Translation runtime first, then download this model." }) } };
  await h.api.downloadModel("hunyuan");
  assert.equal(h.$("modelsError").textContent, "Hunyuan: Install the Translation runtime first, then download this model.");
});

test("a catalog row says what the thing is for, under its name", async (t) => {
  const h = harness({ rows: [{ ...ENGINE, hint: "Runs local dubbing on this computer." }] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  const name = h.$("modelsList").children[0].children[0];
  assert.equal(name.children[0].className, "model-hint");
  assert.equal(name.children[0].textContent, "Runs local dubbing on this computer.");
});

test("a pack being installed reads as downloading in the rows the page paints, and a failed one as paused with the reason", async (t) => {
  let finish;
  const shell = fakeShell({ install: () => new Promise((r) => { finish = r; }) });
  const h = harness({ rows: [ENGINE], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  // Started from a dropdown hint (downloadModel), not the dialog: the hints
  // and the topbar chip only know rows, so the pack must show up as one.
  const p = h.api.downloadModel("engine");
  await settle();
  let painted = h.state.painted.at(-1).find((r) => r.id === "engine");
  assert.equal(painted.state, "downloading");
  shell.progress({ pack: "engine", stepId: "venv-engines", title: "Installing AI engines", state: "progress", pct: 42, detail: "torch" });
  painted = h.state.painted.at(-1).find((r) => r.id === "engine");
  assert.equal(painted.progress, 42);
  finish({ ok: false, reason: "Health check timed out" });
  await p; await settle();
  painted = h.state.painted.at(-1).find((r) => r.id === "engine");
  assert.equal(painted.state, "paused");
  assert.equal(painted.error, "Health check timed out");
  // Settings says the same, with Resume.
  const row = h.$("modelsList").children[0];
  assert.equal(row.children[2].textContent, "Stopped: Health check timed out");
  assert.equal(row.children[3].textContent, "Resume");
});

test("downloadAll installs the packs first, one after another, then downloads the models", async (t) => {
  const shell = fakeShell({ install: async () => { h.state.rows = [{ ...ENGINE, state: "ready" }, WHISPER]; return { ok: true }; } });
  const h = harness({ rows: [ENGINE, WHISPER], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  await h.api.downloadAll(["engine", "whisper"]);
  await settle();
  assert.deepEqual(shell.asked, ["install engine"]);
  assert.ok(h.state.calls.includes("POST /api/models/whisper/download"));
});

test("downloadAll stops at a pack that failed and downloads no model", async (t) => {
  const shell = fakeShell({ install: async () => ({ ok: false, reason: "Cancelled." }) });
  const h = harness({ rows: [ENGINE, WHISPER], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  assert.equal(await h.api.downloadAll(["engine", "whisper"]), false);
  assert.ok(!h.state.calls.some((c) => c.startsWith("POST")));
});

test("the dub dialog lists what it will download, by name, size and purpose, and names the API as the other road", async (t) => {
  const h = harness({ rows: [ENGINE, WHISPER] });
  t.after(h.state.restore);
  await h.api.refreshModels();
  h.api.showModelsDialog({ missing: [
    { id: "engine", kind: "pack", name: "AI engine", bytes: 2e9, hint: "Runs local dubbing on this computer." },
    { id: "whisper", kind: "model", name: "Whisper", bytes: 2.9e9, hint: "Turns the speech into text." },
  ] });
  const items = h.$("mnItems").children;
  assert.equal(items.length, 2);
  assert.equal(items[0].children[0].textContent, "AI engine · 1.9 GB");
  assert.equal(items[0].children[1].textContent, "Runs local dubbing on this computer.");
  assert.equal(h.$("mnItems").hidden, false);
  assert.equal(h.$("mnAlt").hidden, false);
  // Once the download runs the list gives way to the bar.
  h.$("mnDownload").click();
  await settle();
  assert.equal(h.$("mnItems").hidden, true);
});


test("the poll keeps running while the page says so, and a paint that throws does not end it", async (t) => {
  const h = harness({ rows: [WHISPER] });
  t.after(h.state.restore);
  h.state.keepPolling = true;
  h.api.startPolling();
  await settle();
  assert.equal(h.state.timers.length, 1, "scheduled again with nothing downloading");
  const realErr = console.error; console.error = () => {};
  t.after(() => { console.error = realErr; });
  const origPush = h.state.painted.push;
  h.state.painted.push = () => { throw new Error("paint boom"); };
  await h.state.timers[0].fn();
  h.state.painted.push = origPush;
  assert.equal(h.state.timers.length, 2, "still scheduled after the throw");
});


test("a second pack pressed while one installs waits: the first keeps its place, the other button is locked, the notice clears when the first finishes", async (t) => {
  let finish;
  const shell = fakeShell({ install: () => new Promise((r) => { finish = r; }) });
  const RUNTIME = { id: "ollama-runtime", role: "pack", name: "Translation runtime", bytes: 4.6e8, state: "not_downloaded" };
  const h = harness({ rows: [ENGINE, RUNTIME], shell });
  t.after(h.state.restore);
  await h.api.refreshModels();
  const first = h.api.installPack("engine");
  await settle();
  assert.equal(await h.api.installPack("ollama-runtime"), false);
  assert.deepEqual(shell.asked, ["install engine"], "the desktop app was not asked twice");
  assert.equal(h.$("modelsError").textContent, "AI engine is still installing. Wait for it to finish.");
  const painted = h.state.painted.at(-1).find((r) => r.id === "engine");
  assert.equal(painted.state, "downloading", "the first keeps its busy state");
  const runtimeBtn = h.$("modelsList").children[1].children[3];
  assert.equal(runtimeBtn.disabled, true);
  finish({ ok: true });
  await first; await settle();
  assert.equal(h.$("modelsError").textContent, "", "the notice is gone once the first is done");
});
