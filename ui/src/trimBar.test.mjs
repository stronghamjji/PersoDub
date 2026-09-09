// The trim bar, on a paper-thin page: elements that are plain objects and a
// video that never plays. What is asserted is what the two screens depend on --
// the ids stay apart, the handles open where they are told to, and the part
// they end up on is what gets reported back.
//
// The bar's exact markup is pinned byte for byte by newProject.test.mjs, which
// is the screen that has drawn it since before this module existed.
//
// Run with: node --test ui/src/trimBar.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initTrimBar, TRIM_MIN_SPAN } from "./trimBar.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", max: "", title: "", hidden: false,
    paused: true, ended: false, currentTime: 0, clientWidth: 600,
    style: {}, listeners: {}, attrs: {},
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 contains: (c) => classes.has(c),
                 toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    getBoundingClientRect: () => ({ left: 0, width: 600 }),
    setAttribute: function (k, v) { this.attrs[k] = v; },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener: function (ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    fire: function (ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) fn(arg); },
    parentElement: null,
  };
}

function bar({ prefix = "" } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  // The playhead reads the bar it sits in through .parentElement.
  $(prefix ? "eraseTrimSel" : "trimSel").parentElement = makeEl("bar");
  const video = makeEl("video");
  const chosen = [];
  const api = initTrimBar({
    $, prefix, getVideo: () => video, getClock: () => $("clock"),
    playRange: () => Promise.resolve(), cancelRange: () => {},
    labelPx: () => 58, onChange: (t) => chosen.push(t),
  });
  return { $, api, video, chosen, els };
}

test("a bar with no prefix answers to the ids the dialog has always used", () => {
  const h = bar();
  h.api.render(30);
  assert.match(h.$("trimBox").innerHTML, /id="trimStart"/);
  assert.match(h.$("trimBox").innerHTML, /id="trimEnd"/);
  assert.equal(h.$("trimStart").value, "0");
  assert.equal(h.$("trimEnd").value, "30");
});

test("a prefixed bar keeps its own ids, so two can share one page", () => {
  const h = bar({ prefix: "erase" });
  h.api.render(30);
  assert.match(h.$("eraseTrimBox").innerHTML, /id="eraseTrimStart"/);
  assert.match(h.$("eraseTrimBox").innerHTML, /id="eraseTrimRead"/);
  // And nothing at all under the unprefixed names.
  assert.equal(h.$("trimBox").innerHTML, "");
});

test("a part chosen elsewhere is what the handles open on", () => {
  const h = bar({ prefix: "erase" });
  h.api.render(60, { start: 5, end: 15 });
  assert.equal(h.$("eraseTrimStart").value, "5");
  assert.equal(h.$("eraseTrimEnd").value, "15");
  assert.equal(h.$("eraseTrimRead").textContent,
    "00:00:05.0 – 00:00:15.0 · 10.0s of 60.0s");
  assert.deepEqual(h.chosen.at(-1), { start: 5, end: 15 });

  // A range from outside is still kept inside the video, and still long enough
  // to be one: a saved trim can outlive the file it was made on.
  const wild = bar({ prefix: "erase" });
  wild.api.render(10, { start: -4, end: 999 });
  assert.equal(wild.$("eraseTrimStart").value, "0");
  assert.equal(wild.$("eraseTrimEnd").value, "10");
  const tiny = bar({ prefix: "erase" });
  tiny.api.render(10, { start: 9.9, end: 9.9 });
  assert.equal(Number(tiny.$("eraseTrimEnd").value) - Number(tiny.$("eraseTrimStart").value),
    TRIM_MIN_SPAN);
});

test("handles parked at both ends are no trim at all", () => {
  const h = bar();
  h.api.render(30);
  assert.equal(h.chosen.at(-1), null);
  assert.equal(h.$("trimRead").textContent, "00:00:00.0 – 00:00:30.0 · 30.0s of 30.0s");

  h.$("trimEnd").value = "20";
  h.$("trimEnd").fire("input");
  assert.deepEqual(h.chosen.at(-1), { start: 0, end: 20 });
});

test("no usable length draws nothing, and letting go takes the listener off", () => {
  const h = bar();
  h.api.render(0.5);
  assert.equal(h.$("trimBox").innerHTML, "");

  h.api.render(30);
  assert.equal(h.video.listeners.timeupdate.length, 1);
  h.api.clear();
  assert.equal(h.$("trimBox").innerHTML, "");
  assert.equal(h.video.listeners.timeupdate.length, 0);
  // And a second release is not an error.
  h.api.release();
});
