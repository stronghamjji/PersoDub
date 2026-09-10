// The box the user drags over the burned-in subtitles, in numbers: where it
// sits, how it moves, how long the erase will take and what the screen says
// while it runs. No DOM and no fetch -- ui/src/eraseScreen.mjs does the
// dragging and the drawing, and ui/src/eraseArea.test.mjs pins everything here.
//
// One box, in the frame's own pixels, kept as [ymin, ymax, xmin, xmax] -- rows
// before columns, because that is the order app/api/erase.py takes it in and a
// number that changes meaning on the way to the server is a bug waiting to
// happen. The screen coordinates it is drawn at are a second thing, worked out
// afresh from the picture's rectangle every time the window changes size.
import { pictureRect } from "./subtitleLayout.mjs";
import { gb } from "./modelsUi.mjs";

// The smallest box worth erasing, in the video's own pixels: under this it
// holds no line of writing, and the erase would take the same minutes finding
// that out. Height first, as everywhere else in this file.
export const MIN_H = 24;
export const MIN_W = 48;

// How long an erase takes, per second of video, measured on this Mac and on a
// Windows machine with a GPU (2026-09-04). Plus the fixed cost of loading the
// detector, which a ten-second clip pays as surely as an hour-long one does.
export const RATE = { mac: 50, windows: 37 };
// A Windows machine with no NVIDIA card does the inpainting on the CPU. The
// same ten-second band took 7m25s with an RTX 3080 and 35m22s with the GPU
// hidden (measured 2026-09-10), and RATE.windows is the GPU figure.
export const NO_GPU_SLOWER = 4.8;
export const SETUP_SECONDS = 10;
// When the erasing is done the tool reads finished frames back looking for
// writing it missed, and spends up to a sixth of the erase doing it
// (app/scripts/erase_subtitles.py, CHECK_BUDGET). That pass was not in the
// estimate, so three runs measured on Windows came in 16-24% over what the
// screen had promised, all in the same direction (2026-09-10).
export const CHECK_SHARE_EXTRA = 1.15;
// Erasing the whole frame is inpainting everywhere rather than in one band.
export const WHOLE_EXTRA = 1.3;
// A box this close to the frame's edges IS the whole frame, near enough.
const WHOLE_AT = 0.95;

/** Keep a box inside the frame, and big enough to hold a line of writing. */
export function clampArea(area, videoW, videoH) {
  let [y0, y1, x0, x1] = area.map((v) => Math.round(v));
  y0 = Math.max(0, Math.min(y0, videoH - MIN_H));
  x0 = Math.max(0, Math.min(x0, videoW - MIN_W));
  y1 = Math.min(videoH, Math.max(y1, y0 + MIN_H));
  x1 = Math.min(videoW, Math.max(x1, x0 + MIN_W));
  return [y0, y1, x0, x1];
}

/**
 * The box in the screen's pixels, measured from the top left of the stage the
 * video is drawn in -- which is where the box element is positioned from.
 * The picture is what the box is on, not the element around it: a portrait clip
 * in a wide stage has letterbox down both sides, and a box drawn against the
 * element would sit that far to the left of the writing it is meant to cover.
 */
export function toScreen(area, stage, videoW, videoH) {
  const r = pictureRect({ left: 0, top: 0, width: stage.width, height: stage.height,
                          videoWidth: videoW, videoHeight: videoH });
  const s = videoW ? r.width / videoW : 1;
  const [y0, y1, x0, x1] = area;
  return { left: r.left + x0 * s, top: r.top + y0 * s,
           width: (x1 - x0) * s, height: (y1 - y0) * s };
}

/** The reverse: a box drawn on screen read back as frame pixels. */
export function toVideo(box, stage, videoW, videoH) {
  const r = pictureRect({ left: 0, top: 0, width: stage.width, height: stage.height,
                          videoWidth: videoW, videoHeight: videoH });
  const s = r.width ? videoW / r.width : 1;
  return clampArea([(box.top - r.top) * s, (box.top + box.height - r.top) * s,
                    (box.left - r.left) * s, (box.left + box.width - r.left) * s],
                   videoW, videoH);
}

/** How many frame pixels one screen pixel is worth, for a drag in progress. */
export function videoPerScreen(stage, videoW, videoH) {
  const r = pictureRect({ left: 0, top: 0, width: stage.width, height: stage.height,
                          videoWidth: videoW, videoHeight: videoH });
  return r.width ? videoW / r.width : 1;
}

/**
 * The box after a drag: `handle` is "move" or one of the four corners
 * ("nw", "ne", "sw", "se"), dx/dy the drag so far in FRAME pixels.
 *
 * Moving keeps the box's size and stops at the frame's edge; pulling a corner
 * moves that corner alone and stops at the smallest box worth erasing, so a
 * corner dragged past its opposite one does not turn the box inside out.
 */
export function dragArea(area, handle, dx, dy, videoW, videoH) {
  let [y0, y1, x0, x1] = area;
  if (handle === "move") {
    const h = y1 - y0, w = x1 - x0;
    const y = Math.max(0, Math.min(y0 + dy, videoH - h));
    const x = Math.max(0, Math.min(x0 + dx, videoW - w));
    return [Math.round(y), Math.round(y + h), Math.round(x), Math.round(x + w)];
  }
  if (handle[0] === "n") y0 = Math.min(y0 + dy, y1 - MIN_H); else y1 = Math.max(y1 + dy, y0 + MIN_H);
  if (handle[1] === "w") x0 = Math.min(x0 + dx, x1 - MIN_W); else x1 = Math.max(x1 + dx, x0 + MIN_W);
  return clampArea([y0, y1, x0, x1], videoW, videoH);
}

/**
 * The box the screen opens with when the app has no guess to offer -- the pack
 * is not installed yet, or the detector found no writing. The bottom fifth,
 * where subtitles are, so the first drag is a nudge rather than a drawing.
 */
export function defaultArea(videoW, videoH) {
  const boxH = Math.round(videoH * 0.18);
  const bottom = Math.round(videoH * 0.94);
  const boxW = Math.round(videoW * 0.8);
  const x0 = Math.round((videoW - boxW) / 2);
  return clampArea([bottom - boxH, bottom, x0, x0 + boxW], videoW, videoH);
}

/**
 * The line beside the minutes when the box has grown past half the frame.
 * The estimate hardly follows the box's size -- only the whole frame costs
 * more -- so the minutes alone never warn anybody that a box dragged out to
 * cover two bands will take far longer (user, 2026-09-10).
 */
export function bigBoxNote(area, videoW, videoH) {
  if (!area || !videoW || !videoH) return "";
  const [y0, y1, x0, x1] = area;
  const share = ((y1 - y0) * (x1 - x0)) / (videoW * videoH);
  return share >= 0.5 ? "Larger area, longer wait." : "";
}

/** Is this box the whole frame? (Which costs more -- see WHOLE_EXTRA.) */
export function isWhole(area, videoW, videoH) {
  const [y0, y1, x0, x1] = area;
  return (y1 - y0) >= videoH * WHOLE_AT && (x1 - x0) >= videoW * WHOLE_AT;
}

/**
 * How much of the video an erase will actually work through: the part the trim
 * handles kept, or all of it. Everything the screen promises -- the estimate,
 * the countdown -- is made from this, because a 10-second cut of a 60-second
 * video takes a sixth of the minutes.
 */
export function workLength(source) {
  if (!source) return 0;
  const t = source.trim;
  const whole = Number.isFinite(source.duration) ? source.duration : 0;
  if (!t || !Number.isFinite(t.start) || !Number.isFinite(t.end)) return whole;
  return Math.max(0, t.end - t.start);
}

/**
 * "15s of 60s" -- said on screen wherever a trim came in, because without it
 * the user has every reason to think the whole video is being erased. "" when
 * nothing was trimmed, or when the length is not known.
 */
export function trimNote(source) {
  const t = source && source.trim;
  if (!t || !source.duration) return "";
  return `${Math.round(workLength(source))}s of ${Math.round(source.duration)}s`;
}

/** How long this erase will take, in seconds. 0 when the length is unknown. */
export function estimateSeconds(durationSec, { whole = false, windows = false, noGpu = false } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const base = (windows ? RATE.windows : RATE.mac) * durationSec + SETUP_SECONDS;
  const slow = windows && noGpu ? NO_GPU_SLOWER : 1;
  return Math.round((whole ? base * WHOLE_EXTRA : base) * CHECK_SHARE_EXTRA * slow);
}

/**
 * The one line a machine with no graphics card is told before it starts, and
 * "" for every other machine. Minutes are what the top bar already promises;
 * this says why they are so many (user, 2026-09-10).
 */
export function noGpuNote(platformKey) {
  return platformKey === "win-cpu"
    ? "No graphics card found. Erasing will take about 5x longer." : "";
}

/** "About 9 min" for the top bar, or "" when there is nothing to promise. */
export function estimateLabel(seconds) {
  if (!seconds) return "";
  return `About ${Math.max(1, Math.ceil(seconds / 60))} min`;
}

/**
 * The line under the video while the erase runs: "Erasing · 43% · 4 min left".
 * The time left is the estimate less the part already done, and is dropped
 * once under half a minute is left rather than counting down to "1 min left"
 * and staying there.
 */
export function progressLine(percent, estSeconds) {
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const remaining = (estSeconds || 0) * (1 - pct / 100);
  if (remaining < 30) return `Erasing · ${pct}%`;
  return `Erasing · ${pct}% · ${Math.ceil(remaining / 60)} min left`;
}

/**
 * How far along an erase is, read out of its own log. The eraser prints one
 * "progress N%" line as it goes and nothing else the screen can count, which
 * is why a dub's stage markers (dubApi's parseProgress) say nothing here.
 */
export function erasePercent(logs) {
  let pct = 0;
  for (const line of logs || []) {
    const m = /^\s*progress (\d+)%/.exec(String(line));
    if (m) pct = Math.max(pct, parseInt(m[1], 10));
  }
  return pct;
}

/** Is this the app saying the eraser is not installed on this computer? */
export function isPackMissing(err) {
  return !!err && err.reason === "pack_missing";
}

/** The banner over the video when it is not: "Erase tool needed · 3.6 GB, once". */
export function packNeededLine(bytes) {
  return `Erase tool needed · ${gb(bytes || 0)} GB, once`;
}

/**
 * Which of the screen's faces belongs to this state: the drop zone, the box,
 * the erase running, the result, or a job that stopped without one.
 */
export function eraseView({ source, job }) {
  if (!source) return "drop";
  if (!job) return "area";
  if (["queued", "running", "cancelling"].includes(job.status)) return "working";
  return job.done ? "done" : "failed";
}
