// A video brought into a finished audio project plays as two files on one
// clock: the dubbed sound and the muted picture. Each has kept parts (its
// lane's cuts) laid end to end, and the sound alone has a speed. So there are
// three clocks:
//
//   the sound's own time     where the sound file is; the script lines live here
//   the picture's own time   where the picture file is
//   joined time              seconds into the joined video
//
// The joined video is as long as what is kept of the picture. Sound that runs
// out before that leaves a tail the picture plays alone; sound that would run
// past it is cut there. These are the same rules the built file follows
// (app/media.py join_video).
//
// Pure arithmetic: ui/src/joinPlayer.mjs applies it to the two elements.
import { keptToSource, sourceToKept, playableFrom, totalOf } from "./cutTools.mjs";

/**
 * @typedef {{video: number[][], audio: number[][], tempo: number}} Join
 *   each lane's kept ranges in its own file's seconds, and the sound's speed
 */

// How far the picture may be from where it belongs before it is moved there
// rather than hurried or held back, in seconds.
export const SEEK_AT = 0.15;
// Closer than this it is left alone: about a frame.
export const NUDGE_AT = 0.04;
// How much faster or slower it plays to close a small gap.
const NUDGE = 0.08;

/** How long the joined video is: what is kept of the picture. */
export function joinedEnd(join) {
  return totalOf(join.video);
}

/** The joined time at which the sound stops: where it runs out, or the end. */
export function soundEnd(join) {
  return Math.min(totalOf(join.audio) / join.tempo, joinedEnd(join));
}

/** The sound's own time -> joined time. */
export function joinedOfSound(join, a) {
  return sourceToKept(join.audio, a) / join.tempo;
}

/** Joined time -> the sound's own time; null once there is no sound (the tail, and the end). */
export function soundAt(join, j) {
  return j < soundEnd(join) ? keptToSource(join.audio, Math.max(0, j) * join.tempo) : null;
}

/** Joined time -> the picture's own time, never past its kept end. */
export function pictureAt(join, j) {
  return keptToSource(join.video, j);
}

/**
 * The joined time right now. While there is sound it is the clock; in the
 * tail the picture is, and it never reads earlier than where the sound ended.
 */
export function joinedNow(join, { tail, sound, picture }) {
  if (!tail) return joinedOfSound(join, sound);
  return Math.max(soundEnd(join), sourceToKept(join.video, picture));
}

/**
 * What to do about a picture that is `error` seconds from where it belongs
 * (negative: behind): move it there, or play it a little faster or slower.
 */
export function correct(error) {
  const off = Math.abs(error);
  if (off > SEEK_AT) return { seek: true, rate: 1 };
  if (off <= NUDGE_AT) return { seek: false, rate: 1 };
  return { seek: false, rate: error < 0 ? 1 + NUDGE : 1 - NUDGE };
}

/**
 * One look at the two files while they play, and what to do next.
 *
 * @param {Join} join
 * @param {{tail: boolean, sound: number, soundEnded: boolean, picture: number, pictureEnded: boolean}} at
 *        where each file is, and whether it played to its own end (a file can
 *        end a hair before the length the app gave for it)
 * @returns {{tail: boolean, done: boolean, soundTo: number|null, pictureTo: number|null, rate: number}}
 *        `tail`: the picture is the clock from here. `done`: the joined video
 *        is over, stop both. `soundTo`, `pictureTo`: move that file there
 *        (over a cut-away part, or back in step). `rate`: the picture's speed.
 */
export function step(join, at) {
  const over = { tail: true, done: true, soundTo: null, pictureTo: null, rate: 1 };
  if (at.tail) {
    const p = at.pictureEnded ? null : playableFrom(join.video, at.picture);
    if (p === null) return over;
    return { tail: true, done: false, soundTo: null, pictureTo: p === at.picture ? null : p, rate: 1 };
  }
  const a = at.soundEnded ? null : playableFrom(join.audio, at.sound);
  const j = a === null ? totalOf(join.audio) / join.tempo : joinedOfSound(join, a);
  if (j >= joinedEnd(join)) return over;
  const target = pictureAt(join, j);
  const fix = correct(at.picture - target);
  return { tail: a === null, done: false, soundTo: a === null || a === at.sound ? null : a,
           pictureTo: fix.seek ? target : null, rate: fix.rate };
}
