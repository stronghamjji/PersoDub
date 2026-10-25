// Importing paints real elements and holds a video through the same
// network calls the New project dialog makes, so the tests hand it a
// paper-thin page and a fetch that answers from a script -- the pattern
// ui/src/newProject.test.mjs and ui/src/projects.test.mjs already use.
//
// Run with: node --test ui/src/draftImport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initDraftImport } from "./draftImport.mjs";
import { clearDraft, getDraft, setDraft, setRanges } from "./draft.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", hidden: false, files: null,
    style: {}, dataset: {}, listeners: {}, attrs: {},
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 contains: (c) => classes.has(c),
                 toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    removeAttribute: function (k) { delete this.attrs[k]; },
    focus: function () {},
    load: function () { this.loaded = (this.loaded || 0) + 1; },
    click: function () { this.clicked = (this.clicked || 0) + 1; },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener: function (ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    fire: async function (ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

function harness({ responses = {}, state, checkFile, onSaveLinkReady } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  const real = { fetch: globalThis.fetch, document: globalThis.document, URL: globalThis.URL,
                 setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
                 setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const log = { calls: [], docClicks: [], replaced: [] };

  let ticks = new Map(), nextTick = 1;
  globalThis.setInterval = (fn) => { ticks.set(nextTick, fn); return nextTick++; };
  globalThis.clearInterval = (id) => { ticks.delete(id); };
  log.tick = async () => { for (const fn of [...ticks.values()]) await fn(); };

  // The link field's 400ms debounce: run it immediately, deterministically,
  // and hand the test whatever promise it started so it can be awaited.
  globalThis.setTimeout = (fn) => { log.lastTimeout = fn(); return 0; };
  globalThis.clearTimeout = () => {};

  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "click") log.docClicks.push(fn); },
  };
  globalThis.URL = {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => {},
  };
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    log.calls.push(`${method} ${url}`);
    const r = responses[url];
    if (typeof r === "function") return r(url, init);
    return r ?? { ok: true, json: async () => ({}) };
  };
  log.restore = () => {
    globalThis.fetch = real.fetch;
    globalThis.document = real.document;
    globalThis.URL = real.URL;
    globalThis.setInterval = real.setInterval;
    globalThis.clearInterval = real.clearInterval;
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  };

  clearDraft();
  const api = initDraftImport({ $, state, checkFile, onReplaced: (id) => log.replaced.push(id), onSaveLinkReady });
  return { $, api, log };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// Let a fetch the page started come back (setTimeout is the harness's own).
const settle = () => new Promise((r) => setImmediate(r));

test("with no video the Dubbing tab shows the shared Import block, and hides it once there is one", () => {
  const { $, api, log } = harness();
  assert.match($("dubbingImportSlot").outerHTML, /class="import-block" id="dubbingZone"/);
  assert.match($("dubbingImportSlot").outerHTML, />Import<\/div><div class="import-sub">Drop videos here, or click to choose<\/div><label class="import-link" id="dubbingLinkRow"><svg/);
  api.render();
  assert.equal($("dubbingImport").hidden, false);
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  assert.equal($("dubbingImport").hidden, true);
  assert.equal(getDraft().onTimeline, true, "an import is on the timeline at once");
  log.restore();
});

test("a job on screen has its script there, not the Import block", () => {
  const { $, api, log } = harness({ state: { jobId: "j1" } });
  api.render();
  assert.equal($("dubbingImport").hidden, true);
  log.restore();
});

test("a click anywhere on the Import block opens the page's hidden file input", async () => {
  const { $, log } = harness();
  $("dubbingZone").fire("click", {});
  assert.equal($("draftFileInput").clicked, 1);
  log.restore();
});

test("something that is not a link is answered on every tab's status line, and fetches nothing", async () => {
  const { $, log } = harness();
  $("dubbingLinkInput").value = "holiday";
  await $("dubbingLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  for (const id of ["dubbingImportStatus", "capImportStatus"]) {
    assert.equal($(id).textContent, "That is not a link. Paste one that starts with https://");
    assert.equal($(id).classList.contains("error"), true);
  }
  assert.deepEqual(log.calls, []);
  log.restore();
});

test("a file the app does not take is refused on the status line, and nothing is uploaded", async () => {
  const { $, api, log } = harness({ checkFile: (f) => (/\.mp4$/.test(f.name) ? null : "Please choose an MP4 or MOV video file.") });
  await api.importSource({ file: { name: "notes.txt" } });
  assert.equal($("dubbingImportStatus").textContent, "Please choose an MP4 or MOV video file.");
  assert.deepEqual(log.calls, []);
  assert.equal(getDraft(), null);
  log.restore();
});

test("picking a file uploads it and starts the draft", async () => {
  const { $, api, log } = harness({
    responses: {
      "/api/downloads/upload": ok({ id: "d1" }),
    },
  });
  api.render();
  const video = { preload: "", src: "", duration: 10, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); } };
  globalThis.document.createElement = (tag) => (tag === "video" ? video : makeEl(tag));

  const file = { name: "street-food.mp4", size: 100 };
  const p = api.importSource({ file });
  // The probe's loadedmetadata fires once the fake <video> "loads".
  await video.listeners.loadedmetadata[0]();
  await p;

  const d = getDraft();
  assert.equal(d.downloadId, "d1");
  assert.equal(d.name, "street-food.mp4");
  assert.equal(d.duration, 10);
  assert.ok(log.calls.includes("POST /api/downloads/upload"));
  log.restore();
});

test("a link is fetched and, once ready, becomes the draft", async () => {
  let call = 0;
  const { $, api, log } = harness({
    responses: {
      "/api/downloads": ok({ id: "dl1" }),
      "/api/downloads/dl1": () => {
        call += 1;
        return call === 1
          ? ok({ status: "downloading", percent: 40 })
          : ok({ status: "ready", id: "dl1", title: "street-food", duration_sec: 10 });
      },
    },
  });
  api.render();
  $("dubbingLinkInput").value = "https://example.com/v";
  await $("dubbingLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  await settle();
  assert.equal($("capImportStatus").textContent, "Reading the link…");
  await log.tick();
  assert.equal($("dubbingImportStatus").textContent, "Downloading… 40%");
  assert.equal($("capImportStatus").textContent, "Downloading… 40%", "the same line on whichever tab is open");
  await log.tick();
  assert.equal($("dubbingImportStatus").textContent, "");

  const d = getDraft();
  assert.equal(d.downloadId, "dl1");
  assert.equal(d.name, "street-food");
  log.restore();
});

// Save video with no video: the link field alone (owner, 2026-10-24).
test("with no video the Save video tab shows the link field alone, and a link there becomes the draft and is saved", async () => {
  let call = 0, saved = 0;
  const { $, api, log } = harness({
    responses: {
      "/api/downloads": ok({ id: "dl1" }),
      "/api/downloads/dl1": () => (++call === 1 ? ok({ status: "downloading", percent: 40 })
        : ok({ status: "ready", id: "dl1", title: "street-food", duration_sec: 10 })),
    },
    onSaveLinkReady: () => { saved += 1; },
  });
  assert.match($("saveImportSlot").outerHTML, /<div class="tab-empty-title">Save video<\/div><div class="tab-empty-sub">Saves a video from a link.<\/div><div class="import-block link-only" id="saveZone"><label class="import-link" id="saveLinkRow">/);
  api.render();
  assert.equal($("saveImport").hidden, false);
  // No file picker and no drop on it: the link field is all it takes.
  await $("saveZone").fire("click", {});
  assert.equal($("draftFileInput").clicked, undefined);
  assert.equal(($("saveZone").listeners.drop || []).length, 0);

  $("saveLinkInput").value = "https://example.com/v";
  await $("saveLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  await settle();
  await log.tick();
  assert.equal($("saveImportStatus").textContent, "Downloading… 40%");
  assert.equal(saved, 0, "not while it is coming down");
  await log.tick();
  assert.equal(getDraft().downloadId, "dl1");
  assert.equal($("saveImport").hidden, true);
  assert.equal(saved, 1);
  log.restore();
});

// A paste starts the fetch by itself (owner, 2026-10-09). The harness's
// setTimeout runs at once; the 400 ms wait is importBlock.test.mjs's to check.
test("a pasted link fetches by itself, words that are not one do not, and a click in the field stays with the field", async () => {
  const { $, log } = harness({ responses: { "/api/downloads": ok({ id: "dl1" }) } });
  $("dubbingLinkInput").value = "example.com/v";
  await $("dubbingLinkInput").fire("input", { inputType: "insertFromPaste" });
  const click = { target: $("dubbingLinkInput"), stopPropagation() { this.stopped = true; } };
  await $("dubbingLinkRow").fire("click", click);
  assert.equal(click.stopped, true);
  await settle();
  assert.ok(!log.calls.includes("POST /api/downloads"));
  assert.equal($("dubbingImportStatus").textContent, "", "nothing said mid-word");

  $("dubbingLinkInput").value = "https://example.com/v";
  await $("dubbingLinkInput").fire("input", { inputType: "insertFromPaste" });
  await settle();
  assert.ok(log.calls.includes("POST /api/downloads"));
  // Enter out of habit, after the paste has started it: not a second fetch.
  await $("dubbingLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  await settle();
  assert.equal(log.calls.filter((c) => c === "POST /api/downloads").length, 1);
  log.restore();
});

test("importing a second video asks first, in the confirm-dialog style", async () => {
  const { $, api, log } = harness();
  setDraft({ downloadId: "d1", name: "first.mp4", duration: 10, videoUrl: "/v" });
  api.render();
  const p = api.importSource({ file: { name: "second.mp4" } });
  assert.equal($("mediaReplaceOverlay").classList.contains("open"), true);
  // Cancelling keeps the first video.
  await $("mediaReplaceCancelBtn").fire("click");
  await p;
  assert.equal(getDraft().name, "first.mp4");
  log.restore();
});

test("the video pane plays the draft's video under its Original tab", () => {
  const { $, api, log } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  api.render();
  assert.equal($("doneVideo").getAttribute("src"), "/v");
  assert.equal($("vtabOriginal").classList.contains("active"), true);
  log.restore();
});

test("an empty new project empties the player: the last video's picture and length go", () => {
  const { $, api, log } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  clearDraft();
  assert.equal($("doneVideo").getAttribute("src"), undefined);
  assert.equal($("doneVideo").loaded, 1);
  // Already empty: nothing to load again.
  api.render();
  assert.equal($("doneVideo").loaded, 1);
  log.restore();
});

test("a job on screen keeps its video when a draft is left beside it", () => {
  const { $, api, log } = harness({ state: { jobId: "j1" } });
  $("doneVideo").setAttribute = (k, v) => { $("doneVideo").src = v; };
  $("doneVideo").getAttribute = () => "/job-video";
  setDraft({ downloadId: "d1", name: "other.mp4", duration: 10, videoUrl: "/v" });
  api.render();
  assert.equal($("doneVideo").src, undefined);
  log.restore();
});

test("a video file dropped on the timeline is imported, asking before it replaces the draft", async () => {
  const { $, api, log } = harness({ responses: { "/api/downloads/upload": ok({ id: "d2" }) } });
  setDraft({ downloadId: "d1", name: "first.mp4", duration: 10, videoUrl: "/v" });
  const drop = (types, files) => ({ dataTransfer: { types, files }, preventDefault() { this.prevented = true; } });
  const other = drop(["text/plain"], []);
  await $("timeline").fire("dragover", other);
  assert.equal(other.prevented, undefined, "only files are taken");
  const p = $("timeline").fire("drop", drop(["Files"], [{ name: "second.mp4" }]));
  assert.equal($("mediaReplaceOverlay").classList.contains("open"), true);
  await $("mediaReplaceCancelBtn").fire("click");
  await p;
  assert.equal(getDraft().name, "first.mp4");
  log.restore();
});

test("a video file dropped on the empty timeline row comes in with no question, only on the draft's own screen", async () => {
  const { $, log } = harness({ responses: { "/api/downloads/upload": ok({ id: "d3" }) } });
  const video = { preload: "", src: "", duration: 10, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); } };
  globalThis.document.createElement = (tag) => (tag === "video" ? video : makeEl(tag));
  const drop = { dataTransfer: { types: ["Files"], files: [{ name: "clip.mp4", size: 1 }] }, preventDefault() {} };
  const p = $("timeline").fire("drop", drop);
  await settle();
  assert.equal($("mediaReplaceOverlay").classList.contains("open"), false);
  assert.equal($("dubbingImportStatus").textContent, "Importing…");
  await video.listeners.loadedmetadata[0]();
  await p;
  await settle();
  assert.equal(getDraft().downloadId, "d3");
  assert.deepEqual(log.replaced, [], "a first video replaces nothing");
  log.restore();
});

// Replace on the Before dubbing card opens this same picker (owner,
// 2026-10-22): pressing Replace was the asking, so the file chosen takes the
// video's place with no question, and the line under the card says how it
// is going -- the Import block's own line is hidden behind the card.
test("a file chosen in the picker while the card has a video replaces it with no question, said under the card", async () => {
  const { $, log } = harness({ responses: { "/api/downloads/upload": ok({ id: "d2" }) } });
  const video = { preload: "", src: "", duration: 12, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); } };
  globalThis.document.createElement = (tag) => (tag === "video" ? video : makeEl(tag));
  setDraft({ downloadId: "d1", name: "first.mp4", duration: 10, videoUrl: "/v" });
  $("draftFileInput").files = [{ name: "second.mp4", size: 1 }];
  const p = $("draftFileInput").fire("change");
  await settle();
  assert.equal($("mediaReplaceOverlay").classList.contains("open"), false);
  assert.equal($("draftImportStatus").textContent, "Importing…");
  await video.listeners.loadedmetadata[0]();
  await p;
  await settle();
  assert.equal(getDraft().downloadId, "d2");
  assert.equal(getDraft().name, "second.mp4");
  assert.equal($("draftImportStatus").textContent, "");
  // The video it replaced is let go: its Draft card leaves Home (app.mjs forgetDraft).
  assert.deepEqual(log.replaced, ["d1"]);
  log.restore();
});

test("a file the app does not take says why under the card, until another video is on it", async () => {
  const { $, log } = harness({ checkFile: () => "Please choose an MP4 or MOV video file." });
  setDraft({ downloadId: "d1", name: "first.mp4", duration: 10, videoUrl: "/v" });
  $("draftFileInput").files = [{ name: "clip.mkv", size: 1 }];
  await $("draftFileInput").fire("change");
  await settle();
  assert.equal($("draftImportStatus").textContent, "Please choose an MP4 or MOV video file.");
  assert.equal($("draftImportStatus").classList.contains("error"), true);
  assert.equal(getDraft().downloadId, "d1", "the video stays");
  assert.deepEqual(log.replaced, [], "and so does its card");
  // A cut is still this video: what was said stays said.
  setRanges([[0, 5]]);
  assert.equal($("draftImportStatus").textContent, "Please choose an MP4 or MOV video file.");
  // Another one on the card (a draft opened from Home) is not what it was about.
  setDraft({ downloadId: "d9", name: "other.mp4", duration: 10, videoUrl: "/v9" });
  assert.equal($("draftImportStatus").textContent, "");
  log.restore();
});

// -- a download that finishes after the person has moved on ------------------

const slowLink = () => {
  let ready = false;
  return {
    finish: () => { ready = true; },
    responses: {
      "/api/downloads": ok({ id: "dlA" }),
      "/api/downloads/dlA": () => (ready
        ? ok({ status: "ready", id: "dlA", title: "video A", duration_sec: 10 })
        : ok({ status: "downloading", percent: 40 })),
    },
  };
};

test("a link still coming down when another project opens on a held video does not take its place", async () => {
  const link = slowLink();
  const { api, log } = harness({ responses: link.responses });
  api.render();
  await api.importSource({ link: "https://example.com/a" });
  await log.tick();

  // Project B: the way openDraft does it, the old draft let go and a video
  // the app already holds put in.
  clearDraft();
  await api.importSource({ downloadId: "heldB", name: "video B", duration: 5 });
  link.finish();
  await log.tick();

  assert.equal(getDraft().downloadId, "heldB", "B keeps its own video");
  log.restore();
});

// Add language hands over where the video is spoken, which prices a Perso
// dubbing of it (owner, 2026-10-22).
test("a held video brought in with where it is spoken keeps that on its draft", async (t) => {
  const { api, log } = harness();
  t.after(log.restore);
  await api.importSource({ downloadId: "heldB", name: "video B", duration: 5, speech: [[1, 2]] });
  assert.deepEqual(getDraft().speech, [[1, 2]]);
  clearDraft();   // as openDraft lets the last draft go
  await api.importSource({ downloadId: "heldC", name: "video C", duration: 5 });
  assert.equal(getDraft().speech, null, "one brought without it knows none");
});

// Save video's Export opens on this (2026-10-21): only for the link it was
// handed with, and only once that link's video is the draft.
test("a link's onReady is told once, when its video is the draft", async () => {
  const link = slowLink();
  const { api, log } = harness({ responses: link.responses });
  api.render();
  let told = 0;
  await api.importSource({ link: "https://example.com/a", onReady: () => { told += 1; } });
  await log.tick();
  assert.equal(told, 0, "not while it is coming down");
  link.finish();
  await log.tick();
  assert.equal(getDraft().downloadId, "dlA");
  assert.equal(told, 1);
  await log.tick();
  assert.equal(told, 1);
  log.restore();
});

test("a link let go for another one never tells its onReady", async () => {
  const link = slowLink();
  const { api, log } = harness({ responses: {
    ...link.responses,
    // Link a is dlA, still coming down; link b is dlB, in at once.
    "/api/downloads": (url, init) => ok({ id: JSON.parse(init.body).url.endsWith("/b") ? "dlB" : "dlA" }),
    "/api/downloads/dlB": ok({ status: "ready", id: "dlB", title: "video B", duration_sec: 5 }),
  } });
  api.render();
  let told = 0;
  await api.importSource({ link: "https://example.com/a", onReady: () => { told += 1; } });
  await log.tick();
  // Another link pasted into the Dubbing tab's block while the first comes down.
  await api.importSource({ link: "https://example.com/b" });
  await log.tick();
  assert.equal(getDraft().downloadId, "dlB");
  link.finish();
  await log.tick();
  assert.equal(getDraft().downloadId, "dlB", "a's video never lands");
  assert.equal(told, 0);
  log.restore();
});

test("a link still coming down when the draft is let go makes no draft, and its progress line goes", async () => {
  const link = slowLink();
  const { $, api, log } = harness({ responses: link.responses });
  api.render();
  await api.importSource({ link: "https://example.com/a" });
  await log.tick();
  assert.match($("dubbingImportStatus").textContent, /Downloading/);

  clearDraft();          // a job was opened, or an empty new project
  link.finish();
  await log.tick();
  assert.equal(getDraft(), null);
  assert.equal($("dubbingImportStatus").textContent, "");

  // Home keeps the draft as it is, so the page says so itself.
  await api.importSource({ link: "https://example.com/a" });
  api.cancelImport();
  await log.tick();
  assert.equal(getDraft(), null);
  log.restore();
});
