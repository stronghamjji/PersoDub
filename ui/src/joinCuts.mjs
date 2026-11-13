// The timeline of a video brought into a finished audio project, as plain
// sums. The state is two lanes and a speed:
//
//   {video: [[a, b], ...], audio: [[a, b], ...], tempo}
//
// each lane's kept parts in its own file's seconds, in play order, and the
// sound's speed. On the strip both lanes start at 0 and lay their parts end to
// end in joined time (ui/src/joinClock.mjs): the picture second for second,
// the sound divided by its speed. The per-lane cuts are ui/src/cutTools.mjs's;
// this file only says which lane, and at which of that lane's own moments.
// Nothing here touches the page.
import { totalOf, keptToSource, sourceToKept, split, removeClip, removeLeft, removeRight } from "./cutTools.mjs";
import { normalizeRanges } from "./draft.mjs";
import { fmtLength } from "./format.mjs";
import { t } from "./i18n.mjs";

// The speeds the owner allows, and no others (app/api/join.py checks the same).
export const TEMPOS = [0.5, 1, 1.5, 2, 3];
// Two lanes this close in length are the same length, in seconds.
export const SAME_WITHIN = 0.1;
// A playhead dragged this close to a lane's end lands on it, in pixels, so a
// mouse can reach "same length".
export const SNAP_PX = 6;

const copy = (ranges) => ranges.map(([a, b]) => [a, b]);

/** A copy of the state that shares nothing with it (the history's copier). */
export function cloneJoin(s) {
  return { video: copy(s.video), audio: copy(s.audio), tempo: s.tempo };
}

const soundLength = (s) => totalOf(s.audio) / s.tempo;

/** How long the strip is: the longer of the two lanes. */
export function joinedLength(s) {
  return Math.max(totalOf(s.video), soundLength(s));
}

/** Joined time -> that lane's own file time, clamped to the lane's kept end. */
export function laneTime(s, lane, j) {
  return lane === "video" ? keptToSource(s.video, j) : keptToSource(s.audio, j * s.tempo);
}

/**
 * One cut on one lane: "split", "left" or "right" of joined time `arg`, or
 * "remove" part number `arg`. The new state, or null when the lane's sums
 * refuse it.
 */
export function applyCut(s, lane, op, arg) {
  const clips = s[lane];
  const at = laneTime(s, lane, arg);
  const next = op === "split" ? split(clips, at)
    : op === "left" ? removeLeft(clips, at)
    : op === "right" ? removeRight(clips, at)
    : op === "remove" ? removeClip(clips, arg)
    : null;
  return next ? { ...cloneJoin(s), [lane]: next } : null;
}

/**
 * Where the playhead goes after a change from `prev` to `next` with it at
 * joined time `j`: on the same moment of the lane that changed (as a draft
 * keeps the video's own moment), or the same joined time when no lane did
 * (undo, redo). Never past what is kept of the picture.
 */
export function landing(prev, next, lane, j) {
  let to = j;
  if (lane === "video") to = sourceToKept(next.video, keptToSource(prev.video, j));
  // In the tail there is no sound under the playhead to keep it on.
  else if (lane === "audio" && j * prev.tempo < totalOf(prev.audio)) {
    to = sourceToKept(next.audio, keptToSource(prev.audio, j * prev.tempo)) / next.tempo;
  }
  return Math.min(Math.max(0, to), totalOf(next.video));
}

/**
 * Where a script line of [start, end] in the sound's own time lands on the
 * strip, as [from, to] in joined time: moved by the audio lane's cuts, clipped
 * where it straddles one, and null when all of it was cut away.
 */
export function lineSpan(s, start, end) {
  const from = sourceToKept(s.audio, start) / s.tempo;
  const to = sourceToKept(s.audio, end) / s.tempo;
  return to - from > 1e-6 ? [from, to] : null;
}

/** The sound is cut or sped (a split alone keeps every second of it). */
export function audioTouched(s, audioSeconds) {
  return s.tempo !== 1 || totalOf(s.audio) < audioSeconds - 1e-3;
}

// Seconds the way the pill says them: a tenth at most, no trailing ".0".
const secs = (x) => String(Math.round(x * 10) / 10);

/**
 * The pill beside the timeline's title: which lane is longer and by how much,
 * or that they are the same length; on its tip, what that means for the
 * joined video, and once the sound is cut or sped, that the dubbed audio and
 * the script stay whole.
 * @returns {{kind: "warn"|"ok", text: string, tip: string}}
 */
export function lengthPill(s, audioSeconds) {
  const v = totalOf(s.video);
  const d = v - soundLength(s);
  const note = audioTouched(s, audioSeconds)
    ? t("Cuts here go into the dubbed video only. The dubbed audio and the script stay whole.") : "";
  if (Math.abs(d) <= SAME_WITHIN + 1e-9) {
    return { kind: "ok", text: t("Same length · {length}", { length: fmtLength(v) }), tip: note };
  }
  const n = secs(Math.abs(d));
  const text = d > 0 ? t("The video is {n}s longer", { n }) : t("The audio is {n}s longer", { n });
  const why = d > 0 ? t("The last {n}s play without sound.", { n }) : t("The audio is cut where the video ends.");
  return { kind: "warn", text, tip: note ? `${why} ${note}` : why };
}

/** Joined time `j`, moved onto a lane's end when it is within SNAP_PX of it at `pps`. */
export function snapToEnds(s, j, pps) {
  for (const end of [totalOf(s.video), soundLength(s)]) {
    if (Math.abs(j - end) * pps <= SNAP_PX) return end;
  }
  return j;
}

/**
 * The ranges as they are saved: touching parts joined, as a draft saves its
 * own, so a lane that was only split is sent whole (and the joined video
 * copies the picture rather than re-encoding it).
 */
export function toSave(s, videoSeconds, audioSeconds) {
  return { video: normalizeRanges(s.video, videoSeconds), audio: normalizeRanges(s.audio, audioSeconds) };
}
