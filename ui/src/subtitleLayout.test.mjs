// The player is the one place a subtitle is laid out: it breaks the words
// into lines with the real font and measures the box, and the burn draws that
// (app/subtitle_ass.py takes it as `layout`). These pin the pure part -- the
// arithmetic -- with a made-up ruler where every letter is 10 wide and a
// space is 5, so the numbers can be checked by hand.
//
// Run with: node --test ui/src/subtitleLayout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wrapLines, layoutOf, SUB_FONT_STACK } from "./subtitleLayout.mjs";

const ruler = (s) => [...s].reduce((w, ch) => w + (ch === " " ? 5 : 10), 0);

test("words that fit stay on one line", () => {
  assert.deepEqual(wrapLines("ab cd", 100, ruler), ["ab cd"]);
});

test("the line breaks before the word that would not fit", () => {
  // "ab cd" = 45, "ab cd ef" = 70: room for 60 breaks before ef
  assert.deepEqual(wrapLines("ab cd ef", 60, ruler), ["ab cd", "ef"]);
});

test("a word wider than the room is broken between letters", () => {
  // Chinese and Japanese have no spaces to break at.
  assert.deepEqual(wrapLines("abcdefg", 30, ruler), ["abc", "def", "g"]);
});

test("the writer's own line breaks are kept", () => {
  assert.deepEqual(wrapLines("ab\ncd ef", 100, ruler), ["ab", "cd ef"]);
});

test("empty text is one empty line", () => {
  assert.deepEqual(wrapLines("", 100, ruler), [""]);
});

// The box: a fixed width (the user dragged the handles) or one that hugs
// the widest line, never wider than the cap. Everything in the same units
// the ruler uses; the caller turns them into em.
test("a fixed-width box keeps its width and wraps inside its padding", () => {
  const lay = layoutOf({ text: "ab cd ef", ruler, boxWidth: 70, cap: 1000,
                         padX: 5, padY: 2, lineHeight: 12 });
  // room = 70 - 2*5 = 60 -> two lines
  assert.deepEqual(lay.lines, ["ab cd", "ef"]);
  assert.equal(lay.w, 70);
  assert.equal(lay.h, 2 * 12 + 2 * 2);
});

test("a hugging box is as wide as its widest line plus padding", () => {
  const lay = layoutOf({ text: "ab cd ef", ruler, boxWidth: null, cap: 1000,
                         padX: 5, padY: 2, lineHeight: 12 });
  assert.deepEqual(lay.lines, ["ab cd ef"]);
  assert.equal(lay.w, 70 + 10);
  assert.equal(lay.h, 12 + 4);
});

test("a hugging box never passes the cap, and wraps to stay under it", () => {
  const lay = layoutOf({ text: "ab cd ef", ruler, boxWidth: null, cap: 70,
                         padX: 5, padY: 2, lineHeight: 12 });
  assert.deepEqual(lay.lines, ["ab cd", "ef"]);
  assert.equal(lay.w, 45 + 10);
});

test("the player's font stack is the burn's, in the burn's order", () => {
  // app/api/results.py picks one of these three per platform; the page lists
  // all three so the browser lands on the same one ffmpeg will use.
  assert.deepEqual(SUB_FONT_STACK, ["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR"]);
});

import { pictureRect } from "./subtitleLayout.mjs";

test("a picture that fills its element is the element", () => {
  assert.deepEqual(pictureRect({ left: 10, top: 20, width: 160, height: 90, videoWidth: 1920, videoHeight: 1080 }),
    { left: 10, top: 20, width: 160, height: 90 });
});

test("a portrait picture in a landscape element sits centred between the bars", () => {
  const r = pictureRect({ left: 0, top: 0, width: 160, height: 90, videoWidth: 1080, videoHeight: 1920 });
  assert.deepEqual([Math.round(r.left), r.top, Math.round(r.width), r.height], [55, 0, 51, 90]);
});

test("without the video's size, the element is all there is to go on", () => {
  assert.deepEqual(pictureRect({ left: 1, top: 2, width: 3, height: 4, videoWidth: 0, videoHeight: 0 }),
    { left: 1, top: 2, width: 3, height: 4 });
});
