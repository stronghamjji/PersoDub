// The timeline draws real elements, measures them and is dragged about, so the
// tests hand it a paper-thin page: elements that are plain objects, a $ that
// makes more of them, and a window, document and localStorage of the same kind.
// What is asserted is what the user would see -- where every bar lands and how
// wide it is, the ruler thinning its labels, the fold, the zoom, a subtitle
// block pulled by its end, the playhead scrubbed, the keyboard, and the four
// grips putting remembered pane sizes back.
//
// The numbers are not this file's opinion: the whole strip is pinned byte for
// byte against what static/index.html drew before the code moved out of it
// (`git show HEAD:static/index.html`, the "Done: the timeline" section, run
// against this same fake page). A pixel that moves has to move on purpose.
//
// The strip is written as ONE string of HTML, so a fake page cannot walk real
// nodes back out of it. Where a test needs to press something, it hands the
// event a target that answers closest() from a table of selectors -- the same
// answer the browser would have given from the node under the pointer.
//
// Run with: node --test ui/src/timeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initTimelineUi, TL_LABEL_PX } from "./timeline.mjs";

function makeEl(id) {
  const el = {
    id, textContent: "", title: "", disabled: false, hidden: false,
    clientWidth: 0, offsetWidth: 0, offsetHeight: 0, scrollLeft: 0,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    style: {}, dataset: {}, attrs: {}, classes: new Set(), listeners: {},
    children: [], captured: [],
    // What each querySelectorAll / querySelector should find, filled in by the
    // test the way the browser would have filled it in from the HTML.
    qs: {}, qs1: {},
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    // Only ever asked "is there anything drawn in here yet".
    get firstChild() { return this.html ? { nodeName: "DIV" } : null; },
    querySelectorAll(sel) { return this.qs[sel] || []; },
    querySelector(sel) { return this.qs1[sel] || null; },
    getBoundingClientRect() { return this.rect; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(kid) { this.children.push(kid); return kid; },
    remove() { this.removed = true; },
    setPointerCapture(pid) { this.captured.push(pid); },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) fn(arg); },
  };
  el.style.setProperty = (k, v) => { el.style[k] = v; };
  el.classList = {
    add(...c) { for (const x of c) el.classes.add(x); },
    remove(...c) { for (const x of c) el.classes.delete(x); },
    contains(c) { return el.classes.has(c); },
    toggle(c, on) {
      const want = on === undefined ? !el.classes.has(c) : on;
      if (want) el.classes.add(c); else el.classes.delete(c);
      return want;
    },
  };
  return el;
}

/** An event whose target answers closest() from a table of selectors. */
function evt(hits, extra = {}) {
  return {
    target: { closest: (sel) => hits[sel] || null },
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    pointerId: 7, clientX: 0, clientY: 0, ...extra,
  };
}

/** A handle that can be pressed and dragged: the trim handles and the grips. */
function makeHandle(side) {
  const h = makeEl(`hdl-${side}`);
  h.classList = { ...h.classList, contains: (c) => c === side };
  return h;
}

/** A page, the calls the strip reaches out through, and the globals it reads. */
function harness({ room = 600, innerHeight = 900, innerWidth = 1600,
                   stored = {} } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  $("timelineTrack").clientWidth = room;
  const video = makeEl("doneVideo");
  video.currentTime = 0;
  video.paused = true;
  video.seeking = false;
  video.play = () => Promise.resolve();
  const log = { saved: 0, updated: 0, played: [], shown: [], cancelled: 0,
                painted: 0, toggled: 0, clipped: 0, frames: [],
                stored: new Map(Object.entries(stored)) };
  const subStyle = { enabled: true, preset: "clean", pos: null, size: null,
                     cues: {}, boxWidth: null, widths: {} };

  const real = { document: globalThis.document, window: globalThis.window,
                 localStorage: globalThis.localStorage,
                 ResizeObserver: globalThis.ResizeObserver,
                 requestAnimationFrame: globalThis.requestAnimationFrame };
  // The keyboard sits on the document and the refit on the window, so the fakes
  // have to hold those listeners for a test to fire them.
  const docListeners = {}, winListeners = {};
  globalThis.document = {
    body: { dataset: { screen: "done" } },
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,     // no dialog is open
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
  };
  log.fireDoc = (ev, arg) => { for (const fn of docListeners[ev] || []) fn(arg); };
  globalThis.window = {
    innerHeight, innerWidth,
    addEventListener(ev, fn) { (winListeners[ev] ||= []).push(fn); },
  };
  log.fireWin = (ev, arg) => { for (const fn of winListeners[ev] || []) fn(arg); };
  globalThis.localStorage = {
    getItem: (k) => (log.stored.has(k) ? log.stored.get(k) : null),
    setItem: (k, v) => log.stored.set(k, String(v)),
  };
  globalThis.ResizeObserver = class {
    constructor(fn) { log.observer = fn; }
    observe(el) { log.observed = el.id; }
  };
  // Held rather than run, so a test can see that the refit was queued once and
  // then run the frame by hand.
  globalThis.requestAnimationFrame = (fn) => log.frames.push(fn);
  log.restore = () => {
    globalThis.document = real.document;
    globalThis.window = real.window;
    globalThis.localStorage = real.localStorage;
    globalThis.ResizeObserver = real.ResizeObserver;
    globalThis.requestAnimationFrame = real.requestAnimationFrame;
  };

  const api = initTimelineUi({
    $,
    getVideo: () => video,
    getClock: () => "00:00:00.0 / 00:00:30.0",
    getSubStyle: () => subStyle,
    // The page's own reader, which the overlay on the picture shares.
    subCueOf: (l, idx) => {
      const o = subStyle.cues[String(idx + 1)];
      return o ? { start: +o.start, end: +o.end } : { start: l.start, end: l.end };
    },
    saveSubStyle: () => { log.saved += 1; },
    updateSubtitleNow: () => { log.updated += 1; },
    isNowLine: (t, el) => t > +el.dataset.start && t <= +el.dataset.end,
    showVideoSource: async (which) => { log.shown.push(which); },
    playRange: (v, a, b) => { log.played.push([v.id, a, b]); },
    cancelRange: () => { log.cancelled += 1; },
    paintPlayhead: () => { log.painted += 1; },
    toggleDonePlay: () => { log.toggled += 1; },
    markClippedNames: () => { log.clipped += 1; },
  });
  return { $, api, log, video, subStyle, box: $("timeline") };
}

// Three lines of a real script: one whose voice fits its slot, one that runs a
// second past it, and one with no voice made yet.
const LINES = [
  { line: 1, start: 0, end: 2, slot: 2, estimated: 1.5, audio_sec: 1.5,
    text: "Hello", source: "안녕", fits: true },
  { line: 2, start: 2, end: 4, slot: 2, estimated: 3, audio_sec: 3,
    text: "Over", source: "길게", fits: false },
  { line: 3, start: 5, end: 6, slot: 1, estimated: 0.8, audio_sec: null,
    text: "Third", source: "셋", fits: true },
];

// -- the strip, drawn -----------------------------------------------------

// One line, six seconds, six hundred pixels of room: a hundred pixels to the
// second. Every line below the first of the strip's templates is HTML the
// browser receives, so its indentation is output, not layout -- this is the
// exact string the page produced while the code was still inline in
// static/index.html. Nothing here is worth "tidying".
const ONE_LINE_TRACK = [
  '<div class="tl-inner" style="width:600px">',
  '    <div class="tl-ruler"><div class="tl-tick" style="left:0.0px"><span>00:00:00</span></div><div class="tl-tick" style="left:100.0px"><span>00:00:01</span></div><div class="tl-tick" style="left:200.0px"><span>00:00:02</span></div><div class="tl-tick" style="left:300.0px"><span>00:00:03</span></div><div class="tl-tick" style="left:400.0px"><span>00:00:04</span></div><div class="tl-tick" style="left:500.0px"><span>00:00:05</span></div><div class="tl-tick" style="left:600.0px"></div></div>',
  '    <div class="tl-lane"><button type="button" class="tl-blk tl-slot" tabindex="-1"',
  '    data-start="0" data-end="2"',
  '    style="left:0.0px;width:200.0px"',
  '    title="Line 7"></button><button type="button" class="tl-blk tl-voice"',
  '    data-start="0" data-end="2"',
  '    style="left:0.0px;width:120.0px"',
  '    title="Hello">Hello</button></div>',
  '    <div class="tl-lane"><button type="button" class="tl-blk tl-org" tabindex="-1"',
  '    data-start="0" data-end="2"',
  '    style="left:0.0px;width:200.0px"',
  '    title="안녕">안녕</button></div>',
  '    <div class="tl-lane tl-lane-caps"><div class="tl-cap" data-idx="0"',
  '      style="left:0.0px;width:200.0px"',
  '      title="Hello"><span class="tl-hdl l"></span><span',
  '      class="tl-cap-txt">Hello</span><span class="tl-hdl r"></span></div></div>',
  '    <div class="tl-playhead" id="timelinePlayhead"><i></i></div>',
  '  </div>',
].join("\n");

const ONE_LINE = { line: 7, start: 0, end: 2, slot: 2, estimated: 1.2,
                   audio_sec: 1.2, text: "Hello", source: "안녕", fits: true };

test("the strip is byte for byte the strip the page drew before this file existed", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([ONE_LINE], 6);

  assert.equal(h.$("timelineTrack").innerHTML, ONE_LINE_TRACK);
  // And the head above it, indentation included: the clock the player last
  // painted, the zoom, the legend, the fold and the subtitle lane's own eye.
  assert.equal(h.box.innerHTML,
    '\n    <div class="tl-head">\n' +
    '      <span class="tl-title">Timeline</span>\n' +
    '      <span class="tl-clock" id="timelineClock">00:00:00.0 / 00:00:30.0</span>\n' +
    '      <span class="tl-zoom">\n' +
    '        <button class="tl-zbtn" id="tlZoomOut" type="button" title="Zoom out (-)">−</button>\n' +
    '        <span class="tl-zlv" id="tlZoomLevel">×1</span>\n' +
    '        <button class="tl-zbtn" id="tlZoomIn" type="button" title="Zoom in (+)">＋</button>\n' +
    '        <button class="tl-zbtn tl-zfit" id="tlZoomFit" type="button" title="Fit the whole video (0)">Fit</button>\n' +
    '      </span>\n' +
    '      <span class="tl-legend">\n' +
    '        <span><i class="tl-sw-voice"></i>Voice length</span>\n' +
    '        <span><i class="tl-sw-slot"></i>Time available</span>\n' +
    '        <span><i class="tl-sw-over"></i>Over time</span>\n' +
    '      </span>\n' +
    '      <button class="tl-fold" id="timelineFold" type="button" aria-label="Fold the timeline">\n' +
    '        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>\n' +
    '      </button>\n' +
    '    </div>\n' +
    '    <div class="tl-body">\n' +
    '      <div class="tl-names">\n' +
    '        <div class="tl-corner"></div>\n' +
    '        <div class="tl-name strong">Translated</div>\n' +
    '        <div class="tl-name">Original</div>\n' +
    '        <div class="tl-name strong tl-name-caps">\n' +
    '          <button class="tl-eye on" id="tlSubEye" type="button"\n' +
    '            title="Subtitles on or off" aria-label="Subtitles on or off">' +
    '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/>' +
    '<circle cx="12" cy="12" r="2.6"/></svg></button>Subtitles</div>\n' +
    '      </div>\n' +
    '      <div class="tl-track" id="timelineTrack"></div>\n' +
    '    </div>');
});

test("three lines land where their seconds are, and a long voice spills past its slot", (t) => {
  const h = harness();            // 600px of room for 30s: 20px to the second
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  const track = h.$("timelineTrack").innerHTML;

  assert.match(track, /class="tl-inner" style="width:600px"/);
  // Line 1: two seconds of slot from the very start, with 1.5s of voice on it.
  assert.ok(track.includes('style="left:0.0px;width:40.0px"\n    title="Line 1"'));
  assert.ok(track.includes('style="left:0.0px;width:30.0px"\n    title="Hello"'));
  // Line 2 runs a second past its slot: the solid bar stops at the slot's end
  // and a tint carries on over what follows, saying how far.
  assert.ok(track.includes('class="tl-blk tl-voice tl-over"'));
  assert.ok(track.includes('style="left:40.0px;width:40.0px"\n    title="Over"'));
  assert.ok(track.includes('<span class="tl-spill" style="left:80.0px;width:20.0px"' +
                           ' title="Line 2 runs 1.0s past its time"></span>'));
  // Line 3 has no voice yet, so its slot is the whole truth about it -- and it
  // is the block the Tab key stops on, the voice bar being the tab stop when
  // there is one.
  assert.ok(track.includes('<button type="button" class="tl-blk tl-slot"\n' +
                           '    data-start="5" data-end="6"'));
  assert.equal((track.match(/class="tl-blk tl-org"/g) || []).length, 3,
    "the original line is drawn under every one of them");
  // The subtitle lane draws one block per line, over the same seconds.
  assert.ok(track.includes('<div class="tl-cap" data-idx="2"\n' +
                           '      style="left:100.0px;width:20.0px"'));
});

// The lanes are named for what they hold, not for the languages in them: the
// table above already heads its columns with those, and "English / Korean"
// down the side said nothing about which row was the dub (user, 2026-09-08).
test("the lanes are named Translated, Original and Subtitles", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  const names = h.box.innerHTML;

  assert.ok(names.includes('<div class="tl-name strong">Translated</div>'));
  assert.ok(names.includes('<div class="tl-name">Original</div>'));
  assert.ok(names.includes(">Subtitles</div>"));
});

// One voice needs no telling apart, so the badge would be a "1" on every bar.
test("one speaker gets no badge on the bars", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline(LINES.map((l) => ({ ...l, speaker: "SPEAKER_00" })), 30);

  assert.equal(h.$("timelineTrack").innerHTML.includes("tl-spk"), false);
});

// Two or more, and each Target bar leads with the number the table's chip
// gives that speaker -- numbered in the order they first speak.
test("two speakers put their letter at the head of each Target bar", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([
    { ...LINES[0], speaker: "SPEAKER_01" },   // speaks first, so it is 1
    { ...LINES[1], speaker: "SPEAKER_00" },
    { ...LINES[2], speaker: "SPEAKER_01" },   // no voice on disk: slot only
  ], 30);
  const track = h.$("timelineTrack").innerHTML;

  assert.ok(track.includes('title="Hello"><i class="tl-spk" title="Speaker 1">A</i>Hello'));
  assert.ok(track.includes('title="Over"><i class="tl-spk" title="Speaker 2">B</i>Over'));
  // The original lane and the slots stay bare -- the badge belongs to the dub.
  assert.equal((track.match(/tl-spk/g) || []).length, 2);
});

test("a second is never drawn smaller than ten pixels, and the ruler thins its labels", (t) => {
  const h = harness({ room: 200 });   // 200px for 30s would be 6.7px a second
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  const track = h.$("timelineTrack").innerHTML;

  // The floor holds at 10px a second, so the strip is wider than its room and
  // scrolls instead of squeezing into slivers.
  assert.match(track, /class="tl-inner" style="width:300px"/);
  assert.ok(track.includes('style="left:0.0px;width:20.0px"\n    title="Line 1"'));
  // One tick every 6s (58px of label at 10px a second), and the last one keeps
  // its line but drops the label that would hang off the end.
  assert.equal((track.match(/class="tl-tick"/g) || []).length, 6);
  assert.equal((track.match(/<span>00:/g) || []).length, 5);
  assert.equal(TL_LABEL_PX, 58, "the trim bar's ruler is ruled by the same number");
});

test("a line too short to draw is still wide enough to see and to grab", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([{ line: 1, start: 0, end: 0.1, slot: 0.1, estimated: 0.05,
                          audio_sec: 0.05, text: "Hi", source: "네", fits: true }], 30);
  const track = h.$("timelineTrack").innerHTML;

  // A tenth of a second is 2px at this scale. A bar is never thinner than 3,
  // and a subtitle block -- which has two handles to take hold of -- never
  // thinner than 8.
  assert.equal((track.match(/width:3\.0px/g) || []).length, 3, "slot, voice and original");
  assert.ok(track.includes('style="left:0.0px;width:8.0px"'));
});

test("the strip follows the playhead while it plays, and lets go when the viewer scrolls", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.video.paused = false;
  // Two minutes at the 10px floor: 1200px of strip in 600px of window, so the
  // playhead walks off the end of what is on show.
  h.api.renderTimeline(LINES, 120);
  const track = h.$("timelineTrack");
  assert.equal(track.scrollLeft, 0);

  h.api.paintTimeline(100, 120, "clock");
  assert.equal(track.scrollLeft, 800, "back into view, a third of the way in");

  // A paused strip belongs to whoever is reading it.
  h.video.paused = true;
  track.scrollLeft = 0;
  h.api.paintTimeline(110, 120, "clock");
  assert.equal(track.scrollLeft, 0);

  // And a strip the viewer just scrolled by hand is left alone for a while, so
  // a look back at an earlier line is not yanked away mid-read.
  h.video.paused = false;
  track.scrollLeft = 50;
  h.box.fire("scroll", { target: track });
  h.api.paintTimeline(100, 120, "clock");
  assert.equal(track.scrollLeft, 50);
});

test("no lines, or no length yet, leaves the strip blank and forgets where it was scrolled", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  h.$("timelineTrack").fire("scroll", { target: h.$("timelineTrack") });
  h.api.renderTimeline([], 0);
  assert.equal(h.box.innerHTML, "");

  // A length of zero is the same story: the video's metadata has not landed.
  h.api.renderTimeline(LINES, 0);
  assert.equal(h.box.innerHTML, "");
  assert.deepEqual(h.api.getLines(), LINES, "the lines are still what the table fetched");

  // And the next job starts at its own beginning.
  h.api.renderTimeline(LINES, 30);
  assert.equal(h.$("timelineTrack").scrollLeft, 0);
});

test("the strip is drawn again when the video's real length arrives, and wears the clock", (t) => {
  const h = harness();
  t.after(h.log.restore);
  // Drawn to the last line's end first, because the browser has no metadata yet.
  h.api.renderTimeline(LINES, 6);
  assert.ok(h.$("timelineTrack").innerHTML.includes('style="left:0.0px;width:200.0px"'),
    "6 seconds in 600px is 100px a second");

  h.api.paintTimeline(1.5, 30, "00:00:01.5 / 00:00:30.0");

  assert.equal(h.$("timelineClock").textContent, "00:00:01.5 / 00:00:30.0");
  assert.ok(h.$("timelineTrack").innerHTML.includes('style="left:0.0px;width:40.0px"'),
    "and redrawn to 30 seconds, which is 20px a second");
  assert.equal(h.$("timelinePlayhead").style.left, "30.0px", "1.5s at 20px a second");

  // Nothing to paint on an empty strip.
  h.api.renderTimeline([], 0);
  h.api.paintTimeline(2, 30, "later");
  assert.equal(h.$("timelineClock").textContent, "00:00:01.5 / 00:00:30.0");
});

// -- the head's own controls ----------------------------------------------

test("zoom steps around the playhead, and the buttons stop at the ends", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  h.video.currentTime = 10;
  const track = h.$("timelineTrack");
  track.scrollLeft = 0;

  assert.equal(h.$("tlZoomLevel").textContent, "×1");
  assert.equal(h.$("tlZoomOut").disabled, true, "there is no zooming out past Fit");
  assert.equal(h.$("tlZoomIn").disabled, false);

  h.box.fire("click", evt({ "#tlZoomIn": {} }));

  assert.equal(h.$("tlZoomLevel").textContent, "×1.5");
  assert.match(track.innerHTML, /class="tl-inner" style="width:900px"/);
  // The moment under the playhead stays where it was on screen: it sat a third
  // of the way in at 200px, and it still does at 300 - 100.
  assert.equal(track.scrollLeft, 100);
  assert.equal(h.$("timelinePlayhead").style.left, "300.0px");
  assert.equal(h.$("tlZoomOut").disabled, false);

  h.box.fire("click", evt({ "#tlZoomOut": {} }));
  assert.equal(h.$("tlZoomLevel").textContent, "×1");
  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  assert.equal(h.$("tlZoomLevel").textContent, "×2.3", "1.5 twice, said to one decimal");
  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(h.$("tlZoomLevel").textContent, "×1");
});

test("the fold is remembered, and the button says which way it points", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  assert.equal(h.box.classes.has("folded"), false);
  assert.equal(h.$("timelineFold").getAttribute("aria-label"), "Fold the timeline away");

  h.box.fire("click", evt({ ".tl-fold": {} }));

  assert.equal(h.box.classes.has("folded"), true);
  assert.equal(h.$("timelineFold").getAttribute("aria-expanded"), "false");
  assert.equal(h.$("timelineFold").title, "Show the timeline");
  assert.equal(h.log.stored.get("persodub.layout.timelineOpen"), "0");

  h.box.fire("click", evt({ ".tl-fold": {} }));
  assert.equal(h.box.classes.has("folded"), false);
  assert.equal(h.log.stored.get("persodub.layout.timelineOpen"), "1");

  // A strip folded away last time comes back folded.
  const again = harness({ stored: { "persodub.layout.timelineOpen": "0" } });
  t.after(again.log.restore);
  again.api.renderTimeline(LINES, 30);
  assert.equal(again.box.classes.has("folded"), true);
});

test("the eye switches the subtitle lane off, saves it and redraws the overlay", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);

  h.box.fire("click", evt({ "#tlSubEye": {} }));

  assert.equal(h.subStyle.enabled, false);
  assert.equal(h.log.saved, 1);
  assert.equal(h.log.updated, 1);
  assert.ok(h.box.innerHTML.includes('class="tl-name strong tl-name-caps off"'));
  assert.ok(h.box.innerHTML.includes('class="tl-eye" id="tlSubEye"'), "the eye is shut");
  assert.ok(h.$("timelineTrack").innerHTML.includes('class="tl-lane tl-lane-caps off"'));
});

test("the ✱ dot gives a line back the width every other line has", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.subStyle.widths["2"] = 60;
  h.api.renderTimeline(LINES, 30);
  assert.ok(h.$("timelineTrack").innerHTML.includes('class="tl-exdot"'));

  h.box.fire("click", evt({ ".tl-exdot": {}, ".tl-cap": { dataset: { idx: "1" } } }));

  assert.equal(h.subStyle.widths["2"], undefined);
  assert.equal(h.log.saved, 1);
  assert.equal(h.log.updated, 1);
  assert.ok(!h.$("timelineTrack").innerHTML.includes('class="tl-exdot"'));
});

// -- dragging --------------------------------------------------------------

/** Press a subtitle block's handle and hand back the pieces of the drag. */
function grabHandle(h, side, idx, clientX = 100) {
  const blk = makeEl("cap");
  blk.dataset.idx = String(idx);
  const hdl = makeHandle(side);
  hdl.closest = () => blk;
  h.box.fire("pointerdown", evt({ ".tl-hdl": hdl }, { clientX }));
  return { blk, hdl, tip: blk.children[0] };
}

test("a subtitle block is trimmed by its right end, and the tip says the new times", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);

  const { blk, hdl, tip } = grabHandle(h, "r", 1);   // line 2, 2s – 4s
  assert.equal(blk.classes.has("trimming"), true);
  hdl.fire("pointermove", { clientX: 110 });          // half a second, at 20px/s

  assert.equal(blk.style.left, "40.0px", "the block's start does not move");
  assert.equal(blk.style.width, "50.0px", "2.5 seconds of it, at 20px a second");
  assert.equal(tip.textContent, "2.0s – 4.5s");

  hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues, { 2: { start: 2, end: 4.5 } },
    "remembered to a tenth, under the line's own number");
  assert.equal(h.log.saved, 1);
  assert.equal(h.log.updated, 1);
  assert.equal(blk.classes.has("trimming"), false);
  assert.equal(tip.removed, true);
});

test("a trim cannot be pulled through its own other end, or off the video", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);

  // The left end, pulled far past the right one: it stops a fifth of a second
  // short of it.
  const left = grabHandle(h, "l", 1);
  left.hdl.fire("pointermove", { clientX: 5000 });
  left.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["2"], { start: 3.8, end: 4 });

  // And pulled off the front of the video, it stops at zero.
  const again = grabHandle(h, "l", 0);
  again.hdl.fire("pointermove", { clientX: -5000 });
  again.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["1"], { start: 0, end: 2 });

  // The right end, pulled past the end of the video, stops at its length.
  const right = grabHandle(h, "r", 2);
  right.hdl.fire("pointermove", { clientX: 5000 });
  right.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["3"], { start: 5, end: 30 });
});

test("the ruler seeks the video, and the playhead can be dragged along it", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  // The strip's own left edge, however far it has been scrolled.
  h.box.qs1[".tl-inner"] = { getBoundingClientRect: () => ({ left: 20 }) };

  // A press on the ruler is one jump, not a drag.
  h.box.fire("pointerdown", evt({ ".tl-ruler": {} }, { clientX: 220 }));
  assert.equal(h.video.currentTime, 10, "200px in, at 20px a second");
  assert.equal(h.log.cancelled, 1, "playing on from here means no stopping point");
  assert.equal(h.log.painted, 1);
  assert.equal(h.box.classes.has("scrubbing"), false);

  // A press on the head itself keeps hold of the pointer until it is let go.
  h.box.fire("pointerdown", evt({ ".tl-playhead": {}, ".tl-ruler": {} }, { clientX: 220 }));
  assert.equal(h.box.classes.has("scrubbing"), true);
  assert.deepEqual(h.box.captured, [7]);
  h.box.fire("pointermove", { clientX: 320 });
  assert.equal(h.video.currentTime, 15);
  h.box.fire("pointermove", { clientX: 9000 });
  assert.equal(h.video.currentTime, 30, "and never past the end of the video");
  h.box.fire("pointerup", {});
  assert.equal(h.box.classes.has("scrubbing"), false);
  h.box.fire("pointermove", { clientX: 40 });
  assert.equal(h.video.currentTime, 30, "the drag is over");
});

test("a bar plays its own line -- the bottom row in the film as it came in", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  const bar = makeEl("bar");
  bar.dataset.start = "5";
  bar.dataset.end = "6";

  h.box.fire("click", evt({ ".tl-blk": bar }));
  await Promise.resolve();
  assert.deepEqual(h.log.shown, ["dubbed"], "a voice bar is the dub");
  assert.deepEqual(h.log.played, [["doneVideo", 5, 6]]);

  bar.classes.add("tl-org");
  h.box.fire("click", evt({ ".tl-blk": bar }));
  await Promise.resolve();
  assert.deepEqual(h.log.shown, ["dubbed", "original"]);

  // A press on a trim handle is a trim, not a way into the video.
  h.box.fire("click", evt({ ".tl-hdl": {}, ".tl-blk": bar }));
  assert.equal(h.log.shown.length, 2);
});

// -- the keyboard ----------------------------------------------------------

const key = (k, over = {}) => ({
  key: k, isComposing: false, metaKey: false, ctrlKey: false, altKey: false,
  target: { closest: () => null },
  preventDefault() { this.prevented = true; }, ...over,
});

test("the keyboard plays, restarts and zooms -- and only on the finished screen", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.attach();
  h.api.renderTimeline(LINES, 30);

  const space = key(" ");
  h.log.fireDoc("keydown", space);
  assert.equal(h.log.toggled, 1);
  assert.equal(space.prevented, true, "space scrolls the page otherwise");

  h.video.currentTime = 12;
  h.log.fireDoc("keydown", key("Enter"));
  assert.equal(h.video.currentTime, 0, "Enter plays from the very start");
  assert.equal(h.log.cancelled, 1);

  h.log.fireDoc("keydown", key("+"));
  assert.equal(h.$("tlZoomLevel").textContent, "×1.5");
  h.log.fireDoc("keydown", key("="));
  assert.equal(h.$("tlZoomLevel").textContent, "×2.3", "the unshifted + key too");
  h.log.fireDoc("keydown", key("-"));
  assert.equal(h.$("tlZoomLevel").textContent, "×1.5");
  h.log.fireDoc("keydown", key("0"));
  assert.equal(h.$("tlZoomLevel").textContent, "×1");

  // A space in the middle of a sentence stays a space; so does one pressed with
  // a modifier, or while an IME is still settling a syllable.
  h.log.fireDoc("keydown", key(" ", { target: { closest: () => ({}) } }));
  h.log.fireDoc("keydown", key(" ", { metaKey: true }));
  h.log.fireDoc("keydown", key(" ", { isComposing: true }));
  assert.equal(h.log.toggled, 1);

  // And nothing at all on another screen.
  globalThis.document.body.dataset.screen = "home";
  h.log.fireDoc("keydown", key(" "));
  assert.equal(h.log.toggled, 1);
});

// -- the grips that size the panes ----------------------------------------

/** A page whose panes have been measured, with sizes remembered from before. */
function laidOut(stored) {
  const h = harness({ stored });
  h.$("timeline").offsetHeight = 150;
  h.$("historySidebar").offsetWidth = 260;
  h.$("videoPane").offsetWidth = 400;
  h.$("doneMain").offsetHeight = 800;
  h.$("doneMain").offsetWidth = 1000;
  h.$("agentStrip").offsetWidth = 400;
  return h;
}

test("remembered pane sizes come back, clamped to the window as it stands now", (t) => {
  const h = laidOut({
    "persodub.layout.timelineHeight": "300",
    "persodub.layout.sidebarW": "999",     // saved on a much wider window
    "persodub.layout.videoWidth": "400",
    "persodub.layout.agentWidth": "400",
  });
  t.after(h.log.restore);

  h.api.attach();

  assert.equal(h.$("timeline").style.height, "300px");
  assert.equal(h.$("historySidebar").style["--sidebar-w"], "480px",
    "480px of project names is as much as anyone wants");
  assert.equal(h.$("videoPane").style.width, "400px");
  assert.equal(h.$("agentStrip").style.width, "400px");
  assert.equal(h.log.clipped, 1, "the names are re-measured for their new column");

  // Nothing saved: the stylesheet's own size stands.
  const fresh = laidOut({});
  t.after(fresh.log.restore);
  fresh.api.fitLayout();
  assert.equal(fresh.$("timeline").style.height, undefined);
});

test("a grip drag sizes the pane below the line, and remembers what ended up on screen", (t) => {
  const h = laidOut({});
  t.after(h.log.restore);
  const grip = h.$("gripTimeline");

  // Pull the line up 50px and the pane below it grows by 50.
  grip.fire("pointerdown", evt({}, { clientY: 500 }));
  assert.equal(grip.classes.has("dragging"), true);
  grip.fire("pointermove", { clientY: 450 });
  assert.equal(h.$("timeline").style.height, "200px");

  // And never taller than 40% of the window, or than what the panes above it
  // can spare -- whichever is less.
  grip.fire("pointermove", { clientY: 100 });
  assert.equal(h.$("timeline").style.height, "360px", "40% of a 900px window");

  // What is remembered is measured off the box itself at the end, once, not
  // what the pointer asked for on the way.
  h.$("timeline").offsetHeight = 355;
  grip.fire("pointerup", {});
  assert.equal(h.log.stored.get("persodub.layout.timelineHeight"), "355");
  assert.equal(grip.classes.has("dragging"), false);

  // A press that never moved changes nothing and remembers nothing.
  const still = laidOut({});
  t.after(still.log.restore);
  still.$("gripPanes").fire("pointerdown", evt({}, { clientX: 500 }));
  still.$("gripPanes").fire("pointermove", { clientX: 500 });
  still.$("gripPanes").fire("pointerup", {});
  assert.equal(still.log.stored.has("persodub.layout.videoWidth"), false);
});

test("the grip left of its pane counts the drag the other way round", (t) => {
  const h = laidOut({});
  t.after(h.log.restore);

  // The projects list is left of its handle, so pulling the line right grows it.
  h.$("gripSidebar").fire("pointerdown", evt({}, { clientX: 300 }));
  h.$("gripSidebar").fire("pointermove", { clientX: 340 });
  assert.equal(h.$("historySidebar").style["--sidebar-w"], "300px");

  // Layout G: the video pane is RIGHT of its handle, so pulling that line left
  // grows it -- and it never takes more than 45% of the row.
  h.$("gripPanes").fire("pointerdown", evt({}, { clientX: 900 }));
  h.$("gripPanes").fire("pointermove", { clientX: 870 });
  assert.equal(h.$("videoPane").style.width, "430px");
  h.$("gripPanes").fire("pointermove", { clientX: 100 });
  assert.equal(h.$("videoPane").style.width, "450px", "45% of a 1000px row");
});

test("a window that changed size refits once a frame, and a track that changed width is redrawn", (t) => {
  const h = laidOut({ "persodub.layout.timelineHeight": "300" });
  t.after(h.log.restore);
  h.api.attach();
  assert.equal(h.log.observed, "timeline", "the strip itself is what is watched");

  h.$("timeline").style.height = "";
  h.log.fireWin("resize");
  h.log.fireWin("resize");
  h.log.fireWin("resize");
  assert.equal(h.log.frames.length, 1, "three events, one pass");
  h.log.frames.pop()();
  assert.equal(h.$("timeline").style.height, "300px");
  // The next resize gets its own frame again.
  h.log.fireWin("resize");
  assert.equal(h.log.frames.length, 1);

  // The observer only redraws when the width it measures has actually changed.
  h.api.renderTimeline(LINES, 30);
  const drawn = h.$("timelineTrack").innerHTML;
  h.log.observer();
  assert.equal(h.$("timelineTrack").innerHTML, drawn);
  h.$("timelineTrack").clientWidth = 1200;
  h.log.observer();
  assert.match(h.$("timelineTrack").innerHTML, /class="tl-inner" style="width:1200px"/);
});
