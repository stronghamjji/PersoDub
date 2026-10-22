// The draft state of the work screen paints real elements and asks the New
// project dialog to lend it its language/Advanced options block, so the
// tests hand it a paper-thin page -- the pattern ui/src/newProject.test.mjs
// already uses.
//
// Run with: node --test ui/src/draftSetup.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initDraftSetup } from "./draftSetup.mjs";
import { clearDraft, getDraft, setDraft, setRanges } from "./draft.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

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
    click: function () { this.clicked = (this.clicked || 0) + 1; },
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
                imported: [], moved: 0, started: [], removed: [] };
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
    persoModel: () => log.model ?? "WREN",
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
    removeDraft: (d) => log.removed.push(d.downloadId),
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
  assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · Perso API · up to 10 credits");
});

// Before a Perso API dubbing, what it costs and what is left (owner,
// 2026-10-22, 2-1): the first thing a paid dubbing should say.
test("a Perso dubbing's foot says at most what it costs, the model's a second times the whole seconds kept, and what is left", async () => {
  clearDraft();
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => (url === "/api/perso/spaces"
      ? { spaces: [{ seq: 7, name: "Mine", tier: "Free", credits: 1280 }] } : { perso_space_seq: "7" }) };
  };
  try {
    const { $, log } = harness();
    log.model = "ORIOLE";
    setDraft({ downloadId: "d1", name: "paris_steps.mp4", duration: 24.7, videoUrl: "/v" });
    $("dubModeSelect").value = "perso";
    await $("dubModeSelect").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Perso API · up to 24 credits", "the price at once");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Perso API · up to 24 credits · 1,280 left");
    // Another model prices it again (newProject.mjs fires the pick's change).
    log.model = "NIGHTINGALE";
    await $("persoModelPick").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Perso API · up to 96 credits · 1,280 left");
    log.model = "FINCH";
    await $("persoModelPick").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Perso API · up to 4.8 credits · 1,280 left");
    // A cut prices what is kept, in whole seconds; one credit is one.
    log.model = "ORIOLE";
    setRanges([[0, 1.6]]);
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:01 · Perso API · up to 1 credit · 1,280 left");
    // What is left was asked once: it moves only when credits are spent.
    assert.deepEqual(asked, ["/api/perso/spaces", "/api/settings"]);
    // Back on Local model the foot is the mode alone again.
    $("dubModeSelect").value = "local";
    await $("dubModeSelect").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:01 · Fast mode");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
});

test("the foot leaves out what is left when the workspace cannot be told", async () => {
  clearDraft();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => (url === "/api/perso/spaces"
    ? { spaces: [{ seq: 7, credits: 1280 }, { seq: 9, credits: 40 }] } : { perso_space_seq: "" }) });
  try {
    const { $ } = harness();
    setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
    $("dubModeSelect").value = "perso";
    await $("dubModeSelect").fire("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · Perso API · up to 10 credits");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
});

// Perso charges only the seconds that are spoken, whole ones (owner,
// 2026-10-22). Before a script has heard the video that is at most every
// second kept: a 10.01-second video read 00:10 and 11 credits.
async function korean(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
}
const noWorkspace = async () => ({ ok: false, json: async () => ({}) });

test("before a script has heard the video the foot says up to the whole seconds kept: 10.01 seconds is up to 10", async (t) => {
  clearDraft();
  const real = globalThis.fetch;
  globalThis.fetch = noWorkspace;
  try {
    const { $, api, log } = harness();
    log.model = "LINNET_4";
    setDraft({ downloadId: "d1", name: "a.mp4", duration: 10.01, videoUrl: "/v" });
    $("dubModeSelect").value = "perso";
    await $("dubModeSelect").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:10 · Perso API · up to 10 credits");
    await korean(t);
    globalThis.fetch = noWorkspace;
    api.paintFoot();
    assert.equal($("draftFootLabel").textContent, "00:10 더빙 · Perso API · 크레딧 최대 10개");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
});

// Add language: the dubbing it came from heard where the video is spoken.
test("once a script has heard the video the foot says about the whole seconds spoken in the kept parts", async (t) => {
  clearDraft();
  const real = globalThis.fetch;
  globalThis.fetch = noWorkspace;
  try {
    const { $, log } = harness();
    log.model = "NIGHTINGALE";
    // A minute of video, 45.6 seconds of it spoken: Perso took 180 credits
    // for such a video at 4 a second.
    setDraft({ downloadId: "d1", name: "a.mp4", duration: 60, videoUrl: "/v", speech: [[0, 20.3], [25, 50.3]] });
    $("dubModeSelect").value = "perso";
    await $("dubModeSelect").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 01:00 · Perso API · about 180 credits");
    // A cut leaves less of it spoken: 20.3 and 5 seconds.
    setRanges([[0, 30]]);
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:30 · Perso API · about 100 credits");
    // One credit is one.
    log.model = "ORIOLE";
    setRanges([[0, 1.9]]);
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:01 · Perso API · about 1 credit");
    await korean(t);
    globalThis.fetch = noWorkspace;
    log.model = "NIGHTINGALE";
    setRanges([[0, 30]]);
    assert.equal($("draftFootLabel").textContent, "00:30 더빙 · Perso API · 크레딧 약 100개");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
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

// Both feet in one (2-1 and 1-3, 2026-10-22): a Perso API dubbing says what it
// costs, a local one what it downloads the first time, never the two together.
test("the foot says the credits for a Perso dubbing and the first download's size for a local one", async () => {
  clearDraft();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => (url === "/api/perso/spaces"
    ? { spaces: [{ seq: 7, credits: 1280 }] } : { perso_space_seq: "7" }) });
  try {
    const { $, log } = harness({ firstDownloadBytes: () => 9.6e9 });
    log.model = "ORIOLE";
    setDraft({ downloadId: "d1", name: "a.mp4", duration: 24.7, videoUrl: "/v" });
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Fast mode · 9.6 GB the first time");
    $("dubModeSelect").value = "perso";
    await $("dubModeSelect").fire("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Perso API · up to 24 credits · 1,280 left");
    $("dubModeSelect").value = "local";
    await $("dubModeSelect").fire("change");
    assert.equal($("draftFootLabel").textContent, "Dubbing 00:24 · Fast mode · 9.6 GB the first time");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
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
  $("draftError").textContent = "The connection to PersoDub dropped for a moment. If it stays this way, quit and reopen PersoDub.";
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

// The Video card's Replace and Remove (owner, 2026-10-22). Replace is the
// Import block's own picker (#draftFileInput); Remove is the page's delete
// question, which ui/src/dubbingPrep.test.mjs answers in the page itself.
test("Replace on the Video card opens the Import block's file picker, and Remove hands the draft to the delete question", async () => {
  clearDraft();
  const { $, log } = harness();
  await $("draftRemoveBtn").fire("click");
  assert.deepEqual(log.removed, [], "no video, nothing to remove");
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  await $("draftReplaceBtn").fire("click");
  assert.equal($("draftFileInput").clicked, 1);
  assert.deepEqual(log.removed, []);
  await $("draftRemoveBtn").fire("click");
  assert.deepEqual(log.removed, ["d1"]);
  assert.equal(getDraft().downloadId, "d1", "nothing is gone until the question is answered");
});

test("a plain draft's start names no project", async () => {
  clearDraft();
  const { $, api, log } = harness();
  await api.openDraft({ file: { name: "a.mp4" } });
  assert.equal(log.kept, null);
  await $("draftStartBtn").fire("click");
  assert.equal(log.started[0].fd.get("project_id"), null);
});

// A video with the user's own subtitles has no script (the Subtitle style
// tab on its own): one card with the way to dub it, never the script table.
test("a captions project's Dubbing tab is one card instead of the script; a dubbing keeps its script", () => {
  clearDraft();
  const { $, api, state } = harness();
  state.jobId = "c1";
  state.job = { id: "c1", kind: "captions", status: "done" };
  api.paint();
  assert.equal($("dubbingCaptions").hidden, false);
  assert.equal($("dubbingPaneHead").hidden, true, "no Remake voices, no Translate again");
  assert.equal($("scriptBox").hidden, true, "no script table");
  assert.equal($("draftSetup").hidden, true);
  state.jobId = "j1";
  state.job = { id: "j1", status: "done" };
  api.paint();
  assert.equal($("dubbingCaptions").hidden, true);
  assert.equal($("dubbingPaneHead").hidden, false);
  assert.equal($("scriptBox").hidden, false);
});
