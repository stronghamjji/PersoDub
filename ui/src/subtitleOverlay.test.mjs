// The subtitles over the finished screen's player (ui/src/subtitleOverlay.mjs),
// run for real on a paper-thin page: elements by id that keep their listeners
// and can lose their children, a video with no picture size yet (so nothing is
// measured against a font), the few browser globals the file reaches for, and
// a fetch the test answers.
//
// Run with: node --test ui/src/subtitleOverlay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initSubtitleOverlay } from "./subtitleOverlay.mjs";

function makeEl(name = "") {
  const el = {
    name, parent: null, children: [], listeners: [], texts: [],
    hidden: false, className: "", innerHTML: "", dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    get textContent() { return el.texts.at(-1) ?? ""; },
    // Writing words into an element throws its children off the page, the
    // way a browser does.
    set textContent(v) {
      for (const kid of el.children) kid.parent = null;
      el.children = [];
      el.texts.push(String(v));
    },
    addEventListener(type, fn, capture) { el.listeners.push({ type, fn, capture: capture === true }); },
    removeEventListener(type, fn) { el.listeners = el.listeners.filter((l) => l.type !== type || l.fn !== fn); },
    appendChild(kid) { kid.parent = el; el.children.push(kid); return kid; },
    setAttribute() {},
    setPointerCapture() {},
    querySelectorAll: () => [],
    // Only a width handle answers to its class here.
    closest: (sel) => (sel === ".sub-wh" && /\bsub-wh\b/.test(el.className) ? el : null),
    getContext: () => ({}),
  };
  return el;
}

// The browser sends an event to the element under the pointer: the capture
// listeners from the top down, then the others from the element up, until one
// stops it. An element thrown off the page has no way up.
function send(target, type, fields = {}) {
  const path = [];
  for (let n = target; n; n = n.parent) path.push(n);
  let stopped = false;
  const ev = { type, target, pointerId: 3, preventDefault() {}, stopPropagation() { stopped = true; }, ...fields };
  for (const [nodes, capture] of [[[...path].reverse(), true], [path, false]]) {
    for (const n of nodes) {
      for (const l of n.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(ev);
      if (stopped) return;
    }
  }
}

// The style a project comes back with: a boxed look, 80 % wide.
const SAVED_STYLE = { enabled: true, preset: "sticker", pos: null, size: null, cues: {},
                      boxWidth: 80, widths: {}, layout: {} };

/**
 * One page with the module on it. `answer` is what the app says to a save.
 * The browser's globals stay until restore().
 */
function harness({ answer = async () => ({ ok: true }), state = { job: null, jobId: null },
                   lines = [{ start: 0, end: 5, text: "Hello there" }] } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const body = makeEl("body");
  body.dataset.screen = "done";
  const calls = { puts: [], drawTimelineTrack: 0 };
  const globals = {
    document: { body, createElement: (tag) => makeEl(tag), addEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({}),
    fetch: async (url, opts = {}) => {
      if (opts.method !== "PUT") return { ok: true, json: async () => structuredClone(SAVED_STYLE) };
      calls.puts.push({ url, style: JSON.parse(opts.body) });
      return answer();
    },
  };
  const saved = Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  Object.assign(globalThis, globals);
  const video = Object.assign(makeEl("doneVideo"), {
    currentTime: 0, paused: true, offsetLeft: 0, offsetTop: 0, offsetWidth: 200, offsetHeight: 100,
    videoWidth: 0, videoHeight: 0,
    // The picture is 200 px wide from the left edge of the window.
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
  });
  const subs = initSubtitleOverlay({
    $, state, doneVideo: video,
    leftTabs: { show() {}, setLocked() {} },
    timeline: { getLines: () => lines, redraw() {},
                drawTimelineTrack: () => { calls.drawTimelineTrack++; } },
    getDoneSource: () => "dubbed",
    showVideoSource: async () => {},
  });
  const restore = () => {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  };
  return { $, subs, calls, restore };
}

// The save waits 350 ms for the last of a run of changes (ui/src/pendingSave.mjs,
// which uses the real clock's names): the timers are held here instead, so
// nothing waits on a real clock -- run() is "the wait is over".
function holdTimers() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let pending = [];
  Object.assign(globalThis, {
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout: (id) => { if (id) pending[id - 1] = null; },
  });
  return {
    run: async () => {
      const now = pending; pending = [];
      for (const fn of now) if (fn) await fn();
    },
    restore: () => Object.assign(globalThis, real),
  };
}
// Every answer already on its way has landed.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// The boxed subtitle's width handles sit inside the subtitle's own text box.
// Every move of a drag redraws that box, and the redraw writes the text afresh,
// which throws the handles away and makes new ones. A drag whose listeners and
// pointer capture hang on the handle itself therefore hears exactly one move:
// the handle it held is gone, and later moves land on the new one, which
// listens to nothing. On screen that was "the box widens one notch per click"
// (user, 2026-09-07). The drag has to live on the box, which survives.
test("dragging a subtitle width handle keeps following the pointer after the box is redrawn", async () => {
  const h = harness();
  const timers = holdTimers();
  try {
    await h.subs.loadSubStyle("j1");
    const box = h.$("subOverlayText");
    // A press on the subtitle selects it, which draws its width handles; "All
    // lines" makes a drag set every line's width.
    send(box, "pointerdown");
    send(box, "pointerup");
    send(h.$("subScopeAll"), "click");
    // Whichever handle is on the page now: each redraw makes new ones.
    const handle = () => box.children.find((kid) => /\bsub-wh\b/.test(kid.className));
    assert.ok(handle(), "a selected boxed subtitle has its width handles");
    // Pressed on the handle at 150 px from the picture's left edge -- and the
    // video is 200 px wide, so x = 150 means a box 50 % wide, x = 170 means 70 %.
    send(handle(), "pointerdown", { clientX: 150 });
    send(handle(), "pointermove", { clientX: 150 });
    send(handle(), "pointermove", { clientX: 160 });
    send(handle(), "pointermove", { clientX: 170 });
    assert.equal(h.subs.getSubStyle().boxWidth, 70,
      "the box must follow every move of one drag, not just the first");
    send(handle(), "pointerup", { clientX: 170 });
    await timers.run();
    assert.equal(h.calls.puts.length, 1, "letting go remembers the width once");
    assert.equal(h.calls.puts[0].style.boxWidth, 70);
    assert.equal(h.calls.drawTimelineTrack, 1, "letting go redraws the timeline once");
    // And letting go ends the drag: a move afterwards changes nothing.
    send(handle(), "pointermove", { clientX: 190 });
    assert.equal(h.subs.getSubStyle().boxWidth, 70, "a drag that was let go must not keep following");
  } finally {
    timers.restore();
    h.restore();
  }
});

// A subtitle look is written to the job the moment it is changed -- there is no
// Save button and the user decided there should not be one. Saving and having
// saved are quiet (owner, 2026-09-30): only a failed save still leaves a mark,
// since silence there would read as a change that stuck when it did not.
test("the subtitle toolbar stays quiet while saving and once saved, but says so when it could not", async () => {
  // A project's style is loaded, then a look is changed: nothing shows, and the
  // app's answer to the save decides whether anything does.
  async function changeALook(answer) {
    const h = harness({ answer });
    const timers = holdTimers();
    try {
      await h.subs.loadSubStyle("j1");
      h.subs.saveSubStyle();
      assert.equal(h.$("subSaved").textContent, "");
      await timers.run();          // the 350ms settle, which sends the PUT
      await settle();
      assert.equal(h.calls.puts.length, 1);
      return h.$("subSaved").textContent;
    } finally {
      timers.restore();
      h.restore();
    }
  }

  // A good answer leaves it that way.
  assert.equal(await changeALook(async () => ({ ok: true })), "");
  // The app refused it, or could not be reached: the mark says so and stays.
  assert.equal(await changeALook(async () => ({ ok: false })), "Not saved");
  assert.equal(await changeALook(async () => { throw new Error("no"); }), "Not saved");
});


// A project's style that answered late, after another project was opened,
// became that other project's style, and its next save wrote it into that
// project's file (final review, 2026-10-12).
test("a late answer for the project before does not become the open project's style", async () => {
  const h = harness();
  const answers = {};
  globalThis.fetch = (url) => new Promise((resolve) => { answers[url] = resolve; });
  try {
    const a = h.subs.loadSubStyle("A");
    const b = h.subs.loadSubStyle("B");
    answers["/api/dub/jobs/B/subtitle_style"]({ ok: true, json: async () => ({ ...SAVED_STYLE, preset: "broadcast" }) });
    await b;
    answers["/api/dub/jobs/A/subtitle_style"]({ ok: true, json: async () => ({ ...SAVED_STYLE, preset: "neon-yellow" }) });
    await a;
    assert.equal(h.subs.getSubStyle().preset, "broadcast");
  } finally {
    h.restore();
  }
});

// A refused answer (no such job) is not a style: its body became one, and the
// next look at a cue threw.
test("a refused style answer leaves the default look", async () => {
  const h = harness();
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ detail: "Unknown job" }) });
  try {
    await h.subs.loadSubStyle("gone");
    assert.equal(h.subs.getSubStyle().preset, "clean");
    assert.deepEqual(h.subs.getSubStyle().cues, {});
  } finally {
    h.restore();
  }
});

// The looks also open from the finished video panel, left of Download (owner,
// 2026-10-22). A look picked there is the subtitle style itself: it is saved
// to the project, and the Download dialog's Dubbed video with subtitles asks
// for it (ui/src/app.mjs builds that row's link from exportParams).
test("a look picked over the video is saved and is the look the subtitled download asks for", async () => {
  const h = harness();
  const timers = holdTimers();
  try {
    await h.subs.loadSubStyle("j1");
    assert.equal(h.subs.exportParams().preset, "sticker", "the project's own look to begin with");
    const card = makeEl("card");
    card.parent = h.$("videoStyleGrid");
    card.dataset.preset = "white-box";
    card.closest = (sel) => (sel === "[data-preset]" ? card : null);
    send(card, "click");
    assert.equal(h.subs.getSubStyle().preset, "white-box");
    assert.equal(h.subs.exportParams().preset, "white-box");
    await timers.run();
    assert.equal(h.calls.puts.length, 1);
    assert.equal(h.calls.puts[0].url, "/api/dub/jobs/j1/subtitle_style");
    assert.equal(h.calls.puts[0].style.preset, "white-box");
  } finally {
    timers.restore();
    h.restore();
  }
});

// The video panel's Subtitle style is dim while the dub has no lines. The
// lines arrive after the job opens, and the one under the playhead can have
// no words ("Not translated"): the overlay draws nothing for it, and the
// button stayed dim saying the project had no subtitles.
test("Subtitle style in the video panel wakes when the lines arrive, even if the first has no words", async () => {
  const lines = [];
  const h = harness({ state: { job: { id: "j1", status: "done", kind: "dub" }, jobId: "j1" }, lines });
  try {
    await h.subs.loadSubStyle("j1");
    assert.equal(h.$("videoStyleBtn").disabled, true, "no lines yet");
    lines.push({ start: 0, end: 2, text: "" }, { start: 2, end: 5, text: "Hello there" });
    // What the page does when the script lands (ui/src/app.mjs renderTimeline).
    h.subs.subLinesChanged();
    h.subs.updateSubtitleNow();
    assert.equal(h.$("videoStyleBtn").disabled, false);
    assert.equal(h.$("videoStyleBtn").title, "");
  } finally {
    h.restore();
  }
});
