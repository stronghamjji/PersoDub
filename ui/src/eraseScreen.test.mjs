// The Erase tab, driven the way the page drives it: a paper-thin page of plain
// objects, the app's answers stubbed at fetch, and what is asserted is what
// the user would see -- which face is up, what the cards and the foot say,
// where the box and the part are, and which ways in keep what they came with.
//
// Run with: node --test ui/src/eraseScreen.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initEraseScreenUi } from "./eraseScreen.mjs";
import { cropView } from "./eraseArea.mjs";
import { setDraft, clearDraft, setRanges, getDraft } from "./draft.mjs";

function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  const attrs = {};
  const props = {};
  const el = {
    id, hidden: false, disabled: false, textContent: "", innerHTML: "", value: "",
    dataset: {}, clientWidth: 900, videoWidth: 1280, videoHeight: 720, duration: 10,
    paused: true, muted: true,
    style: { setProperty: (k, v) => { props[k] = v; }, props },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; if (k === "src") el.src = ""; },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    fire: async (ev, arg = {}) => { for (const fn of [...(listeners[ev] || [])]) await fn(arg); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    pause() {}, load() {}, click() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => true,
  };
  // The box's own label, and the two tabs over the picture.
  const label = { textContent: "" };
  const tabs = ["original", "erased"].map((which) => {
    const t = makeTab(which);
    return t;
  });
  el.querySelector = () => label;
  el.querySelectorAll = () => (id === "eraseTabs" ? tabs : []);
  el.label = label;
  el.tabs = tabs;
  return el;
}
function makeTab(which) {
  const classes = new Set();
  const listeners = {};
  return {
    dataset: { erase: which }, disabled: false,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
                 contains: (c) => classes.has(c) },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire: (ev) => { for (const fn of listeners[ev] || []) fn(); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A page, the app behind it, and what the screen reached out for. */
function harness({ suggest = { width: 1280, height: 720, area: [560, 680, 180, 1100] },
                   erase = { status: "running", percent: 35 }, projectOpen = false, platform = "mac",
                   pickedFolder, savedAt = "/Users/me/Downloads/2026-09-30/Street food/Street food.mp4" } = {}) {
  const steps = [];
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const log = { screen: "home", topbar: null, posts: [], bodies: [], dub: [], jobs: 0, timeline: null, started: [] };
  const app = { suggest, erase };

  globalThis.ResizeObserver = class { observe() {} };
  // Not the desktop app: nothing is counted and nothing is reported.
  globalThis.window = {};
  globalThis.fetch = async (url, opts = {}) => {
    const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (opts.method === "POST") { log.posts.push(String(url)); log.bodies.push(opts.body); }
    if (url === "/api/models") return answer({ platform });
    if (url === "/api/erase/suggest") {
      return app.suggest ? answer(app.suggest)
        : answer({ detail: { reason: "pack_missing", message: "needed" } }, 409);
    }
    if (url === "/api/erase") return answer({ job_id: "E1" });
    if (/^\/api\/erase\/E\d$/.test(url)) {
      return answer({ id: "E1", logs: [], done: app.erase.status === "done", ...app.erase });
    }
    if (url === "/api/erase/E1/save") return answer({ path: savedAt });
    if (url === "/api/erase/E1/retry") return answer({ job_id: "E2" });
    if (url === "/api/erase/E1/dub") return answer({ download_id: "D2", title: "Street food", duration_sec: 6 });
    return answer({ detail: "stub" }, 404);
  };

  const api = initEraseScreenUi({
    $,
    showScreen: (name) => { log.screen = name; },
    getScreen: () => log.screen,
    setTopbar: (o) => { log.topbar = o; },
    checkFile: () => null,
    installPack: async () => true,
    packRow: () => ({ bytes: 3.6e9 }),
    onPackProgress: () => {},
    onJobsChanged: () => { log.jobs += 1; },
    onDub: (source) => log.dub.push(source),
    reveal: null,
    showTimeline: (info) => { log.timeline = info; },
    projectOpen: () => projectOpen,
    onEraseStarted: (downloadId) => log.started.push(downloadId),
    pickedFolder,
    record: (name, props) => steps.push([name, props]),
  });
  return { $, api, log, app, steps };
}

const HELD = { downloadId: "D1", title: "Street food", duration_sec: 10, trim: { start: 2, end: 8 } };

test("the first screen's card opens the tab asking for a video", () => {
  clearDraft();
  const h = harness();
  h.api.openErase();
  assert.equal(h.log.screen, "erase");
  assert.equal(h.$("eraseDrop").hidden, false);
  assert.equal(h.$("eraseBody").hidden, true);
  assert.equal(h.$("eraseRow").hidden, true);
  assert.equal(h.log.topbar.title, "Erase subtitles");
  assert.equal(h.log.topbar.done, false);
});

// Opened empty from Home while a link's draft was still held: the top bar's
// Export was lit and saved that draft, a video nowhere on the screen (Windows
// test E9, 2026-10-01 and again 2026-10-10).
test("the empty tab offers nothing to export, whatever draft is still held", () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "L9", name: "Me at the zoo", duration: 19, videoUrl: "/api/downloads/L9/video" });
  h.api.openErase();
  assert.equal(h.api.showsDraft(), false);
  assert.equal(h.log.topbar.exportable, false);
  clearDraft();
});

// A finished dubbing's Erase tab holds that project's own video. Export stays
// off until the erase is done: lit, it handed back the dubbing's files instead
// of the video on the screen (final review of 0dce66a, 2026-10-12).
test("a project's Erase tab offers nothing to export before its erase", async () => {
  clearDraft();
  const h = harness({ projectOpen: true });
  h.api.openEraseOn({ downloadId: "P1", title: "Street food", duration: 10 });
  await settle();
  assert.equal(h.log.screen, "erase");
  assert.equal(h.api.showsDraft(), true, "the project's video is held as the draft");
  assert.equal(h.api.exportsDraft(), false);
  assert.equal(h.log.topbar.exportable, false);
  clearDraft();
});

test("a video from the New project dialog comes with its part, and the way back to the dialog", async () => {
  clearDraft();
  const h = harness();
  h.api.openEraseWith(HELD);
  await settle();
  assert.deepEqual(h.api.origin(), { downloadId: "D1", title: "Street food", trim: { start: 2, end: 8 } });
  assert.equal(h.$("eraseDrop").hidden, true);
  // The first card names the video and how much is kept; the erase's own
  // card has nothing to say before an erase.
  assert.equal(h.$("eraseVideoCard").innerHTML,
    '<div class="k">Video</div><div class="m vc-name" title="Street food">Street food</div>'
    + '<div class="s vc-len">00:06<span class="vc-cut">00:04 cut</span></div>'
    + '<div class="s erase-range" title="Part to erase · 00:00:02.0 – 00:00:08.0">Part to erase · 00:00:02.0 – 00:00:08.0</div>');
  assert.equal(h.$("erasePartCard").hidden, true);
  assert.equal(h.$("erasePartNote").textContent, "");
  // The two things to know about the box, before the erase starts.
  assert.equal(h.$("eraseAreaNote").textContent, "Fit the box to the subtitles. A bigger box takes longer.");
  assert.equal(h.$("eraseAreaTip").textContent, "Go to a frame with subtitles, then place the box.");
  assert.equal(h.$("eraseAreaTip").hidden, false);
  // The video is the draft now, on the timeline, cut to that part -- so the
  // Dubbing tab starts from the same video, cut the same way.
  const d = getDraft();
  assert.equal(d.downloadId, "D1");
  assert.equal(d.onTimeline, true);
  assert.deepEqual(d.ranges, [[2, 8]]);
  // The timeline draws the draft's clips, open to cutting, and the Erase lane
  // under them says how long the erase is.
  assert.deepEqual(h.log.timeline, { strip: "draft", locked: false,
                                     lane: { text: "Erase · 00:06", cls: "", pct: 0 } });
  // The foot: the minutes, and the button.
  assert.match(h.log.topbar.estimate, /^Local model · about \d+ min$/);
  assert.equal(h.log.topbar.erase, true);
  assert.equal(h.$("eraseRunBtn").disabled, false);
  // Only the first tab has anything behind it.
  const [original, erased] = h.$("eraseTabs").tabs;
  assert.equal(original.classList.contains("active"), true);
  assert.equal(erased.disabled, true);
});

test("the box goes from red to green, and Reset puts it back where the app found it", async () => {
  clearDraft();
  const h = harness();
  h.api.openEraseWith(HELD);
  assert.equal(h.$("eraseBox").classList.contains("finding"), true);
  assert.equal(h.$("eraseBox").label.textContent, "Finding subtitles…");
  await settle();
  assert.equal(h.$("eraseBox").classList.contains("found"), true);
  assert.equal(h.$("eraseBox").label.textContent, "Subtitles");
  const found = { ...h.$("eraseBox").style };

  // Dragged up to the top of the frame: more than half of it, and said so.
  const corner = { dataset: { handle: "nw" }, setPointerCapture() {}, hasPointerCapture: () => true,
                   releasePointerCapture() {} };
  await h.$("eraseBox").fire("pointerdown", { target: corner, pointerId: 1, clientX: 100, clientY: 300, preventDefault() {} });
  await h.$("eraseBox").fire("pointermove", { pointerId: 1, clientX: 0, clientY: 0 });
  await h.$("eraseBox").fire("pointerup", { pointerId: 1 });
  assert.notEqual(h.$("eraseBox").style.top, found.top);
  assert.equal(h.$("eraseBigBox").textContent, "Larger area, longer wait.");
  assert.equal(h.$("eraseBigBox").hidden, false);

  await h.$("eraseResetBtn").fire("click");
  assert.equal(h.$("eraseBox").style.top, found.top);
  assert.equal(h.$("eraseBox").style.width, found.width);
  assert.equal(h.$("eraseBigBox").hidden, true);
});

test("with the eraser not installed the tab says so, offers the download, and holds Erase back", async () => {
  clearDraft();
  const h = harness({ suggest: null });
  h.api.openEraseWith(HELD);
  await settle();
  assert.equal(h.$("erasePack").hidden, false);
  assert.match(h.$("erasePackText").textContent, /^Erase tool needed · 3\.6 GB, once$/);
  assert.equal(h.$("eraseRunBtn").disabled, true);
  // The box can still be placed.
  assert.equal(h.$("eraseBox").hidden, false);
  // The download is the line to read; the result card waits for the eraser.
  assert.equal(h.$("eraseResult").hidden, true);
  assert.equal(h.$("eraseTip").hidden, true);
});

test("while it erases: the percent, the bar, the line with the time left, Cancel, and a locked box", async () => {
  clearDraft();
  const h = harness();
  h.api.openEraseWith(HELD);
  await settle();
  await h.$("eraseRunBtn").fire("click");
  assert.ok(h.log.posts.includes("/api/erase"));
  assert.equal(h.log.jobs, 1);
  // The first answer of the watch.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("erasePartKey").textContent, "Erasing");
  assert.equal(h.$("erasePct").textContent, "35%");
  assert.equal(h.$("erasePct").hidden, false);
  assert.equal(h.$("eraseBarBox").hidden, false);
  assert.equal(h.$("eraseFill").style.width, "35%");
  assert.match(h.$("eraseState").textContent, /^Erasing · 35% · \d+ min left$/);
  assert.equal(h.$("eraseCancelBtn").hidden, false);
  assert.equal(h.$("eraseWait").hidden, false);
  assert.equal(h.$("eraseAreaNote").textContent, "Locked while erasing");
  assert.equal(h.$("eraseBox").hidden, false);
  assert.equal(h.$("eraseBox").classList.contains("lock"), true);
  assert.equal(h.$("eraseResetBtn").hidden, true);
  // The picture and the strip are the job's own video now -- the part it
  // works on -- with the cuts locked and the lane counting up.
  assert.equal(h.$("eraseVideo").src, "/api/erase/E1/original");
  assert.deepEqual(h.log.timeline, {
    strip: { media: { kind: "job", id: "E1", name: "Street food" }, duration: 10 },
    lane: { text: "Erasing 35%", cls: "now", pct: 35 }, locked: true });
  assert.equal(h.log.topbar.erase, false);
  // A locked box does not move.
  const top = h.$("eraseBox").style.top;
  await h.$("eraseBox").fire("pointerdown", { target: { dataset: {} }, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} });
  await h.$("eraseBox").fire("pointermove", { pointerId: 1, clientX: 50, clientY: 50 });
  assert.equal(h.$("eraseBox").style.top, top);

  // Done: the green card, the two tabs, the way on, and another part.
  h.app.erase = { status: "done", percent: 100 };
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("erasePartKey").textContent, "Erased");
  assert.equal(h.$("erasePartCard").classList.contains("ok"), true);
  assert.equal(h.$("erasePartNote").textContent, "Compare in the Original and Erased tabs");
  // The area it was, named and nothing more (mockup edit-flow).
  assert.equal(h.$("eraseAreaCard").hidden, false);
  assert.equal(h.$("eraseAreaNote").textContent, "");
  assert.equal(h.$("eraseResetBtn").hidden, true);
  assert.equal(h.$("eraseAreaTip").hidden, true);
  // The foot: how much was erased and Dubbing.
  assert.equal(h.$("eraseDoneLabel").textContent, "00:06 erased");
  assert.equal(h.$("eraseDoneLabel").hidden, false);
  assert.equal(h.$("eraseDubBtn").hidden, false);
  assert.equal(h.$("eraseAgainBtn").hidden, false);
  assert.equal(h.$("eraseBox").hidden, true);
  assert.deepEqual(h.log.timeline.lane, { text: "Erased", cls: "ok", pct: 0 });
  assert.equal(h.log.timeline.locked, true);
  assert.equal(h.$("eraseVideo").src, "/api/erase/E1/video");
  assert.equal(h.$("eraseVideo").muted, false);
  assert.equal(h.log.topbar.done, true, "Export has something to hand back");
  const [original, erased] = h.$("eraseTabs").tabs;
  assert.equal(erased.disabled, false);
  assert.equal(erased.classList.contains("active"), true);
  original.fire("click");
  assert.equal(h.$("eraseVideo").src, "/api/erase/E1/original");

  // The top bar's Export saves the erased video, or its sound alone.
  assert.equal(h.api.erasedJob().id, "E1");
  assert.equal(await h.api.exportErased(), "/Users/me/Downloads/2026-09-30/Street food/Street food.mp4");
  assert.equal(h.$("eraseSavedWhere").textContent, "Downloads / 2026-09-30 / Street food");
  assert.equal(h.log.bodies[h.log.posts.lastIndexOf("/api/erase/E1/save")], "{}");
  await h.api.exportErased({ audio: "mp3" });
  assert.equal(h.log.bodies[h.log.posts.lastIndexOf("/api/erase/E1/save")], '{"audio":"mp3"}');

  // Dubbing hands the erased video on.
  await h.$("eraseDubBtn").fire("click");
  await settle();
  assert.ok(h.log.posts.includes("/api/erase/E1/dub"));
  assert.deepEqual(h.log.dub, [{ downloadId: "D2", title: "Street food", duration_sec: 6 }]);

  // Erase another part: the same video and box, the cuts back on the timeline.
  await h.$("eraseAgainBtn").fire("click");
  assert.equal(h.$("erasePartKey").textContent, "Part to erase");
  assert.equal(h.$("eraseVideo").src, "/api/downloads/D1/video");
  assert.equal(h.$("eraseBox").hidden, false);
  assert.deepEqual(h.log.timeline, { strip: "draft", locked: false,
                                     lane: { text: "Erase · 00:06", cls: "", pct: 0 } });
  assert.equal(h.log.topbar.erase, true);
});

test("an erase that stopped says why, and offers Try again, Back and the log", async () => {
  clearDraft();
  const h = harness({ erase: { status: "error", percent: 35, error: "The eraser ran out of memory.",
                               logs: ["progress 35%", "stopped"] } });
  h.api.openEraseWith(HELD);
  await settle();
  await h.$("eraseRunBtn").fire("click");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("eraseState").textContent, "The eraser ran out of memory.");
  assert.equal(h.$("eraseState").classList.contains("bad"), true);
  assert.equal(h.$("eraseRetryBtn").hidden, false);
  assert.equal(h.$("eraseBackBtn").hidden, false);
  assert.equal(h.$("eraseLogDetails").hidden, false);
  assert.equal(h.$("eraseLogBox").textContent, "progress 35%\nstopped");
  assert.equal(h.$("eraseCancelBtn").hidden, true);
  assert.equal(h.log.timeline.lane, null, "nothing was erased");
  assert.equal(h.$("eraseTip").hidden, true, "the reason is the line to read, not a tip");
  assert.equal(h.$("eraseResult").hidden, true);

  // Back: the box, the video and the cuts, as they were.
  await h.$("eraseBackBtn").fire("click");
  assert.equal(h.$("eraseRetryBtn").hidden, true);
  assert.equal(h.$("eraseBox").hidden, false);
  assert.equal(h.$("eraseVideo").src, "/api/downloads/D1/video");
  assert.equal(h.log.timeline.strip, "draft");
  assert.deepEqual(getDraft().ranges, [[2, 8]]);
});

// The charts' tool steps (ui/src/events.mjs): an erase started here, and how it ended.
test("an erase started here is a tool step, and its end too, once; Try again starts another", async () => {
  clearDraft();
  const h = harness({ erase: { status: "error", percent: 35, error: "The eraser ran out of memory.", logs: [] } });
  h.api.openEraseWith(HELD);
  await settle();
  await h.$("eraseRunBtn").fire("click");
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(h.steps, [["tool_started", { tool: "erase", from: "erase" }], ["tool_finished", { tool: "erase", outcome: "failed" }]]);
  h.app.erase = { status: "done", percent: 100 };
  await h.$("eraseRetryBtn").fire("click");
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(h.steps.slice(2), [["tool_started", { tool: "erase", from: "erase" }], ["tool_finished", { tool: "erase", outcome: "done" }]]);
});

test("an erase that stopped says why in the page's language when the engine sent it (error_shown)", async () => {
  clearDraft();
  const h = harness({ erase: { status: "error", percent: 35, logs: ["progress 35%"],
                               error: "No subtitles were found in that area. Move the box and try again.",
                               error_shown: "그 영역에서 자막을 찾지 못했어요. 상자를 옮긴 뒤 다시 시도해 주세요." } });
  h.api.openEraseWith(HELD);
  await settle();
  await h.$("eraseRunBtn").fire("click");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("eraseState").textContent, "그 영역에서 자막을 찾지 못했어요. 상자를 옮긴 뒤 다시 시도해 주세요.");
});

// The folder the Download dialog's Change picked (owner, 2026-10-22): the
// app saves the erased video there, and this line names it as it names Downloads.
test("the saved line names the folder picked for downloads by its own name", async () => {
  clearDraft();
  const h = harness({ erase: { status: "done", percent: 100 }, pickedFolder: async () => "/Volumes/Work SSD",
                      savedAt: "/Volumes/Work SSD/2026-09-30/Street food/Street food.mp4" });
  h.api.openEraseJob({ id: "E1", status: "done", project: "Street food" });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await h.api.exportErased(), "/Volumes/Work SSD/2026-09-30/Street food/Street food.mp4");
  assert.equal(h.$("eraseSavedWhere").textContent, "Work SSD / 2026-09-30 / Street food");
  h.api.openErase();
});

test("an erase opened from the projects list is followed without a held video", async () => {
  clearDraft();
  const h = harness();
  h.api.openEraseJob({ id: "E1", status: "running", project: "Street food" });
  await settle();
  assert.equal(h.log.screen, "erase");
  assert.equal(h.api.origin(), null);
  assert.equal(h.$("erasePartKey").textContent, "Erasing");
  assert.equal(h.$("erasePartRange").textContent, "", "its length is not on the record");
  // No length, so no time is promised either.
  assert.equal(h.$("eraseState").textContent, "Erasing · 35%");
  assert.equal(h.$("eraseAreaCard").hidden, true);
  assert.equal(h.$("eraseVideo").src, "/api/erase/E1/original");
  // The strip is the job's own video, one clip, locked.
  assert.deepEqual(h.log.timeline.strip, { media: { kind: "job", id: "E1", name: "Street food" }, duration: 10 });
  assert.equal(h.log.timeline.locked, true);
  assert.equal(getDraft(), null, "no draft is made for a video the app no longer holds");
  // Stop the watch so the test can end.
  h.api.openErase();
  assert.deepEqual(h.log.timeline, { strip: null, lane: null, locked: true }, "an empty tab draws no strip");
});

test("the tab opens on a new project's video, with the part its cuts kept", async () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "D7", name: "Cat Talk", duration: 20, videoUrl: "/api/downloads/D7/video" });
  setRanges([[4, 12]]);
  h.api.openEraseTab();
  await settle();
  assert.equal(h.log.screen, "erase");
  assert.equal(h.api.origin(), null, "there is no dialog to go back to");
  assert.equal(h.log.topbar.title, "Cat Talk");
  assert.equal(h.$("erasePartRange").textContent, "00:00:04.0 – 00:00:12.0");
  assert.equal(h.$("eraseVideo").src, "/api/downloads/D7/video");
  assert.equal(getDraft().onTimeline, true, "the video is put on the timeline to be cut");
  assert.equal(h.log.timeline.strip, "draft");
  // This tab's video is the draft: its kept parts are what Export hands back.
  assert.equal(h.api.showsDraft(), true);
  assert.equal(h.log.topbar.exportable, true);
  // One part goes as a trim.
  await h.$("eraseRunBtn").fire("click");
  const one = h.log.bodies[h.log.posts.indexOf("/api/erase")];
  assert.equal(one.get("trim_start"), "4");
  assert.equal(one.get("trim_end"), "12");
  assert.equal(one.get("ranges"), null);
  h.api.openErase();   // stop the watch
});

// An erase is a card of its own on Home from its start, so the draft card
// for the same video goes (2026-10-21): the page is told which video.
test("an erase started tells the page the video it was started on, and a refused one does not", async () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "D7", name: "Cat Talk", duration: 20, videoUrl: "/api/downloads/D7/video" });
  h.api.openEraseTab();
  await settle();
  // The app refuses the first start (no room on the disk, say).
  const answers = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (url === "/api/erase"
    ? { ok: false, status: 507, json: async () => ({ detail: "No room" }) } : answers(url, opts));
  await h.$("eraseRunBtn").fire("click");
  assert.deepEqual(h.log.started, []);
  globalThis.fetch = answers;
  await h.$("eraseRunBtn").fire("click");
  assert.deepEqual(h.log.started, ["D7"]);
  h.api.openErase();   // stop the watch
  clearDraft();
});

test("several kept parts are erased as they were cut, and a cut made here counts", async () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "D8", name: "Two parts", duration: 20, videoUrl: "" });
  setRanges([[0, 5], [10, 20]]);
  h.api.openEraseTab();
  await settle();
  assert.equal(h.$("erasePartRange").textContent, "2 parts");
  assert.match(h.$("eraseVideoCard").innerHTML, /vc-len">00:15<span class="vc-cut">00:05 cut</);
  assert.equal(h.log.timeline.lane.text, "Erase · 00:15");
  // Cut again on the timeline (the draft changes): the part follows.
  setRanges([[0, 5], [10, 16]]);
  assert.match(h.$("eraseVideoCard").innerHTML, /vc-len">00:11<span class="vc-cut">00:09 cut</);
  assert.equal(h.log.timeline.lane.text, "Erase · 00:11");
  assert.equal(h.$("eraseRunBtn").disabled, false);
  await h.$("eraseRunBtn").fire("click");
  const sent = h.log.bodies[h.log.posts.indexOf("/api/erase")];
  assert.equal(sent.get("ranges"), "[[0,5],[10,16]]");
  assert.equal(sent.get("trim_start"), null);
  // A cut made while it erases does not change what is being erased.
  setRanges([[0, 2]]);
  assert.equal(h.$("erasePartRange").textContent, "2 parts");
  h.api.openErase();   // stop the watch
  clearDraft();
});

test("one set of kept parts: cuts made on Dubbing reach Erase, and cuts made on Erase stay on the way back", async () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "D9", name: "Walk", duration: 30, videoUrl: "/api/downloads/D9/video" });
  // Cut on the Dubbing tab's timeline.
  h.log.screen = "done";
  setRanges([[0, 10], [20, 30]]);
  h.api.openEraseTab();
  await settle();
  assert.match(h.$("eraseVideoCard").innerHTML, /vc-len">00:20<span class="vc-cut">00:10 cut</);
  // Cut on the Erase tab: the one draft is what changes.
  setRanges([[0, 10], [20, 25]]);
  assert.deepEqual(getDraft().ranges, [[0, 10], [20, 25]]);
  // Over to Dubbing and cut again there, then back to Erase: no second look for
  // the subtitles, and the part is the draft's as it stands.
  h.log.screen = "done";
  setRanges([[5, 10], [20, 25]]);
  const posts = h.log.posts.length;
  h.api.openEraseTab();
  assert.equal(h.log.posts.length, posts);
  assert.match(h.$("eraseVideoCard").innerHTML, /vc-len">00:10<span class="vc-cut">00:20 cut</);
  await h.$("eraseRunBtn").fire("click");
  assert.equal(h.log.bodies[h.log.posts.indexOf("/api/erase")].get("ranges"), "[[5,10],[20,25]]");
  h.api.openErase();   // stop the watch
  clearDraft();
});

test("the tab comes back as it was left, and does nothing when it is already up", async () => {
  clearDraft();
  const h = harness();
  // Nothing in hand: the same empty tab the card opens.
  h.api.openEraseTab();
  assert.equal(h.$("eraseDrop").hidden, false);

  h.api.openEraseWith(HELD);
  await settle();
  const posts = h.log.posts.length;
  // Away to the job and back again.
  h.log.screen = "done";
  h.log.topbar = null;
  h.api.openEraseTab();
  assert.equal(h.log.screen, "erase");
  assert.equal(h.$("erasePartRange").textContent, "00:00:02.0 – 00:00:08.0");
  assert.equal(h.log.topbar.title, "Street food");
  assert.deepEqual(h.api.origin(), { downloadId: "D1", title: "Street food", trim: { start: 2, end: 8 } },
    "the way back to the dialog is kept");
  assert.equal(h.log.posts.length, posts, "the subtitles are not looked for twice");

  // Pressed while it is up: nothing is thrown away.
  h.api.openEraseTab();
  assert.equal(h.$("erasePartRange").textContent, "00:00:02.0 – 00:00:08.0");

  // The draft went meanwhile (a dub was started from it): the video is the
  // draft again, cuts and all, so the timeline has something to cut.
  h.log.screen = "done";
  clearDraft();
  h.api.openEraseTab();
  assert.equal(getDraft().downloadId, "D1");
  assert.deepEqual(getDraft().ranges, [[2, 8]]);
  assert.equal(getDraft().onTimeline, true);
  assert.equal(h.log.timeline.strip, "draft");
  clearDraft();
});

test("a pasted link is fetched once, says what it is doing, and a stale fetch says nothing", async () => {
  clearDraft();
  const h = harness();
  h.app.download = { id: "L1", status: "probing", percent: 0 };
  const real = globalThis.fetch;
  let started = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const answer = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/downloads") { started += 1; return answer({ id: "L1" }); }
    if (url === "/api/downloads/L1") return answer(h.app.download);
    return real(url, opts);
  };
  try {
    h.api.openErase();
    const link = h.$("eraseLinkInput");
    link.value = "https://youtu.be/abc";
    await link.fire("input", { inputType: "insertFromPaste" });
    await new Promise((r) => setTimeout(r, 450));
    // Enter after the paste has already started it is not a second fetch.
    await link.fire("keydown", { key: "Enter", preventDefault() {} });
    await settle();
    assert.equal(started, 1);
    assert.equal(h.$("eraseDlRow").hidden, false);
    assert.equal(h.$("eraseDlRow").textContent, "Reading the link…", "no 0% while nothing can be counted");
    await new Promise((r) => setTimeout(r, 1050));
    assert.equal(h.$("eraseDlRow").textContent, "Reading the link…");
    h.app.download = { id: "L1", status: "downloading", percent: 40 };
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(h.$("eraseDlRow").textContent, "Fetching the video · 40%");

    // The tab starts over: the fetch under way goes quiet for good.
    h.api.openErase();
    assert.equal(h.$("eraseDlRow").hidden, true);
    h.app.download = { id: "L1", status: "ready", percent: 100, title: "Clip", duration_sec: 8 };
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.$("eraseDlRow").hidden, true);
    assert.equal(h.$("eraseDrop").hidden, false, "nothing came in behind the user's back");

    // Fetched to the end: the video is the draft, on the timeline.
    link.value = "https://youtu.be/abc";
    await link.fire("keydown", { key: "Enter", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.$("eraseDlRow").hidden, true);
    assert.equal(h.$("eraseDrop").hidden, true);
    assert.equal(getDraft().downloadId, "L1");
    assert.equal(h.log.timeline.strip, "draft");
  } finally {
    globalThis.fetch = real;
    clearDraft();
  }
});

test("an erase watched from another screen leaves the top bar alone", async () => {
  clearDraft();
  const h = harness();
  h.api.openEraseWith(HELD);
  await settle();
  await h.$("eraseRunBtn").fire("click");
  h.log.screen = "home";
  h.log.topbar = null;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("erasePct").textContent, "35%", "the tab is kept up to date");
  assert.equal(h.log.topbar, null);
  // Stop the watch so the test can end.
  h.api.openErase();
});

// ---- Design 5 (owner, 2026-10-22): the panel filled, with no new control ----

test("the video card names the part to erase before an erase, and leaves it to the erase's card after", async () => {
  clearDraft();
  const h = harness();
  setDraft({ downloadId: "D5", name: "Paris", duration: 10, videoUrl: "/api/downloads/D5/video" });
  h.api.openEraseTab();
  await settle();
  assert.match(h.$("eraseVideoCard").innerHTML,
    /<div class="s erase-range" title="Part to erase · 00:00:00\.0 – 00:00:10\.0 · Whole video">Part to erase · 00:00:00\.0 – 00:00:10\.0 · Whole video<\/div>$/);
  // Cut on the timeline: every kept part, and the whole video no more.
  setRanges([[0, 3.4], [7, 10]]);
  assert.match(h.$("eraseVideoCard").innerHTML, />Part to erase · 00:00:00\.0 – 00:00:03\.4, 00:00:07\.0 – 00:00:10\.0<\/div>$/);
  // Erasing: the erase's own card says which part.
  await h.$("eraseRunBtn").fire("click");
  assert.ok(!h.$("eraseVideoCard").innerHTML.includes("erase-range"));
  assert.equal(h.$("erasePartRange").textContent, "2 parts");
  h.api.openErase();   // stop the watch
  clearDraft();
});

// Placing the box, the card saying what the erase makes stands where the line
// was: the column at 1280x800 has room for one of them (owner, 2026-10-22).
test("under the cards: what the erase makes while placing the box, then what to do while erasing and when done", async () => {
  clearDraft();
  const h = harness();
  h.api.openErase();
  assert.equal(h.$("eraseTip").hidden, true, "nothing to say before there is a video");
  assert.equal(h.$("eraseResult").hidden, true);
  h.api.openEraseWith(HELD);
  await settle();
  assert.equal(h.$("eraseResult").hidden, false);
  assert.equal(h.$("eraseTip").hidden, true, "the card takes the line's place");
  await h.$("eraseRunBtn").fire("click");
  assert.equal(h.$("eraseResult").hidden, true);
  assert.equal(h.$("eraseTip").hidden, false);
  assert.equal(h.$("eraseTipText").textContent,
    "Erasing carries on if you go to another screen. The Home card shows the progress.");
  assert.equal(h.$("eraseDoneNote").textContent, "");
  h.app.erase = { status: "done", percent: 100 };
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.$("eraseResult").hidden, true);
  assert.equal(h.$("eraseTip").hidden, false);
  assert.equal(h.$("eraseTipText").textContent, "Save it with Download, or carry on with Dubbing.");
  // The erased card says what the clean video is for.
  assert.equal(h.$("eraseDoneNote").textContent,
    "Send the erased video to Dubbing to add new subtitles in the dubbing language. The original subtitles are gone now.");
  h.api.openErase();
  assert.equal(h.$("eraseTip").hidden, true);
  assert.equal(h.$("eraseResult").hidden, true);
  clearDraft();
});

test("the Area card enlarges the box's part of the frame at the playhead, and follows a seek and a drag", async () => {
  clearDraft();
  const h = harness();
  // A canvas with a size and a context, which the page has and this one only
  // when it is given them.
  const drawn = [];
  const pic = h.$("eraseCropPic");
  pic.clientHeight = 80;
  pic.getContext = () => ({ drawImage: (...args) => drawn.push(args) });
  h.api.openEraseWith(HELD);   // kept: 00:00:02.0 - 00:00:08.0
  await settle();
  assert.equal(h.$("eraseCrop").hidden, false);
  // No frame yet: the time and the dotted edge, and no picture.
  assert.equal(h.$("eraseCropTime").textContent, "In the box · 00:00:00.0");
  assert.equal(drawn.length, 0);
  const first = cropView([560, 680, 180, 1100], 1280, 720, 900 / 80);
  assert.equal(h.$("eraseCropBox").style.left, `${first.box.left * 100}%`);
  assert.equal(h.$("eraseCropBox").style.width, `${first.box.width * 100}%`);
  // A seek to 3.5 s of the video: 1.5 s into what the timeline kept, the time
  // the clock under the video says too.
  const v = h.$("eraseVideo");
  v.readyState = 2;
  v.currentTime = 3.5;
  await v.fire("seeked");
  assert.equal(h.$("eraseCropTime").textContent, "In the box · 00:00:01.5");
  assert.deepEqual(drawn.at(-1), [v, first.x, first.y, first.w, first.h, 0, 0, 900, 80]);
  assert.deepEqual([pic.width, pic.height], [900, 80]);
  // Played on: each new moment is drawn.
  v.currentTime = 4.2;
  await v.fire("timeupdate");
  assert.equal(h.$("eraseCropTime").textContent, "In the box · 00:00:02.2");
  // The box dragged up: the enlargement goes with it.
  const before = drawn.length;
  await h.$("eraseBox").fire("pointerdown", { target: { dataset: {} }, pointerId: 1, clientX: 100, clientY: 300, preventDefault() {} });
  await h.$("eraseBox").fire("pointermove", { pointerId: 1, clientX: 100, clientY: 200 });
  await h.$("eraseBox").fire("pointerup", { pointerId: 1 });
  assert.ok(drawn.length > before);
  assert.ok(drawn.at(-1)[2] < first.y, "drawn from higher up the frame");
  // Out of sight (the left panel hidden): the time still follows, nothing is drawn.
  pic.clientWidth = 0;
  const hiddenAt = drawn.length;
  v.currentTime = 5;
  await v.fire("seeked");
  assert.equal(h.$("eraseCropTime").textContent, "In the box · 00:00:03.0");
  assert.equal(drawn.length, hiddenAt);
  pic.clientWidth = 900;
  // Erasing locks the box, and the enlargement goes with the box's tips.
  await h.$("eraseRunBtn").fire("click");
  assert.equal(h.$("eraseCrop").hidden, true);
  h.api.openErase();   // stop the watch
  clearDraft();
});

// The column at 1280x800 has room for the result card or a warning, not both.
test("placing the box, the result card gives way to the no-graphics-card line and to the big box warning", async () => {
  clearDraft();
  const h = harness({ platform: "win-cpu" });
  h.api.openEraseWith(HELD);
  await settle();
  assert.equal(h.$("eraseNoGpu").hidden, false);
  assert.equal(h.$("eraseResult").hidden, true);
  assert.equal(h.$("eraseTip").hidden, true);
  clearDraft();

  const mac = harness();
  mac.api.openEraseWith(HELD);
  await settle();
  assert.equal(mac.$("eraseResult").hidden, false);
  // Dragged out over most of the frame: the warning, and no card.
  const corner = { dataset: { handle: "nw" }, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  await mac.$("eraseBox").fire("pointerdown", { target: corner, pointerId: 1, clientX: 100, clientY: 300, preventDefault() {} });
  await mac.$("eraseBox").fire("pointermove", { pointerId: 1, clientX: 0, clientY: 0 });
  await mac.$("eraseBox").fire("pointerup", { pointerId: 1 });
  assert.equal(mac.$("eraseBigBox").hidden, false);
  assert.equal(mac.$("eraseResult").hidden, true);
  assert.equal(mac.$("eraseTip").hidden, true);
  // Reset: the card is back.
  await mac.$("eraseResetBtn").fire("click");
  assert.equal(mac.$("eraseResult").hidden, false);
  assert.equal(mac.$("eraseTip").hidden, true);
  clearDraft();
});
