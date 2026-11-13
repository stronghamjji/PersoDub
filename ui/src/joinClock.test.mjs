// The three clocks of a video brought into an audio project
// (ui/src/joinClock.mjs): the sound's own time, the picture's own time and
// joined time, with each lane's kept parts laid end to end.
//
// Run with: node --test ui/src/joinClock.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { joinedEnd, soundEnd, joinedOfSound, soundAt, pictureAt, joinedNow, correct, step,
         SEEK_AT, NUDGE_AT } from "./joinClock.mjs";

const whole = (video, audio, tempo = 1) => ({ video: [[0, video]], audio: [[0, audio]], tempo });
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-9, `${got} is not ${want}`);

test("with nothing cut and no speed change the three clocks are one", () => {
  const join = whole(92, 92);
  assert.equal(joinedEnd(join), 92);
  assert.equal(soundEnd(join), 92);
  assert.equal(joinedOfSound(join, 12.5), 12.5);
  assert.equal(soundAt(join, 12.5), 12.5);
  assert.equal(pictureAt(join, 12.5), 12.5);
});

test("each lane's kept parts lie end to end, so a cut on one lane moves only that lane", () => {
  // The sound keeps 0-10 and 20-30; the picture keeps 5-25.
  const join = { video: [[5, 25]], audio: [[0, 10], [20, 30]], tempo: 1 };
  assert.equal(joinedEnd(join), 20);
  assert.equal(soundEnd(join), 20);
  // 22 s into the sound file is 12 s into what is kept of it...
  assert.equal(joinedOfSound(join, 22), 12);
  assert.equal(soundAt(join, 12), 22);
  // ...and the picture is 12 s into what is kept of it, which is 17 s into its file.
  assert.equal(pictureAt(join, 12), 17);
  // A moment in the sound's cut-away gap stands where the next kept part begins.
  assert.equal(joinedOfSound(join, 15), 10);
});

test("speed is the sound's alone: twice as fast, the kept sound takes half the joined time", () => {
  const join = whole(40, 30, 2);
  assert.equal(soundEnd(join), 15);
  assert.equal(joinedEnd(join), 40, "the picture is not sped up");
  assert.equal(joinedOfSound(join, 10), 5);
  assert.equal(soundAt(join, 5), 10);
  assert.equal(pictureAt(join, 5), 5);
  // Half speed: the sound would run to 60 s, and is cut where the picture ends.
  assert.equal(soundEnd(whole(40, 30, 0.5)), 40);
});

test("after the sound ends the picture runs on alone to its own kept end", () => {
  const join = whole(40, 30);
  assert.equal(soundEnd(join), 30);
  assert.equal(joinedEnd(join), 40);
  assert.equal(soundAt(join, 29.5), 29.5);
  assert.equal(soundAt(join, 30), null, "no sound from here: the tail");
  assert.equal(soundAt(join, 35), null);
  assert.equal(pictureAt(join, 35), 35);
  assert.equal(pictureAt(join, 99), 40, "never past the picture's kept end");
  // In the tail the picture is the clock; before it, the sound is.
  assert.equal(joinedNow(join, { tail: false, sound: 12, picture: 11.9 }), 12);
  assert.equal(joinedNow(join, { tail: true, sound: 30, picture: 35 }), 35);
  // A picture not yet moved on from where the sound ended does not turn the clock back.
  assert.equal(joinedNow(join, { tail: true, sound: 30, picture: 29.9 }), 30);
});

test("sound longer than the picture is cut where the picture ends", () => {
  const join = whole(30, 40);
  assert.equal(joinedEnd(join), 30);
  assert.equal(soundEnd(join), 30);
  assert.equal(soundAt(join, 30), null);
  const s = step(join, { tail: false, sound: 30.02, soundEnded: false, picture: 30, pictureEnded: false });
  assert.equal(s.done, true, "both stop there");
});

test("the picture is nudged for a small error and moved for a large one", () => {
  assert.deepEqual(correct(0), { seek: false, rate: 1 });
  assert.deepEqual(correct(NUDGE_AT / 2), { seek: false, rate: 1 }, "within a frame: left alone");
  // Behind the sound (a negative error): a little faster. Ahead: a little slower.
  const behind = correct(-0.1), ahead = correct(0.1);
  assert.equal(behind.seek, false);
  assert.ok(behind.rate > 1 && behind.rate <= 1.1);
  assert.equal(ahead.seek, false);
  assert.ok(ahead.rate < 1 && ahead.rate >= 0.9);
  // Further out than a nudge can make up soon: moved there, at its own speed.
  assert.deepEqual(correct(-(SEEK_AT + 0.01)), { seek: true, rate: 1 });
  assert.deepEqual(correct(SEEK_AT + 0.01), { seek: true, rate: 1 });
});

test("a step while the sound plays: the picture follows, and the sound skips what is cut away", () => {
  const join = { video: [[5, 25]], audio: [[0, 10], [20, 30]], tempo: 1 };
  // In step: nothing to do.
  assert.deepEqual(step(join, { tail: false, sound: 4, soundEnded: false, picture: 9, pictureEnded: false }),
                   { tail: false, done: false, soundTo: null, pictureTo: null, rate: 1 });
  // The picture is 0.1 s behind: faster, not moved.
  const nudge = step(join, { tail: false, sound: 4, soundEnded: false, picture: 8.9, pictureEnded: false });
  assert.equal(nudge.pictureTo, null);
  assert.ok(nudge.rate > 1);
  // The sound ran into its gap: it goes to the next kept part, and the picture
  // to where that part's first moment is on its own lane.
  const skip = step(join, { tail: false, sound: 10.02, soundEnded: false, picture: 15.02, pictureEnded: false });
  assert.equal(skip.soundTo, 20);
  assert.equal(skip.pictureTo, null, "10 s into the kept sound is 15 s into the picture file: already there");
  // Far off (a line was pressed while it played): moved.
  const far = step(join, { tail: false, sound: 22, soundEnded: false, picture: 9, pictureEnded: false });
  assert.equal(far.pictureTo, 17);
  assert.equal(far.rate, 1);
});

test("a step when the sound runs out: the tail begins, and it ends at the picture's kept end", () => {
  // The picture keeps 0-10 and 20-50 (40 s); the sound is 30 s.
  const join = { video: [[0, 10], [20, 50]], audio: [[0, 30]], tempo: 1 };
  // The sound's file ended a hair before the length the app gave: still its end.
  const into = step(join, { tail: false, sound: 29.98, soundEnded: true, picture: 40, pictureEnded: false });
  assert.equal(into.tail, true);
  assert.equal(into.done, false);
  assert.equal(into.soundTo, null);
  assert.equal(into.pictureTo, null, "30 s joined is 40 s into the picture file: it runs on from there");
  // In the tail the picture is the clock: nothing is corrected...
  assert.deepEqual(step(join, { tail: true, sound: 30, soundEnded: true, picture: 45, pictureEnded: false }),
                   { tail: true, done: false, soundTo: null, pictureTo: null, rate: 1 });
  // ...and both stop at its kept end, or where its file ends.
  assert.equal(step(join, { tail: true, sound: 30, soundEnded: true, picture: 50, pictureEnded: false }).done, true);
  assert.equal(step(join, { tail: true, sound: 30, soundEnded: true, picture: 49.97, pictureEnded: true }).done, true);
});

test("in the tail the picture skips its own cut-away parts", () => {
  const join = { video: [[0, 10], [20, 50]], audio: [[0, 5]], tempo: 1 };
  const s = step(join, { tail: true, sound: 5, soundEnded: true, picture: 10.01, pictureEnded: false });
  assert.equal(s.pictureTo, 20);
  assert.equal(s.done, false);
  near(joinedNow(join, { tail: true, sound: 5, picture: 20 }), 10);
});
