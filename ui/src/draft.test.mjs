import test from "node:test";
import assert from "node:assert/strict";
import {
  getDraft, setDraft, clearDraft, setRanges, normalizeRanges,
  keptSeconds, isWhole, onDraftChange, spokenSeconds, toOriginal,
} from "./draft.mjs";

const video = { downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" };

test("a new draft keeps the whole video and is on the timeline at once", () => {
  clearDraft();
  const d = setDraft(video);
  assert.deepEqual(d.ranges, [[0, 10]]);
  assert.equal(d.onTimeline, true);
  assert.equal(isWhole(), true);
  assert.equal(keptSeconds(), 10);
});

test("a new draft tells the listeners", () => {
  clearDraft();
  const seen = [];
  const off = onDraftChange((d) => seen.push(d && d.onTimeline));
  setDraft(video);
  off();
  setDraft(video);
  assert.deepEqual(seen, [true]);
});

test("kept parts are sorted, clamped, joined, and slivers dropped", () => {
  assert.deepEqual(normalizeRanges([[4.8, 12], [0, 2.4], [2.4, 2.45], [5, 6]], 10), [[0, 2.4], [4.8, 10]]);
  assert.deepEqual(normalizeRanges([[3, 1]], 10), [[1, 3]]);
});

test("cutting the middle out leaves two parts and fewer seconds", () => {
  setDraft(video);
  setRanges([[0, 2.4], [4.8, 10]]);
  assert.equal(isWhole(), false);
  assert.ok(Math.abs(keptSeconds() - 7.6) < 1e-9);
});

test("no draft: nothing to change, nothing kept", () => {
  clearDraft();
  setRanges([[0, 1]]);
  assert.equal(getDraft(), null);
  assert.equal(keptSeconds(), 0);
});

test("a kept draft comes back on the canvas it was left on; a new one starts on the original", () => {
  assert.equal(setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" }).ratio, "original");
  assert.equal(setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v", ratio: "9:16" }).ratio, "9:16");
  clearDraft();
});

// Perso charges a dubbing by the seconds that are spoken (owner,
// 2026-10-22), so a draft that knows where its video is spoken -- Add
// language, from its dubbing's script -- counts those in what is kept.
test("the seconds spoken in the kept parts, or null for a draft no script has heard", () => {
  clearDraft();
  assert.equal(spokenSeconds(setDraft(video)), null);
  setDraft({ ...video, speech: [[1, 2.5], [4, 8]] });
  assert.equal(spokenSeconds(), 5.5);
  setRanges([[0, 2], [6, 10]]);   // 1 to 2 of the first line, 6 to 8 of the second
  assert.equal(spokenSeconds(), 3);
  clearDraft();
  assert.equal(spokenSeconds(), null);
});

test("a dubbing's lines land on the video it was cut from through the parts it kept", () => {
  // Kept 10-20 and 30-40: the dubbing's own 0-10 is 10-20 there, and 10-20 is 30-40.
  assert.deepEqual(toOriginal([[2, 5], [8, 13], [15, 18]], [[10, 20], [30, 40]]),
    [[12, 15], [18, 20], [30, 33], [35, 38]]);
  // Kept all of it: the two clocks are one.
  assert.deepEqual(toOriginal([[2, 5]], null), [[2, 5]]);
});
