// The timeline draws real elements, measures them and is dragged about, so the
// tests hand it a paper-thin page: elements that are plain objects, a $ that
// makes more of them, and a window, document and localStorage of the same kind.
// What is asserted is what the user would see -- where every block lands and
// how wide it is, the ruler, the fold, the zoom, a subtitle block pulled by its
// end, the playhead scrubbed, the keyboard, the four grips putting remembered
// pane sizes back, the video lane's film strip and waveform, and a new
// project's video cut into clips before it is dubbed.
//
// The strip is written as ONE string of HTML, so a fake page cannot walk real
// nodes back out of it. Where a test needs to press something, it hands the
// event a target that answers closest() from a table of selectors -- the same
// answer the browser would have given from the node under the pointer.
//
// Run with: node --test ui/src/timeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initTimelineUi, TL_LABEL_PX, TL_PPS, fmtRuler, labelEvery } from "./timeline.mjs";
import { getDraft, setDraft, clearDraft } from "./draft.mjs";
import { modKey } from "./format.mjs";

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

// A film strip of twelve frames and a second of sound at 25 values a second.
const STRIP = { width: 69 * 12 };
const WAVE = { rate: 25, duration: 10, peaks: Array.from({ length: 250 }, (_, i) => (i % 5) / 4) };

/** A page, the calls the strip reaches out through, and the globals it reads. */
function harness({ room = 600, innerHeight = 900, innerWidth = 1600,
                   stored = {}, media = null, own = false } = {}) {
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
  video.pause = () => { video.paused = true; };
  const log = { saved: 0, updated: 0, played: [], shown: [], cancelled: 0,
                painted: 0, toggled: 0, clipped: 0, frames: [], fetched: [],
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
    clearDraft();
  };

  const api = initTimelineUi({
    $,
    getVideo: () => video,
    getClock: () => "00:00:00.0 / 00:00:30.0",
    getMedia: () => media,
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
    loadImage: async (url) => { log.fetched.push(url); return STRIP; },
    fetchJson: async (url) => { log.fetched.push(url); return WAVE; },
    ownSubtitles: () => own,
  });
  return { $, api, log, video, subStyle, box: $("timeline") };
}

/** Let the film strip and waveform "arrive". */
const settle = () => new Promise((r) => setTimeout(r, 0));

// Three lines of a real script: one whose voice fits its slot, one that runs a
// second past it, and one with no voice made yet.
const LINES = [
  { line: 1, start: 0, end: 2, slot: 2, estimated: 1.7, audio_sec: 1.7,
    text: "Hello", source: "안녕", fits: true },
  { line: 2, start: 2, end: 4, slot: 2, estimated: 3, audio_sec: 3,
    text: "Over", source: "길게", fits: false },
  { line: 3, start: 5, end: 6, slot: 1, estimated: 0.8, audio_sec: null,
    text: "Third", source: "셋", fits: true },
];

// -- a finished job, drawn ------------------------------------------------

// One line, six seconds, six hundred pixels of room, 77px to the second -- its
// 1.2s of voice in a 2s slot much shorter than it, so orange. Every
// line below the first of the strip's templates is HTML the browser receives,
// so its indentation is output, not layout. A pixel that moves has to move on
// purpose.
const ONE_LINE_TRACK = [
  '<div class="tl-inner" style="width:600px">',
  '    <div class="tl-ruler" style="--tl-step:23.10px"><span style="left:0.0px">00:00</span><span style="left:231.0px">00:03</span><span style="left:462.0px">00:06</span></div>',
  '    <div class="tl-lanes"><div class="tl-lane tl-lane-video"><div class="tl-vclip" style="left:0;width:462.0px">',
  '      <div class="tl-vcap"><b>00:06</b></div>',
  '      ',
  '      <div class="tl-wave"></div></div></div>',
  '    <div class="tl-lane tl-lane-org"><button type="button" class="tl-blk tl-org" tabindex="-1"',
  '    data-start="0" data-end="2"',
  '    style="left:0.0px;width:154.0px"',
  '    title="안녕">안녕</button></div>',
  '    <div class="tl-lane tl-lane-dub"><button type="button" class="tl-blk tl-voice tl-short tl-s1"',
  '    data-start="0" data-end="2"',
  '    style="left:0.0px;width:154.0px"',
  '    title="Hello">Hello<i class="tl-vlen" style="width:60.0%"></i></button></div>',
  '    <div class="tl-lane tl-lane-caps"><div class="tl-cap" data-idx="0"',
  '      style="left:0.0px;width:154.0px"',
  '      title="Hello"><span class="tl-hdl l"></span><span',
  '      class="tl-cap-txt">Hello</span><span class="tl-hdl r"></span></div></div></div>',
  '    <div class="tl-playhead" id="timelinePlayhead"><i></i></div>',
  '  </div>',
].join("\n");

const ONE_LINE = { line: 7, start: 0, end: 2, slot: 2, estimated: 1.2,
                   audio_sec: 1.2, text: "Hello", source: "안녕", fits: true };

test("a finished job's strip is pinned byte for byte", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([ONE_LINE], 6);

  assert.equal(h.$("timelineTrack").innerHTML, ONE_LINE_TRACK);
});

test("the toolbar carries the legend, the clock, fit, zoom and the fold; the names carry an icon each", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  const html = h.box.innerHTML;

  assert.ok(html.includes('<span><i class="tl-sw-voice"></i>Voice length</span>'));
  assert.ok(html.includes('<span><i class="tl-sw-slot"></i>Time available</span>'));
  assert.ok(html.includes('<span><i class="tl-sw-over"></i>Over time</span>'));
  assert.ok(html.indexOf('<span><i class="tl-sw-short"></i>Much shorter</span>')
    > html.indexOf('<span><i class="tl-sw-over"></i>Over time</span>'), "and after it, Much shorter");
  assert.ok(html.includes('<span class="tl-clock" id="timelineClock">00:00:00.0 / 00:00:30.0</span>'));
  for (const id of ["tlZoomFit", "tlZoomOut", "tlZoomLevel", "tlZoomIn", "timelineFold", "tlSubEye"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('id="tlZoomFit"') < html.indexOf('id="tlZoomOut"'), "fit, zoom out, slider, zoom in");
  assert.ok(html.indexOf('id="tlZoomLevel"') < html.indexOf('id="tlZoomIn"'));
  assert.ok(!html.includes('id="tlSplit"'), "a finished job has no cut tools");
  // The four lanes, in the mockup's order: Video, Original, Translated, Captions.
  const names = ["Video", "Original", "Translated", "Captions"].map((n) => html.indexOf(`<span>${n}</span>`));
  assert.ok(names.every((i) => i > 0), "every lane is named");
  assert.deepEqual([...names].sort((a, b) => a - b), names);
  assert.equal(h.box.classes.has("tl-draftmode"), false);
});

test("three lines land where their seconds are, and a long voice runs red past its slot", (t) => {
  const h = harness();            // 77px to the second at zoom 1
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  const track = h.$("timelineTrack").innerHTML;

  assert.match(track, /class="tl-inner" style="width:2390px"/, "30s at 77px, and 80px past the end");
  // Line 1: two seconds of slot from the very start, 1.7s of voice along its foot.
  assert.ok(track.includes('style="left:0.0px;width:154.0px"\n    title="Hello">Hello<i class="tl-vlen" style="width:85.0%"></i>'));
  // Line 2 runs a second past its slot: a red clip, a red foot all the way,
  // and a tint carrying on over what follows, saying how far.
  assert.ok(track.includes('class="tl-blk tl-voice tl-over tl-s1"'));
  assert.ok(track.includes('title="Over">Over<i class="tl-vlen" style="width:100.0%"></i>'));
  assert.ok(track.includes('<span class="tl-spill" style="left:308.0px;width:77.0px"' +
                           ' title="Line 2 runs 1.0s past its time"></span>'));
  // Line 3 has no voice yet: the dashed slot alone, and still the tab stop.
  assert.ok(track.includes('<button type="button" class="tl-blk tl-voice tl-novoice tl-s1"\n' +
                           '    data-start="5" data-end="6"'));
  assert.ok(track.includes('title="Third">Third</button>'));
  assert.equal((track.match(/class="tl-blk tl-org"/g) || []).length, 3,
    "the original line is drawn under every one of them");
  assert.equal((track.match(/tabindex="-1"/g) || []).length, 3, "only the Translated blocks are tab stops");
  // The subtitle lane draws one block per line, over the same seconds.
  assert.ok(track.includes('<div class="tl-cap" data-idx="2"\n' +
                           '      style="left:385.0px;width:77.0px"'));
});

test("a voice much shorter than its slot is orange, as in the table, its foot as long as the voice", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const voice = (line, start, slot, sec) => ({ line, start, end: start + slot, slot, estimated: sec,
    audio_sec: sec, text: `L${line}`, source: "원문", fits: true });

  h.api.renderTimeline([
    voice(1, 0, 3.0, 1.6),     // 1.4 short: more than a second
    voice(2, 3, 4.0, 3.1),     // 0.9 short: more than a fifth of the slot
    voice(3, 7, 4.7, 4.4),     // 0.3 short: fits
    voice(4, 12, 1.9, 2.5),    // 0.6 over
  ], 30);
  const track = h.$("timelineTrack").innerHTML;

  assert.ok(track.includes('class="tl-blk tl-voice tl-short tl-s1"\n    data-start="0"'));
  assert.ok(track.includes('title="L1">L1<i class="tl-vlen" style="width:53.3%"></i>'));
  assert.ok(track.includes('class="tl-blk tl-voice tl-short tl-s1"\n    data-start="3"'));
  assert.ok(track.includes('class="tl-blk tl-voice tl-s1"\n    data-start="7"'), "green while it fits");
  assert.ok(track.includes('class="tl-blk tl-voice tl-over tl-s1"\n    data-start="12"'), "red past its slot");
  assert.equal((track.match(/tl-short/g) || []).length, 2);
});

test("each speaker wears a colour on the top edge of their lines", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([
    { ...LINES[0], speaker: "SPEAKER_01" },   // speaks first, so it is 1
    { ...LINES[1], speaker: "SPEAKER_00" },
    { ...LINES[2], speaker: "SPEAKER_01" },
  ], 30);
  const track = h.$("timelineTrack").innerHTML;

  assert.ok(track.includes('class="tl-blk tl-voice tl-s1"\n    data-start="0"'));
  assert.ok(track.includes('class="tl-blk tl-voice tl-over tl-s2"'));
  assert.ok(track.includes('class="tl-blk tl-voice tl-novoice tl-s1"'));
  // Seven voices: the seventh comes round to the first colour again.
  const many = Array.from({ length: 7 }, (_, i) => ({ ...LINES[0], line: i + 1, start: i * 2, end: i * 2 + 2, speaker: `S${i}` }));
  h.api.renderTimeline(many, 30);
  const again = h.$("timelineTrack").innerHTML;
  assert.equal((again.match(/tl-s1"/g) || []).length, 2);
  assert.ok(again.includes("tl-s6"));
});

test("the ruler labels every 3 seconds at zoom 1 and thins out as the strip shrinks", (t) => {
  assert.equal(TL_PPS, 77);
  assert.equal(TL_LABEL_PX, 58, "the trim bar's ruler is ruled by the same number");
  assert.equal(labelEvery(77), 3);
  assert.equal(labelEvery(77 * 8), 1);
  assert.equal(labelEvery(10), 30);
  assert.equal(fmtRuler(3), "00:03");
  assert.equal(fmtRuler(754), "12:34");
  assert.equal(fmtRuler(3723), "1:02:03");

  const h = harness({ room: 200 });
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  // Fit: 30s in the 120px left of the 80px tail is 4px a second, however
  // small that is -- a 26-minute job has to fit too (owner, 2026-10-14).
  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  const track = h.$("timelineTrack").innerHTML;
  assert.match(track, /class="tl-inner" style="width:200px"/);
  assert.ok(track.includes('style="left:0.0px;width:8.0px"\n    title="안녕"'));
  assert.equal(labelEvery(4), 60, "a label every minute at 4px a second");
  assert.ok(track.includes('<span style="left:0.0px">00:00</span>'));
  assert.ok(track.includes("--tl-step:24.00px"), "and ten small ticks between two");
});

test("a line too short to draw is still wide enough to see and to grab", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline([{ line: 1, start: 0, end: 0.02, slot: 0.02, estimated: 0.01,
                          audio_sec: 0.01, text: "Hi", source: "네", fits: true }], 30);
  const track = h.$("timelineTrack").innerHTML;

  // Two hundredths of a second is 1.5px at this scale. A block is never thinner
  // than 3, and a subtitle block -- which has two handles to take hold of --
  // never thinner than 8.
  assert.equal((track.match(/width:3\.0px/g) || []).length, 2, "original and translated");
  assert.ok(track.includes('style="left:0.0px;width:8.0px"'));
});

test("the strip follows the playhead while it plays, and lets go when the viewer scrolls", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.video.paused = false;
  h.api.renderTimeline(LINES, 120);
  const track = h.$("timelineTrack");
  assert.equal(track.scrollLeft, 0);

  h.api.paintTimeline(100, 120, "clock");
  assert.equal(track.scrollLeft, 7500, "back into view, a third of the way in");

  // A paused strip belongs to whoever is reading it.
  h.video.paused = true;
  track.scrollLeft = 0;
  h.api.paintTimeline(110, 120, "clock");
  assert.equal(track.scrollLeft, 0);

  // And a strip the viewer just scrolled by hand is left alone for a while.
  h.video.paused = false;
  track.scrollLeft = 50;
  h.box.fire("scroll", { target: track });
  h.api.paintTimeline(100, 120, "clock");
  assert.equal(track.scrollLeft, 50);
});

// A line pressed in the script table puts the still video at its start; the
// strip is brought to it the way following would, playing or not (owner, 2026-10-21).
test("a moment the page moved the still video to is brought into view, and only when it is off the strip", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 120);
  const track = h.$("timelineTrack");
  assert.equal(h.video.paused, true);

  h.api.revealTime(100);
  assert.equal(track.scrollLeft, 7500, "a third of the way in, as following puts it");
  h.api.revealTime(101);
  assert.equal(track.scrollLeft, 7500, "already on show: left where it is");

  // Its scrolling is not the viewer's: once the video plays, following goes on.
  h.box.fire("scroll", { target: track });
  h.video.paused = false;
  h.api.paintTimeline(110, 120, "clock");
  assert.equal(track.scrollLeft, 8270);

  // A press wins over a strip just scrolled by hand.
  h.video.paused = true;
  track.scrollLeft = 0;
  h.box.fire("scroll", { target: track });
  h.api.revealTime(100);
  assert.equal(track.scrollLeft, 7500);
});

test("no lines, or no length yet, leaves the strip blank and forgets where it was scrolled", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.renderTimeline(LINES, 30);
  h.$("timelineTrack").fire("scroll", { target: h.$("timelineTrack") });
  h.api.renderTimeline([], 0);
  assert.equal(h.box.innerHTML, "");

  h.api.renderTimeline(LINES, 0);
  assert.equal(h.box.innerHTML, "");
  assert.deepEqual(h.api.getLines(), LINES, "the lines are still what the table fetched");

  h.api.renderTimeline(LINES, 30);
  assert.equal(h.$("timelineTrack").scrollLeft, 0);
});

test("the strip is drawn again when the video's real length arrives, and wears the clock", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 6);
  assert.ok(h.$("timelineTrack").innerHTML.includes("<b>00:06</b>"));

  h.api.paintTimeline(1.5, 30, "00:00:01.5 / 00:00:30.0");

  assert.equal(h.$("timelineClock").textContent, "00:00:01.5 / 00:00:30.0");
  assert.ok(h.$("timelineTrack").innerHTML.includes("<b>00:30</b>"), "redrawn to 30 seconds");
  assert.equal(h.$("timelinePlayhead").style.left, "115.5px", "1.5s at 77px a second");

  // Nothing to paint on an empty strip.
  h.api.renderTimeline([], 0);
  h.api.paintTimeline(2, 30, "later");
  assert.equal(h.$("timelineClock").textContent, "00:00:01.5 / 00:00:30.0");
});

// -- the video lane's pictures -------------------------------------------------

test("the video lane shows the file's name, then its film strip and waveform once they arrive", async (t) => {
  const h = harness({ media: { kind: "job", id: "j 1", name: "cat-talk.mp4" } });
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 10);
  let track = h.$("timelineTrack").innerHTML;
  // Until they arrive: the plain clip colour, the name and the length.
  assert.ok(track.includes('<div class="tl-vcap">cat-talk.mp4<b>00:10</b></div>'));
  assert.ok(track.includes('<div class="tl-film"></div>'));
  assert.ok(track.includes('<div class="tl-wave"></div>'));
  assert.deepEqual(h.log.fetched, ["/api/media/job/j%201/filmstrip", "/api/media/job/j%201/waveform"]);

  await settle();
  track = h.$("timelineTrack").innerHTML;
  // Twelve 69px frames for 770px of video: a frame box every 69px.
  assert.ok(track.includes("--strip:url('/api/media/job/j%201/filmstrip');--strip-w:828.0px"));
  assert.equal((track.match(/<i style="left:/g) || []).length, 12);
  assert.ok(track.includes('<i style="left:69.0px;width:69.0px;background-position:-69.0px 0"></i>'));
  // One bar per waveform value: 250 for ten seconds.
  assert.ok(track.includes('<svg viewBox="0 0 250 100" preserveAspectRatio="none"'));
  assert.equal((track.match(/h0\.6V100z/g) || []).length, 250);
  // Asked once, whatever is drawn after.
  h.api.redraw();
  assert.equal(h.log.fetched.length, 2);
});

// -- the toolbar's own controls ---------------------------------------------

test("zoom steps around the playhead, fits the whole video, and stops at the ends", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  h.video.currentTime = 10;
  const track = h.$("timelineTrack");
  track.scrollLeft = 570;       // the playhead a third of the way in

  const zoom = () => h.$("tlZoomLevel").getAttribute("aria-valuetext");
  assert.equal(zoom(), "×1");
  assert.equal(h.$("tlZoomOut").disabled, false, "a 30s video can shrink to fit");

  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  assert.equal(zoom(), "×1.5");
  assert.match(track.innerHTML, /class="tl-inner" style="width:3545px"/);
  assert.equal(track.scrollLeft, 955, "the moment under the playhead stays where it was on screen");
  assert.equal(h.$("timelinePlayhead").style.left, "1155.0px");

  // Fit: 30 seconds and the 80px tail in 600px is about 17px a second.
  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(zoom(), "×0.2");
  assert.match(track.innerHTML, /class="tl-inner" style="width:600px"/);
  assert.equal(h.$("tlZoomOut").disabled, true, "there is no zooming out past Fit");

  // The slider says the same on a log scale, and moves it.
  assert.equal(+h.$("tlZoomLevel").max, Math.log(8));
  h.box.fire("input", { target: { id: "tlZoomLevel", value: String(Math.log(2)) } });
  assert.equal(zoom(), "×2");
  for (let i = 0; i < 9; i++) h.box.fire("click", evt({ "#tlZoomIn": {} }));
  assert.equal(zoom(), "×8");
  assert.equal(h.$("tlZoomIn").disabled, true);
});

// Fit used to zoom around the playhead like the other zoom buttons: with the
// playhead near the end, the strip was left scrolled and the browser clamped it
// to the 80px tail, so the first seconds and the first line were cut off.
test("Fit shows the whole video from 00:00, the end inside the room, wherever the playhead is", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.attach();
  h.api.renderTimeline(LINES, 30);
  const track = h.$("timelineTrack");
  h.video.currentTime = 28;
  track.scrollLeft = 28 * TL_PPS - 300;     // the playhead in the middle of the view
  h.box.fire("scroll", { target: track });

  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(track.scrollLeft, 0, "the strip starts at 00:00");
  assert.match(track.innerHTML, /class="tl-inner" style="width:600px"/, "nothing left to scroll");
  assert.match(track.innerHTML, /<span style="left:0.0px">00:00<\/span>/);
  const end = +track.innerHTML.match(/tl-vclip" style="left:0;width:([\d.]+)px/)[1];
  assert.ok(end <= 600 - 40, `the video's end (${end}px) sits inside the room with a margin`);

  // Scrolled by hand afterwards, Fit brings the start back at the same zoom,
  // and so does the 0 key.
  track.scrollLeft = 50;
  h.box.fire("scroll", { target: track });
  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(track.scrollLeft, 0);
  track.scrollLeft = 50;
  h.box.fire("scroll", { target: track });
  h.log.fireDoc("keydown", key("0"));
  assert.equal(track.scrollLeft, 0);
});

test("Fit on a draft shows every clip from the first one's start", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  const track = h.$("timelineTrack");
  h.video.currentTime = 9;
  track.scrollLeft = 9 * TL_PPS - 300;
  h.box.fire("scroll", { target: track });

  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(track.scrollLeft, 0);
  assert.match(track.innerHTML, /class="tl-inner" style="width:850px"/);
});

test("a short video that fits at zoom 1 can still zoom out to half, and Fit fills the room", (t) => {
  const h = harness({ room: 1200 });
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 10);        // 770px of video in 1200px
  const zoom = () => h.$("tlZoomLevel").getAttribute("aria-valuetext");
  assert.equal(h.$("tlZoomOut").disabled, false);
  h.box.fire("click", evt({ "#tlZoomOut": {} }));
  h.box.fire("click", evt({ "#tlZoomOut": {} }));
  assert.equal(zoom(), "×0.5");
  assert.equal(h.$("tlZoomOut").disabled, true);
  h.box.fire("click", evt({ "#tlZoomFit": {} }));
  assert.equal(zoom(), "×1.5", "112px a second fills 1200px with ten seconds and the tail");
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
  assert.ok(h.box.innerHTML.includes('class="tl-name tl-name-caps off"'));
  assert.ok(h.box.innerHTML.includes('class="tl-eye" id="tlSubEye"'), "the eye is shut");
  assert.ok(h.box.innerHTML.includes('<path d="m2 2 20 20"/>'), "and drawn shut");
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
  hdl.fire("pointermove", { clientX: 138.5 });        // half a second, at 77px/s

  assert.equal(blk.style.left, "154.0px", "the block's start does not move");
  assert.equal(blk.style.width, "192.5px", "2.5 seconds of it");
  assert.equal(tip.textContent, "2.0s – 4.5s");

  hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues, { 2: { start: 2, end: 4.5 } },
    "remembered to a tenth, under the line's own number");
  assert.equal(h.log.saved, 1);
  assert.equal(h.log.updated, 1);
  assert.equal(blk.classes.has("trimming"), false);
  assert.equal(tip.removed, true);
});

// A line that starts between tenths keeps that start when its end is
// trimmed: the line's own time still shows its subtitle.
test("a trim moves only the end it drags, the other end exactly as it was", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const lines = LINES.map((l) => (l.line === 2 ? { ...l, start: 2.04, end: 4.03 } : l));
  h.api.renderTimeline(lines, 30);
  const right = grabHandle(h, "r", 1);
  right.hdl.fire("pointermove", { clientX: 138.5 });
  right.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["2"], { start: 2.04, end: 4.5 });
  const left = grabHandle(h, "l", 1);
  left.hdl.fire("pointermove", { clientX: 138.5 });
  left.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["2"], { start: 2.5, end: 4.5 });
});

test("a trim cannot be pulled through its own other end, or off the video", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);

  // The left end, pulled far past the right one: it stops a fifth of a second
  // short of it.
  const left = grabHandle(h, "l", 1);
  left.hdl.fire("pointermove", { clientX: 50000 });
  left.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["2"], { start: 3.8, end: 4 });

  const again = grabHandle(h, "l", 0);
  again.hdl.fire("pointermove", { clientX: -50000 });
  again.hdl.fire("pointerup", {});
  assert.deepEqual(h.subStyle.cues["1"], { start: 0, end: 2 });

  const right = grabHandle(h, "r", 2);
  right.hdl.fire("pointermove", { clientX: 50000 });
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
  h.box.fire("pointerdown", evt({ ".tl-ruler": {} }, { clientX: 790 }));
  assert.equal(h.video.currentTime, 10, "770px in, at 77px a second");
  assert.equal(h.log.cancelled, 1, "playing on from here means no stopping point");
  assert.equal(h.log.painted, 1);
  assert.equal(h.box.classes.has("scrubbing"), false);

  h.box.fire("pointerdown", evt({ ".tl-playhead": {}, ".tl-ruler": {} }, { clientX: 790 }));
  assert.equal(h.box.classes.has("scrubbing"), true);
  assert.deepEqual(h.box.captured, [7]);
  h.box.fire("pointermove", { clientX: 1175 });
  assert.equal(h.video.currentTime, 15);
  h.box.fire("pointermove", { clientX: 90000 });
  assert.equal(h.video.currentTime, 30, "and never past the end of the video");
  h.box.fire("pointerup", {});
  assert.equal(h.box.classes.has("scrubbing"), false);
  h.box.fire("pointermove", { clientX: 40 });
  assert.equal(h.video.currentTime, 30, "the drag is over");
});

// Move only, the way CapCut and Premiere do: a press on an empty part of a
// finished job's lane, or on its video clip, moves the playhead there as the
// ruler does, and Space plays. A line's bar still plays its line, and a
// subtitle block keeps its ends to trim (owner, 2026-10-11; Windows D2 found
// the empty lane and the Video lane did nothing).
test("on a finished job a press on an empty part of a lane moves the playhead, a bar still plays its line", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  h.box.qs1[".tl-inner"] = { getBoundingClientRect: () => ({ left: 20 }) };
  h.box.fire("pointerdown", evt({ ".tl-lanes": {} }, { clientX: 790 }));
  assert.equal(h.video.currentTime, 10, "moved there, as a press on the ruler does");
  h.video.currentTime = 0;
  h.box.fire("pointerdown", evt({ ".tl-lanes": {}, ".tl-blk": {} }, { clientX: 790 }));
  assert.equal(h.video.currentTime, 0, "a bar is its click's to play, not a jump");
  h.box.fire("pointerdown", evt({ ".tl-lanes": {}, ".tl-cap": {} }, { clientX: 790 }));
  assert.equal(h.video.currentTime, 0, "nor a subtitle block, whose ends are trimmed");
});

test("a block plays its own line -- the Original lane in the film as it came in", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  const bar = makeEl("bar");
  bar.dataset.start = "5";
  bar.dataset.end = "6";

  h.box.fire("click", evt({ ".tl-blk": bar }));
  await Promise.resolve();
  assert.deepEqual(h.log.shown, ["dubbed"], "a Translated block is the dub");
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
  key: k, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  target: { closest: () => null },
  preventDefault() { this.prevented = true; }, ...over,
});

test("the keyboard plays, restarts and zooms -- and only on the finished screen", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.attach();
  h.api.renderTimeline(LINES, 30);
  const zoom = () => h.$("tlZoomLevel").getAttribute("aria-valuetext");

  const space = key(" ");
  h.log.fireDoc("keydown", space);
  assert.equal(h.log.toggled, 1);
  assert.equal(space.prevented, true, "space scrolls the page otherwise");

  h.video.currentTime = 12;
  h.log.fireDoc("keydown", key("Enter"));
  assert.equal(h.video.currentTime, 0, "Enter plays from the very start");
  assert.equal(h.log.cancelled, 1);

  h.log.fireDoc("keydown", key("+"));
  assert.equal(zoom(), "×1.5");
  h.log.fireDoc("keydown", key("="));
  assert.equal(zoom(), "×2.3", "the unshifted + key too");
  h.log.fireDoc("keydown", key("-"));
  assert.equal(zoom(), "×1.5");
  h.log.fireDoc("keydown", key("0"));
  assert.equal(zoom(), "×0.2", "0 fits the whole video");

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

// -- a new project, before it is dubbed ---------------------------------------

const DRAFT = { downloadId: "d1", name: "street-food.mp4", duration: 10, videoUrl: "/v" };

/** A draft screen: the timeline asked for the draft state, on show. */
// 850px of track: a 10s video fitted (770px and the 80px tail) is 77px to the
// second, zoom 1, so the tests below read in round numbers.
function drafting() {
  const h = harness({ room: 850 });
  h.api.attach();
  h.$("timeline").offsetWidth = 1200;   // on show
  setDraft(DRAFT);
  h.api.showDraft();
  return h;
}

test("a draft's video opens fitted to the strip, and a cut does not refit it", (t) => {
  clearDraft();
  const h = harness();            // 600px of track
  t.after(h.log.restore);
  h.api.attach();
  h.api.showDraft();
  setDraft(DRAFT);
  // 10s in 600px less the 80px tail: 52px to the second, less the 2px seam.
  assert.ok(h.$("timelineTrack").innerHTML.includes('style="left:0.0px;width:518.0px"'));
  h.video.currentTime = 5;
  h.api.paintTimeline(5, 10, "clock");
  h.box.fire("click", evt({ "#tlDelRight": {} }));
  assert.deepEqual(getDraft().ranges, [[0, 5]]);
  assert.ok(h.$("timelineTrack").innerHTML.includes('style="left:0.0px;width:258.0px"'), "the same scale after a cut");
});

test("before a video is imported, one row says what to do; an imported one is on it at once", (t) => {
  clearDraft();
  const h = harness({ room: 850 });
  t.after(h.log.restore);
  h.api.attach();
  h.api.showDraft();
  let html = h.box.innerHTML;
  const track = () => h.$("timelineTrack").innerHTML;
  assert.ok(track().includes("Drop videos here"), "even before any video is imported");
  assert.equal(h.box.classes.has("tl-draftmode"), true);
  for (const id of ["tlUndo", "tlRedo", "tlSplit", "tlDelLeft", "tlDelRight", "tlDelete"]) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.equal(h.$(id).disabled, true, `${id} has nothing to work on`);
  }
  assert.ok(!html.includes("Voice length"), "no legend before dubbing");
  assert.ok(!track().includes('id="timelinePlayhead"'));

  // No + and no drag onto the strip (mockup edit-flow): imported is on it.
  setDraft(DRAFT);
  html = h.box.innerHTML;
  assert.ok(!track().includes("Drop videos here"));
  assert.ok(html.includes('<span>Video</span>'), "the Video lane alone");
  assert.ok(!html.includes('<span>Original</span>'));
  // One clip, the whole video: 770px, less the 2px that shows where clips meet.
  assert.ok(h.$("timelineTrack").innerHTML.includes('class="tl-vclip tl-cut" data-i="0"\n      style="left:0.0px;width:768.0px"'));
});

// A draft left with Home, then an empty new project: the player went on
// saying the last draft's kept length, 00:01:10.7, over no video (2026-10-21).
test("an empty new project's player says the clock handed in, not the last draft's kept time", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.video.currentTime = 6;
  h.box.fire("click", evt({ "#tlDelRight": {} }));
  assert.deepEqual(getDraft().ranges, [[0, 6]]);
  h.api.paintTimeline(0, 10, "00:00:00.0 / 00:00:10.0");
  assert.equal(h.$("videoTime").textContent, "00:00:00.0 / 00:00:06.0", "a draft counts kept time");
  clearDraft();
  h.api.showDraft();
  // The clock the player last painted (the harness's getClock), on both clocks.
  assert.equal(h.$("videoTime").textContent, "00:00:00.0 / 00:00:30.0");
  assert.equal(h.$("timelineClock").textContent, "00:00:00.0 / 00:00:30.0");
});

test("split, select, delete, undo and redo -- and the draft is told every time", async (t) => {
  const h = drafting();
  t.after(h.log.restore);
  await settle();   // the film strip and waveform of the held video
  assert.ok(h.log.fetched.includes("/api/media/download/d1/filmstrip"));

  h.video.currentTime = 3.4;
  h.api.paintTimeline(3.4, 10, "clock");
  assert.equal(h.$("tlSplit").disabled, false);
  assert.equal(h.$("tlDelete").disabled, true, "nothing chosen yet");
  h.box.fire("click", evt({ "#tlSplit": {} }));
  let track = h.$("timelineTrack").innerHTML;
  assert.equal((track.match(/class="tl-vclip tl-cut/g) || []).length, 2);
  assert.deepEqual(getDraft().ranges, [[0, 10]], "a split keeps every second");
  assert.ok(track.includes('data-i="1"\n      style="left:261.8px'), "the second clip starts where the first ends");
  // The cut itself has to be seen, not just felt: a seam between the two
  // pieces, and only between them -- never after the last one.
  assert.equal((track.match(/class="tl-seam"/g) || []).length, 1);

  // Choose the second clip: a white ring. Then Delete.
  h.box.fire("click", evt({ ".tl-cut": { dataset: { i: "1" } } }));
  assert.ok(h.$("timelineTrack").innerHTML.includes('class="tl-vclip tl-cut sel" data-i="1"'));
  assert.equal(h.$("tlDelete").disabled, false);
  const del = key("Delete");
  h.log.fireDoc("keydown", del);
  assert.equal(del.prevented, true);
  assert.deepEqual(getDraft().ranges, [[0, 3.4]]);
  assert.equal(h.$("tlDelete").disabled, true, "the last clip cannot go");

  // Cmd+Z brings it back, still split; Shift+Cmd+Z takes it out again.
  h.log.fireDoc("keydown", key("z", { metaKey: true }));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);
  assert.equal((h.$("timelineTrack").innerHTML.match(/tl-cut/g) || []).length, 2);
  h.log.fireDoc("keydown", key("z", { ctrlKey: true, shiftKey: true }));
  assert.deepEqual(getDraft().ranges, [[0, 3.4]]);
  h.box.fire("click", evt({ "#tlUndo": {} }));
  h.box.fire("click", evt({ "#tlUndo": {} }));
  assert.equal((h.$("timelineTrack").innerHTML.match(/tl-cut/g) || []).length, 1, "back to the whole video");
  assert.ok(!h.$("timelineTrack").innerHTML.includes("tl-seam"), "one piece has no seam to show");
  assert.equal(h.$("tlUndo").disabled, true);
  h.box.fire("click", evt({ "#tlRedo": {} }));
  assert.equal((h.$("timelineTrack").innerHTML.match(/tl-cut/g) || []).length, 2);

  // A click away from every clip lets go of the choice.
  h.box.fire("click", evt({ ".tl-cut": { dataset: { i: "0" } } }));
  h.box.fire("click", evt({}));
  assert.ok(!h.$("timelineTrack").innerHTML.includes(" sel"));
});

test("Cmd/Ctrl+B splits at the playhead too, gated the same as the other cut keys", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.video.currentTime = 4;
  globalThis.document.body.dataset.screen = "new";

  // Typing in a field keeps a "b" a "b".
  h.log.fireDoc("keydown", key("b", { metaKey: true, target: { closest: () => ({}) } }));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);
  // Not while the draft timeline is off screen either.
  h.$("timeline").offsetWidth = 0;
  h.log.fireDoc("keydown", key("b", { ctrlKey: true }));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);

  h.$("timeline").offsetWidth = 1200;
  const pressed = key("b", { metaKey: true });
  h.log.fireDoc("keydown", pressed);
  assert.equal(pressed.prevented, true);
  // A split keeps every second (the draft joins the touching pieces back into
  // one range), but the timeline's own list keeps it a split -- same as a
  // press on the Split button (see "split, select, delete..." above).
  assert.deepEqual(getDraft().ranges, [[0, 10]], "Cmd+B splits where the playhead stands");
  const track = h.$("timelineTrack").innerHTML;
  assert.equal((track.match(/class="tl-vclip tl-cut/g) || []).length, 2);
  assert.ok(track.includes('data-i="1"\n      style="left:308.0px'), "the second piece starts at 4s");
});

test("a cut tool that cannot be used says why on its tip, and its name again once it can", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.api.paintTimeline(0, 10, "clock");
  assert.equal(h.$("tlSplit").disabled, true);
  for (const id of ["tlSplit", "tlDelLeft"]) {
    assert.equal(h.$(id).dataset.tip, "Move the playhead into the video", id);
  }
  assert.equal(h.$("tlDelete").dataset.tip, "Select a part first");
  assert.equal(h.$("tlUndo").dataset.tip, "Nothing to undo");
  h.video.currentTime = 3.4;
  h.api.paintTimeline(3.4, 10, "clock");
  assert.equal(h.$("tlSplit").disabled, false);
  assert.equal(h.$("tlSplit").dataset.tip, "Split at playhead");
  assert.equal(h.$("tlDelRight").dataset.tip, "Delete right of playhead");
});

test("the cut tools and the zoom buttons carry a fast tooltip, not the slow native one", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  const html = h.box.innerHTML;
  assert.ok(!/\btitle="/.test(html.slice(0, html.indexOf("tl-clock"))), "no slow native tooltip on the toolbar");
  assert.ok(html.includes(`id="tlUndo" type="button" data-tip="Undo" data-tip-key="${modKey()}+Z" aria-label="Undo"`));
  assert.ok(html.includes(`id="tlSplit" type="button" data-tip="Split at playhead" data-tip-key="${modKey()}+B" aria-label="Split at playhead"`),
    "the new shortcut shows in the tooltip");
  assert.ok(html.includes('id="tlDelLeft" type="button" data-tip="Delete left of playhead" aria-label="Delete left of playhead"'),
    "no shortcut of its own, so no data-tip-key");
  assert.ok(html.includes('id="tlZoomFit" type="button" data-tip="Fit the whole video" data-tip-key="0" aria-label="Fit the whole video"'));
  assert.ok(html.includes('id="tlZoomOut" type="button" data-tip="Zoom out" data-tip-key="-" aria-label="Zoom out"'));
  assert.ok(html.includes('id="tlZoomIn" type="button" data-tip="Zoom in" data-tip-key="+" aria-label="Zoom in"'));
});

test("delete left and right trim the clip under the playhead", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.video.currentTime = 2;
  h.box.fire("click", evt({ "#tlDelLeft": {} }));
  assert.deepEqual(getDraft().ranges, [[2, 10]]);
  h.video.currentTime = 8;
  h.box.fire("click", evt({ "#tlDelRight": {} }));
  assert.deepEqual(getDraft().ranges, [[2, 8]]);
  // The playhead is somewhere still kept.
  assert.equal(h.video.currentTime, 8);
  h.video.currentTime = 9.5;
  h.box.fire("click", evt({ "#tlDelRight": {} }));
  assert.deepEqual(getDraft().ranges, [[2, 8]], "past the last clip there is nothing to trim");
});

test("a draft plays its kept parts only, and the clocks count kept time", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  // Cut out 3.4 - 6.8, the mockup's own cut.
  h.video.currentTime = 3.4;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  h.video.currentTime = 6.8;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  h.box.fire("click", evt({ ".tl-cut": { dataset: { i: "1" } } }));
  h.box.fire("click", evt({ "#tlDelete": {} }));
  assert.deepEqual(getDraft().ranges, [[0, 3.4], [6.8, 10]]);

  // The playhead and both clocks: 8.4s of the video is 5.0s kept, of 6.6.
  h.api.paintTimeline(8.4, 10, "00:00:08.4 / 00:00:10.0");
  assert.equal(h.$("timelinePlayhead").style.left, "385.0px");
  assert.equal(h.$("timelineClock").textContent, "00:00:05.0 / 00:00:06.6");
  assert.equal(h.$("videoTime").textContent, "00:00:05.0 / 00:00:06.6");

  // Playing into the cut-away part jumps over it...
  h.log.frames.length = 0;
  h.video.currentTime = 3.3;
  h.video.paused = false;
  h.video.fire("play");
  h.video.currentTime = 4;
  h.log.frames.shift()();
  assert.equal(h.video.currentTime, 6.8);
  // ...and the end of the last clip is the end.
  h.video.currentTime = 10;
  h.log.frames.shift()();
  assert.equal(h.video.paused, true);
  // Play again from the end: from the top.
  h.video.fire("play");
  assert.equal(h.video.currentTime, 0);

  // The ruler takes kept time back to the video's own.
  h.box.qs1[".tl-inner"] = { getBoundingClientRect: () => ({ left: 0 }) };
  h.box.fire("pointerdown", evt({ ".tl-ruler": {} }, { clientX: 385 }));
  assert.ok(Math.abs(h.video.currentTime - 8.4) < 1e-9);
});

test("the cut keys work only while the draft is on show and nobody is typing", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.video.currentTime = 5;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  h.box.fire("click", evt({ ".tl-cut": { dataset: { i: "0" } } }));
  globalThis.document.body.dataset.screen = "new";

  h.log.fireDoc("keydown", key("Backspace", { target: { closest: () => ({}) } }));
  assert.deepEqual(getDraft().ranges, [[0, 10]], "a Backspace in a text box stays there");
  h.$("timeline").offsetWidth = 0;   // hidden
  h.log.fireDoc("keydown", key("Backspace"));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);
  h.$("timeline").offsetWidth = 1200;
  h.log.fireDoc("keydown", key("Backspace"));
  assert.deepEqual(getDraft().ranges, [[5, 10]]);
});

test("a new video starts a fresh list; the draft's own echo keeps a split a split", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.video.currentTime = 5;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  assert.equal((h.$("timelineTrack").innerHTML.match(/tl-cut/g) || []).length, 2);
  setDraft({ ...DRAFT, downloadId: "d2" });
  assert.equal((h.$("timelineTrack").innerHTML.match(/tl-cut/g) || []).length, 1);
  assert.equal(h.$("tlUndo").disabled, true, "and nothing to undo");
  // A finished job takes the strip over; with no job and no draft it is blank.
  h.api.renderTimeline(LINES, 30);
  assert.equal(h.box.classes.has("tl-draftmode"), false);
  clearDraft();
  assert.ok(h.box.innerHTML.includes("Voice length"), "the job keeps its strip");
  h.api.renderTimeline([], 0);
  assert.equal(h.box.innerHTML, "");
});

// -- the Erase tab ------------------------------------------------------------

const AREA = { strip: "draft", locked: false, lane: { text: "Erase · 00:10", cls: "", pct: 0 } };

test("the Erase tab draws the draft with the same tools, and an Erase lane as long as what is kept", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  globalThis.document.body.dataset.screen = "erase";
  h.api.showErase(AREA);
  const html = h.box.innerHTML;
  assert.equal(h.box.classes.has("tl-draftmode"), true);
  for (const id of ["tlUndo", "tlRedo", "tlSplit", "tlDelLeft", "tlDelRight", "tlDelete", "tlZoomFit", "tlZoomIn"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is on the Erase tab too`);
  }
  assert.ok(html.includes("<span>Video</span>") && html.includes("<span>Erase</span>"));
  // One block under the clips, 770px of kept video less the 2px seam.
  const track = () => h.$("timelineTrack").innerHTML;
  assert.match(track(), /<div class="tl-lane tl-lane-erase"><div class="et-seg"\n      style="left:0;width:768.0px;--pct:0%">Erase · 00:10<\/div><\/div>/);
  assert.ok(track().includes('id="timelinePlayhead"'));

  // Cut here: the draft is told, as on the Dubbing tab, and Space still plays.
  h.video.currentTime = 4;
  h.api.paintTimeline(4, 10, "clock");
  assert.equal(h.$("tlDelLeft").disabled, false);
  h.box.fire("click", evt({ "#tlDelLeft": {} }));
  assert.deepEqual(getDraft().ranges, [[4, 10]]);
  h.log.fireDoc("keydown", key(" "));
  assert.equal(h.log.toggled, 1);
  h.log.fireDoc("keydown", key("z", { metaKey: true }));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);

  // The lane's words change as the erase counts up: the track alone is redrawn.
  h.$("tlUndo").marker = "kept";
  h.api.showErase({ ...AREA, lane: { text: "Erase · 00:06", cls: "", pct: 0 } });
  assert.ok(track().includes(">Erase · 00:06<"));
  assert.equal(h.$("tlUndo").marker, "kept", "the head is not rebuilt for a lane's words");
});

test("while an erase runs the cuts are locked, but the playhead and playback are not", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  globalThis.document.body.dataset.screen = "erase";
  h.video.currentTime = 5;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  h.box.fire("click", evt({ ".tl-cut": { dataset: { i: "0" } } }));
  const job = { media: { kind: "job", id: "E1", name: "street-food" }, duration: 10 };
  h.api.showErase({ strip: job, locked: true, lane: { text: "Erasing 35%", cls: "now", pct: 35 } });
  h.api.paintTimeline(5, 10, "clock");
  for (const id of ["tlUndo", "tlRedo", "tlSplit", "tlDelLeft", "tlDelRight", "tlDelete"]) {
    assert.equal(h.$(id).disabled, true, `${id} is locked`);
  }
  // The strip is the job's own video: one clip, its own film strip.
  const track = h.$("timelineTrack").innerHTML;
  assert.equal((track.match(/tl-cut/g) || []).length, 1);
  assert.ok(track.includes('class="et-seg now"') && track.includes("--pct:35%") && track.includes(">Erasing 35%<"));
  // Nothing cuts: not a tool, not Delete, not Cmd+Z.
  h.box.fire("click", evt({ "#tlDelRight": {} }));
  h.log.fireDoc("keydown", key("Delete"));
  h.log.fireDoc("keydown", key("z", { metaKey: true }));
  assert.deepEqual(getDraft().ranges, [[0, 10]]);
  // The playhead: a press on the ruler still goes there, and Space still plays.
  h.box.qs1[".tl-inner"] = { getBoundingClientRect: () => ({ left: 0 }) };
  h.box.fire("pointerdown", evt({ ".tl-ruler": {} }, { clientX: 154 }));
  assert.ok(Math.abs(h.video.currentTime - 2) < 1e-9);
  h.log.fireDoc("keydown", key(" "));
  assert.equal(h.log.toggled, 1);
});

test("an erase job's strip is its own video, and giving the strip back restores what was there", async (t) => {
  clearDraft();
  const h = harness();
  t.after(h.log.restore);
  h.api.attach();
  h.$("timeline").offsetWidth = 1200;
  h.api.renderTimeline(LINES, 30);
  globalThis.document.body.dataset.screen = "erase";
  // Nothing to erase yet: the frame an empty draft has, with the row that
  // asks for a video -- even with a draft left behind from before.
  setDraft(DRAFT);
  h.api.showErase({ strip: null, lane: null, locked: true });
  assert.ok(h.box.classes.has("tl-draftmode"));
  assert.ok(h.$("timelineTrack").innerHTML.includes("Drop videos here"));
  assert.ok(!h.$("timelineTrack").innerHTML.includes("tl-vclip"));
  clearDraft();
  // A finished dub's lines arriving meanwhile wait for the strip to come back.
  h.api.renderTimeline(LINES, 30);
  assert.ok(!h.box.innerHTML.includes("Voice length"));
  h.api.showErase({ strip: { media: { kind: "job", id: "E1", name: "x" }, duration: 8 },
                    locked: true, lane: { text: "Erased", cls: "ok", pct: 0 } });
  await settle();
  assert.ok(h.log.fetched.includes("/api/media/job/E1/filmstrip"));
  assert.ok(!h.$("timelineTrack").innerHTML.includes("Drop videos here"));
  // Its time is the strip's own: 3s of the video is 3s along.
  h.api.paintTimeline(3, 8, "clock");
  assert.equal(h.$("timelinePlayhead").style.left, `${(3 * TL_PPS).toFixed(1)}px`);
  // Leaving the tab: the finished job's lanes, as they were.
  h.api.showErase(null);
  assert.ok(h.box.innerHTML.includes("Voice length"));
  assert.equal(h.box.classes.has("tl-draftmode"), false);
});

test("a press on a lane moves the playhead there before dubbing, and the click still picks the clip", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  h.box.qs1[".tl-inner"] = { getBoundingClientRect: () => ({ left: 0 }) };
  const press = evt({ ".tl-lanes": {}, ".tl-cut": { dataset: { i: "0" } } }, { clientX: 385 });
  h.box.fire("pointerdown", press);
  assert.ok(Math.abs(h.video.currentTime - 5) < 1e-9);
  assert.equal(press.prevented, undefined, "the click that follows is not stopped");
  assert.equal(h.log.painted, 1);
  // A tool pressed with the mouse does not keep the focus the space bar needs.
  const down = evt({ ".tl-head button": {} });
  h.box.fire("mousedown", down);
  assert.equal(down.prevented, true);
});

test("the cut tools end at Delete: saving is the top bar's Export", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.attach();
  h.$("timeline").offsetWidth = 1200;
  setDraft(DRAFT);
  h.api.showDraft();
  assert.match(h.box.innerHTML, /id="tlDelete"/);
  assert.doesNotMatch(h.box.innerHTML, /Save clip|tlSaveClip/);
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
  // Flex bases, not widths: the panels share the row by flex (mockup
  // 2026-09-29), and a width under a share is ignored. The video's is
  // written on the row, for whichever center panel is up.
  assert.equal(h.$("doneMain").style["--video-flex"], "0 0 400px");
  assert.equal(h.$("agentStrip").style.flex, "0 0 400px");
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

// The owner's complaint (2026-09-30): the Erase tab came up with panels of
// its own widths. The center panel is one of three elements, and the width is
// one number for all of them.
test("the Erase tab's and the running video's grips size the same one width", (t) => {
  for (const [grip, pane] of [["gripPanesErase", "erasePane"], ["gripPanesRun", "runPane"]]) {
    const h = laidOut({});
    t.after(h.log.restore);
    // Only that panel is up: the finished video's has no width.
    h.$("videoPane").offsetWidth = 0;
    h.$(pane).offsetWidth = 500;
    h.$(grip).fire("pointerdown", evt({}, { clientX: 900 }));
    h.$(grip).fire("pointermove", { clientX: 880 });
    assert.equal(h.$("doneMain").style["--video-flex"], "0 0 520px", `${grip} starts from its own panel's width`);
    h.$(pane).offsetWidth = 520;
    h.$(grip).fire("pointerup", {});
    assert.equal(h.log.stored.get("persodub.layout.videoWidth"), "520", "and is remembered under the one key");
    for (const id of ["videoPane", "runPane", "erasePane"]) {
      assert.equal(h.$(id).style.flex, undefined, `${id} carries no width of its own`);
    }
  }
});

test("the grip left of its pane counts the drag the other way round", (t) => {
  const h = laidOut({});
  t.after(h.log.restore);

  // The projects list is left of its handle, so pulling the line right grows it.
  h.$("gripSidebar").fire("pointerdown", evt({}, { clientX: 300 }));
  h.$("gripSidebar").fire("pointermove", { clientX: 340 });
  assert.equal(h.$("historySidebar").style["--sidebar-w"], "300px");

  // Layout G: the video pane is RIGHT of its handle, so pulling that line left
  // grows it -- the video keeps at least 320px of the row, the panel 380.
  h.$("gripPanes").fire("pointerdown", evt({}, { clientX: 900 }));
  h.$("gripPanes").fire("pointermove", { clientX: 870 });
  assert.equal(h.$("doneMain").style["--video-flex"], "0 0 430px");
  h.$("gripPanes").fire("pointermove", { clientX: 100 });
  assert.equal(h.$("doneMain").style["--video-flex"], "0 0 613px", "380px left of a 1000px row, less the gap");
  h.$("gripPanes").fire("pointerup", {});

  // Stacked, a basis would be the video's height: nothing is written.
  const stacked = laidOut({ "persodub.layout.videoWidth": "400" });
  t.after(stacked.log.restore);
  stacked.$("doneMain").classes.add("stacked");
  stacked.api.fitLayout();
  assert.equal(stacked.$("videoPane").style.flex, undefined);
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
  h.$("timelineTrack").clientWidth = 3000;
  h.log.observer();
  assert.match(h.$("timelineTrack").innerHTML, /class="tl-inner" style="width:3000px"/);
});

// -- each project starts on its own view ---------------------------------------

test("a zoom left on one project is not the next project's", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const zoom = () => h.$("tlZoomLevel").getAttribute("aria-valuetext");
  h.api.renderTimeline(LINES, 30);
  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  assert.notEqual(zoom(), "×1");

  // The page opens another job.
  h.api.resetView();
  h.api.renderTimeline(LINES, 30);
  assert.equal(zoom(), "×1");
  assert.equal(h.$("timelineTrack").scrollLeft, 0);
});

test("a new draft's video starts at zoom 1; a cut on the same video keeps the zoom", (t) => {
  const h = drafting();
  t.after(h.log.restore);
  const zoom = () => h.$("tlZoomLevel").getAttribute("aria-valuetext");
  h.box.fire("click", evt({ "#tlZoomIn": {} }));
  assert.equal(zoom(), "×1.5");
  h.video.currentTime = 5;
  h.box.fire("click", evt({ "#tlSplit": {} }));
  assert.equal(zoom(), "×1.5", "the same video, still being cut");

  setDraft({ ...DRAFT, downloadId: "d2" });
  assert.equal(zoom(), "×1");
});

test("a long video's film strip keeps every frame its own size and draws only the part near the view", async (t) => {
  // 1,000 seconds at zoom 1 is 77,000px: boxes widened to fit a cap of 400
  // stretched every frame sideways (owner, 2026-10-14). Now a box is always
  // 69px, and only a screen either side of the view is in the page.
  const h = harness({ media: { kind: "job", id: "long", name: "long.mp4" } });
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 1000);
  await settle();
  let track = h.$("timelineTrack").innerHTML;
  assert.ok(track.includes("--strip-w:828.0px"), "the strip image at its own size");
  const boxes = track.match(/<i style="left:[0-9.]+px;width:69\.0px;/g) || [];
  assert.equal(boxes.length, Math.ceil(1200 / 69), "the view (600px) and the screen after it");
  assert.ok(!/width:(?!69\.0px)[0-9.]+px;background-position/.test(track), "no box wider than a frame");

  // Scrolled to the middle, the boxes there are drawn and the first ones let go.
  const el = h.$("timelineTrack");
  el.scrollLeft = 38500;
  const film = { dataset: { film: "0" }, innerHTML: "" };
  el.qs[".tl-film[data-film]"] = [film];
  h.box.fire("scroll", { target: el });
  for (const frame of h.log.frames.splice(0)) frame();   // the queued animation frame
  assert.ok(film.innerHTML.startsWith('<i style="left:37881.0px;width:69.0px;'), film.innerHTML.slice(0, 60));
  assert.equal((film.innerHTML.match(/<i /g) || []).length, Math.ceil((38500 + 1200) / 69) - Math.floor((38500 - 600) / 69));
});

// A video with the user's own subtitles (kind "captions") has no voices: the
// strip is the video and the captions, with no voice lanes and no legend.
test("a video with its own subtitles shows the video and captions lanes only, and no voice legend", (t) => {
  const h = harness({ own: true });
  t.after(h.log.restore);
  h.api.renderTimeline(LINES, 30);
  const html = h.box.innerHTML + h.$("timelineTrack").innerHTML;
  for (const gone of ["tl-sw-voice", "Voice length", "Much shorter", "<span>Original</span>", "<span>Translated</span>",
                      "tl-lane-org", "tl-lane-dub", "tl-voice", "tl-org"]) {
    assert.ok(!html.includes(gone), gone);
  }
  assert.ok(html.includes("<span>Video</span>") && html.includes("<span>Captions</span>"));
  assert.equal((html.match(/class="tl-cap"/g) || []).length, 3, "the three lines on the captions lane");
  assert.ok(html.includes('id="timelineClock"') && html.includes('id="tlSubEye"'));
  // A dubbing's strip is as it was.
  const d = harness();
  t.after(d.log.restore);
  d.api.renderTimeline(LINES, 30);
  const dub = d.box.innerHTML + d.$("timelineTrack").innerHTML;
  for (const kept of ["Voice length", "<span>Original</span>", "<span>Translated</span>", "tl-lane-org", "tl-lane-dub"]) {
    assert.ok(dub.includes(kept), kept);
  }
});
