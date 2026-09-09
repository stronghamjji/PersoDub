// The box over the subtitles, in numbers -- and every word the erase screen
// says that has a number in it. All pure: no page, no fetch, no clock.
//
// Run with: node --test ui/src/eraseArea.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_H, MIN_W, RATE, SETUP_SECONDS, clampArea, toScreen, toVideo,
         videoPerScreen, dragArea, defaultArea, isWhole, estimateSeconds,
         estimateLabel, progressLine, erasePercent, isPackMissing,
         packNeededLine, eraseView } from "./eraseArea.mjs";

// A portrait clip in a stage wider and shorter than it is: the picture is
// letterboxed down both sides, which is what the conversions have to allow for.
const FRAME = { w: 608, h: 1080 };
const STAGE = { width: 1000, height: 700 };   // the picture: 394 x 700, at x=303

// -- the box stays a box ----------------------------------------------------

test("a box is kept inside the frame", () => {
  assert.deepEqual(clampArea([-40, 200, -10, 300], FRAME.w, FRAME.h), [0, 200, 0, 300]);
  assert.deepEqual(clampArea([900, 2000, 400, 900], FRAME.w, FRAME.h),
                   [900, FRAME.h, 400, FRAME.w]);
});

test("a box too small to hold a line of writing is opened out to one", () => {
  const [y0, y1, x0, x1] = clampArea([500, 505, 100, 110], FRAME.w, FRAME.h);
  assert.equal(y1 - y0, MIN_H);
  assert.equal(x1 - x0, MIN_W);
  // And a box squeezed against the far edge grows the other way rather than
  // out of the frame.
  const bottom = clampArea([FRAME.h - 2, FRAME.h, 0, 60], FRAME.w, FRAME.h);
  assert.equal(bottom[1], FRAME.h);
  assert.equal(bottom[1] - bottom[0], MIN_H);
});

test("the numbers are whole -- the server takes pixels, not fractions", () => {
  assert.deepEqual(clampArea([10.4, 200.6, 5.5, 90.2], FRAME.w, FRAME.h), [10, 201, 6, 90]);
});

// -- frame pixels <-> screen pixels ------------------------------------------

test("the box is drawn against the picture, not the letterbox around it", () => {
  const box = toScreen([540, 648, 0, 608], STAGE, FRAME.w, FRAME.h);
  // The picture is 700 tall and 394 wide, sitting 303 from the left.
  assert.equal(Math.round(box.left), 303);
  assert.equal(Math.round(box.width), 394);
  assert.equal(Math.round(box.top), 350);       // half way down
  assert.equal(Math.round(box.height), 70);     // a tenth of the height
});

test("a box drawn on screen reads back as the same frame pixels", () => {
  const area = [614, 847, 23, 571];             // the real suggestion for clip10
  const back = toVideo(toScreen(area, STAGE, FRAME.w, FRAME.h), STAGE, FRAME.w, FRAME.h);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(back[i] - area[i]) <= 1, `${back} is not ${area}`);
  }
});

test("one screen pixel is worth a known number of frame pixels", () => {
  assert.ok(Math.abs(videoPerScreen(STAGE, FRAME.w, FRAME.h) - FRAME.h / STAGE.height) < 0.01);
  // A stage with nothing in it yet must not divide by zero.
  assert.equal(videoPerScreen({ width: 0, height: 0 }, 0, 0), 1);
});

// -- dragging ----------------------------------------------------------------

test("moving the box keeps its size and stops at the frame's edge", () => {
  const area = [800, 900, 100, 300];
  assert.deepEqual(dragArea(area, "move", 20, -50, FRAME.w, FRAME.h), [750, 850, 120, 320]);
  // Pushed past the bottom, it lands ON the bottom, still 100 tall.
  const far = dragArea(area, "move", 0, 5000, FRAME.w, FRAME.h);
  assert.deepEqual(far, [980, 1080, 100, 300]);
});

test("a corner moves its own two edges", () => {
  const area = [800, 900, 100, 300];
  assert.deepEqual(dragArea(area, "nw", -30, -40, FRAME.w, FRAME.h), [760, 900, 70, 300]);
  assert.deepEqual(dragArea(area, "se", 50, 60, FRAME.w, FRAME.h), [800, 960, 100, 350]);
});

test("a corner dragged past its opposite one does not turn the box inside out", () => {
  const area = [800, 900, 100, 300];
  const flipped = dragArea(area, "nw", 400, 400, FRAME.w, FRAME.h);
  assert.equal(flipped[1] - flipped[0], MIN_H);
  assert.equal(flipped[3] - flipped[2], MIN_W);
  assert.ok(flipped[0] < flipped[1] && flipped[2] < flipped[3]);
});

// -- the box the screen opens with -------------------------------------------

test("with no guess to offer, the box starts where subtitles are", () => {
  const [y0, y1, x0, x1] = defaultArea(FRAME.w, FRAME.h);
  assert.ok(y0 > FRAME.h * 0.7, "not in the bottom part of the frame");
  assert.ok(y1 <= FRAME.h);
  assert.ok(x0 > 0 && x1 < FRAME.w, "not the full width");
  assert.equal(x0, FRAME.w - x1, "not centred");
});

test("the whole frame is the whole frame, near enough", () => {
  assert.equal(isWhole([0, 1080, 0, 608], FRAME.w, FRAME.h), true);
  assert.equal(isWhole([20, 1070, 10, 600], FRAME.w, FRAME.h), true);
  assert.equal(isWhole([614, 847, 23, 571], FRAME.w, FRAME.h), false);
});

// -- what it will cost --------------------------------------------------------

test("the estimate is this computer's rate times the length, plus the setup", () => {
  assert.equal(estimateSeconds(10), RATE.mac * 10 + SETUP_SECONDS);
  assert.equal(estimateSeconds(10, { windows: true }), RATE.windows * 10 + SETUP_SECONDS);
  // Erasing everywhere costs more than erasing one band.
  assert.ok(estimateSeconds(10, { whole: true }) > estimateSeconds(10));
  // Nothing is promised for a length nobody knows.
  assert.equal(estimateSeconds(0), 0);
  assert.equal(estimateSeconds(NaN), 0);
});

test("the estimate is said in whole minutes, rounded up, or not at all", () => {
  assert.equal(estimateLabel(estimateSeconds(10)), "About 9 min");   // 510s
  assert.equal(estimateLabel(61), "About 2 min");
  assert.equal(estimateLabel(5), "About 1 min");                     // never "0 min"
  assert.equal(estimateLabel(0), "");
});

test("the running line counts down, and stops promising near the end", () => {
  assert.equal(progressLine(43, 510), "Erasing · 43% · 5 min left");
  assert.equal(progressLine(0, 510), "Erasing · 0% · 9 min left");
  // Under half a minute left, and at the end, it says only how far along it is.
  assert.equal(progressLine(97, 510), "Erasing · 97%");
  assert.equal(progressLine(100, 510), "Erasing · 100%");
  // A length nobody knows leaves the percentage on its own.
  assert.equal(progressLine(50, 0), "Erasing · 50%");
  // Nonsense from the server is still a percentage.
  assert.equal(progressLine(140, 0), "Erasing · 100%");
  assert.equal(progressLine(null, 0), "Erasing · 0%");
});

test("the percentage comes off the eraser's own log line", () => {
  assert.equal(erasePercent(["starting", "progress 3%", "progress 41%"]), 41);
  assert.equal(erasePercent(["separating audio 1/6"]), 0);
  assert.equal(erasePercent([]), 0);
  assert.equal(erasePercent(null), 0);
});

// -- the pack -----------------------------------------------------------------

test("only the app's own pack_missing offers the download", () => {
  assert.equal(isPackMissing({ reason: "pack_missing", status: 409 }), true);
  assert.equal(isPackMissing({ reason: "unknown", status: 500 }), false);
  assert.equal(isPackMissing(null), false);
});

test("the pack line says this computer's own size, in the app's own unit", () => {
  assert.equal(packNeededLine(3900000000), "Erase tool needed · 3.6 GB, once");
  assert.equal(packNeededLine(8500000000), "Erase tool needed · 7.9 GB, once");
  // A catalog that has not been read yet must still make a sentence.
  assert.equal(packNeededLine(0), "Erase tool needed · 0.0 GB, once");
});

// -- which face of the screen is up -------------------------------------------

test("the screen shows the drop zone until there is a video, then the box", () => {
  assert.equal(eraseView({ source: null, job: null }), "drop");
  assert.equal(eraseView({ source: { downloadId: "d1" }, job: null }), "area");
});

test("a job on its way is the running face; one with a video is the result", () => {
  const source = { downloadId: "d1" };
  for (const status of ["queued", "running", "cancelling"]) {
    assert.equal(eraseView({ source, job: { status, done: false } }), "working");
  }
  assert.equal(eraseView({ source, job: { status: "done", done: true } }), "done");
});

test("a job that stopped without a video is a failure, whatever it says", () => {
  const source = { downloadId: "d1" };
  assert.equal(eraseView({ source, job: { status: "error", done: false } }), "failed");
  assert.equal(eraseView({ source, job: { status: "cancelled", done: false } }), "failed");
  // Even "done": with no erased video there is nothing to show under a tab.
  assert.equal(eraseView({ source, job: { status: "done", done: false } }), "failed");
});
