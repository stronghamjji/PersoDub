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
function harness({ rows = [] } = {}) {
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
  });
  return { $, api, state };
}

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

  assert.equal(h.$("mnTitle").textContent, "Download 4.0 GB of AI models to dub?");
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

  assert.equal(h.$("mnTitle").textContent, "Download Hunyuan (1.1 GB) to dub?");
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
