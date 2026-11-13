// The timeline's cut tools before a video is dubbed, as plain sums: split at
// the playhead, delete a clip, delete what lies left or right of the playhead
// inside a clip, undo and redo -- and the two-way mapping between the
// timeline's time (the kept clips laid end to end) and the video's own time.
//
// A clip is [start, end] in seconds of the ORIGINAL video; `clips` is the
// list in play order. Clips may touch -- a split makes two that do -- which is
// why the timeline keeps its own list: the draft's ranges join touching parts
// (ui/src/draft.mjs normalizeRanges), and a split has to stay a split on
// screen. Nothing here touches the page.

// The draft drops anything shorter than this, and the server refuses it.
export const MIN_PIECE = 0.1;
// The server's floor for the whole dub.
export const MIN_TOTAL = 0.5;

const copy = (clips) => clips.map(([a, b]) => [a, b]);

/** Seconds kept in all. */
export function totalOf(clips) {
  return clips.reduce((s, [a, b]) => s + (b - a), 0);
}

/**
 * The clip a moment of the video is inside: start <= t < end, and the very
 * end of the last clip counts as inside it. -1 in a cut-away gap.
 */
export function clipIndexAt(clips, t) {
  const i = clips.findIndex(([a, b]) => t >= a && t < b);
  if (i >= 0) return i;
  const last = clips.length - 1;
  return last >= 0 && Math.abs(t - clips[last][1]) < 1e-9 ? last : -1;
}

/** Timeline time -> video time. Clamped to the kept length. */
export function keptToSource(clips, k) {
  let left = Math.max(0, k);
  for (const [a, b] of clips) {
    if (left < b - a) return a + left;
    left -= b - a;
  }
  return clips.length ? clips[clips.length - 1][1] : 0;
}

/**
 * Video time -> timeline time. A moment in a cut-away gap stands where the
 * next kept clip begins; past the last clip, at the very end.
 */
export function sourceToKept(clips, t) {
  let k = 0;
  for (const [a, b] of clips) {
    if (t < a) return k;
    if (t < b) return k + (t - a);
    k += b - a;
  }
  return k;
}

/**
 * Where playback belongs for a video at t: t itself inside a kept clip, the
 * next clip's start in a gap, null once past the last clip (stop there).
 */
export function playableFrom(clips, t) {
  for (const [a, b] of clips) {
    if (t < a) return a;
    if (t < b) return t;
  }
  return null;
}

/** Split the clip under t into two that touch. Null when t is not at least
 * MIN_PIECE inside a clip. */
export function split(clips, t) {
  const i = clipIndexAt(clips, t);
  if (i < 0) return null;
  const [a, b] = clips[i];
  if (t - a < MIN_PIECE || b - t < MIN_PIECE) return null;
  const out = copy(clips);
  out.splice(i, 1, [a, t], [t, b]);
  return out;
}

/** Take clip i out. Null when it is the last one, or too little would stay. */
export function removeClip(clips, i) {
  if (clips.length < 2 || i < 0 || i >= clips.length) return null;
  const out = copy(clips);
  out.splice(i, 1);
  return totalOf(out) >= MIN_TOTAL ? out : null;
}

// One end of the clip under t moved to t. Null when nothing would go, or too
// little would stay.
function trimAt(clips, t, side) {
  const i = clipIndexAt(clips, t);
  if (i < 0) return null;
  const [a, b] = clips[i];
  const kept = side === "left" ? [t, b] : [a, t];
  if (kept[1] - kept[0] < MIN_PIECE || kept[0] === a && kept[1] === b) return null;
  const out = copy(clips);
  out[i] = kept;
  return totalOf(out) >= MIN_TOTAL ? out : null;
}

/** Everything in the clip under t before t goes. */
export function removeLeft(clips, t) { return trimAt(clips, t, "left"); }

/** Everything in the clip under t after t goes. */
export function removeRight(clips, t) { return trimAt(clips, t, "right"); }

/** The same kept seconds, whether or not the parts were split. */
export function sameRanges(x, y) {
  return x.length === y.length && x.every(([a, b], i) =>
    Math.abs(a - y[i][0]) < 1e-6 && Math.abs(b - y[i][1]) < 1e-6);
}

/**
 * Undo and redo over whole lists of clips. `limit` steps back are kept (the
 * oldest fall off); a new change after an undo drops the steps that were
 * undone, as every editor does. `clone` is how a step is copied: a list of
 * clips by default; a timeline with more than one lane hands its own
 * (ui/src/joinCuts.mjs cloneJoin).
 */
export function createHistory(initial, limit = 100, clone = copy) {
  let past = [];
  let now = clone(initial);
  let future = [];
  return {
    current: () => clone(now),
    push(clips) {
      past.push(now);
      if (past.length > limit) past = past.slice(past.length - limit);
      now = clone(clips);
      future = [];
    },
    undo() {
      if (!past.length) return null;
      future.push(now);
      now = past.pop();
      return clone(now);
    },
    redo() {
      if (!future.length) return null;
      past.push(now);
      now = future.pop();
      return clone(now);
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
