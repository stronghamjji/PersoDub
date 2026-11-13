// The sums behind the timeline of a video brought into a finished audio
// project: each lane's cuts on a two-lane state, the speed, where the
// playhead lands after a change, where a script line lands, the pill beside
// the timeline's title, and the playhead's snap to a lane's end.
// Run with: node --test ui/src/joinCuts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPOS, SAME_WITHIN, SNAP_PX, cloneJoin, joinedLength, laneTime, applyCut, landing,
  lineSpan, audioTouched, lengthPill, snapToEnds, toSave,
} from "./joinCuts.mjs";
import { createHistory } from "./cutTools.mjs";

// 40 s of picture, 30 s of sound, nothing cut, at 1x.
const WHOLE = { video: [[0, 40]], audio: [[0, 30]], tempo: 1 };
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("the speeds are the owner's fixed steps, and the two small numbers are the lead's", () => {
  assert.deepEqual(TEMPOS, [0.5, 1, 1.5, 2, 3]);
  assert.equal(SAME_WITHIN, 0.1);
  assert.ok(SNAP_PX >= 4 && SNAP_PX <= 8, "a few pixels");
});

test("a copy of the state shares nothing with it", () => {
  const c = cloneJoin(WHOLE);
  c.video[0][1] = 1;
  c.audio.push([31, 32]);
  assert.deepEqual(WHOLE, { video: [[0, 40]], audio: [[0, 30]], tempo: 1 });
  assert.deepEqual(cloneJoin(WHOLE), WHOLE);
});

test("the strip is as long as the longer lane, the sound's length divided by its speed", () => {
  assert.equal(joinedLength(WHOLE), 40);
  assert.equal(joinedLength({ ...WHOLE, video: [[0, 10]] }), 30);
  assert.equal(joinedLength({ ...WHOLE, video: [[0, 10]], tempo: 2 }), 15);
  assert.equal(joinedLength({ ...WHOLE, video: [[0, 10]], tempo: 0.5 }), 60);
});

test("a joined moment is a moment in each lane's own file", () => {
  const s = { video: [[0, 10], [20, 40]], audio: [[0, 5], [10, 30]], tempo: 2 };
  assert.equal(laneTime(s, "video", 12), 22);
  assert.equal(laneTime(s, "video", 3), 3);
  // 4 s joined at 2x is 8 s of kept sound: 5 of the first part, 3 of the second.
  assert.equal(laneTime(s, "audio", 4), 13);
  assert.equal(laneTime(s, "audio", 999), 30, "clamped to the lane's end");
});

test("each cut acts on its own lane only and leaves the other and the speed alone", () => {
  const split = applyCut(WHOLE, "video", "split", 12);
  assert.deepEqual(split, { video: [[0, 12], [12, 40]], audio: [[0, 30]], tempo: 1 });
  assert.deepEqual(applyCut(WHOLE, "audio", "split", 12), { video: [[0, 40]], audio: [[0, 12], [12, 30]], tempo: 1 });
  assert.deepEqual(applyCut(WHOLE, "video", "left", 5), { video: [[5, 40]], audio: [[0, 30]], tempo: 1 });
  assert.deepEqual(applyCut(WHOLE, "audio", "right", 20), { video: [[0, 40]], audio: [[0, 20]], tempo: 1 });
  assert.deepEqual(applyCut(split, "video", "remove", 0), { video: [[12, 40]], audio: [[0, 30]], tempo: 1 });
  // At 2x, 6 s joined is 12 s into the sound.
  assert.deepEqual(applyCut({ ...WHOLE, tempo: 2 }, "audio", "right", 6).audio, [[0, 12]]);
  // What the per-lane sums refuse is refused here too.
  assert.equal(applyCut(WHOLE, "video", "remove", 0), null, "the last part stays");
  assert.equal(applyCut(WHOLE, "audio", "split", 30), null, "the very end is not inside a part");
  assert.equal(applyCut(WHOLE, "audio", "right", 35), null, "past the sound's end there is nothing to cut");
  assert.equal(applyCut(WHOLE, "video", "nope", 3), null);
  // The state handed in is never changed.
  assert.deepEqual(WHOLE, { video: [[0, 40]], audio: [[0, 30]], tempo: 1 });
});

test("one history holds both lanes and the speed", () => {
  const h = createHistory(WHOLE, 100, cloneJoin);
  h.push(applyCut(WHOLE, "video", "left", 5));
  h.push({ ...h.current(), tempo: 2 });
  assert.deepEqual(h.undo(), { video: [[5, 40]], audio: [[0, 30]], tempo: 1 });
  assert.deepEqual(h.undo(), WHOLE);
  assert.deepEqual(h.redo().video, [[5, 40]]);
  // A copy each time: changing what came back changes nothing held.
  h.current().video[0][0] = 99;
  assert.deepEqual(h.current().video, [[5, 40]]);
});

test("after a cut the playhead stays on the same moment of the lane that was cut", () => {
  // Delete left of 5 s on the picture: the moment that was at 5 s is now the start.
  const left = applyCut(WHOLE, "video", "left", 5);
  assert.equal(landing(WHOLE, left, "video", 5), 0);
  // A split moves nothing.
  assert.equal(landing(WHOLE, applyCut(WHOLE, "audio", "split", 12), "audio", 12), 12);
  // Twice the speed: the same word of the sound is at half the joined time.
  assert.equal(landing(WHOLE, { ...WHOLE, tempo: 2 }, "audio", 12), 6);
  // In the tail, past the sound, a speed change leaves the playhead where it is.
  assert.equal(landing(WHOLE, { ...WHOLE, tempo: 2 }, "audio", 35), 35);
  // Undo and redo say no lane: the same joined time, inside what is kept.
  assert.equal(landing(WHOLE, WHOLE, null, 12), 12);
  assert.equal(landing(WHOLE, { ...WHOLE, video: [[0, 10]] }, null, 12), 10);
  assert.equal(landing(WHOLE, WHOLE, null, -1), 0);
});

test("a line lands where its sound lands: moved by the audio lane's cuts, clipped by them, gone with them, shrunk by speed", () => {
  const s = { video: [[0, 40]], audio: [[0, 5], [10, 30]], tempo: 1 };
  assert.deepEqual(lineSpan(s, 1, 3), [1, 3], "before the cut: where it was");
  assert.deepEqual(lineSpan(s, 12, 14), [7, 9], "after it: five seconds earlier");
  assert.equal(lineSpan(s, 6, 9), null, "inside it: not drawn");
  assert.deepEqual(lineSpan(s, 4, 12), [4, 7], "across it: what is kept either side, end to end");
  assert.deepEqual(lineSpan(s, 8, 12), [5, 7], "starting in it: from where the next part begins");
  assert.deepEqual(lineSpan({ ...s, tempo: 2 }, 12, 14), [3.5, 4.5], "at 2x half as far in and half as long");
  assert.deepEqual(lineSpan(s, 28, 33), [23, 25], "past the sound's end: clipped there");
});

test("the audio lane counts as touched once it is cut or sped, not when it is only split", () => {
  assert.equal(audioTouched(WHOLE, 30), false);
  assert.equal(audioTouched({ ...WHOLE, audio: [[0, 12], [12, 30]] }, 30), false);
  assert.equal(audioTouched({ ...WHOLE, audio: [[0, 20]] }, 30), true);
  assert.equal(audioTouched({ ...WHOLE, tempo: 1.5 }, 30), true);
  // A picture cut alone leaves the sound whole.
  assert.equal(audioTouched({ ...WHOLE, video: [[5, 40]] }, 30), false);
});

test("the pill says which is longer and by how much, or that the two are the same length", () => {
  assert.deepEqual(lengthPill(WHOLE, 30),
    { kind: "warn", text: "The video is 10s longer", tip: "The last 10s play without sound." });
  assert.deepEqual(lengthPill({ ...WHOLE, video: [[0, 20]] }, 30),
    { kind: "warn", text: "The audio is 10s longer", tip: "The audio is cut where the video ends." });
  assert.deepEqual(lengthPill({ ...WHOLE, video: [[0, 92.04]], audio: [[0, 92]] }, 92),
    { kind: "ok", text: "Same length · 01:32", tip: "" });
  // A tenth either way is the same length; a hair more is not.
  assert.equal(lengthPill({ ...WHOLE, video: [[0, 30.1]] }, 30).kind, "ok");
  assert.equal(lengthPill({ ...WHOLE, video: [[0, 29.9]] }, 30).kind, "ok");
  assert.deepEqual(lengthPill({ ...WHOLE, video: [[0, 30.4]] }, 30).text, "The video is 0.4s longer");
  assert.deepEqual(lengthPill({ ...WHOLE, video: [[0, 42.36]] }, 30).text, "The video is 12.4s longer");
});

test("once the audio lane is cut or sped, the pill's tip also says the dubbed audio and script stay whole", () => {
  const note = "Cuts here go into the dubbed video only. The dubbed audio and the script stay whole.";
  assert.equal(lengthPill({ ...WHOLE, tempo: 1.5 }, 30).tip, `The last 20s play without sound. ${note}`);
  assert.equal(lengthPill({ ...WHOLE, video: [[0, 20]], audio: [[0, 25]] }, 30).tip,
    `The audio is cut where the video ends. ${note}`);
  assert.equal(lengthPill({ ...WHOLE, audio: [[0, 10], [20, 50]] }, 50).tip, note, "same length: the note alone");
  assert.equal(lengthPill({ ...WHOLE, video: [[5, 40]] }, 30).tip, "The last 5s play without sound.",
    "a picture cut alone says nothing about the sound");
});

test("the playhead snaps to either lane's end within a few pixels, and not farther", () => {
  const s = { video: [[0, 40]], audio: [[0, 30]], tempo: 1 };
  const pps = 10;   // 10 px a second: a few pixels is under a second
  assert.equal(snapToEnds(s, 29.7, pps), 30, "3 px short of the sound's end");
  assert.equal(snapToEnds(s, 30.4, pps), 30);
  assert.equal(snapToEnds(s, 39.6, pps), 40, "the picture's end too");
  assert.equal(snapToEnds(s, 28, pps), 28, "20 px off: left alone");
  // At 2x the sound ends at 15 s.
  assert.equal(snapToEnds({ ...s, tempo: 2 }, 15.3, pps), 15);
  assert.ok(near(snapToEnds(s, 29, 100), 29), "zoomed in, the same second is many pixels away");
});

test("what is saved joins the parts a split left touching, so a whole lane is sent whole", () => {
  assert.deepEqual(toSave({ video: [[0, 12], [12, 40]], audio: [[0, 30]], tempo: 1 }, 40, 30),
    { video: [[0, 40]], audio: [[0, 30]] });
  assert.deepEqual(toSave({ video: [[0, 12], [20, 40]], audio: [[0, 5], [5, 9]], tempo: 2 }, 40, 30),
    { video: [[0, 12], [20, 40]], audio: [[0, 9]] });
});
