// The draft state of the work screen paints real elements and asks the New
// project dialog to lend it its language/Advanced options block, so the
// tests hand it a paper-thin page -- the pattern ui/src/newProject.test.mjs
// already uses.
//
// Run with: node --test ui/src/draftSetup.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initDraftSetup } from "./draftSetup.mjs";
import { clearDraft, getDraft, setDraft, setRanges } from "./draft.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", hidden: false, disabled: false, children: [],
    listeners: {},
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 contains: (c) => classes.has(c) },
    appendChild: function (kid) { this.children.push(kid); },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire: async function (ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

function harness({ firstDownloadBytes = () => 0 } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  $("targetLangSelect").value = "en";
  $("qualitySelect").value = "fast";

  const log = { screens: [], topbars: [], fit: 0, sized: 0, tabs: [], mediaRendered: 0,
                imported: [], moved: 0, started: [] };
  const state = { jobId: null };
  const importer = {
    render: () => { log.mediaRendered += 1; },
    importSource: async (source) => {
      log.imported.push(source);
      setDraft({ downloadId: "d1", name: source.file ? source.file.name : "linked.mp4",
                 duration: 10, videoUrl: "/v" });
    },
  };
  const newProject = {
    startOnDefaults: async (kept) => { log.defaults = (log.defaults || 0) + 1; log.kept = kept; },
    currentLanguages: () => [{ id: "en", code: "en", name: "English" }],
    persoModel: () => "WREN",
    moveOptionsInto: (el) => { log.moved += 1; el.appendChild($("langGrid")); },
  };
  let submitResult = true;
  const submitDubStart = async (o) => { log.started.push(o); return submitResult; };
  // A start whose answer the test lets through by hand.
  log.holdStart = () => { submitResult = new Promise((res) => { log.answerStart = res; }); };
  let restart = null;

  const api = initDraftSetup({
    $, state,
    showScreen: (name) => log.screens.push(name),
    setTopbar: (o) => log.topbars.push(o),
    fitLayout: () => { log.fit += 1; },
    sizeVideoPane: () => { log.sized += 1; },
    leftTabsShow: (name) => log.tabs.push(name),
    importer, newProject, submitDubStart,
    setDubRestart: (fn) => { restart = fn; },
    getScreen: () => log.screen,
    firstDownloadBytes,
  });
  log.screen = "done";
  return { $, api, log, state, setSubmitResult: (v) => { submitResult = v; }, restart: () => restart };
}

test("opening an empty draft resets the work screen to a blank New project", async () => {
  clearDraft();
  const { $, api, log } = harness();
  await api.openDraft();
  assert.deepEqual(log.screens, ["done"]);
  assert.equal(log.topbars[0].title, "New project");
  assert.equal($("exportBtn").disabled, true);
  assert.equal($("doneLayout").hidden, false);
  assert.equal($("doneFail").hidden, true);
  assert.deepEqual(log.tabs, ["dubbing"], "Dubbing is the tab a new project opens on");
  assert.ok(log.mediaRendered >= 1, "the Import block is asked for");
  // Neither the card nor a script: the Import block is the tab's face.
  assert.equal($("draftSetup").hidden, true);
  assert.equal($("dubbingPaneHead").hidden, true);
  assert.equal($("scriptBox").hidden, true);
  assert.equal(log.fit, 1);
  assert.equal(log.sized, 1);
});

test("one file opens a draft with the video already on the timeline", async () => {
  clearDraft();
  const { api, log } = harness();
  await api.openDraft({ file: { name: "street-food.mp4" } });
  assert.deepEqual(log.imported, [{ file: { name: "street-food.mp4" } }]);
  assert.equal(getDraft().onTimeline, true);
});

test("the Dubbing tab's card shows once a video is imported, and hides the Script pane", () => {
  clearDraft();
  const { $, log } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  assert.equal($("draftSetup").hidden, false);
  assert.equal($("dubbingPaneHead").hidden, true);
  assert.equal($("scriptBox").hidden, true);
  assert.equal($("draftPartCard").innerHTML,
    '<div class="k">Video</div><div class="m vc-name" title="a.mp4">a.mp4</div><div class="s vc-len">00:10</div>');
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · Fast mode");
  assert.equal(log.moved, 1);
});

test("cutting a part out updates the card's numbers", () => {
  clearDraft();
  const { $ } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  setRanges([[0, 7.6]]);
  assert.match($("draftPartCard").innerHTML, /<div class="s vc-len">00:07<span class="vc-cut">00:02 cut<\/span><\/div>/);
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:07 · Fast mode");
});

test("a video over 30 minutes gets the long-video note on the card, gone once the kept part is under", () => {
  clearDraft();
  const { $ } = harness();
  setDraft({ downloadId: "d1", name: "long.mp4", duration: 31 * 60, videoUrl: "/v" });
  assert.equal($("draftLongHint").hidden, false);
  setRanges([[0, 29 * 60]]);
  assert.equal($("draftLongHint").hidden, true);
  setDraft({ downloadId: "d1", name: "short.mp4", duration: 10, videoUrl: "/v" });
  assert.equal($("draftLongHint").hidden, true);
});


test("a real job takes the card back down, even mid-draft", () => {
  clearDraft();
  const { $, state } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  state.jobId = "j1";
  setDraft({ downloadId: "d2", name: "b.mp4", duration: 5, videoUrl: "/v2" });
  assert.equal($("draftSetup").hidden, true);
  assert.equal($("dubbingPaneHead").hidden, false);
});

test("Start dubbing posts the form and clears the draft once the job is under way", async () => {
  clearDraft();
  const { $, api, log } = harness();
  await api.openDraft({ file: { name: "a.mp4" } });
  await $("draftStartBtn").fire("click");
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].label, "a");
  assert.equal(getDraft(), null);
});

test("Start dubbing that comes back short leaves the draft in place to retry", async () => {
  clearDraft();
  const { $, api, log, setSubmitResult } = harness();
  setSubmitResult(false);
  await api.openDraft({ file: { name: "a.mp4" } });
  await $("draftStartBtn").fire("click");
  assert.equal(log.started.length, 1);
  assert.ok(getDraft());
});

test("cutting several parts starts the dub with the kept parts as pairs of seconds", async () => {
  clearDraft();
  const { $, api, log } = harness();
  await api.openDraft({ file: { name: "a.mp4" } });
  setRanges([[0, 2], [4, 8]]);
  await $("draftStartBtn").fire("click");
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].fd.get("ranges"), "[[0,2],[4,8]]");
  assert.equal(log.started[0].fd.get("trim_start"), null);
});

test("Start dubbing sends the Text-to-speech engine picked in Advanced options", async () => {
  clearDraft();
  const { $, api, log } = harness();
  $("voiceSelect").value = "qwen3";
  await api.openDraft({ file: { name: "a.mp4" } });
  await $("draftStartBtn").fire("click");
  assert.equal(log.started[0].fd.get("tts_engine"), "qwen3");
});

test("Add language and an erased video open on the Dubbing tab with the parts that were kept", async () => {
  clearDraft();
  const { api, log } = harness();
  await api.openDraft({ downloadId: "d1", name: "Cats", duration: 10 },
                      { tab: "dubbing", ranges: [[0, 2], [4, 6]] });
  assert.deepEqual(log.tabs, ["dubbing"]);
  assert.deepEqual(getDraft().ranges, [[0, 2], [4, 6]]);
  assert.equal(getDraft().onTimeline, true);
});

test("coming back from the Erase tab shows the same draft, cuts and all, without starting over", () => {
  clearDraft();
  const { $, api, log } = harness();
  setDraft({ downloadId: "d1", name: "street-food.mp4", duration: 10, videoUrl: "/v" });
  setRanges([[0, 3.4], [6.8, 10]]);
  // Cut on the Erase tab: that tab keeps its own top bar.
  log.screen = "erase";
  const before = log.topbars.length;
  setRanges([[0, 3.4], [6.8, 9]]);
  assert.equal(log.topbars.length, before, "the Erase tab's top bar is left alone");
  api.showDraftScreen();
  assert.deepEqual(log.screens.at(-1), "done");
  assert.equal(log.topbars.at(-1).title, "street-food");
  assert.deepEqual(getDraft().ranges, [[0, 3.4], [6.8, 9]]);
  assert.equal($("draftSetup").hidden, false);
  assert.equal(log.tabs.length, 0, "the tab the user pressed stays up");
});

test("Export on a draft: lit once a video is in, the kept parts as a video or their sound", async () => {
  clearDraft();
  const { $, api } = harness();
  const real = globalThis.fetch;
  let ok = true;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return ok ? { ok: true, json: async () => ({ path: "/Downloads/a/a.mp4" }) }
      : { ok: false, status: 500, json: async () => ({ detail: "Disk full" }) };
  };
  try {
    api.showDraftScreen();
    assert.equal(api.canExport(), false);
    assert.equal($("exportBtn").disabled, true, "nothing on the timeline, nothing to export");
    await assert.rejects(api.saveDraft(), /There is no video to save\./);
    setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
    assert.equal(api.canExport(), true);
    assert.equal($("exportBtn").disabled, false, "a video on the timeline can be exported before any dub");
    // The whole video: nothing to say about parts.
    assert.equal(await api.saveDraft(), "/Downloads/a/a.mp4");
    assert.deepEqual(sent[0], { url: "/api/downloads/d1/save", body: {} });
    // Several kept parts go as they are: the app joins them, as a dub does.
    setRanges([[0, 3], [5, 10]]);
    await api.saveDraft();
    assert.deepEqual(sent[1].body, { ranges: [[0, 3], [5, 10]] });
    await api.saveDraft({ audio: "wav" });
    assert.deepEqual(sent[2].body, { ranges: [[0, 3], [5, 10]], audio: "wav" });
    // The Ratio button's shape rides with the video, never with the sound.
    await api.saveDraft({ ratio: "9:16" });
    assert.deepEqual(sent[3].body, { ranges: [[0, 3], [5, 10]], ratio: "9:16" });
    await api.saveDraft({ ratio: "original" });
    assert.deepEqual(sent[4].body, { ranges: [[0, 3], [5, 10]] });
    await api.saveDraft({ audio: "mp3", ratio: "9:16" });
    assert.deepEqual(sent[5].body, { ranges: [[0, 3], [5, 10]], audio: "mp3" });
    ok = false;
    await assert.rejects(api.saveDraft(), /Disk full/);
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
});

// The foot went on saying "Fast mode" after High quality was picked, and said
// it under Perso API too, where the choice is not in force (2026-09-30).
test("the foot's mode follows the quality and the Dubbing choice as they are changed", async () => {
  clearDraft();
  const { $ } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  $("qualitySelect").value = "high";
  await $("qualitySelect").fire("change");
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · High quality mode");
  $("dubModeSelect").value = "perso";
  await $("dubModeSelect").fire("change");
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · Perso API");
});

// What the choices still download, said before Start once and in total
// (owner, 2026-10-22, 1-3): the dialog asked 9.6 GB out of nowhere.
test("the foot says the first download's size while the choices need one, and paints it again on its own", () => {
  clearDraft();
  let bytes = 9.6e9;
  const { $, api, log } = harness({ firstDownloadBytes: () => bytes });
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 24, videoUrl: "/v" });
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Fast mode · 9.6 GB the first time");
  const moved = log.moved;
  bytes = 0;   // downloaded from the line under a field
  api.paintFoot();
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Fast mode");
  assert.equal(log.moved, moved, "the foot alone: Advanced options stay where they are");
});

test("a draft's Perso dubbing starts with the Dubbing model its row has selected", async () => {
  clearDraft();
  const { $, log } = harness();
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  $("dubModeSelect").value = "perso";
  await $("draftStartBtn").fire("click");
  assert.equal(log.started[0].fd.get("perso_model"), "WREN");
});

test("Start says why it is dim while the video is still coming in, and a new draft drops the last one's refusal", async () => {
  clearDraft();
  const { $, api } = harness();
  setDraft({ downloadId: "", name: "a.mp4", duration: 10, videoUrl: "/v" });
  assert.equal($("draftStartBtn").disabled, true);
  assert.equal($("draftStartBtn").title, "The video is still coming in");
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  assert.equal($("draftStartBtn").title, "");
  $("draftError").textContent = "PersoDub is not running. Restart the app.";
  await api.openDraft(null);
  assert.equal($("draftError").textContent, "");
});

// -- a start that is picked up again after the person has moved on -----------

test("a start put off on one draft is not picked up again on another", async () => {
  clearDraft();
  const { $, log, setSubmitResult, restart } = harness();
  setDraft({ downloadId: "dA", name: "a.mp4", duration: 10, videoUrl: "/a" });
  setSubmitResult(false);           // models missing, or not signed in yet
  await $("draftStartBtn").fire("click");
  assert.equal(log.started.length, 1);

  // Meanwhile: another project, with its own video.
  clearDraft();
  setDraft({ downloadId: "dB", name: "b.mp4", duration: 5, videoUrl: "/b" });
  setSubmitResult(true);
  await restart()();                // the download finished, the sign-in landed
  await log.started.at(-1).retry();
  assert.equal(log.started.length, 1, "B is not dubbed with what was asked of A");
  assert.equal(getDraft().downloadId, "dB");
});

test("a start that lands after another draft was opened leaves that draft alone", async () => {
  clearDraft();
  const { $, log } = harness();
  setDraft({ downloadId: "dA", name: "a.mp4", duration: 10, videoUrl: "/a" });
  log.holdStart();
  const pressed = $("draftStartBtn").fire("click");
  await new Promise((r) => setImmediate(r));

  clearDraft();
  setDraft({ downloadId: "dB", name: "b.mp4", duration: 5, videoUrl: "/b" });
  log.answerStart(true);
  await pressed;
  assert.equal(getDraft().downloadId, "dB");
});

test("a new draft starts on the saved choices, not the ones the last draft was left on", async () => {
  clearDraft();
  const { api, log } = harness();
  await api.openDraft();
  assert.equal(log.defaults, 1);
  // Coming back to the same draft keeps what was chosen on it.
  api.showDraftScreen();
  assert.equal(log.defaults, 1);
});

// Add language (mockup script-buttons, 2026-10-01): the draft starts on the
// open dubbing's choices, and its dubbing joins that dubbing's project.
test("an Add language draft starts on the dubbing's choices and its start names the project", async () => {
  clearDraft();
  const { $, api, log, state } = harness();
  const choices = { dubMode: "perso", source: "ko", speakers: "" };
  await api.openDraft({ downloadId: "d1", name: "Cats", duration: 10 }, { tab: "dubbing", choices });
  assert.equal(log.kept, choices);
  state.draftProject = "ko123456";
  await $("draftStartBtn").fire("click");
  assert.equal(log.started[0].fd.get("project_id"), "ko123456");
});

test("a plain draft's start names no project", async () => {
  clearDraft();
  const { $, api, log } = harness();
  await api.openDraft({ file: { name: "a.mp4" } });
  assert.equal(log.kept, null);
  await $("draftStartBtn").fire("click");
  assert.equal(log.started[0].fd.get("project_id"), null);
});
