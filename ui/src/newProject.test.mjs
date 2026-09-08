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
import { initNewProjectUi } from "./newProject.mjs";
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
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener: function (ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    fire: async function (ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

/** A page, a fetch log and the callbacks the dialog reaches out through. */
function harness({ responses = {} } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { newProject: null, linkProbe: null };
  const log = { calls: [], docKeydown: [], hints: 0, dubMode: 0, engines: 0,
                started: 0, closed: 0, picked: 0, played: [], cancelled: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document, URL: globalThis.URL };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "keydown") log.docKeydown.push(fn); },
  };
  globalThis.URL = {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: (u) => log.calls.push(`revoke ${u}`),
  };
  globalThis.fetch = async (url) => {
    log.calls.push(`GET ${url}`);
    const r = responses[url];
    if (typeof r === "function") return r();
    return r ?? { ok: true, json: async () => ({}) };
  };
  log.restore = () => {
    globalThis.fetch = real.fetch;
    globalThis.document = real.document;
    globalThis.URL = real.URL;
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
  });
  return { $, api, state, log };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// The Advanced-options dropdowns as the markup ships them, so loadSavedDefaults
// has real options to find (or fail to find).
function fillAdvanced($) {
  const opts = {
    dubModeSelect: ["local", "perso"],
    sepSelect: ["local", "perso"],
    sttSelect: ["local", "perso"],
    translateSelect: ["hunyuan", "gemma", "gemini"],
    qualitySelect: ["fast", "high"],
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

  assert.deepEqual(h.state.newProject, { file: null, files: null, probe, trim: null });
  assert.equal(h.$("projectOverlay").classList.contains("open"), true);
  assert.equal(h.$("projectTitle").textContent, "New project");
  // A link has no video to scrub -- a still, a length, and no trim bar.
  assert.equal(h.$("projectVideo").hidden, true);
  assert.equal(h.$("projectThumb").style.backgroundImage, "url(https://x/t.jpg)");
  assert.equal(h.$("projectDur").textContent, "00:01:30");
  assert.equal(h.$("trimBox").innerHTML, "");
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

  assert.equal(h.$("projectTitle").textContent, "New projects (3)");
  // Replace picks ONE file, which would silently drop the rest of the batch.
  assert.equal(h.$("projectReplace").hidden, true);
  assert.equal(h.$("projectDur").textContent, "3 videos");
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

  assert.equal(h.$("projectDur").textContent, "00:00:30");
  assert.match(h.$("trimBox").innerHTML, /id="trimStart"/);
  assert.equal(h.$("trimStart").value, "0");
  assert.equal(h.$("trimEnd").value, "30");
  assert.equal(h.$("trimEnd").max, "30");
  assert.equal(h.$("trimRead").textContent,
    "00:00:00.0 – 00:00:30.0 · 30.0s of 30.0s");
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
    "00:00:00.0 – 00:00:20.0 · 20.0s of 30.0s");
});

test("a length too short to scrub draws no bar at all", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.openNewProject({ file: { name: "a.mp4" } });
  h.$("projectVideo").duration = 0.4;
  await h.$("projectVideo").fire("loadedmetadata");

  assert.equal(h.$("trimBox").innerHTML, "");
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

  assert.deepEqual(h.api.readOptions(), {
    video: file,
    sourceUrl: null,
    sourceLang: "ko",
    targetLang: "en",
    sttEngine: "local",
    sepEngine: "perso",
    dubMode: "local",
    qualityMode: "high",
    numSpeakers: 2,
    translateEngine: "gemini",
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
  assert.deepEqual(bare.map((o) => o.value), [], "every option starts with a flag");
  const byId = Object.fromEntries(opts.map((o) => [o.value, o.textContent]));
  assert.ok(byId["en-GB"].startsWith("🇬🇧") && byId["en"].startsWith("🇺🇸"), "UK and US English differ");
  assert.ok(byId["pt"].startsWith("🇧🇷") && byId["pt-PT"].startsWith("🇵🇹"));
  assert.ok(byId["es"].startsWith("🇲🇽") && byId["es-ES"].startsWith("🇪🇸"));
});
