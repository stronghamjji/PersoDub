// The finished screen's player (ui/src/donePlayer.mjs) on a paper-thin page:
// what a job new to the player clears, and what the same job keeps.
//
// Run with: node --test ui/src/donePlayer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initDonePlayer } from "./donePlayer.mjs";

function makeEl() {
  const attrs = new Map();
  return {
    dataset: {}, style: {}, hidden: false, disabled: false, title: "", innerHTML: "", textContent: "",
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    querySelectorAll: () => [],
  };
}

function harness() {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  const globals = {
    document: { body: { dataset: { screen: "done" } }, querySelectorAll: () => [] },
    ResizeObserver: class { observe() {} },
  };
  const saved = Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  Object.assign(globalThis, globals);
  const video = Object.assign(makeEl(), { paused: true, ended: false, currentTime: 0, duration: NaN,
                                          videoWidth: 0, videoHeight: 0, pause() {}, load() {},
                                          play: async () => {} });
  const state = { job: { id: "a" }, jobId: "a" };
  const player = initDonePlayer({ $, state, doneVideo: video, timeline: { paintTimeline() {} } });
  const restore = () => {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  };
  return { player, state, video, restore };
}

// renderDone asks this on every poll of a finished job; only another job may
// clear what the player holds for the one on screen.
test("a job new to the player starts on the dubbed file with no remake mark; the same job keeps both", () => {
  const { player, state, video, restore } = harness();
  try {
    assert.equal(player.openJob("a"), true, "the first job is new to the player");
    assert.equal(player.doneVideoSrc(state.job, "dubbed"), "/api/dub/result/a");
    // A line was made again: the video is fetched afresh, under a new mark.
    player.reloadDoneVideo();
    assert.equal(player.getDoneVersion(), 1);
    assert.equal(video.getAttribute("src"), "/api/dub/result/a?v=1");
    player.showVideoSource("original");
    assert.equal(player.getDoneSource(), "original");
    // The same job reported again: nothing is cleared.
    assert.equal(player.openJob("a"), false);
    assert.equal(player.getDoneVersion(), 1);
    assert.equal(player.getDoneSource(), "original");
    assert.equal(player.doneVideoSrc(state.job, "original"), "/api/dub/result/a/original?v=1");
    // Another job: back to its dubbed file, and no mark of the last job's.
    state.job = { id: "b" };
    state.jobId = "b";
    assert.equal(player.openJob("b"), true);
    assert.equal(player.getDoneVersion(), 0);
    assert.equal(player.getDoneSource(), "dubbed");
    assert.equal(player.doneVideoSrc(state.job, "dubbed"), "/api/dub/result/b");
  } finally {
    restore();
  }
});

// Leaving a job puts the player back to nothing, so the next job's own first
// look is a new one too, even when it is the job just left.
test("letting go of the player forgets the job it showed", () => {
  const { player, video, restore } = harness();
  try {
    player.openJob("a");
    player.reloadDoneVideo();
    player.releaseDoneVideo();
    assert.equal(video.getAttribute("src"), null);
    assert.equal(player.getDoneVersion(), 0);
    assert.equal(player.openJob("a"), true);
  } finally {
    restore();
  }
});

// A video with the user's own subtitles is one file: Original only, lit,
// and the player stays on the file the subtitles are drawn over.
test("a video with its own subtitles shows only the Original tab and keeps the subtitled file", () => {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  const lit = {};
  const tab = (src) => ({ dataset: { src }, addEventListener() {},
                          classList: { toggle: (c, on) => { if (c === "active") lit[src] = on; } } });
  const tabs = [tab("original"), tab("dubbed")];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { body: { dataset: { screen: "done" } }, querySelectorAll: () => tabs };
  globalThis.ResizeObserver ??= class { observe() {} };
  try {
    const video = Object.assign(makeEl(), { paused: true, currentTime: 0, pause() {}, load() {}, play: async () => {} });
    const state = { job: { id: "c", kind: "captions" }, jobId: "c" };
    const player = initDonePlayer({ $, state, doneVideo: video, timeline: { paintTimeline() {} } });
    player.openJob("c");
    assert.equal($("vtabDubbed").hidden, true, "no Dubbed tab: there is one file");
    assert.deepEqual(lit, { original: true, dubbed: false }, "Original is the one lit");
    player.showVideoSource("original");
    assert.equal(player.getDoneSource(), "dubbed", "the file the subtitles are drawn over");
    // A dubbing: both tabs, Dubbed lit, and Original goes to the original.
    state.job = { id: "d" };
    state.jobId = "d";
    player.openJob("d");
    assert.equal($("vtabDubbed").hidden, false);
    assert.deepEqual(lit, { original: false, dubbed: true });
    player.showVideoSource("original");
    assert.equal(player.getDoneSource(), "original");
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved); else delete globalThis.document;
  }
});
