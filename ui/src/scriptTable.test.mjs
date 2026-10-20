// The script table paints real elements and talks to a real server, so the
// tests hand it a paper-thin page: elements that are plain objects, a $ that
// makes more of them, a document that creates them, and a fetch that answers
// from a script. What is asserted is what the user would see -- a row per line
// with who said it and whether it fits, the words changing when a cell is
// committed and staying put when it is not, and the voice button through all
// four of its looks.
//
// The table writes its rows as ONE string of HTML, so a fake page cannot walk
// real nodes back out of it. Where a test needs to press something, it hands
// the box the nodes that query should find (`box.qs[selector]`) -- the same
// buttons the browser would have built from that string.
//
// Run with: node --test ui/src/scriptTable.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initScriptTableUi, lineOverBy, lineVerdict } from "./scriptTable.mjs";
import { lucide } from "./icons.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

// The three icon-button glyphs (ui/src/scriptTable.mjs): one glyph per
// button, its colour is what changes state, never the mark.
const PLAY_ICON = lucide("play", 14, true);
const WAVE_ICON = lucide("refresh-cw", 14);
const UNDO_ICON = lucide("undo-2", 14);

function makeEl(id) {
  return {
    id, textContent: "", className: "", type: "", title: "", disabled: false,
    style: {}, dataset: {}, attrs: {}, classes: new Set(), listeners: {},
    children: [], blurred: false,
    // What each querySelectorAll should find, filled in by the test.
    qs: {},
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    classList: {
      add(...c) { for (const x of c) this.owner.classes.add(x); },
      remove(...c) { for (const x of c) this.owner.classes.delete(x); },
      contains(c) { return this.owner.classes.has(c); },
    },
    querySelectorAll(sel) { return this.qs[sel] || []; },
    // One element per selector, made the first time it is asked for: the
    // Translate again menu's two items and the header's tick box.
    querySelector(sel) { return ((this.q1 ||= {})[sel] ||= bindClassList(makeEl(sel))); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    append(...kids) { this.children.push(...kids); },
    prepend(kid) { this.children.unshift(kid); },
    // A real blur() does not run the handlers there and then; it puts the event
    // in the queue. The tests fire "blur" themselves, the way the browser does
    // a moment later.
    blur() { this.blurred = true; },
    remove() { this.removed = true; },
    closest() { return this.row || null; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

function bindClassList(el) {
  el.classList = { ...el.classList, owner: el };
  return el;
}

/** An editable cell, as the browser would have built it from a row's HTML. */
function makeCell(line, text) {
  const cell = bindClassList(makeEl(`cell-${line}`));
  cell.dataset.line = String(line);
  cell.textContent = text;
  return cell;
}

/** A voice button, with the row it sits in (the play button reads that row). */
function makeButton(id, data) {
  const btn = bindClassList(makeEl(id));
  Object.assign(btn.dataset, data);
  return btn;
}

/** A page, a fetch log and everything the table reaches out through. */
function harness({ responses = {}, perso = false, duration = 30, job = null } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, bindClassList(makeEl(id)));
    return els.get(id);
  };
  const log = { calls: [], timeline: [], playhead: 0, played: [], shown: [],
                reloads: 0, timers: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document,
                 setTimeout: globalThis.setTimeout };
  // The table clears its "a revert is being pressed" flag on the document's own
  // mouseup, so the fake document has to hold that listener for a test to fire.
  const docListeners = {};
  globalThis.document = {
    createElement: (tag) => bindClassList(makeEl(tag)),
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
  };
  log.fireDoc = (ev) => { for (const fn of docListeners[ev] || []) fn(); };
  globalThis.fetch = async (url, init) => {
    log.calls.push(`${(init && init.method) || "GET"} ${url}` +
                   (init && init.body ? ` ${init.body}` : ""));
    const r = responses[url];
    if (typeof r === "function") return r();
    if (!r) throw new Error(`no answer scripted for ${url}`);
    return r;
  };
  // The status line clears itself a second or two later. Held rather than
  // scheduled, so a test can look at the message before it goes and run the
  // clock forward by hand when it wants to see it go.
  globalThis.setTimeout = (fn) => { log.timers.push(fn); return log.timers.length; };
  log.runTimers = () => { const t = log.timers.splice(0); for (const fn of t) fn(); };
  log.restore = () => {
    globalThis.fetch = real.fetch;
    globalThis.document = real.document;
    globalThis.setTimeout = real.setTimeout;
  };

  const video = bindClassList(makeEl("doneVideo"));
  video.duration = duration;
  const api = initScriptTableUi({
    $,
    scriptLangNames: () => ({ source: "Korean", target: "English" }),
    isPersoJob: () => perso,
    renderTimeline: (lines, total) => log.timeline.push([lines.length, total]),
    paintPlayhead: () => { log.playhead += 1; },
    getVideo: () => video,
    showVideoSource: async (which) => { log.shown.push(which); },
    playRange: (v, start, end) => { log.played.push([v.id, start, end]); },
    reloadVideo: () => { log.reloads += 1; },
    getJob: () => job,
    askTranslator: (notice, pick) => { log.asked = { notice, pick }; },
    needModels: (detail, retry) => { log.needed = { detail, retry }; },
  });
  return { $, api, log, video };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (detail) => ({ ok: false, status: 400, json: async () => ({ detail }) });
const SCRIPT = "/api/dub/jobs/j1/script";

// One line of a real script: a slot of time, the words, and how long the voice
// that was made for it actually runs.
const line = (n, over = {}) => ({
  line: n, start: n, end: n + 1, slot: 1, estimated: 0.9, audio_sec: 0.9,
  speaker: "SPEAKER_00", source: "안녕하세요", text: `Hello ${n}`,
  edited: false, voice_stale: false, fits: true, ...over,
});

// -- a row --------------------------------------------------------------------

test("a row carries the line number, who said it, both languages and whether it fits", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [
    line(1),
    line(2, { speaker: "SPEAKER_01", audio_sec: 2.4 }),   // 1.4s past its slot
    line(3, { audio_sec: 0.2 }),                          // well short of it
  ] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;

  // The header names the two languages the page chose, not "Original/Script".
  assert.match(html, /<div class="sc-h-src">Korean<\/div>/);
  assert.match(html, /<div class="sc-h-dst">English<\/div>/);
  // Speakers are numbered in the order they first speak -- one chip colour for
  // all of them; the diarizer's own "SPEAKER_00" never reaches the screen.
  assert.match(html, /class="spk-chip" title="Speaker 1"/);
  assert.match(html, /class="spk-chip" title="Speaker 2"/);
  assert.doesNotMatch(html, /SPEAKER_0/);
  // Number, time, source and the editable translation.
  // The number sits behind the tick box Translate again picks lines with.
  assert.match(html, /<label class="sc-n"><input class="sc-pick" type="checkbox" data-pick="1"/);
  assert.match(html, /<span>1<\/span><\/label>/);
  assert.match(html, /00:00:01\.0<\/span><span\s+class="sc-t-b"> – 00:00:02\.0/);
  assert.match(html, /class="sc-src">안녕하세요</);
  assert.match(html, /class="sc-dst" contenteditable="plaintext-only"[\s\S]*?data-line="1">Hello 1</);
  // The three verdicts: fits, runs over by this much, and is this much short
  // -- the slot first, then the voice in bold.
  assert.match(html, /<span class="sc-len sc-v-fit"><span class="sc-dot"><\/span><span class="sc-num">1\.0 \/ <b>0\.9<\/b>s<\/span><\/span>/);
  assert.match(html, /<span class="sc-len sc-v-over"><span class="sc-dot"><\/span><span class="sc-num">1\.0 \/ <b>2\.4<\/b>s · <\/span><span class="sc-diff">\+1\.4s<\/span><\/span>/);
  assert.match(html, /<span class="sc-len sc-v-short"><span class="sc-dot"><\/span><span class="sc-num">1\.0 \/ <b>0\.2<\/b>s · <\/span><span class="sc-diff">−0\.8s<\/span><\/span>/);
  // A local dub's chip only displays -- changing a speaker is Perso's own.
  assert.doesNotMatch(html, /<button[^>]*class="spk-chip"/);

  // The strip under the table draws the same lines, to the video's own length.
  assert.deepEqual(h.log.timeline, [[3, 30]]);
  assert.equal(h.log.playhead, 1);
});

test("the script's own clipped list replaces the job's old one, so a remade line stops saying cut", async (t) => {
  const job = { id: "j1", result: { clipped: [{ line: 2, cut_s: 0.6 }], clipped_count: 1 } };
  const h = harness({ job, responses: { [SCRIPT]: ok({ lines: [line(1), line(2)], clipped: [] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.doesNotMatch(h.$("scriptBox").innerHTML, /cut 0\.6s/);
});

test("a line the assembly cut short is marked cut whatever its own numbers say, and one notice names them all", async (t) => {
  const job = { id: "j1", result: { clipped: [{ line: 2, cut_s: 0.6 }], clipped_count: 1 } };
  const h = harness({ job, responses: { [SCRIPT]: ok({ lines: [
    line(1),
    line(2), // fits by its own numbers -- the assembly cut it short anyway
  ] }) } });
  t.after(h.log.restore);
  const box = h.$("scriptBox");

  await h.api.renderScript("j1");
  const html = box.innerHTML;

  assert.match(html, /data-line="2"[\s\S]*?<span class="sc-len sc-v-cut">[^]*?<span class="sc-diff" title="Cut off by 0\.6s">cut 0\.6s<\/span>/);
  assert.match(html, /data-line="1"[\s\S]*?<span class="sc-len sc-v-fit">/); // line 1 untouched

  // One line above the table, singular for one line, with a way to jump there.
  const bar = box.children[0];
  assert.equal(bar.className, "sc-clipped");
  assert.match(bar.innerHTML, /1 line is cut off before it ends\. Shorten it, then remake the voice\./);

  const row = bindClassList(makeEl("row2"));
  let scrolled = null;
  row.scrollIntoView = (opts) => { scrolled = opts; };
  box.q1 = { '.sc-row[data-line="2"]': row };
  await bar.fire("click");
  assert.deepEqual(scrolled, { block: "center" });
});

test("two or more cut-off lines say so in the plural, and a job with none says nothing", async (t) => {
  const job = { id: "j1", result: { clipped: [{ line: 1, cut_s: 0.2 }, { line: 2, cut_s: 0.1 }], clipped_count: 2 } };
  const h = harness({ job, responses: { [SCRIPT]: ok({ lines: [line(1), line(2)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.match(h.$("scriptBox").children[0].innerHTML,
    /2 lines are cut off before they end\. Shorten them, then remake the voice\./);
});

test("a job finished before clipped was recorded shows no notice", async (t) => {
  // clipped_count absent means unknown, not "nothing was cut" -- but there is
  // nothing to show either way.
  const h = harness({ job: { id: "j1", result: {} },
                      responses: { [SCRIPT]: ok({ lines: [line(1)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.deepEqual(h.$("scriptBox").children, []);
});

// The row below is the exact string the page produced while this code was
// still inline in static/index.html, newlines and all. The whitespace matters
// twice over: .sc-row is a grid, so a stray text node would become a cell, and
// stepping the template in with the code that holds it is the silent way to
// add one. Nothing here is worth "tidying" -- change it only when the row is
// meant to change.
const ONE_ROW =
  '<div class="sc-row" data-line="7" data-start="1" data-end="2.5">\n' +
  '    <label class="sc-n"><input class="sc-pick" type="checkbox" data-pick="7"\n' +
  '      aria-label="Choose line 7"><span>7</span></label>\n' +
  '    <div><span class="spk-chip" title="Speaker 1" aria-label="Speaker 1"><b>A</b></span></div>\n' +
  '    <div class="sc-time"><span class="sc-t-a">00:00:01.0</span><span\n' +
  '      class="sc-t-b"> – 00:00:02.5</span></div>\n' +
  '    <div class="sc-src">안녕</div>\n' +
  // Listen stands in its own column in front of the translation now, where
  // the eye already is (user, 2026-09-11).
  '    <button class="sc-listen" data-play="7" type="button"\n' +
  // The icons are written out rather than imported: a pin that reads the same
  // constant the code does could not notice the constant changing.
  '      title="Play this line in the video">' +
  '<svg class="lu lu-fill" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>' +
  '</button>\n' +
  '    <div class="sc-dst" contenteditable="plaintext-only" spellcheck="false"\n' +
  '      data-line="7">Hello</div>\n' +
  '    <div class="sc-tools"><span class="sc-len sc-v-fit"><span class="sc-dot"></span>' +
  '<span class="sc-num">1.5 / <b>1.3</b>s</span></span>' +
  '<span></span><button class="sc-wave" data-voice="7"\n' +
  '        type="button" title="Make this line\'s voice again">' +
  '<svg class="lu" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>' +
  '</button></div>\n' +
  '  </div>';

test("a row is byte for byte the row the page drew before this file existed", async (t) => {
  // 1.3s of voice, not the 1.2 it was: 1.2 of 1.5 sits exactly on the
  // "more than a fifth short" line, and a pin should not rest on a tie.
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(7, {
    start: 1, end: 2.5, slot: 1.5, estimated: 1.3, audio_sec: 1.3,
    source: "안녕", text: "Hello",
  })] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.equal(html.slice(html.indexOf('<div class="sc-row" data-line')), ONE_ROW);
  // And the header above it, indentation included.
  assert.equal(html.slice(0, html.indexOf('<div class="sc-row" data-line')),
    '\n    <div class="sc-row head">\n' +
    '      <label class="sc-h-n"><input class="sc-pick" type="checkbox" data-pick="all" aria-label="Choose every line">#</label><div class="sc-h-spk">Who</div><div class="sc-h-t">Time</div><div class="sc-h-src">Korean</div>\n' +
    '      <div class="sc-h-dst">English</div>\n' +
    '      <div class="sc-tools"><span><span class="sc-h-len">Original / Translated (s)</span><span class="sc-h-len-narrow">Length</span></span><span></span><span class="sc-h-voice">Voice</span></div>\n' +
    '    </div>\n    ');
});

test("a line the translator left untranslated says so in its own empty cell, and rests its buttons", async (t) => {
  // No words and no voice. The wide translation cell says what is missing
  // (the stylesheet draws data-empty in red while the cell is empty); the
  // length cell is left blank; play and remake are off until it is written.
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [
    line(1),
    line(2, { text: "", untranslated: true, estimated: 0, audio_sec: null, fits: false }),
  ] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  const row2 = html.slice(html.indexOf('data-start="2"'));

  // Still editable, still empty -- the mark is not in the words.
  assert.match(row2, /class="sc-dst" contenteditable="plaintext-only" spellcheck="false"\s+data-line="2" data-empty="Not translated"><\/div>/);
  assert.match(row2, /<span class="sc-len"><\/span>/);
  assert.match(row2, /class="sc-listen sc-off" data-play="2" type="button" disabled\s+title="Write the translation first"/);
  assert.match(row2, /class="sc-wave sc-off" data-voice="2"\s+type="button" disabled title="Write the translation first"/);
  // Line 1 is untouched by any of it.
  assert.equal(html.match(/data-empty|sc-off/g).length, 3);
  assert.match(html, /<span class="sc-len sc-v-fit"><span class="sc-dot"><\/span><span class="sc-num">1\.0 \/ <b>0\.9<\/b>s<\/span>/);
});

test("with no length known yet the strip is drawn to the last line's end", async (t) => {
  const h = harness({ duration: NaN,
                      responses: { [SCRIPT]: ok({ lines: [line(1), line(2)] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  assert.deepEqual(h.log.timeline, [[2, 3]], "line 2 ends at 3s");
});

test("a job with no script says so, and a Perso dub says why", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.match(h.$("scriptBox").innerHTML, /No script was recorded for this project\./);
  assert.deepEqual(h.log.timeline, [[0, 0]], "and the strip is emptied with it");

  const p = harness({ perso: true, responses: { [SCRIPT]: () => { throw new Error("500"); } } });
  t.after(p.log.restore);
  await p.api.renderScript("j1");
  assert.match(p.$("scriptBox").innerHTML,
    /Perso dubbing arrives as a finished video, so this project has no script\./);
});

test("an answer that arrives after another job was opened changes nothing on screen", async (t) => {
  // A Perso job's script took seconds to answer; by then a local job was open,
  // and the late answer emptied its table and timeline (Windows, 2026-09-29).
  let letSlowAnswer;
  const slow = new Promise((r) => { letSlowAnswer = r; });
  const h = harness({ responses: {
    "/api/dub/jobs/slow/script": () => slow.then(() => ok({ lines: [] })),
    "/api/dub/jobs/open/script": ok({ lines: [line(1), line(2)] }),
  } });
  t.after(h.log.restore);

  const first = h.api.renderScript("slow");
  await h.api.renderScript("open");
  const shown = h.$("scriptBox").innerHTML;
  letSlowAnswer();
  await first;

  assert.equal(h.$("scriptBox").innerHTML, shown);
  assert.equal(h.log.timeline.length, 1, "the strip was drawn once, for the open job");
  assert.equal(h.api.getJobId(), "open");
});

// The length cell of line n as drawn: its own span, up to the empty revert
// slot and the voice button after it.
const lengthOf = (html, n) => html.match(new RegExp(`<div class="sc-row" data-line="${n}"`
  + '[\\s\\S]*?<div class="sc-tools">(<span class="sc-len[\\s\\S]*?</span>)<span></span><button class="sc-wave"'))[1];
const DOT = '<span class="sc-dot"></span>';

test("the length gives the slot, then the voice in bold, and what is missed: over, well short, cut -- a line that fits says no more", async (t) => {
  const len = (n, slot, sec) => line(n, { slot, estimated: sec, audio_sec: sec });
  const job = { id: "j1", result: { clipped: [{ line: 7, cut_s: 0.3 }], clipped_count: 1 } };
  const h = harness({ job, responses: { [SCRIPT]: ok({ lines: [
    len(1, 1.9, 2.5),    // 0.6 over
    len(2, 3.0, 1.6),    // 1.4 short: more than a second
    len(3, 4.7, 4.4),    // 0.3 short: inside both limits
    len(4, 6.5, 6.0),    // 0.5 short: under a second, and under a fifth (1.3)
    len(5, 10.0, 8.5),   // 1.5 short: more than a second, though under a fifth (2.0)
    len(6, 4.0, 3.1),    // 0.9 short: under a second, but 22.5% of the slot
    len(7, 2.0, 2.0),    // fits by its own numbers; the assembly cut it anyway
  ] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;

  assert.equal(lengthOf(html, 1),
    `<span class="sc-len sc-v-over">${DOT}<span class="sc-num">1.9 / <b>2.5</b>s · </span><span class="sc-diff">+0.6s</span></span>`);
  assert.equal(lengthOf(html, 2),
    `<span class="sc-len sc-v-short">${DOT}<span class="sc-num">3.0 / <b>1.6</b>s · </span><span class="sc-diff">−1.4s</span></span>`);
  assert.equal(lengthOf(html, 3), `<span class="sc-len sc-v-fit">${DOT}<span class="sc-num">4.7 / <b>4.4</b>s</span></span>`);
  assert.equal(lengthOf(html, 4), `<span class="sc-len sc-v-fit">${DOT}<span class="sc-num">6.5 / <b>6.0</b>s</span></span>`);
  assert.equal(lengthOf(html, 5),
    `<span class="sc-len sc-v-short">${DOT}<span class="sc-num">10.0 / <b>8.5</b>s · </span><span class="sc-diff">−1.5s</span></span>`);
  assert.equal(lengthOf(html, 6),
    `<span class="sc-len sc-v-short">${DOT}<span class="sc-num">4.0 / <b>3.1</b>s · </span><span class="sc-diff">−0.9s</span></span>`);
  assert.equal(lengthOf(html, 7), `<span class="sc-len sc-v-cut">${DOT}<span class="sc-num">2.0 / <b>2.0</b>s · </span>`
    + '<span class="sc-diff" title="Cut off by 0.3s">cut 0.3s</span></span>');
});

test("in Korean the unit is said once, after the voice's length, and the heading names the two numbers", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1, { slot: 1.9, estimated: 2.5, audio_sec: 2.5 })] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;

  // "Length" waits for the narrow table, which hides the two numbers.
  assert.match(html, /<span class="sc-h-len">원본 \/ 번역 \(초\)<\/span><span class="sc-h-len-narrow">길이<\/span>/);
  assert.equal(lengthOf(html, 1),
    `<span class="sc-len sc-v-over">${DOT}<span class="sc-num">1.9 / <b>2.5</b>초 · </span><span class="sc-diff">+0.6초</span></span>`);
});

// -- the fit rule, which the timeline shares ----------------------------------

test("lineOverBy forgives a hair over the slot and trusts the server before a voice exists", () => {
  assert.equal(lineOverBy({ audio_sec: 1.04, slot: 1, fits: false }), 0, "0.04s is within tolerance");
  assert.equal(lineOverBy({ audio_sec: 1.4, slot: 1, fits: true }).toFixed(1), "0.4");
  // No voice on disk: the estimate is only consulted when the server already
  // said the line does not fit.
  assert.equal(lineOverBy({ audio_sec: null, estimated: 9, slot: 1, fits: true }), 0);
  assert.equal(lineOverBy({ audio_sec: null, estimated: 9, slot: 1, fits: false }), 8);
});

test("lineVerdict: cut before anything else, then over, then short by more than a second or a fifth", () => {
  const v = (slot, sec, clipped) => lineVerdict({ line: 1, slot, estimated: sec, audio_sec: sec, fits: true }, clipped);
  assert.deepEqual(v(2, 3, new Map([[1, 0.4]])), { kind: "cut", by: 0.4 }, "cut, though it runs over as well");
  assert.equal(v(1.9, 2.5).kind, "over");
  assert.equal(v(1.9, 2.5).by.toFixed(1), "0.6");
  assert.equal(v(3, 1.6).kind, "short");
  assert.equal(v(3, 1.6).by.toFixed(1), "1.4");
  assert.deepEqual(v(5, 4), { kind: "fit", by: 0 }, "exactly a second and exactly a fifth short: neither is more");
  assert.deepEqual(v(1, 1.04), { kind: "fit", by: 0 }, "a hair over is lineOverBy's to forgive");
});

// -- editing a line -----------------------------------------------------------

/** Render a table whose one editable cell the test can type into. */
async function withCell(t, { responses = {}, text = "Hello 1" } = {}) {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1)] }), ...responses } });
  t.after(h.log.restore);
  const cell = makeCell(1, text);
  h.$("scriptBox").qs[".sc-dst[contenteditable]"] = [cell];
  await h.api.renderScript("j1");
  return { h, cell };
}

test("writing an untranslated line in saves it, and the redrawn row is an ordinary one", async (t) => {
  // The cell stays editable: typed words are saved like any edit, and the
  // table drawn again from the server has no mark and live buttons.
  let untranslated = true;
  const h = harness({ responses: {
    [SCRIPT]: () => ok({ lines: [untranslated
      ? line(2, { text: "", untranslated: true, estimated: 0, audio_sec: null, fits: false })
      : line(2, { text: "Hi there", edited: true, voice_stale: true, audio_sec: null })] }),
    "/api/dub/jobs/j1/script/2": () => { untranslated = false; return ok({}); },
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");

  const cell = makeCell(2, "");
  h.$("scriptBox").qs[".sc-dst[contenteditable]"] = [cell];
  await h.api.renderScript("j1");                     // wire the cell
  cell.textContent = "Hi there";
  await cell.fire("blur");

  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/script/2 {"text":"Hi there"}'));
  const html = h.$("scriptBox").innerHTML;
  assert.doesNotMatch(html, /data-empty|sc-off|disabled/);
  assert.match(html, /class="sc-wave stale"/);          // now waiting for its first voice
});

test("committing an edited cell saves that line's new words", async (t) => {
  const { h, cell } = await withCell(t, {
    responses: { "/api/dub/jobs/j1/script/1": ok({}) },
  });

  cell.textContent = "  Good morning  ";
  await cell.fire("blur");

  assert.deepEqual(h.log.calls.slice(1), [
    // Trimmed, and posted to the line the cell belongs to.
    'POST /api/dub/jobs/j1/script/1 {"text":"Good morning"}',
    `GET ${SCRIPT}`,   // the slot check has to be recomputed
  ]);
  assert.equal(h.$("scriptSaving").textContent, "Saved");
  h.log.runTimers();
  assert.equal(h.$("scriptSaving").textContent, "", "and the word goes away by itself");
});

test("a save the server refuses leaves the reason under the table", async (t) => {
  const { h, cell } = await withCell(t, {
    responses: { "/api/dub/jobs/j1/script/1": bad("That line is locked") },
  });

  cell.textContent = "Good morning";
  await cell.fire("blur");
  assert.equal(h.$("scriptSaving").textContent, "That line is locked");
});

test("Enter commits instead of opening a second line", async (t) => {
  const { cell } = await withCell(t);
  let prevented = false;
  await cell.fire("keydown", { key: "Enter", preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "a script line has one slot of time and cannot grow a row");
  assert.ok(cell.blurred, "and leaving the cell is what saves it");
});

test("Escape puts the words back and saves nothing", async (t) => {
  const { h, cell } = await withCell(t);

  cell.textContent = "something else";
  await cell.fire("keydown", { key: "Escape", preventDefault: () => {} });
  assert.equal(cell.textContent, "Hello 1");
  assert.ok(cell.blurred);

  // The blur that follows finds the words unchanged, so nothing is posted.
  await cell.fire("blur");
  assert.deepEqual(h.log.calls, [`GET ${SCRIPT}`]);
});

test("a cell blurred into its own revert drops the edit; another line's revert does not", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1, { edited: true }), line(2, { edited: true })] }),
    "/api/dub/jobs/j1/script/1": ok({}),
    "/api/dub/jobs/j1/script/1/revert": ok({}),
  } });
  t.after(h.log.restore);
  const cell = makeCell(1, "Hello 1");
  const box = h.$("scriptBox");
  box.qs[".sc-dst[contenteditable]"] = [cell];
  box.qs["[data-undo]"] = [makeButton("undo1", { undo: "1" }), makeButton("undo2", { undo: "2" })];
  await h.api.renderScript("j1");
  const [undo1, undo2] = box.qs["[data-undo]"];

  // Its own revert wins: the edit is dropped and the words come back, with
  // nothing saved on the way out.
  cell.textContent = "Changed";
  await undo1.fire("mousedown");
  await cell.fire("blur");
  assert.equal(cell.textContent, "Hello 1");
  assert.deepEqual(h.log.calls, [`GET ${SCRIPT}`]);
  await undo1.fire("click");
  assert.deepEqual(h.log.calls.slice(1), ["POST /api/dub/jobs/j1/script/1/revert", `GET ${SCRIPT}`]);

  // A press that slid off the button and never became a click is forgotten on
  // mouseup, so the next blur saves as it should.
  h.log.fireDoc("mouseup");
  // And another line's revert is that line's business -- this cell still saves.
  cell.textContent = "Changed";
  await undo2.fire("mousedown");
  await cell.fire("blur");
  assert.ok(h.log.calls.some((c) => c === 'POST /api/dub/jobs/j1/script/1 {"text":"Changed"}'));
});

// -- the voice button ---------------------------------------------------------

const waveOf = (html, n) => {
  const m = html.match(new RegExp(`<button class="sc-wave[^"]*" data-voice="${n}"[\\s\\S]*?</button>`));
  assert.ok(m, `line ${n} has no voice button`);
  return m[0];
};

test("the voice button wears all four of its looks", async (t) => {
  // The server's answer changes under the table, the way it really does once a
  // line has been edited again. One glyph throughout (script-same.html
  // mockup, 2026-09-29): only its colour, carried by the class, says the state.
  let lines = [line(1), line(2, { edited: true, voice_stale: true })];
  const h = harness({ responses: {
    [SCRIPT]: () => ok({ lines }),
    "/api/dub/jobs/j1/script/1/voice": ok({}),
  } });
  t.after(h.log.restore);
  const btn = makeButton("voice1", { voice: "1" });
  h.$("scriptBox").qs["[data-voice]"] = [btn];

  await h.api.renderScript("j1");
  let html = h.$("scriptBox").innerHTML;

  // 1. Never made: no state class, the plain turning arrow.
  assert.match(waveOf(html, 1), /^<button class="sc-wave" data-voice="1"/);
  assert.match(waveOf(html, 1), /title="Make this line's voice again">/);
  assert.ok(waveOf(html, 1).includes(WAVE_ICON));

  // 2. The words changed and the voice has not caught up.
  assert.match(waveOf(html, 2), /^<button class="sc-wave stale" data-voice="2"/);
  assert.match(waveOf(html, 2), /title="The words changed - make the voice again">/);
  assert.ok(waveOf(html, 2).includes(WAVE_ICON));

  // 3. Made in this sitting: green.
  await btn.fire("click");
  html = h.$("scriptBox").innerHTML;
  assert.match(waveOf(html, 1), /^<button class="sc-wave fresh" data-voice="1"/);
  assert.match(waveOf(html, 1), /title="Voice made - press to make it again">/);
  assert.ok(waveOf(html, 1).includes(WAVE_ICON));

  // 4. Made, then edited again: stale wins over the green this line still
  // carries, because green over words the voice has not said would be a lie.
  lines = [line(1, { edited: true, voice_stale: true })];
  await h.api.renderScript("j1");
  html = h.$("scriptBox").innerHTML;
  assert.match(waveOf(html, 1), /^<button class="sc-wave stale" data-voice="1"/);
  assert.ok(waveOf(html, 1).includes(WAVE_ICON));
});

test("remaking a line posts to that line's voice endpoint and rebuilds the screen around it", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/script/1/voice": ok({}),
  } });
  t.after(h.log.restore);
  const btn = makeButton("voice1", { voice: "1" });
  btn.classes.add("stale");
  h.$("scriptBox").qs["[data-voice]"] = [btn];
  await h.api.renderScript("j1");

  await btn.fire("click");

  assert.deepEqual(h.log.calls, [
    `GET ${SCRIPT}`,
    "POST /api/dub/jobs/j1/script/1/voice",
    `GET ${SCRIPT}`,     // the new voice has its own length
  ]);
  // While it turns, its stale colour is gone (turning red reads as an error)
  // and it cannot be pressed twice.
  assert.equal(btn.disabled, true);
  assert.ok(!btn.classList.contains("stale"));
  assert.equal(btn.innerHTML, WAVE_ICON);
  // The video was rebuilt in place, so the player has to go back for it.
  assert.equal(h.log.reloads, 1);
  assert.equal(h.$("scriptSaving").textContent, "Line 1 done");
  h.log.runTimers();
  assert.equal(h.$("scriptSaving").textContent, "");
});

test("a remake the server refuses says why and gives the button back", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/script/1/voice": bad("No cloned voice for this speaker."),
  } });
  t.after(h.log.restore);
  const btn = makeButton("voice1", { voice: "1" });
  h.$("scriptBox").qs["[data-voice]"] = [btn];
  await h.api.renderScript("j1");

  await btn.fire("click");

  assert.equal(h.$("scriptSaving").textContent, "No cloned voice for this speaker.");
  assert.equal(btn.disabled, false, "so it can be tried again");
  assert.equal(h.log.reloads, 0, "and the video was not rebuilt");
  // No second fetch of the script: the table on screen is still the truth.
  assert.deepEqual(h.log.calls, [`GET ${SCRIPT}`, "POST /api/dub/jobs/j1/script/1/voice"]);
});

// -- playing one line ---------------------------------------------------------

test("the play button always plays the line in the dub, not the original", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(4)] }) } });
  t.after(h.log.restore);
  const btn = makeButton("play4", { play: "4" });
  btn.row = { dataset: { start: "4", end: "5" } };
  h.$("scriptBox").qs["[data-play]"] = [btn];
  await h.api.renderScript("j1");

  await btn.fire("click");
  await Promise.resolve();   // showVideoSource answers a tick later

  assert.deepEqual(h.log.shown, ["dubbed"]);
  assert.deepEqual(h.log.played, [["doneVideo", 4, 5]]);
});

// -- what the page still asks of the table ------------------------------------

test("the table says which job it is showing, and forgets it when a new one starts", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1)] }) } });
  t.after(h.log.restore);
  assert.equal(h.api.getJobId(), null);

  await h.api.renderScript("j1");
  assert.equal(h.api.getJobId(), "j1");
  assert.equal(h.$("scriptCount").textContent, "1 lines");
  h.api.setSaving("Saving…");

  h.api.reset();
  assert.equal(h.api.getJobId(), null);
  assert.equal(h.$("scriptBox").innerHTML, "");
  assert.equal(h.$("scriptSaving").textContent, "");
  // The pane's name stops counting the old job's lines: a new project opened
  // from the top bar showed "Script 7 lines" over its empty table.
  assert.equal(h.$("scriptCount").textContent, "");
});

test("countStale counts the lines still waiting for a new voice", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");

  assert.equal(h.api.countStale(), 0);
  h.$("scriptBox").qs['.sc-dst[data-note="Words changed"]'] = [makeEl("a"), makeEl("b")];
  assert.equal(h.api.countStale(), 2);
});

test("a read-only Perso script cannot be typed into until its bar is pressed", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ readonly: true, lines: [line(1)] }),
    "/api/dub/jobs/j1/perso/materialize": ok({}),
  } });
  t.after(h.log.restore);
  const box = h.$("scriptBox");
  const cell = makeCell(1, "Hello 1");
  const wave = makeButton("voice1", { voice: "1" });
  box.qs[".sc-dst"] = [cell];
  box.qs[".sc-wave, .sc-undo"] = [wave];
  await h.api.renderScript("j1");

  assert.equal(cell.getAttribute("contenteditable"), null, "the words cannot be changed");
  assert.equal(wave.removed, true, "and there is nothing to remake");

  const bar = box.children[0];
  assert.equal(bar.className, "script-empty");
  const [note, btn] = bar.children;
  assert.equal(note.textContent, "This Perso dubbing is read-only. ");
  assert.equal(btn.textContent, "Make it editable");

  await btn.fire("click");
  assert.ok(h.log.calls.includes("POST /api/dub/jobs/j1/perso/materialize"));
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 2,
    "and the table is drawn again from the script it just fetched");
});


// -- the pane head's three buttons ---------------------------------------------

test("Translate again sends the chosen lines, changes words only and says how many changed", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1), line(2), line(3)] }),
    "/api/dub/jobs/j1/retranslate": ok({ changed: [{ line: 2, was: "Hello 2", text: "Hi 2" }] }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  // Shown for a script that can be edited, beside the pane's name.
  assert.equal(h.$("scriptActs").hidden, false);

  await h.api.retranslate("j1", [2, 3]);
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":[2,3]}'));
  assert.equal(h.$("scriptSaving").textContent, "1 line translated again");
  assert.equal(h.log.reloads, 0, "no voice was made, so the video is the one it was");
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 2, "the table is drawn again");

  // null is every line.
  await h.api.retranslate("j1", null);
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":null}'));
});

test("the Translate again button sends the ticked lines, or every line when none is ticked", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1), line(2), line(3)] }),
    "/api/dub/jobs/j1/retranslate": ok({ changed: [] }),
  } });
  t.after(h.log.restore);
  const tick = makeButton("pick3", { pick: "3" });
  tick.row = bindClassList(makeEl("row3"));
  tick.row.classList.toggle = () => {};
  h.$("scriptBox").qs[".sc-pick"] = [tick];
  await h.api.renderScript("j1");

  await h.$("retranslateBtn").fire("click");
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":null}'));
  assert.equal(h.$("scriptSaving").textContent, "Same words. Nothing changed.");

  tick.checked = true;
  await tick.listeners.change.at(-1)();
  assert.equal(h.$("scriptPickCount").textContent, "1 selected");
  await h.$("retranslateBtn").fire("click");
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":[3]}'));
});

test("Translate again asks once before it writes over lines edited by hand", async (t) => {
  let n = 0;
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1, { edited: true }), line(2)] }),
    "/api/dub/jobs/j1/retranslate": () => ok({ changed: (n += 1) === 1 ? [] : [{ line: 1, was: "Hello 1", text: "Hi 1" }] }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");

  // A line nobody edited is not asked about.
  await h.api.retranslate("j1", [2]);
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":[2]}'));

  await h.api.retranslate("j1", null);
  assert.equal(h.$("scriptSaving").textContent, "1 edited line is replaced. Press again.");
  assert.ok(!h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":null}'));
  await h.api.retranslate("j1", null);
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":null}'));

  // Its words are now the translator's, not a hand's: not asked about again.
  const before = h.log.calls.length;
  await h.api.retranslate("j1", [1]);
  assert.equal(h.log.calls[before], 'POST /api/dub/jobs/j1/retranslate {"lines":[1]}');
});

test("a Translate again the server refuses says why", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/retranslate": bad("Could not translate those lines again."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.api.retranslate("j1", [1]);
  assert.equal(h.$("scriptSaving").textContent, "Could not translate those lines again.");
  assert.equal(h.$("retranslateBtn").disabled, false);
});

// -- Translate again with the project's own translator (Windows H14) ----------

const answer = (status, detail) => ({ ok: false, status, json: async () => ({ detail }) });

test("Translate again names the translator the project was dubbed with", async (t) => {
  const h = harness({ job: { id: "j1", translator: "hunyuan" }, responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/retranslate": () => new Promise(() => {}),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  h.api.retranslate("j1", [1]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.$("scriptSaving").textContent, "Translating 1 line with Hunyuan…");
});

test("ChatGPT at its limit opens the dubbing's popup, and a pick translates the same lines with it", async (t) => {
  const h = harness({ job: { id: "j1", translator: "chatgpt" }, responses: {
    [SCRIPT]: ok({ lines: [line(1), line(2)] }),
    "/api/dub/jobs/j1/retranslate": answer(429, "ChatGPT usage limit reached. Resets Oct 24, 1:07 PM."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.api.retranslate("j1", [2]);
  assert.deepEqual(h.log.asked.notice,
    { type: "chatgpt_limit", message: "ChatGPT usage limit reached. Resets Oct 24, 1:07 PM." });
  assert.equal(h.$("scriptSaving").textContent, "");
  assert.equal(h.$("retranslateBtn").disabled, false);

  await h.log.asked.pick("gemma");
  assert.equal(h.log.calls.at(-1), 'POST /api/dub/jobs/j1/retranslate {"lines":[2],"translator":"gemma"}');
});

test("a pick in the popup is not asked about hand-edited lines a second time", async (t) => {
  const h = harness({ job: { id: "j1", translator: "chatgpt" }, responses: {
    [SCRIPT]: ok({ lines: [line(1, { edited: true })] }),
    "/api/dub/jobs/j1/retranslate": answer(429, "ChatGPT usage limit reached for now."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.api.retranslate("j1", [1]);
  await h.api.retranslate("j1", [1]);   // the second press: go ahead
  const before = h.log.calls.length;
  await h.log.asked.pick("hunyuan");
  assert.equal(h.log.calls[before], 'POST /api/dub/jobs/j1/retranslate {"lines":[1],"translator":"hunyuan"}');
});

test("signed out of ChatGPT opens the same popup", async (t) => {
  const h = harness({ job: { id: "j1", translator: "chatgpt" }, responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/retranslate": answer(422, "Sign in to ChatGPT first."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.api.retranslate("j1", null);
  assert.equal(h.log.asked.notice.type, "chatgpt_signed_out");
});

test("a translator not downloaded opens the download dialog, then translates", async (t) => {
  const missing = { missing: [{ id: "hunyuan", bytes: 1 }], total_bytes: 1, free_bytes: 9 };
  const h = harness({ job: { id: "j1", translator: "hunyuan" }, responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/retranslate": answer(409, missing),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.api.retranslate("j1", [1]);
  assert.deepEqual(h.log.needed.detail, missing);
  assert.equal(h.$("scriptSaving").textContent, "");
  const before = h.log.calls.length;
  await h.log.needed.retry();
  assert.equal(h.log.calls[before], 'POST /api/dub/jobs/j1/retranslate {"lines":[1]}');
});

// -- NIGHTINGALE: no editing line by line (Windows C14) ------------------------

test("a Nightingale dubbing says it cannot be edited line by line, with no button to try", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ readonly: true, lines: [line(1)],
                   perso_edit: { available: true, reason: "", nightingale: true,
                                 retranslate_available: null, working: null, unfetched: false } }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const bar = h.$("scriptBox").children[0];
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].textContent, "Nightingale dubbings cannot be edited line by line.");
  // Nor a speaker chip to press: a new speaker is a new voice for one line.
  assert.doesNotMatch(h.$("scriptBox").innerHTML, /data-speaker=/);
});

const changed = (n) => line(n, { voice_stale: true, edited: true });

test("Remake voices counts the changed lines, and rests without a number at none", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1), line(2)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("remakeVoicesBtn");
  assert.equal(btn.disabled, true);
  assert.equal(h.$("remakeVoicesCount").textContent, "");
  assert.ok(btn.classList.contains("btn-outline"));
  assert.equal(h.$("scriptChanged").hidden, true);
  assert.doesNotMatch(h.$("scriptBox").innerHTML, /Words changed/);
  // Not a Perso project: All at once rests, and says why.
  assert.equal(h.$("allAtOnceBtn").disabled, true);
  assert.equal(h.$("allAtOnceBtn").title, "Perso dubbing only.");
});

test("changed lines say Words changed, the strip counts them and one press remakes them all", async (t) => {
  let lines = [changed(1), line(2), changed(3)];
  const h = harness({ responses: {
    [SCRIPT]: () => ok({ lines }),
    "/api/dub/jobs/j1/voices/stale": () => { lines = [line(1), line(2), line(3)]; return ok({ remade: [1, 3], skipped: 1 }); },
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.equal(html.match(/data-note="Words changed"/g).length, 2);
  // This computer's project keeps each line's own voice button.
  assert.equal(html.match(/class="sc-wave stale"/g).length, 2);
  assert.match(html, /<span class="sc-h-voice">Voice<\/span>/);
  const btn = h.$("remakeVoicesBtn");
  assert.equal(btn.disabled, false);
  assert.ok(btn.classList.contains("btn-primary"));
  assert.equal(h.$("remakeVoicesCount").textContent, " (2)");
  assert.equal(h.$("scriptChanged").hidden, false);
  assert.equal(h.$("scriptChanged").innerHTML, "<b>2 lines changed.</b> Remake their voices to hear them.");

  await btn.fire("click");
  assert.ok(h.log.calls.includes("POST /api/dub/jobs/j1/voices/stale"), "one press, no second");
  assert.equal(h.$("scriptSaving").textContent, "2 lines remade");
  assert.equal(h.log.reloads, 1);
  assert.equal(btn.disabled, true);
  assert.equal(h.$("remakeVoicesCount").textContent, "");
  assert.equal(h.$("scriptChanged").hidden, true);
});

test("one changed line reads in the singular", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [changed(1), line(2)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.equal(h.$("remakeVoicesCount").textContent, " (1)");
  assert.equal(h.$("scriptChanged").innerHTML, "<b>1 line changed.</b> Remake its voice to hear it.");
});

test("a Remake voices the server refuses says why and gives the button back", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [changed(1)] }),
    "/api/dub/jobs/j1/voices/stale": bad("The voice engine is not running. Quit and reopen PersoDub."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.$("remakeVoicesBtn").fire("click");
  assert.equal(h.$("scriptSaving").textContent, "The voice engine is not running. Quit and reopen PersoDub.");
  assert.equal(h.$("remakeVoicesBtn").disabled, false);
  assert.equal(h.log.reloads, 0);
});


// -- a Perso dub: its voices are Perso's to remake ----------------------------

const PERSO_ON = { available: true, reason: "", nightingale: null,
                   retranslate_available: null, working: null, unfetched: false };
const LIVE = "/api/dub/jobs/j1/perso/edit";
const ASK = `${LIVE}?price=1`;
const asks = (h) => h.log.calls.filter((c) => c === `GET ${ASK}`).length;
const CONFIRM = '{"confirm":true}';
// Everything already queued gets its turn, the held timers included.
const settle = async (h) => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((done) => setImmediate(done));
    h.log.runTimers();
  }
};

test("a Perso project's lines have no voice button, and its strip says to remake when done", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1), line(2), changed(3)], perso_edit: PERSO_ON }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.doesNotMatch(html, /sc-wave/);
  assert.doesNotMatch(html, /sc-h-voice/);
  assert.equal(html.match(/data-note="Words changed"/g).length, 2);
  // Revert sits where the voice button was, at the row's end.
  assert.match(html, /<span class="sc-len[^"]*">[^]*?<\/span><span><\/span><button class="sc-undo" data-undo="1"/);
  assert.equal(h.$("remakeVoicesCount").textContent, " (2)");
  assert.equal(h.$("scriptChanged").innerHTML, "<b>2 lines changed.</b> Remake voices when you are done.");
  assert.equal(h.$("allAtOnceBtn").disabled, false);
  assert.equal(h.$("allAtOnceBtn").title, "Translation and voices.");
  assert.deepEqual(h.$("scriptBox").children, [], "and no bar over the table");
  assert.equal(h.api.countStale(), 0);
});

test("Remake voices on a Perso project asks twice, names no price, and sends every changed line", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1), line(2), changed(3)],
                   perso_edit: { ...PERSO_ON, nightingale: false } }),
    "/api/dub/jobs/j1/perso/script/1/voice": ok({ credits: 2 }),
    "/api/dub/jobs/j1/perso/script/3/voice": ok({ credits: 1 }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("remakeVoicesBtn");
  await btn.fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso remakes 2 lines. Press again.");
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")), "the first press spends nothing");
  await btn.fire("click");
  // changed_only: a line the agent voiced meanwhile is not sent again.
  const sent = '{"confirm":true,"changed_only":true}';
  assert.ok(h.log.calls.includes(`POST /api/dub/jobs/j1/perso/script/1/voice ${sent}`));
  assert.ok(h.log.calls.includes(`POST /api/dub/jobs/j1/perso/script/3/voice ${sent}`));
  assert.equal(h.$("scriptSaving").textContent, "2 lines remade. 3 credits used.");
  assert.equal(h.log.reloads, 1);
});

test("a line Perso reworded says so under it, with the user's words on hover", async (t) => {
  // Perso cannot be told to keep the words as sent (night test 2026-10-01).
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1, { text: "Indeed, there are countless ways.", edited: true,
                                     reworded: 'There are "many" ways.' }), line(2)],
                   perso_edit: { ...PERSO_ON, nightingale: false } }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.match(html, /data-note="Perso reworded this line\." title="You wrote: There are &quot;many&quot; ways\."/);
  assert.equal(html.match(/data-note=/g).length, 1);
  // Revert, the way back, is on that line.
  assert.match(html, /data-undo="1"/);
  // Not a line waiting for its voice: Remake voices rests.
  assert.equal(h.$("remakeVoicesCount").textContent, "");
});

test("what Perso refuses part way is said, and the lines it did voice are drawn", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1), changed(2)], perso_edit: { ...PERSO_ON, nightingale: false } }),
    "/api/dub/jobs/j1/perso/script/1/voice": ok({}),
    "/api/dub/jobs/j1/perso/script/2/voice": bad("Perso credits are used up. Recharge to continue."),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.$("remakeVoicesBtn").fire("click");
  await h.$("remakeVoicesBtn").fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso credits are used up. Recharge to continue.");
  assert.equal(h.log.reloads, 1);
  assert.equal(h.$("remakeVoicesBtn").disabled, false);
});

test("a Perso voice that cannot remake one line sends Remake voices to All at once", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1)], perso_edit: { ...PERSO_ON, nightingale: true } }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await h.$("remakeVoicesBtn").fire("click");
  await h.$("remakeVoicesBtn").fire("click");
  assert.equal(h.$("scriptSaving").textContent,
    "This Perso voice remakes every line together. Use All at once.");
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")));
});

test("Translate again on a Perso project is Perso's, with no warning and no voice made", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    "/api/dub/jobs/j1/retranslate": () => new Promise(() => {}),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  h.api.retranslate("j1", [1]);
  await new Promise((done) => setImmediate(done));
  assert.ok(h.log.calls.includes('POST /api/dub/jobs/j1/retranslate {"lines":[1]}'));
  assert.equal(h.$("scriptSaving").textContent, "Translating 1 line with Perso…");
});

test("a Perso dub's speaker chip is a button; a second press changes that line's speaker", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j1/perso/speaker": ok({ line: 1, old_speaker: 0, new_speaker: 1 }),
  } });
  t.after(h.log.restore);
  const btn = makeButton("spk1", { speaker: "1" });
  h.$("scriptBox").qs["[data-speaker]"] = [btn];
  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.match(html, /<button type="button" class="spk-chip" data-speaker="1"/);

  await btn.fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso gives line 1 a new voice. Uses credits. Press again.");
  assert.deepEqual(h.log.calls, [`GET ${SCRIPT}`], "the first press spends nothing");

  await btn.fire("click");
  assert.deepEqual(h.log.calls.slice(1), [
    `POST /api/dub/jobs/j1/perso/speaker {"line":1}`,
    `GET ${SCRIPT}`,
  ]);
  assert.equal(h.$("scriptSaving").textContent, "Line 1 done");
  assert.equal(h.log.reloads, 1);
});

test("a Perso dub voiced on this computer is edited like this computer's own", async (t) => {
  const reason = "A voice in this job was made on this computer, so it is no longer edited through Perso.";
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)],
                   perso_edit: { ...PERSO_ON, available: false, reason } }),
    "/api/dub/jobs/j1/script/1/voice": ok({}),
  } });
  t.after(h.log.restore);
  const btn = makeButton("voice1", { voice: "1" });
  const box = h.$("scriptBox");
  box.qs["[data-voice]"] = [btn];
  await h.api.renderScript("j1");

  assert.match(box.innerHTML, /class="sc-wave" data-voice="1"/, "its lines keep their voice button");
  assert.equal(h.$("allAtOnceBtn").disabled, true);
  assert.equal(h.$("allAtOnceBtn").title, "Perso dubbing only.");
  await btn.fire("click");
  assert.ok(h.log.calls.includes("POST /api/dub/jobs/j1/script/1/voice"));
});

test("All at once says what it costs, starts on the second press and draws what comes back", async (t) => {
  let live = { ...PERSO_ON, retranslate_available: true, error: null };
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [LIVE]: () => ok(live),
    "/api/dub/jobs/j1/perso/proofread": () => {
      live = { ...live, working: "proofread" };
      return ok({ started: true, fetch_only: false });
    },
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  const note = h.$("scriptSaving");

  await btn.fire("click");
  assert.equal(note.textContent, "Perso redoes every line. Uses credits. Press again.");
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")), "the first press spends nothing");

  const going = btn.fire("click");
  await settle(h);
  assert.ok(h.log.calls.includes(`POST /api/dub/jobs/j1/perso/proofread ${CONFIRM}`));
  assert.equal(note.textContent, "Perso is redoing every line…");
  assert.equal(btn.disabled, true);
  assert.equal(h.log.reloads, 0, "nothing is drawn while Perso works");

  live = { ...live, working: null };
  await settle(h);
  await going;
  assert.equal(h.log.reloads, 1);
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 2);
});

test("All at once on a project Perso has nothing to go over says so and spends nothing", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [LIVE]: ok({ ...PERSO_ON, retranslate_available: false, error: null }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  await btn.fire("click");
  await btn.fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso has nothing to redo yet.");
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")));
  assert.equal(btn.disabled, false);
});

// -- what Perso says when the script is opened --------------------------------

test("a project Perso has nothing to redo in dims All at once once the script is open", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [ASK]: ok({ ...PERSO_ON, nightingale: false, retranslate_available: false, error: null }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  // The table is drawn before Perso answers.
  assert.equal(btn.disabled, false);
  await settle(h);
  assert.equal(btn.disabled, true);
  assert.equal(btn.title, "Translation and voices.");
  // Drawn again within minutes: Perso is not asked twice.
  await h.api.renderScript("j1");
  await settle(h);
  assert.equal(asks(h), 1);
  assert.equal(btn.disabled, true);
});

test("a project Perso can redo keeps All at once, and the press names the price", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [ASK]: ok({ ...PERSO_ON, nightingale: false, retranslate_available: true,
                error: null, proofread_price: 42 }),
    [LIVE]: ok({ ...PERSO_ON, nightingale: false, retranslate_available: true, error: null }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  await settle(h);
  assert.equal(btn.disabled, false);
  assert.equal(btn.title, "Translation and voices.");
  await btn.fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso redoes every line. Uses 42 credits. Press again.");
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")));
});

test("All at once Perso prices at nothing says Free", async (t) => {
  const live = { ...PERSO_ON, nightingale: true, retranslate_available: true, error: null };
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [ASK]: ok({ ...live, proofread_price: 0 }),
    [LIVE]: ok(live),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await settle(h);
  await h.$("allAtOnceBtn").fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso redoes every line. Free. Press again.");
});

test("a price Perso did not give keeps the old words", async (t) => {
  const live = { ...PERSO_ON, nightingale: true, retranslate_available: true, error: null };
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [ASK]: ok({ ...live, proofread_price: null }),
    [LIVE]: ok(live),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await settle(h);
  await h.$("allAtOnceBtn").fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Perso redoes every line. The first time is free. Press again.");
});

test("while Perso has not answered, or could not be asked, All at once stays as it was", async (t) => {
  for (const answer of [() => new Promise(() => {}), bad("Could not reach Perso."),
                        () => { throw new Error("offline"); }]) {
    const h = harness({ perso: true, responses: {
      [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
      [ASK]: answer,
    } });
    await h.api.renderScript("j1");
    await settle(h);
    assert.equal(h.$("allAtOnceBtn").disabled, false);
    assert.equal(h.$("scriptSaving").textContent, "");
    h.log.restore();
  }
});

test("a line edited or reverted has Perso asked again", async (t) => {
  let can = false;
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [ASK]: () => ok({ ...PERSO_ON, nightingale: true, retranslate_available: can, error: null }),
    "/api/dub/jobs/j1/script/1": ok({}),
    "/api/dub/jobs/j1/script/1/revert": ok({}),
  } });
  t.after(h.log.restore);
  const cell = makeCell(1, "Hello 1");
  const undo = makeButton("undo1", { undo: "1" });
  h.$("scriptBox").qs[".sc-dst[contenteditable]"] = [cell];
  h.$("scriptBox").qs["[data-undo]"] = [undo];
  await h.api.renderScript("j1");
  await settle(h);
  assert.equal(h.$("allAtOnceBtn").disabled, true);

  can = true;
  cell.textContent = "Hello again";
  await cell.fire("blur");
  await settle(h);
  assert.equal(asks(h), 2);
  assert.equal(h.$("allAtOnceBtn").disabled, false);

  // The fake box hands every drawing the same nodes, so only the last
  // listener is the page's.
  await undo.listeners.click.at(-1)();
  await settle(h);
  assert.equal(asks(h), 3);
});

test("a NIGHTINGALE project with new words waiting keeps All at once whatever Perso says", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1)], perso_edit: PERSO_ON }),
    [ASK]: ok({ ...PERSO_ON, nightingale: true, retranslate_available: false, error: null }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  await settle(h);
  assert.equal(h.$("allAtOnceBtn").disabled, false);
});

test("All at once with changed lines Perso has not voiced says to remake them first and spends nothing", async (t) => {
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [changed(1), line(2), changed(3)], perso_edit: PERSO_ON }),
    [LIVE]: ok({ ...PERSO_ON, nightingale: false, retranslate_available: false, error: null }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  await btn.fire("click");
  await btn.fire("click");
  assert.equal(h.$("scriptSaving").textContent, "2 lines changed. Remake voices first.");
  assert.equal(btn.disabled, false);
  assert.ok(!h.log.calls.some((c) => c.startsWith("POST")));
});

test("an All at once that failed says what Perso said", async (t) => {
  let live = { ...PERSO_ON, retranslate_available: true, error: null };
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)], perso_edit: PERSO_ON }),
    [LIVE]: () => ok(live),
    "/api/dub/jobs/j1/perso/proofread": () => {
      live = { ...live, error: "Perso credits are used up. Recharge to continue." };
      return ok({ started: true });
    },
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const btn = h.$("allAtOnceBtn");
  await btn.fire("click");
  const going = btn.fire("click");
  await settle(h);
  await going;
  assert.equal(h.$("scriptSaving").textContent, "Perso credits are used up. Recharge to continue.");
  assert.equal(btn.disabled, false);
  assert.equal(h.log.reloads, 0);
});

test("an All at once under way when the script is opened is waited for", async (t) => {
  let live = { ...PERSO_ON, working: "proofread", error: null };
  const h = harness({ perso: true, responses: {
    [SCRIPT]: () => ok({ lines: [line(1)],
                         perso_edit: { ...PERSO_ON, available: false, working: live.working } }),
    [LIVE]: () => ok(live),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.equal(h.$("scriptSaving").textContent, "Perso is redoing every line…");
  assert.equal(h.$("allAtOnceBtn").disabled, true);
  assert.doesNotMatch(h.$("scriptBox").innerHTML, /sc-wave/, "still a Perso project while Perso works");
  // Drawn again while Perso works (the assistant changed a line): the new
  // drawing takes over the watch, and the result is still drawn once.
  await h.api.renderScript("j1");
  live = { ...live, working: null };
  await settle(h);
  assert.equal(h.log.reloads, 1);
});

test("an All at once asked for and never fetched says so, and the press fetches it", async (t) => {
  const reason = "Perso redid this job and the result was never fetched. Press All at once to fetch it. It is not paid for again.";
  const h = harness({ perso: true, responses: {
    [SCRIPT]: ok({ lines: [line(1)],
                   perso_edit: { ...PERSO_ON, available: false, reason, unfetched: true } }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  assert.equal(h.$("scriptSaving").textContent, reason);
  assert.equal(h.$("allAtOnceBtn").disabled, false);
});


// -- an answer that lands after another project was opened --------------------

test("a Translate again that answers after another project was opened draws nothing on it", async (t) => {
  let answer;
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1), line(2)] }),
    "/api/dub/jobs/j2/script": ok({ lines: [line(1, { text: "Other project" })] }),
    "/api/dub/jobs/j1/retranslate": () => new Promise((res) => { answer = res; }),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const late = h.api.retranslate("j1", [1]);
  await new Promise((done) => setImmediate(done));

  await h.api.renderScript("j2");
  h.$("scriptSaving").textContent = "";
  answer(ok({ changed: [{ line: 1, was: "Hello 1", text: "Hi 1" }] }));
  await late;

  assert.equal(h.api.getJobId(), "j2", "the table is still the second project's");
  assert.match(h.$("scriptBox").innerHTML, /Other project/);
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 1, "the first project's script is not fetched again");
  assert.equal(h.log.reloads, 0, "and the second project's video is left playing");
  assert.equal(h.$("scriptSaving").textContent, "", "nor does its status line speak for the first");
  assert.equal(h.$("retranslateBtn").disabled, false);
});

test("a line saved, remade or reverted after another project was opened leaves that project's table alone", async (t) => {
  const waits = {};
  const hold = (key) => () => new Promise((res) => { waits[key] = res; });
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1)] }),
    "/api/dub/jobs/j2/script": ok({ lines: [line(1, { text: "Other project" })] }),
    "/api/dub/jobs/j1/script/1": hold("save"),
    "/api/dub/jobs/j1/script/1/voice": hold("voice"),
    "/api/dub/jobs/j1/script/1/revert": hold("revert"),
  } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");
  const cell = makeCell(1, "Hello 1");
  const voice = makeButton("v1", { voice: "1" });
  const undo = makeButton("u1", { undo: "1" });
  const box = h.$("scriptBox");
  box.qs[".sc-dst[contenteditable]"] = [cell];
  box.qs["[data-voice]"] = [voice];
  box.qs["[data-undo]"] = [undo];
  await h.api.renderScript("j1");
  cell.textContent = "New words";
  const pending = [cell.fire("blur"), voice.fire("click"), undo.fire("click")];
  await new Promise((done) => setImmediate(done));

  await h.api.renderScript("j2");
  box.qs = {};
  h.$("scriptSaving").textContent = "";
  for (const key of Object.keys(waits)) waits[key](ok({}));
  await Promise.all(pending);

  assert.equal(h.api.getJobId(), "j2");
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 2, "only the two draws made while it was open");
  assert.equal(h.log.reloads, 0);
  assert.equal(h.$("scriptSaving").textContent, "");
});

test("a revert the server could not do says so in the status line", async (t) => {
  const h = harness({ responses: {
    [SCRIPT]: ok({ lines: [line(1, { edited: true })] }),
    "/api/dub/jobs/j1/script/1/revert": { ok: false, status: 500, json: async () => ({}) },
  } });
  t.after(h.log.restore);
  const box = h.$("scriptBox");
  box.qs["[data-undo]"] = [makeButton("undo1", { undo: "1" })];
  await h.api.renderScript("j1");
  await box.qs["[data-undo]"][0].fire("click");
  assert.equal(h.$("scriptSaving").textContent, "Could not revert line 1. Try again.");
});
