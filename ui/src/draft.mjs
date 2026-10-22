// The video a new project starts from, before it is dubbed: what was
// imported (ui/src/draftImport.mjs), and which parts of it the timeline's cut tools kept. One
// draft at a time; nothing here talks to the network.

let draft = null;
const listeners = new Set();

function tell() {
  for (const fn of listeners) fn(draft);
}

/** @returns {{downloadId: string, name: string, duration: number, videoUrl: string, onTimeline: boolean, ranges: number[][], ratio: string, speech: number[][]|null}|null} */
export function getDraft() {
  return draft;
}

/** Start a draft from an imported video. `ranges` begins as the whole video.
    An imported video goes straight onto the timeline, whichever tab or way
    it came in by (mockup edit-flow, user 2026-09-30): there is no separate
    "add to timeline" step, so onTimeline is always true. `ratio` is the
    canvas a kept draft was left on (ui/src/keptDrafts.mjs). `speech` is
    where the video is spoken, [[start, end], ...] in its seconds, when a
    dubbing of it has a script (Add language); null when none has. */
export function setDraft({ downloadId, name, duration, videoUrl, ratio = "original", speech = null }) {
  draft = { downloadId, name, duration, videoUrl, onTimeline: true, ranges: [[0, duration]],
            ratio, speech };
  tell();
  return draft;
}

export function clearDraft() {
  draft = null;
  tell();
}

/**
 * The kept parts, in seconds of the original video. Sorted, clamped to the
 * video, overlapping or touching parts joined, slivers under 0.1s dropped.
 */
export function normalizeRanges(ranges, duration) {
  const kept = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(duration, Math.max(a, b))])
    .filter(([a, b]) => b - a >= 0.1)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of kept) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

export function setRanges(ranges) {
  if (!draft) return;
  draft = { ...draft, ranges: normalizeRanges(ranges, draft.duration) };
  tell();
}

/** The canvas the player shows the draft in (ui/src/ratio.mjs): "original",
    "9:16", "16:9", "1:1" or "4:5". Kept here so it goes where the draft goes;
    nothing is redrawn for it, the Ratio button paints itself. */
export function setDraftRatio(ratio) {
  if (draft) draft = { ...draft, ratio };
}

/** Seconds that will be dubbed. */
export function keptSeconds(d = draft) {
  return d ? d.ranges.reduce((s, [a, b]) => s + (b - a), 0) : 0;
}

/** Seconds of speech in the kept parts, or null when the draft does not
    know where its video is spoken (no `speech`). */
export function spokenSeconds(d = draft) {
  if (!d || !d.speech) return null;
  let s = 0;
  for (const [a, b] of d.speech) for (const [x, y] of d.ranges) s += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return s;
}

/** A dubbing's [start, end] spans on the video it was cut from: its own
    clock runs through the parts it kept (`parts`, in that video's seconds;
    null when it kept all of it), one after another. */
export function toOriginal(spans, parts) {
  if (!parts) return spans;
  const out = [];
  let at = 0;   // where this part begins on the dubbing's clock
  for (const [a, b] of parts) {
    for (const [s, e] of spans) {
      const from = Math.max(s, at), to = Math.min(e, at + b - a);
      if (to > from) out.push([a + from - at, a + to - at]);
    }
    at += b - a;
  }
  return out;
}

/** True when nothing was cut: the whole video is one kept part. */
export function isWhole(d = draft) {
  return !!d && d.ranges.length === 1 && d.ranges[0][0] === 0 && d.ranges[0][1] === d.duration;
}

/** @returns {() => void} unsubscribe */
export function onDraftChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
