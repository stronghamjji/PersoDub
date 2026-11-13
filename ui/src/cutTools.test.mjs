// The cut tools' sums: split, delete, delete left/right, undo/redo, and the
// mapping between timeline time and the video's own time.
// Run with: node --test ui/src/cutTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PIECE, MIN_TOTAL, totalOf, clipIndexAt, keptToSource, sourceToKept, playableFrom,
  split, removeClip, removeLeft, removeRight, sameRanges, createHistory,
} from "./cutTools.mjs";

// The mockup's own cut: ten seconds, split at 3.4 and 6.8, the middle gone.
const CUT = [[0, 3.4], [6.8, 10]];

test("the floors are the draft's and the server's", () => {
  assert.equal(MIN_PIECE, 0.1);
  assert.equal(MIN_TOTAL, 0.5);
  assert.ok(Math.abs(totalOf(CUT) - 6.6) < 1e-9);
  assert.equal(totalOf([]), 0);
});

test("the clip under a moment: start inside, end outside, the very end counts", () => {
  const clips = [[0, 2], [2, 5], [7, 9]];
  assert.equal(clipIndexAt(clips, 0), 0);
  assert.equal(clipIndexAt(clips, 1.99), 0);
  assert.equal(clipIndexAt(clips, 2), 1, "a split point belongs to the clip that starts there");
  assert.equal(clipIndexAt(clips, 6), -1, "a cut-away gap is no clip");
  assert.equal(clipIndexAt(clips, 9), 2, "the last clip's end is still the last clip");
  assert.equal(clipIndexAt(clips, 9.5), -1);
  assert.equal(clipIndexAt([], 0), -1);
});

test("timeline time and video time map both ways across a gap", () => {
  assert.equal(keptToSource(CUT, 0), 0);
  assert.equal(keptToSource(CUT, 3), 3);
  assert.ok(Math.abs(keptToSource(CUT, 3.4) - 6.8) < 1e-9, "the join lands on the next clip");
  assert.ok(Math.abs(keptToSource(CUT, 5) - 8.4) < 1e-9);
  assert.equal(keptToSource(CUT, 99), 10, "clamped to the end");
  assert.equal(keptToSource(CUT, -1), 0, "and to the start");
  assert.equal(keptToSource([], 1), 0);

  assert.equal(sourceToKept(CUT, 2), 2);
  assert.ok(Math.abs(sourceToKept(CUT, 5) - 3.4) < 1e-9, "a gap stands where the next clip begins");
  assert.ok(Math.abs(sourceToKept(CUT, 8.4) - 5) < 1e-9);
  assert.ok(Math.abs(sourceToKept(CUT, 12) - 6.6) < 1e-9, "past the end is the end");
  // Round trip at every tenth of the kept time.
  for (let k = 0; k <= 6.6; k += 0.1) {
    assert.ok(Math.abs(sourceToKept(CUT, keptToSource(CUT, k)) - k) < 1e-9);
  }
});

test("playback skips a cut-away gap and stops after the last clip", () => {
  assert.equal(playableFrom(CUT, 1), 1);
  assert.equal(playableFrom(CUT, 5), 6.8);
  assert.equal(playableFrom(CUT, 10), null);
  assert.equal(playableFrom([[2, 4]], 0), 2, "a video cut at the front starts at its first clip");
});

test("split cuts the clip under the playhead into two that touch", () => {
  assert.deepEqual(split([[0, 10]], 3.4), [[0, 3.4], [3.4, 10]]);
  assert.deepEqual(split(CUT, 8), [[0, 3.4], [6.8, 8], [8, 10]]);
  assert.equal(split(CUT, 5), null, "nothing under the playhead in a gap");
  assert.equal(split(CUT, 0.05), null, "a sliver under a tenth would be dropped");
  assert.equal(split(CUT, 3.35), null);
  assert.equal(split(CUT, 0), null, "at a clip's own start there is nothing to split");
});

test("a clip can be deleted, but never the last one or so much that under half a second is left", () => {
  const three = [[0, 3.4], [3.4, 6.8], [6.8, 10]];
  assert.deepEqual(removeClip(three, 1), [[0, 3.4], [6.8, 10]]);
  assert.equal(removeClip([[0, 10]], 0), null, "the last clip stays");
  assert.equal(removeClip([[0, 0.3], [1, 1.3]], 0), null, "0.3s would be left");
  assert.equal(removeClip(three, 5), null);
  assert.equal(removeClip(three, -1), null);
  assert.deepEqual(three, [[0, 3.4], [3.4, 6.8], [6.8, 10]], "the list it was given is left alone");
});

test("delete left and right keep the other side of the playhead inside its clip", () => {
  assert.deepEqual(removeLeft(CUT, 8), [[0, 3.4], [8, 10]]);
  assert.deepEqual(removeRight(CUT, 2), [[0, 2], [6.8, 10]]);
  assert.deepEqual(removeRight([[0, 10]], 3), [[0, 3]], "works on the only clip too");
  assert.equal(removeLeft(CUT, 0), null, "nothing left of a clip's start");
  assert.equal(removeLeft(CUT, 5), null, "nothing under the playhead in a gap");
  assert.equal(removeLeft(CUT, 9.95), null, "a sliver would be left");
  assert.equal(removeRight([[0, 10]], 0.3), null, "under half a second in all");
});

test("the same seconds are the same ranges, split or not only when they match", () => {
  assert.equal(sameRanges([[0, 3.4], [6.8, 10]], [[0, 3.4], [6.8, 10]]), true);
  assert.equal(sameRanges([[0, 3]], [[0, 3.4]]), false);
  assert.equal(sameRanges([[0, 3]], [[0, 3], [4, 5]]), false);
});

test("undo and redo walk the history, and a new change drops what was undone", () => {
  const h = createHistory([[0, 10]]);
  assert.equal(h.canUndo(), false);
  assert.equal(h.undo(), null);
  h.push([[0, 3], [3, 10]]);
  h.push([[0, 3]]);
  assert.deepEqual(h.undo(), [[0, 3], [3, 10]]);
  assert.deepEqual(h.undo(), [[0, 10]]);
  assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), [[0, 3], [3, 10]]);
  assert.equal(h.canRedo(), true);
  h.push([[3, 10]]);
  assert.equal(h.canRedo(), false, "the undone step is gone");
  assert.deepEqual(h.current(), [[3, 10]]);
  // What it hands back is a copy: changing it changes nothing inside.
  h.current()[0][0] = 99;
  assert.deepEqual(h.current(), [[3, 10]]);
});

test("at least fifty steps can be undone", () => {
  const h = createHistory([[0, 100]]);
  for (let i = 1; i <= 60; i++) h.push([[0, 100 - i]]);
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, 60);
  const small = createHistory([[0, 100]], 50);
  for (let i = 1; i <= 60; i++) small.push([[0, 100 - i]]);
  n = 0;
  while (small.undo()) n++;
  assert.equal(n, 50, "the oldest fall off past the limit");
});

test("the history copies with the copier it is handed, so it can hold more than one list", () => {
  const two = (s) => ({ a: s.a.map(([x, y]) => [x, y]), n: s.n });
  const h = createHistory({ a: [[0, 10]], n: 1 }, 100, two);
  h.push({ a: [[0, 5]], n: 2 });
  assert.deepEqual(h.undo(), { a: [[0, 10]], n: 1 });
  h.current().a[0][0] = 99;
  assert.deepEqual(h.redo(), { a: [[0, 5]], n: 2 });
  assert.deepEqual(h.current(), { a: [[0, 5]], n: 2 });
});
