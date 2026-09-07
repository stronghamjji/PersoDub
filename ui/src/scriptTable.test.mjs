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
import { initScriptTableUi, lineOverBy } from "./scriptTable.mjs";
import { CHECK_ICON, REMAKE_ICON } from "./icons.mjs";

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
function harness({ responses = {}, perso = false, duration = 30 } = {}) {
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
  assert.match(html, /<div>Korean<\/div>/);
  assert.match(html, /<div>English<\/div>/);
  // Speakers are numbered in the order they first speak, and coloured by that
  // number -- the diarizer's own "SPEAKER_00" never reaches the screen.
  assert.match(html, /class="spk-chip spk-1" title="Speaker 1"/);
  assert.match(html, /class="spk-chip spk-2" title="Speaker 2"/);
  assert.doesNotMatch(html, /SPEAKER_0/);
  // Number, time, source and the editable translation.
  assert.match(html, /<div class="sc-n">1<\/div>/);
  assert.match(html, /00:00:01\.0<\/span><span\s+class="sc-t-b"> – 00:00:02\.0/);
  assert.match(html, /class="sc-src">안녕하세요</);
  assert.match(html, /class="sc-dst" contenteditable="plaintext-only"[\s\S]*?data-line="1">Hello 1</);
  // The three verdicts: fits, runs over by this much, and is this much short.
  assert.match(html, /<b>0\.9s<\/b> \/ 1\.0s · <span class="sc-fit">fits<\/span>/);
  assert.match(html, /<b>2\.4s<\/b> \/ 1\.0s · <span class="sc-over">\+1\.4s<\/span>/);
  assert.match(html, /<b>0\.2s<\/b> \/ 1\.0s · <span class="sc-under">−0\.8s<\/span>/);

  // The strip under the table draws the same lines, to the video's own length.
  assert.deepEqual(h.log.timeline, [[3, 30]]);
  assert.equal(h.log.playhead, 1);
});

// The row below is the exact string the page produced while this code was
// still inline in static/index.html, newlines and all. The whitespace matters
// twice over: .sc-row is a grid, so a stray text node would become a cell, and
// stepping the template in with the code that holds it is the silent way to
// add one. Nothing here is worth "tidying" -- change it only when the row is
// meant to change.
const ONE_ROW =
  '<div class="sc-row" data-start="1" data-end="2.5">\n' +
  '    <div class="sc-n">7</div>\n' +
  '    <div><span class="spk-chip spk-1" title="Speaker 1"><i></i><b>Speaker 1</b></span></div>\n' +
  '    <div class="sc-time"><span class="sc-t-a">00:00:01.0</span><span\n' +
  '      class="sc-t-b"> – 00:00:02.5</span></div>\n' +
  '    <div class="sc-src">안녕</div>\n' +
  '    <div>\n' +
  '      <div class="sc-dst" contenteditable="plaintext-only" spellcheck="false"\n' +
  '        data-line="7">Hello</div>\n' +
  '      <div class="sc-tools"><button class="sc-listen" data-play="7" type="button"\n' +
  // The icons are written out rather than imported: a pin that reads the same
  // constant the code does could not notice the constant changing.
  '          title="Play this line in the video">' +
  '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:currentColor;stroke-width:3;stroke-linejoin:round;margin-left:2px"><path d="M7.5 5.5v13l10.5-6.5z"/></svg>' +
  '</button>' +
  '<span class="sc-len"><b>1.2s</b> / 1.5s · <span class="sc-under">−0.3s</span></span>' +
  '<span class="sc-sp"></span><button class="sc-wave" data-voice="7"\n' +
  '          type="button" title="Make this line\'s voice again">' +
  '<svg viewBox="0 0 24 24" style="stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>' +
  '</button></div>\n' +
  '    </div>\n' +
  '  </div>';

test("a row is byte for byte the row the page drew before this file existed", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(7, {
    start: 1, end: 2.5, slot: 1.5, estimated: 1.2, audio_sec: 1.2,
    source: "안녕", text: "Hello",
  })] }) } });
  t.after(h.log.restore);

  await h.api.renderScript("j1");
  const html = h.$("scriptBox").innerHTML;
  assert.equal(html.slice(html.indexOf('<div class="sc-row" data-start')), ONE_ROW);
  // And the header above it, indentation included.
  assert.equal(html.slice(0, html.indexOf('<div class="sc-row" data-start')),
    '\n    <div class="sc-row head">\n' +
    '      <div class="sc-h-n">#</div><div class="sc-h-spk">Speaker</div><div>Time</div><div>Korean</div>\n' +
    '      <div>English</div>\n' +
    '    </div>\n    ');
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
  assert.match(h.$("scriptBox").innerHTML, /No script was recorded for this job\./);
  assert.deepEqual(h.log.timeline, [[0, 0]], "and the strip is emptied with it");

  const p = harness({ perso: true, responses: { [SCRIPT]: () => { throw new Error("500"); } } });
  t.after(p.log.restore);
  await p.api.renderScript("j1");
  assert.match(p.$("scriptBox").innerHTML,
    /Perso dubbing arrives as a finished video, so this job has no script\./);
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
  // line has been edited again.
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

  // 1. Never made: the plain circling arrow.
  assert.match(waveOf(html, 1), /^<button class="sc-wave" data-voice="1"/);
  assert.match(waveOf(html, 1), /title="Make this line's voice again">/);
  assert.ok(waveOf(html, 1).includes(REMAKE_ICON));

  // 2. The words changed and the voice has not caught up.
  assert.match(waveOf(html, 2), /^<button class="sc-wave stale" data-voice="2"/);
  assert.match(waveOf(html, 2), /title="The words changed - make the voice again">/);
  assert.ok(waveOf(html, 2).includes(REMAKE_ICON));

  // 3. Made in this sitting: green, with the tick.
  await btn.fire("click");
  html = h.$("scriptBox").innerHTML;
  assert.match(waveOf(html, 1), /^<button class="sc-wave fresh" data-voice="1"/);
  assert.match(waveOf(html, 1), /title="Voice made - press to make it again">/);
  assert.ok(waveOf(html, 1).includes(CHECK_ICON));
  assert.ok(!waveOf(html, 1).includes(REMAKE_ICON));

  // 4. Made, then edited again: stale wins over the tick this line still
  // carries, because a tick over words the voice has not said would be a lie.
  lines = [line(1, { edited: true, voice_stale: true })];
  await h.api.renderScript("j1");
  html = h.$("scriptBox").innerHTML;
  assert.match(waveOf(html, 1), /^<button class="sc-wave stale" data-voice="1"/);
  assert.ok(waveOf(html, 1).includes(REMAKE_ICON));
  assert.ok(!waveOf(html, 1).includes(CHECK_ICON));
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
  // While it turns, the button is the plain arrow -- a spinning tick reads as
  // an error -- and it cannot be pressed twice.
  assert.equal(btn.disabled, true);
  assert.ok(!btn.classList.contains("stale"));
  assert.equal(btn.innerHTML, REMAKE_ICON);
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
  h.api.setSaving("Saving…");

  h.api.reset();
  assert.equal(h.api.getJobId(), null);
  assert.equal(h.$("scriptBox").innerHTML, "");
  assert.equal(h.$("scriptSaving").textContent, "");
});

test("countStale counts the lines still waiting for a new voice", async (t) => {
  const h = harness({ responses: { [SCRIPT]: ok({ lines: [line(1)] }) } });
  t.after(h.log.restore);
  await h.api.renderScript("j1");

  assert.equal(h.api.countStale(), 0);
  h.$("scriptBox").qs[".sc-wave.stale"] = [makeEl("a"), makeEl("b")];
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
  assert.equal(note.textContent, "This Perso dub is read-only. ");
  assert.equal(btn.textContent, "Make it editable");

  await btn.fire("click");
  assert.ok(h.log.calls.includes("POST /api/dub/jobs/j1/perso/materialize"));
  assert.equal(h.log.calls.filter((c) => c === `GET ${SCRIPT}`).length, 2,
    "and the table is drawn again from the script it just fetched");
});
