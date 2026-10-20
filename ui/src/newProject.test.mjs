// The New project dialog paints real elements and asks the engine for the
// saved defaults, so the tests hand it a paper-thin page: elements that are
// plain objects, a document that makes more of them, and a fetch that answers
// from a script. What is asserted is what the user would see (the dialog open,
// the flags in the target dropdown, the trim readout) and what a dub would be
// started with (readOptions' object, field for field).
//
// Run with: node --test ui/src/newProject.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initNewProjectUi, lengthLine } from "./newProject.mjs";
import { LANGUAGES } from "./dubApi.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", className: "", value: "", max: "", title: "",
    src: "", hidden: false, disabled: false, muted: true, paused: true,
    ended: false, currentTime: 0, duration: 0, clientWidth: 600,
    style: {}, dataset: {}, children: [], listeners: {}, attrs: {},
    // The dialog empties boxes with innerHTML = ""; nothing reads one back.
    set innerHTML(v) { this.html = v; if (v === "") this.children = []; },
    get innerHTML() { return this.html || ""; },
    get options() { return this.children; },
    // The real page finds an <option> by value; the fake list is small enough
    // to walk, and the selector is the only one this file ever writes.
    querySelector: function (sel) {
      const m = /^option\[value="(.*)"\]$/.exec(sel);
      return m ? this.children.find((o) => o.value === m[1]) || null : null;
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    getBoundingClientRect: () => ({ left: 0, width: 600 }),
    setAttribute: function (k, v) { this.attrs[k] = v; },
    removeAttribute: function (k) { delete this.attrs[k]; },
    load: function () { this.loaded = (this.loaded || 0) + 1; },
    appendChild: function (kid) { this.children.push(kid); },
    append: function (...kids) { this.children.push(...kids); },
    // restoreOptionsHome/moveOptionsInto (newProject.mjs) move a fixed few
    // elements around a page that, in these tests, never actually nests them --
    // only that the move does not throw matters here.
    insertBefore: function (kid) { this.children.push(kid); return kid; },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener: function (ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    fire: async function (ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

/** The browser's own storage, a Map underneath. One shared by two harnesses
    is the app being closed and opened again. */
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

/** A page, a fetch log and the callbacks the dialog reaches out through. */
function harness({ responses = {}, storage = memoryStorage() } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { newProject: null, linkProbe: null };
  const log = { calls: [], requests: [], docKeydown: [], hints: 0, dubMode: 0, engines: 0,
                started: 0, closed: 0, picked: 0, played: [], cancelled: [], erased: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document, URL: globalThis.URL,
                 setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  // The dialog asks how far along a download is once a second. The tests hold
  // that tick themselves -- log.tick() is one second going by -- so nothing
  // waits on a real clock and no test leaves a timer running behind it.
  let ticks = new Map(), nextTick = 1;
  globalThis.setInterval = (fn) => { ticks.set(nextTick, fn); return nextTick++; };
  globalThis.clearInterval = (id) => { ticks.delete(id); };
  log.tick = async () => { for (const fn of [...ticks.values()]) await fn(); };
  log.ticking = () => ticks.size;
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "keydown") log.docKeydown.push(fn); },
  };
  globalThis.URL = {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: (u) => log.calls.push(`revoke ${u}`),
  };
  // The method and the body come along now: the download routes are POSTs, and
  // what a Save clip asked for is the whole point of that button.
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    log.calls.push(`${method} ${url}`);
    log.requests.push({ url, method, body: init.body });
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
  };

  const api = initNewProjectUi({
    $, state,
    onStart: () => { log.started += 1; },
    applyEngineAvailability: () => { log.engines += 1; },
    updateEngineHints: () => { log.hints += 1; },
    paintDubMode: () => { log.dubMode += 1; },
    playRange: (v, a, b) => { log.played.push([a, b]); return Promise.resolve(); },
    cancelRange: (v) => { log.cancelled.push(v.id); },
    labelPx: () => 58,
    onClosed: () => { log.closed += 1; },
    onPickFile: () => { log.picked += 1; },
    onErase: (source) => { log.erased.push(source); },
    storage,
  });
  return { $, api, state, log };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status, detail) => ({ ok: false, status, json: async () => ({ detail }) });
// A link's dialog with the holding area answering: POST /api/downloads hands
// back id "d1", and every tick of the clock reads the next record in `steps`
// (the last one repeats).
function linkHarness(steps, extra = {}) {
  let at = 0;
  return harness({ responses: {
    "/api/downloads": () => ok({ id: "d1" }),
    "/api/downloads/d1": () => ok({ id: "d1", url: "https://x/y",
                                    ...steps[Math.min(at++, steps.length - 1)] }),
    ...extra,
  } });
}
const PROBE = { url: "https://x/y", title: "A talk", duration_sec: 90 };
// The Advanced-options dropdowns as the markup ships them, so loadSavedDefaults
// has real options to find (or fail to find).
function fillAdvanced($) {
  const opts = {
    dubModeSelect: ["local", "perso"],
    sepSelect: ["local", "perso"],
    sttSelect: ["local", "perso"],
    translateSelect: ["hunyuan", "gemma", "gemini"],
    qualitySelect: ["fast", "high"],
    voiceSelect: ["qwen3"],
  };
  for (const [id, values] of Object.entries(opts)) {
    const sel = $(id);
    for (const v of values) { const o = makeEl("option"); o.value = v; sel.appendChild(o); }
    sel.value = values[0];
  }
}

// -- the two dropdowns the dialog fills for itself -------------------------

test("the language dropdowns are filled from LANGUAGES, flags on the target only", (t) => {
  const h = harness();
  t.after(h.log.restore);

  assert.equal(h.$("sourceLangSelect").children.length, 10);
  assert.equal(h.$("targetLangSelect").children.length, 10);
  assert.equal(h.$("sourceLangSelect").children[0].textContent, "English");
  assert.equal(h.$("targetLangSelect").children[0].textContent, "🇺🇸 English");
  // English is the target's default; the source keeps its markup's Auto-detect.
  assert.equal(h.$("targetLangSelect").children[0].selected, true);
  assert.ok(!h.$("sourceLangSelect").children.some((o) => o.selected));
});

// -- opening ---------------------------------------------------------------

test("openNewProject on a link sets state.newProject and opens the overlay", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const probe = { url: "https://x/y", title: "A talk", duration_sec: 90, thumbnail_url: "https://x/t.jpg" };

  h.api.openNewProject({ probe });

  assert.deepEqual(h.state.newProject,
    { file: null, files: null, probe, trim: null, downloadId: null,
      title: "" });
  assert.equal(h.$("projectOverlay").classList.contains("open"), true);
  assert.equal(h.$("projectTitle").textContent, "New project");
  // A link has no video to scrub -- a still, a length, and no trim bar.
  assert.equal(h.$("projectVideo").hidden, true);
  assert.equal(h.$("projectThumb").style.backgroundImage, "url(https://x/t.jpg)");
  assert.equal(h.$("projectDur").textContent, "01:30");
  assert.equal(h.$("trimBox").innerHTML, "");
});

test("a link over 30 minutes shows the long-video note; a short one hides it", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.openNewProject({ probe: { url: "https://x/y", title: "Long", duration_sec: 1900 } });
  assert.equal(h.$("projectDur").textContent, "31:40");
  assert.equal(h.$("projectLongHint").hidden, false);
  h.api.openNewProject({ probe: { url: "https://x/z", title: "Short", duration_sec: 90 } });
  assert.equal(h.$("projectLongHint").hidden, true);
});

test("openNewProject on one file plays it from memory and clears the last error", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });

  assert.equal(h.state.newProject.file.name, "a.mp4");
  assert.equal(h.state.newProject.files, null);
  assert.equal(h.$("projectVideo").hidden, false);
  assert.equal(h.$("projectVideo").src, "blob:fake");
  assert.equal(h.$("projectReplace").hidden, false);
  assert.equal(h.$("projectError").textContent, "");
});

test("several files are one dialog: the batch title, no Replace, no trim bar", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const files = [{ name: "a.mp4" }, { name: "b.mp4" }, { name: "c.mp4" }];

  h.api.openNewProject({ files });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("projectTitle").textContent, "New project · 3 videos");
  // Replace picks ONE file, which would silently drop the rest of the batch.
  assert.equal(h.$("projectReplace").hidden, true);
  // Said once, in the title: not on the picture and not in the foot.
  assert.equal(h.$("projectDur").textContent, "");
  // A cut made on the first video would mean nothing to the others.
  assert.equal(h.$("trimBox").innerHTML, "");
});

test("opening re-reads the saved defaults, then repaints hints, mode and greying", async (t) => {
  const h = harness({ responses: { "/api/setup": ok({ defaults: {} }) } });
  t.after(h.log.restore);

  h.api.openNewProject({ probe: { url: "u", title: "t" } });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(h.log.calls.includes("GET /api/setup"));
  assert.equal(h.log.hints, 1);
  assert.equal(h.log.dubMode, 1);
  assert.equal(h.log.engines, 1);
});

// -- the trim bar ----------------------------------------------------------

// The trim box exactly as the page drew it before this file existed
// (`git show 72b709a:static/index.html`, renderTrim, for duration 30). Every
// line below the template's first is HTML the browser receives, so its leading
// spaces are output, not layout: this pins them the way scriptTable.test.mjs
// and timeline.test.mjs pin theirs, so the next re-indent of the module cannot
// quietly change what is on screen.
const TRIM_BOX =
  '\n' +
  '    <div class="trim-row">\n' +
  '      <button class="trim-play" id="trimPlay" type="button" title="Play the selected part" aria-label="Play the selected part">\n' +
  '        <svg class="ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5v13l10.5-6.5z"/></svg>\n' +
  '        <svg class="ico-pause" viewBox="0 0 18 18" aria-hidden="true"><rect x="5" y="3" width="3" height="12" rx="1"/><rect x="10" y="3" width="3" height="12" rx="1"/></svg>\n' +
  '      </button>\n' +
  '      <span class="trim-label">Trim</span>\n' +
  '      <span class="trim-read" id="trimRead"></span>\n' +
  '    </div>\n' +
  '    <div class="trim-scale" id="trimScale">\n' +
  '      <div class="trim-bar">\n' +
  '        <div class="trim-hatch" id="trimHatchStart" style="left: 0"></div>\n' +
  '        <div class="trim-hatch" id="trimHatchEnd" style="right: 0"></div>\n' +
  '        <div class="trim-sel" id="trimSel"></div>\n' +
  '        <input type="range" class="trim-range" id="trimStart" min="0" step="0.1" aria-label="Trim start">\n' +
  '        <input type="range" class="trim-range" id="trimEnd" min="0" step="0.1" aria-label="Trim end">\n' +
  '        <div class="trim-head" id="trimHead" hidden><i></i></div>\n' +
  '      </div>\n' +
  '      <div class="trim-ruler" id="trimRuler"></div>\n' +
  '    </div>';

test("the trim box is byte for byte the box the page drew before this file existed", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("trimBox").innerHTML, TRIM_BOX);
});

test("a file's length draws the trim bar and its readout", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("projectDur").textContent, "00:30");
  assert.match(h.$("trimBox").innerHTML, /id="trimStart"/);
  assert.equal(h.$("trimStart").value, "0");
  assert.equal(h.$("trimEnd").value, "30");
  assert.equal(h.$("trimEnd").max, "30");
  assert.equal(h.$("trimRead").textContent,
    "00:00:00.0 – 00:00:30.0 · 00:30 of 00:30");
  // Both handles at the ends is not a trim: nothing goes on the wire.
  assert.equal(h.state.newProject.trim, null);
});

test("dragging the end handle in writes the range onto state.newProject", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  h.$("trimEnd").value = "20";
  await h.$("trimEnd").fire("input");

  assert.deepEqual(h.state.newProject.trim, { start: 0, end: 20 });
  assert.equal(h.$("trimRead").textContent,
    "00:00:00.0 – 00:00:20.0 · 00:20 of 00:30");
});

test("a length too short to scrub draws no bar at all", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  h.$("projectVideo").duration = 0.4;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("trimBox").innerHTML, "");
});

// -- the held video: a link fetched, a file copied --------------------------

test("a pasted link is fetched the moment the dialog opens, and the row counts it down", async (t) => {
  const h = linkHarness([{ status: "downloading", percent: 43 }]);
  t.after(h.log.restore);

  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(h.log.calls.includes("POST /api/downloads"));
  assert.equal(h.$("dlRow").hidden, false);
  // Nothing can be done to a video that is not on this computer yet.
  assert.equal(h.$("startBtn").disabled, true);
  assert.equal(h.$("saveClipBtn").disabled, true);
  assert.equal(h.$("eraseBtn").disabled, true);

  await h.log.tick();

  assert.equal(h.$("dlPercent").textContent, "43%");
  assert.equal(h.$("dlFill").style.width, "43%");
});

test("when the file has landed it plays from the app and gets a trim bar", async (t) => {
  const h = linkHarness([{ status: "downloading", percent: 20 }, { status: "ready", percent: 100 }]);
  t.after(h.log.restore);
  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));

  await h.log.tick();
  await h.log.tick();

  assert.equal(h.$("dlRow").hidden, true, "the row goes rather than sitting at 100%");
  assert.equal(h.$("projectVideo").hidden, false);
  assert.equal(h.$("projectVideo").src, "/api/downloads/d1/video");
  assert.equal(h.state.newProject.downloadId, "d1");
  assert.equal(h.api.readOptions().downloadId, "d1");
  assert.equal(h.$("startBtn").disabled, false);
  assert.equal(h.$("saveClipBtn").disabled, false);
  assert.equal(h.$("eraseBtn").disabled, false);
  assert.equal(h.log.ticking(), 0, "nothing left to ask about");

  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("projectDur").textContent, "00:30");
  assert.match(h.$("trimBox").innerHTML, /id="trimStart"/);
});

// Coming back from the erase screen: the dialog is opened again on the video
// the app is already holding, and the handles have to be where they were left
// -- a trim thrown away on the way out is a cut the user has to make twice
// (user, 2026-09-09).
test("reopening the dialog on a held video puts the trim handles back", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ downloadId: "d1", title: "clip", trim: { start: 5, end: 20 } });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("projectVideo").src, "/api/downloads/d1/video");
  assert.equal(h.$("trimStart").value, "5");
  assert.equal(h.$("trimEnd").value, "20");
  assert.deepEqual(h.state.newProject.trim, { start: 5, end: 20 });
});

test("a fetch that fails says why on the dialog's own line and stops asking", async (t) => {
  const h = linkHarness([{ status: "failed", error: "This video is private." }]);
  t.after(h.log.restore);
  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));

  await h.log.tick();

  assert.equal(h.$("projectError").textContent, "This video is private.");
  assert.equal(h.$("dlRow").hidden, true);
  assert.equal(h.log.ticking(), 0);
  assert.equal(h.$("startBtn").disabled, true);
});

test("closing the dialog stops watching the download", async (t) => {
  const h = linkHarness([{ status: "downloading", percent: 10 }]);
  t.after(h.log.restore);
  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.ticking(), 1);

  h.api.closeNewProject();

  assert.equal(h.log.ticking(), 0);
});

test("the same link is played from the copy already held, not fetched again", async (t) => {
  const h = linkHarness([{ status: "ready", percent: 100 }]);
  t.after(h.log.restore);
  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));
  await h.log.tick();
  h.api.closeNewProject();
  const fetches = h.log.calls.filter((c) => c === "POST /api/downloads").length;

  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(h.log.calls.filter((c) => c === "POST /api/downloads").length, fetches);
  assert.equal(h.state.newProject.downloadId, "d1");
  assert.equal(h.$("projectVideo").src, "/api/downloads/d1/video");
});

test("a dropped file is copied into the holding area behind the video it is already playing", async (t) => {
  const h = harness({ responses: { "/api/downloads/upload": () => ok({ id: "u9", status: "ready" }) } });
  t.after(h.log.restore);
  const file = { name: "a.mp4" };

  h.api.openNewProject({ file });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  await new Promise((r) => setTimeout(r, 0));

  const up = h.log.requests.find((r) => r.url === "/api/downloads/upload");
  assert.equal(up.method, "POST");
  assert.equal(up.body.get("duration_sec"), "30");
  assert.equal(h.state.newProject.downloadId, "u9");
  assert.equal(h.$("saveClipBtn").disabled, false);
  // Nothing on screen waited for the copy: no progress row, and the video has
  // been playing from memory the whole time.
  assert.equal(h.$("dlRow").hidden, true);
  assert.equal(h.$("projectVideo").src, "blob:fake");
});

test("a copy that will not upload leaves the file itself to be dubbed", async (t) => {
  const h = harness({ responses: { "/api/downloads/upload": () => bad(500, "No room on the disk.") } });
  t.after(h.log.restore);
  const file = { name: "a.mp4" };

  h.api.openNewProject({ file });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(h.state.newProject.downloadId, null);
  assert.equal(h.api.readOptions().video, file);
  // The two that need the copy stay off; the dub carries the file as it always did.
  assert.equal(h.$("saveClipBtn").disabled, true);
  assert.equal(h.$("startBtn").disabled, false);
  assert.equal(h.$("projectError").textContent, "", "a quiet copy fails quietly");
});

// -- Save clip and Erase subtitles ------------------------------------------

/** A dialog whose link has landed, with the trim bar drawn for a 30s video. */
async function readyDialog(extra = {}) {
  const h = linkHarness([{ status: "ready", percent: 100 }], extra);
  h.api.openNewProject({ probe: PROBE });
  await new Promise((r) => setTimeout(r, 0));
  await h.log.tick();
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  return h;
}

test("Save clip sends the chosen stretch, then says where the file went", async (t) => {
  const h = await readyDialog({
    "/api/downloads/d1/save": () => ok({ path: "/Users/x/Downloads/A talk (0s-20s).mp4", seconds: 20 }),
  });
  t.after(h.log.restore);
  h.$("trimEnd").value = "20";
  await h.$("trimEnd").fire("input");

  await h.$("saveClipBtn").fire("click");

  const save = h.log.requests.find((r) => r.url === "/api/downloads/d1/save");
  assert.equal(save.method, "POST");
  assert.deepEqual(JSON.parse(save.body), { start: 0, end: 20 });
  assert.equal(h.$("projectSaved").textContent, "Saved to Downloads");
  // The button is itself again, so another stretch can be cut straight away.
  assert.equal(h.$("saveClipBtn").textContent, "Save clip");
  assert.equal(h.$("saveClipBtn").disabled, false);
});

test("Save clip with the handles at the ends asks for the whole video", async (t) => {
  const h = await readyDialog({ "/api/downloads/d1/save": () => ok({ path: "/Users/x/Downloads/A talk.mp4", seconds: 30 }) });
  t.after(h.log.restore);

  await h.$("saveClipBtn").fire("click");

  const save = h.log.requests.find((r) => r.url === "/api/downloads/d1/save");
  assert.deepEqual(JSON.parse(save.body), {});
  assert.equal(h.$("projectSaved").textContent, "Saved to Downloads");
});

test("a clip that cannot be saved says so on the red line, and claims nothing", async (t) => {
  const h = await readyDialog({ "/api/downloads/d1/save": () => bad(503, "ffmpeg could not cut this video.") });
  t.after(h.log.restore);

  await h.$("saveClipBtn").fire("click");

  assert.equal(h.$("projectError").textContent, "ffmpeg could not cut this video.");
  assert.equal(h.$("projectSaved").textContent, "");
  assert.equal(h.$("saveClipBtn").textContent, "Save clip");
  assert.equal(h.$("saveClipBtn").disabled, false);
});

test("Erase subtitles hands the held video over and gets out of the way", async (t) => {
  const h = await readyDialog();
  t.after(h.log.restore);

  await h.$("eraseBtn").fire("click");

  assert.deepEqual(h.log.erased,
    [{ downloadId: "d1", title: "A talk", duration_sec: 30, trim: null }]);
  assert.equal(h.$("projectOverlay").classList.contains("open"), false);
  assert.equal(h.state.newProject, null);
});

test("and the part the handles kept goes with it", async (t) => {
  const h = await readyDialog();
  t.after(h.log.restore);

  h.state.newProject.trim = { start: 2, end: 12 };
  await h.$("eraseBtn").fire("click");

  assert.deepEqual(h.log.erased,
    [{ downloadId: "d1", title: "A talk", duration_sec: 30, trim: { start: 2, end: 12 } }]);
});

test("the choices made before Erase subtitles are still there on the way back", async (t) => {
  // Reopening starts the dropdowns on the saved defaults: Whisper, chosen a
  // moment ago, came back as Perso API and the dub spent credits (2026-09-29).
  const h = await readyDialog({ "/api/setup": () => ok({ defaults: {
    stt: "perso", translator: "hunyuan", voice_quality: "fast" } }) });
  t.after(h.log.restore);
  fillAdvanced(h.$);
  h.$("sttSelect").value = "local";
  h.$("translateSelect").value = "gemma";
  h.$("qualitySelect").value = "high";

  await h.$("eraseBtn").fire("click");
  h.api.openNewProject({ downloadId: "d1", title: "A talk", duration_sec: 30, fromErase: true });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(h.$("sttSelect").value, "local");
  assert.equal(h.$("translateSelect").value, "gemma");
  assert.equal(h.$("qualitySelect").value, "high");

  // Any other way in starts on the saved defaults again, a held video too:
  // leaving the erase screen for home must not carry the choices to the next video.
  h.$("sttSelect").value = "local";
  await h.$("eraseBtn").fire("click");
  h.api.openNewProject({ downloadId: "d2", title: "Another" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.$("sttSelect").value, "perso");
});

// -- the saved defaults ----------------------------------------------------

test("loadSavedDefaults picks the saved value of every dropdown that has it", async (t) => {
  const h = harness({ responses: { "/api/setup": ok({ defaults: {
    dub_mode: "perso", separation: "perso", stt: "perso",
    translator: "gemini", voice_quality: "high",
  } }) } });
  t.after(h.log.restore);
  fillAdvanced(h.$);

  await h.api.loadSavedDefaults();

  assert.equal(h.$("dubModeSelect").value, "perso");
  assert.equal(h.$("sepSelect").value, "perso");
  assert.equal(h.$("sttSelect").value, "perso");
  assert.equal(h.$("translateSelect").value, "gemini");
  assert.equal(h.$("qualitySelect").value, "high");
});

test("a saved value no dropdown offers is ignored, and so is an empty one", async (t) => {
  const h = harness({ responses: { "/api/setup": ok({ defaults: {
    translator: "gemma-4", voice_quality: "", dub_mode: "perso",
  } }) } });
  t.after(h.log.restore);
  fillAdvanced(h.$);

  await h.api.loadSavedDefaults();

  // A model that was renamed, or one this build never shipped, must not
  // silently blank the dropdown it was saved for.
  assert.equal(h.$("translateSelect").value, "hunyuan");
  assert.equal(h.$("qualitySelect").value, "fast");
  assert.equal(h.$("dubModeSelect").value, "perso");
});

test("an engine that will not answer leaves the form on its shipped defaults", async (t) => {
  const h = harness({ responses: { "/api/setup": () => { throw new Error("down"); } } });
  t.after(h.log.restore);
  fillAdvanced(h.$);

  await h.api.loadSavedDefaults();

  assert.equal(h.$("dubModeSelect").value, "local");
  assert.equal(h.$("translateSelect").value, "hunyuan");
});

// -- what a dub is started with -------------------------------------------

test("readOptions hands back the whole form, field for field", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  await new Promise((r) => setTimeout(r, 0));   // the language lists have been asked for
  const file = { name: "a.mp4" };
  h.state.newProject = { file, files: null, probe: null, trim: { start: 1, end: 9 } };
  h.$("sourceLangSelect").value = "ko";
  h.$("targetLangSelect").value = "en";
  h.$("sttSelect").value = "local";
  h.$("sepSelect").value = "perso";
  h.$("dubModeSelect").value = "local";
  h.$("qualitySelect").value = "high";
  h.$("numSpeakers").value = "2";
  h.$("translateSelect").value = "gemini";
  h.$("voiceSelect").value = "qwen3";

  assert.deepEqual(h.api.readOptions(), {
    video: file,
    sourceUrl: null,
    downloadId: null,
    sourceLang: "ko",
    targetLang: "en",
    sttEngine: "local",
    sepEngine: "perso",
    dubMode: "local",
    // What the Dubbing model row would select; only a Perso dubbing sends it.
    persoModel: "ORIOLE",
    qualityMode: "high",
    numSpeakers: 2,
    translateEngine: "gemini",
    ttsEngine: "qwen3",
    // The list the target was picked from (the model's ten until the app
    // answers /api/languages; this harness answers nothing useful).
    languages: LANGUAGES.map((l) => ({ id: l.code, code: l.code, name: l.name, tag: null })),
    project: undefined,
    trim: { start: 1, end: 9 },
  });
});

test("a link's readOptions carries its URL and title instead of a file", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.state.newProject = { file: null, files: null, trim: null,
                         probe: { url: "https://x/y", title: "A talk" } };

  const o = h.api.readOptions();

  assert.equal(o.video, null);
  assert.equal(o.sourceUrl, "https://x/y");
  assert.equal(o.project, "A talk");
  assert.equal(o.trim, null);
});

test("an empty speaker count is left out, not sent as zero", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("numSpeakers").value = "";

  assert.equal(h.api.readOptions().numSpeakers, undefined);
});

test("readOptions on an empty dialog answers with no source at all", (t) => {
  const h = harness();
  t.after(h.log.restore);

  const o = h.api.readOptions();

  assert.equal(o.video, null);
  assert.equal(o.sourceUrl, null);
  assert.equal(o.project, undefined);
});

// -- closing ---------------------------------------------------------------

test("closing hides the dialog, drops the pending video and clears the source", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.openNewProject({ file: { name: "a.mp4" } });

  h.api.closeNewProject();

  assert.equal(h.$("projectOverlay").classList.contains("open"), false);
  assert.equal(h.state.newProject, null);
  assert.equal(h.log.closed, 1);
  // The object URL the dropped file was played from is handed back.
  assert.ok(h.log.calls.includes("revoke blob:fake"));
  assert.equal(h.$("projectVideo").attrs.src, undefined);
});

test("the X closes it", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.openNewProject({ probe: { url: "u", title: "t" } });

  h.$("projectClose").fire("click");

  assert.equal(h.$("projectOverlay").classList.contains("open"), false);
});

test("Escape closes the dialog only while it is open", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const esc = { key: "Escape" };

  for (const fn of h.log.docKeydown) await fn(esc);
  assert.equal(h.log.closed, 0, "nothing to close, nothing cleared");

  h.api.openNewProject({ probe: { url: "u", title: "t" } });
  for (const fn of h.log.docKeydown) await fn(esc);
  assert.equal(h.log.closed, 1);
  assert.equal(h.$("projectOverlay").classList.contains("open"), false);
});

test("Replace closes the dialog and reopens the file picker", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.openNewProject({ file: { name: "a.mp4" } });

  h.$("projectReplace").fire("click");

  assert.equal(h.$("projectOverlay").classList.contains("open"), false);
  assert.equal(h.log.picked, 1);
});

// -- the rest of the dialog's own chrome -----------------------------------

test("Advanced options folds open and shut", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("advancedBody").hidden = true;

  h.$("advancedBtn").fire("click");
  assert.equal(h.$("advancedBody").hidden, false);
  assert.equal(h.$("advancedBtn").attrs["aria-expanded"], "true");

  h.$("advancedBtn").fire("click");
  assert.equal(h.$("advancedBody").hidden, true);
  assert.equal(h.$("advancedBtn").attrs["aria-expanded"], "false");
});

test("Start hands the job back to the page", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.$("startBtn").fire("click");

  assert.equal(h.log.started, 1);
});


// -- the Dubbing model row ---------------------------------------------------

const PERSO_LANGS = [
  { id: "en", code: "en", name: "English (US)", tag: null, models: ["NIGHTINGALE", "ORIOLE", "WREN"] },
  { id: "en-GB", code: "en", name: "English (UK)", tag: "en-GB", models: ["NIGHTINGALE", "ORIOLE"] },
  { id: "en-AU", code: "en", name: "English (Australia)", tag: "en-AU", models: ["NIGHTINGALE"] },
];
async function persoHarness(extra = {}, storage = memoryStorage()) {
  const h = harness({ responses: { "/api/languages": ok({ local: [], perso: PERSO_LANGS }), ...extra }, storage });
  fillAdvanced(h.$);
  await new Promise((r) => setTimeout(r, 0));
  return h;
}
async function persoDialog(extra = {}, storage = memoryStorage()) {
  const h = await persoHarness(extra, storage);
  h.$("dubModeSelect").value = "perso";
  await h.$("dubModeSelect").fire("change");
  return h;
}
// The Dubbing model choice: a button, and the list it opens under it. A model
// row's name is the first line of its text.
const pick = (h) => h.$("persoModelPick");
async function openModels(h) {
  if (pick(h).children.length < 2) await pick(h).children[0].fire("click");
  return pick(h).children[1].children;
}
const nameOf = (opt) => opt.children[0].children[0].textContent;
/** Every model the list offers, the chosen one in brackets; the list is closed again after. */
async function models(h) {
  const names = (await openModels(h)).map((o) => (o.attrs["aria-selected"] === "true" ? `[${nameOf(o)}]` : nameOf(o)));
  await pick(h).children[0].fire("click");
  return names;
}
/** Open the list and press the row named `name`. */
async function chooseModel(h, name) {
  const opt = (await openModels(h)).find((o) => nameOf(o) === name);
  await opt.fire("click");
  return opt;
}
const targets = (h) => h.$("targetLangSelect").children.map((o) => o.value);

test("the Dubbing model row shows only under Perso API, with Oriole selected", async (t) => {
  const h = await persoDialog();
  t.after(h.log.restore);
  assert.equal(h.$("persoModelRow").hidden, false);
  assert.deepEqual(await models(h), ["[Oriole]", "Wren", "Nightingale"]);
  assert.equal(h.api.readOptions().persoModel, "ORIOLE");

  h.$("dubModeSelect").value = "local";
  await h.$("dubModeSelect").fire("change");
  assert.equal(h.$("persoModelRow").hidden, true);
});

test("pressing a segment chooses that model, and it is what the dubbing starts with", async (t) => {
  const h = await persoDialog();
  t.after(h.log.restore);
  await chooseModel(h, "Wren");
  assert.deepEqual(await models(h), ["Oriole", "[Wren]", "Nightingale"]);
  assert.equal(nameOf({ children: [pick(h).children[0]] }), "Wren");     // the button names it
  assert.equal(h.api.readOptions().persoModel, "WREN");
  assert.equal(h.api.persoModel(), "WREN");
});

test("the target languages are the ones the chosen model has", async (t) => {
  const h = await persoDialog();
  t.after(h.log.restore);
  assert.deepEqual(targets(h), ["en", "en-GB"]);                    // Oriole
  await chooseModel(h, "Nightingale");            // Nightingale
  assert.deepEqual(targets(h), ["en", "en-GB", "en-AU"]);
  assert.equal(h.$("persoModelHint").textContent, "6 credits per second · 3 languages · Perso Pro plan and up");
  assert.deepEqual(await models(h), ["Oriole", "Wren", "[Nightingale]"]);
  await chooseModel(h, "Wren");            // Wren
  assert.deepEqual(targets(h), ["en"]);
});

test("a model that lacks the chosen language cannot be chosen, so the language never changes under the user", async (t) => {
  // Choosing it used to swap the language for English without a word, and a
  // Start then dubbed into the wrong language for credits (Windows C11, 2026-10-07).
  const h = await persoDialog();
  t.after(h.log.restore);
  await chooseModel(h, "Nightingale");
  h.$("targetLangSelect").value = "en-GB";
  await h.$("targetLangSelect").fire("change");
  const [oriole, wren] = await openModels(h);
  assert.equal(oriole.disabled, false);                            // Oriole has en-GB
  assert.equal(wren.disabled, true);                               // Wren does not
  assert.equal(wren.title, "Wren has no English (UK)");
  await wren.fire("click");
  assert.equal(h.$("targetLangSelect").value, "en-GB");
  assert.equal(h.api.readOptions().persoModel, "NIGHTINGALE");
  await chooseModel(h, "Oriole");                                       // Oriole has en-GB
  assert.equal(h.$("targetLangSelect").value, "en-GB");
  assert.equal(h.api.readOptions().persoModel, "ORIOLE");
});

test("a remembered model Perso no longer names gives way to Oriole", async (t) => {
  const storage = memoryStorage();
  storage.setItem("persodub.lastChoices", JSON.stringify({ persoModel: { value: "DODO", over: null } }));
  const h = await persoDialog({}, storage);
  t.after(h.log.restore);
  assert.equal(h.api.readOptions().persoModel, "ORIOLE");
});

test("every model Perso names is offered, a new one under a name made from its id, each with its line", async (t) => {
  // A model Perso adds shows up without an app update (owner, 2026-10-19).
  const h = harness({ responses: { "/api/languages": ok({ local: [], perso: [
    { id: "en", code: "en", name: "English (US)", tag: null, models: ["NIGHTINGALE", "FINCH", "ORIOLE", "NEW_ONE"] },
  ] }) } });
  t.after(h.log.restore);
  fillAdvanced(h.$);
  await new Promise((r) => setTimeout(r, 0));
  h.$("dubModeSelect").value = "perso";
  await h.$("dubModeSelect").fire("change");
  const rows = await openModels(h);
  assert.deepEqual(rows.map(nameOf), ["Oriole", "Finch", "Nightingale", "New One"]);
  const caption = (o) => o.children[0].children[1].textContent;
  assert.equal(caption(rows[0]), "Default · 1 credits per second · 1 languages");
  assert.equal(caption(rows[1]), "Lowest-cost basic dubbing · 0.2 credits per second · 1 languages");
  assert.equal(caption(rows[3]), "1 languages");                    // nothing known of it but its languages
  assert.equal(rows[1].children[1].textContent, "Pro and up");       // the Pro badge
  assert.equal(rows[0].children.length, 1);                          // none on Oriole
  assert.equal(rows[0].attrs.role, "option");
  assert.equal(pick(h).children[1].attrs.role, "listbox");
  await rows[1].fire("click");
  assert.equal(h.api.readOptions().persoModel, "FINCH");
  assert.equal(pick(h).children.length, 1, "choosing closes the list");
  assert.equal(h.$("persoModelHint").textContent, "0.2 credits per second · 1 languages · Perso Pro plan and up");
});

test("the chosen model survives the trip to Erase subtitles, and a new video starts on it too", async (t) => {
  const h = await persoDialog({
    "/api/setup": () => ok({ defaults: { dub_mode: "perso" } }),
    "/api/downloads/d1": () => ok({ id: "d1", status: "ready" }),
  });
  t.after(h.log.restore);
  h.api.openNewProject({ downloadId: "d1", title: "A talk" });
  await new Promise((r) => setTimeout(r, 0));
  await chooseModel(h, "Wren");            // Wren

  await h.$("eraseBtn").fire("click");
  h.api.openNewProject({ downloadId: "d1", title: "A talk", fromErase: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await models(h), ["Oriole", "[Wren]", "Nightingale"]);

  // The next project is the person's next one: Wren was their choice, so it
  // is remembered (owner, 2026-10-06; Oriole came back in Windows test B7).
  h.api.openNewProject({ downloadId: "d2", title: "Another" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await models(h), ["Oriole", "[Wren]", "Nightingale"]);
});

// -- the choices remembered for the next project ----------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));
const SETUP = { defaults: { dub_mode: "local", separation: "local", stt: "local",
                            translator: "hunyuan", voice_quality: "fast", voice: "qwen3" },
                keys: { perso: true, gemini: true }, models: [] };
const setupWith = (over = {}) => ({ "/api/setup": () => ok({ ...SETUP, ...over }) });
async function choose(h, id, value) {
  h.$(id).value = value;
  await h.$(id).fire("change");
}

test("Perso API with Wren is what the next project starts on, after a restart too (B7)", async (t) => {
  const store = memoryStorage();
  const h = await persoHarness(setupWith(), store);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "dubModeSelect", "perso");
  await chooseModel(h, "Wren");            // Wren
  await choose(h, "numSpeakers", "2");
  h.log.restore();

  // The app is closed and opened again: a new page on the same storage.
  const h2 = await persoHarness(setupWith(), store);
  t.after(h2.log.restore);
  h2.api.openNewProject({ downloadId: "d2", title: "Next" });
  await tick();
  assert.equal(h2.$("dubModeSelect").value, "perso");
  assert.deepEqual(await models(h2), ["Oriole", "[Wren]", "Nightingale"]);
  assert.equal(h2.$("persoModelRow").hidden, false);
  assert.equal(h2.$("numSpeakers").value, "2");
  assert.equal(h2.api.readOptions().persoModel, "WREN");
});

test("every Advanced option and the target language are remembered", async (t) => {
  const store = memoryStorage();
  const h = await persoHarness(setupWith(), store);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "sepSelect", "perso");
  await choose(h, "sttSelect", "perso");
  await choose(h, "translateSelect", "gemini");
  await choose(h, "qualitySelect", "high");
  await choose(h, "dubModeSelect", "perso");
  await choose(h, "targetLangSelect", "en-GB");
  await choose(h, "dubModeSelect", "local");
  h.log.restore();

  const h2 = await persoHarness(setupWith(), store);
  t.after(h2.log.restore);
  h2.api.openNewProject({ downloadId: "d2", title: "Next" });
  await tick();
  const o = h2.api.readOptions();
  assert.deepEqual([o.dubMode, o.sepEngine, o.sttEngine, o.translateEngine, o.ttsEngine, o.qualityMode],
                   ["local", "perso", "perso", "gemini", "qwen3", "high"]);
  // en-GB is a Perso language: it comes back once Perso dubs again.
  await choose(h2, "dubModeSelect", "perso");
  assert.equal(h2.$("targetLangSelect").value, "en-GB");
});

test("a remembered Perso language waits for the language list that has it", async (t) => {
  const store = memoryStorage();
  const h = await persoHarness(setupWith(), store);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "dubModeSelect", "perso");
  await choose(h, "targetLangSelect", "en-GB");
  h.log.restore();

  // After a restart the list comes in only after the project has opened.
  let answer;
  const late = new Promise((r) => { answer = r; });
  const h2 = harness({ storage: store, responses: { ...setupWith(),
    "/api/languages": () => late.then(() => ok({ local: [], perso: PERSO_LANGS })) } });
  t.after(h2.log.restore);
  fillAdvanced(h2.$);
  h2.api.openNewProject({ downloadId: "d2", title: "Next" });
  await tick();
  assert.equal(h2.$("dubModeSelect").value, "perso");
  assert.equal(h2.$("targetLangSelect").value, "en");             // not in the list yet
  answer();
  await tick();
  assert.equal(h2.$("targetLangSelect").value, "en-GB");
});

test("Perso without its key starts on this computer, and Perso comes back with the key", async (t) => {
  const store = memoryStorage();
  const h = await persoHarness(setupWith(), store);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "dubModeSelect", "perso");
  h.log.restore();

  const noKey = setupWith({ keys: { perso: false, gemini: true } });
  const h2 = await persoHarness(noKey, store);
  h2.api.openNewProject({ downloadId: "d2", title: "Next" });
  await tick();
  h2.log.restore();
  assert.equal(h2.$("dubModeSelect").value, "local");

  // Falling back wrote nothing: once the key is saved again, so is the choice.
  const h3 = await persoHarness(setupWith(), store);
  t.after(h3.log.restore);
  h3.api.openNewProject({ downloadId: "d3", title: "Later" });
  await tick();
  assert.equal(h3.$("dubModeSelect").value, "perso");
});

test("a dubbing's own choices (Add language) win over the remembered ones", async (t) => {
  const store = memoryStorage();
  const h = await persoHarness(setupWith(), store);
  t.after(h.log.restore);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "dubModeSelect", "perso");
  await chooseModel(h, "Wren");            // Wren
  await choose(h, "numSpeakers", "3");

  await h.api.startOnDefaults({ dubMode: "local", source: "", speakers: "1", translator: "gemini" });
  assert.equal(h.$("dubModeSelect").value, "local");
  assert.equal(h.$("translateSelect").value, "gemini");
  assert.equal(h.$("numSpeakers").value, "1");
  assert.equal(h.api.persoModel(), "ORIOLE");
});

test("a storage the browser blocks leaves the dialog working on its defaults", async (t) => {
  const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const h = await persoHarness(setupWith(), blocked);
  t.after(h.log.restore);
  h.api.openNewProject({ downloadId: "d1", title: "First" });
  await tick();
  await choose(h, "dubModeSelect", "perso");
  await chooseModel(h, "Wren");
  assert.equal(h.api.readOptions().persoModel, "WREN");
  h.api.openNewProject({ downloadId: "d2", title: "Next" });
  await tick();
  assert.equal(h.$("dubModeSelect").value, "local");
});

// The four languages that are shown by name alone, no country's flag.
const NO_FLAG = ["bo", "ug", "yue", "zh-TW"];

test("every Perso language gets a flag, regional variants their own country", async (t) => {
  // The bundled list is the one the app ships (app/perso_languages.json).
  const { readFileSync } = await import("node:fs");
  const perso = JSON.parse(readFileSync(new URL("../../app/perso_languages.json", import.meta.url), "utf8")).languages
    .map((l) => ({ id: l.tag || l.code, code: l.code, name: l.name, tag: l.tag }));
  const h = harness({ responses: { "/api/languages": { ok: true, json: async () => ({ local: [], perso }) } } });
  t.after(h.log.restore);
  await new Promise((r) => setTimeout(r, 0));
  h.$("dubModeSelect").value = "perso";
  await h.$("dubModeSelect").fire("change");
  const opts = h.$("targetLangSelect").options;
  assert.equal(opts.length, perso.length);
  const bare = opts.filter((o) => !/^\p{Extended_Pictographic}|^\p{Regional_Indicator}/u.test(o.textContent));
  assert.deepEqual(bare.map((o) => o.value).sort(), [...NO_FLAG].sort(), "every option but the four starts with a flag");
  const byId = Object.fromEntries(opts.map((o) => [o.value, o.textContent]));
  assert.ok(byId["en-GB"].startsWith("🇬🇧") && byId["en"].startsWith("🇺🇸"), "UK and US English differ");
  assert.ok(byId["pt"].startsWith("🇧🇷") && byId["pt-PT"].startsWith("🇵🇹"));
  assert.ok(byId["es"].startsWith("🇲🇽") && byId["es-ES"].startsWith("🇪🇸"));
  // Back on the local list, plain Portuguese and Spanish keep their own flags.
  h.$("dubModeSelect").value = "local";
  await h.$("dubModeSelect").fire("change");
  const localById = Object.fromEntries(h.$("targetLangSelect").options.map((o) => [o.value, o.textContent]));
  assert.equal(localById["pt"], "🇵🇹 Portuguese");
  assert.equal(localById["es"], "🇪🇸 Spanish");
});

// The dialog's bottom line (mockup 2026-09-29): "Duration: 00:10", and what
// is kept once the handles have cut into it.
test("lengthLine says the length, and the kept part only when there is a cut", () => {
  assert.equal(lengthLine(10, null), "Duration: 00:10");
  assert.equal(lengthLine(728, null), "Duration: 12:08");
  assert.equal(lengthLine(3723, null), "Duration: 1:02:03");
  assert.equal(lengthLine(10, { start: 0, end: 6.5 }), "Duration: 00:10 \u00b7 00:06 kept");
  assert.equal(lengthLine(NaN, null), "");
  assert.equal(lengthLine(0, null), "");
});

test("the bottom line follows the video: its length, the cut, the batch, a link", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  assert.equal(h.$("projectLength").textContent, "", "nothing until the length is known");
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  assert.equal(h.$("projectLength").textContent, "Duration: 00:30");

  h.$("trimEnd").value = "12";
  await h.$("trimEnd").fire("input");
  assert.equal(h.$("projectLength").textContent, "Duration: 00:30 \u00b7 00:12 kept");

  h.api.openNewProject({ files: [{ name: "a.mp4" }, { name: "b.mp4" }] });
  h.$("projectVideo").duration = 30;
  await h.$("projectVideo").fire("loadedmetadata");
  assert.equal(h.$("projectLength").textContent, "");

  h.api.openNewProject({ probe: PROBE });
  assert.equal(h.$("projectLength").textContent, "Duration: 01:30");
});

test("the options block goes home to the box that scrolls, in order, and out to a borrower", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ probe: PROBE });
  // The voice engine's warning goes with the languages (issue #187).
  assert.deepEqual(h.$("projectOptions").children.map((e) => e.id),
    ["langGrid", "engineWarning", "advancedBtn", "advancedBody"]);

  const slot = h.$("draftOptionsSlot");
  h.api.moveOptionsInto(slot);
  assert.deepEqual(slot.children.map((e) => e.id), ["langGrid", "engineWarning", "advancedBtn", "advancedBody"]);
});
