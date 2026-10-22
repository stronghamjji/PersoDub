// The Captions tab draws itself from the page's subtitle state, so the tests
// hand it a paper-thin page and a view object, and read the elements back.
//
// Run with: node --test ui/src/captionsTab.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initCaptionsTab, captionsEmpty, captionsLocked, sampleWord, styleCardsHtml,
         AFTER_DUB, NO_SUBTITLES, PICK_A_LINE, LOCKED_TIP } from "./captionsTab.mjs";
import { clearDraft, setDraft } from "./draft.mjs";

const STYLES = [["clean", "Clean"], ["sticker", "Sticker"], ["black-box", "Black Box"]];

function makeEl(id) {
  const classes = new Set();
  const el = {
    id, textContent: "", hidden: false, dataset: {}, listeners: {}, attrs: {}, cards: [],
    classList: { contains: (c) => classes.has(c),
                 toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire(ev, arg) { for (const fn of this.listeners[ev] || []) fn(arg); },
    // The grid's cards, one per data-preset in whatever was written into it.
    set innerHTML(v) {
      this.html = v;
      this.cards = [...v.matchAll(/data-preset="([^"]+)"/g)].map((m) => {
        const c = makeEl("card");
        c.dataset.preset = m[1];
        return c;
      });
    },
    get innerHTML() { return this.html || ""; },
    querySelectorAll() { return this.cards; },
  };
  return el;
}

function harness(view = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const v = { screen: "done", lines: [{ text: "Hola amigos" }], jobId: "j1", preset: "clean",
              size: 100, boxed: false, scope: "all", line: 0, enabled: true, dubbed: true, ...view };
  const picked = [];
  const locks = [];
  let shown = 0;
  // The page: a press anywhere on it, and its keys.
  const doc = makeEl("document");
  const tab = initCaptionsTab({ $, styles: STYLES, getView: () => v, doc,
    onPick: (p) => picked.push(p), onShow: () => { shown++; }, setLocked: (on) => locks.push(on) });
  // A press on an element that stops it there, as the button and the panel do.
  const press = (id) => {
    const e = { stopped: false, stopPropagation() { this.stopped = true; } };
    $(id).fire("click", e);
    if (!e.stopped) doc.fire("click", e);
  };
  // A press on one look's tile in a grid.
  const pick = (grid, preset) => $(grid).fire("click", {
    target: { closest: () => ({ dataset: { preset } }) }, stopPropagation() {} });
  return { $, v, tab, picked, locks, shown: () => shown, doc, press, pick };
}

test("the tab says why it is empty: before dubbing, and with no subtitles", () => {
  assert.equal(captionsEmpty({ screen: "running", lines: 3 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "failed", lines: 0 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "draft", lines: 0 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "done", lines: 0 }), NO_SUBTITLES);
  assert.equal(captionsEmpty({ screen: "done", lines: 2 }), "");
  assert.equal(NO_SUBTITLES, "No captions for this project");
  // The video panel's button opens onto the same looks, so it is dim too,
  // with the same reason on its tip.
  const h = harness({ lines: [] });
  h.tab.paint();
  assert.equal(h.$("videoStyleBtn").disabled, true);
  assert.equal(h.$("videoStyleBtn").title, NO_SUBTITLES);
});

test("a video held as a draft beside a finished dub (the Erase tab's) leaves the tab open", () => {
  // Pressing Erase on a finished dub greyed Captions out (owner, 2026-10-14):
  // the tab took the held video for a new project.
  const h = harness();
  h.tab.paint();
  assert.equal(h.$("capMain").hidden, false);
  assert.equal(h.$("capEmpty").hidden, true);
  setDraft({ downloadId: "d", name: "a.mp4", duration: 5, videoUrl: "/v" });
  h.tab.paint();
  assert.equal(h.$("capMain").hidden, false);
  assert.deepEqual(h.locks, [false, false]);
  assert.equal(h.$("videoStyleBtn").disabled, false, "and the video panel's way to the looks with it");
  clearDraft();
  h.v.lines = [];
  h.tab.paint();
  assert.equal(h.$("capEmpty").textContent, NO_SUBTITLES);
});

test("the size reads as a percent and the Show switch follows the eye", () => {
  const h = harness({ size: 130, enabled: false });
  h.tab.paint();
  assert.equal(h.$("subSizeLv").textContent, "130%");
  assert.equal(h.$("subShow").classList.contains("on"), false);
  assert.equal(h.$("subShow").attrs["aria-checked"], "false");
  h.$("subShow").fire("click");
  assert.equal(h.shown(), 1, "the switch hands the press to the page's eye");
  h.v.enabled = true;
  h.tab.paint();
  assert.equal(h.$("subShow").attrs["aria-checked"], "true");
});

test("All lines / This line shows only for box looks, and This line needs a selection", () => {
  const h = harness();
  h.tab.paint();
  assert.equal(h.$("subScopeSeg").hidden, true);
  assert.equal(h.$("subScopeSep").hidden, true);
  assert.equal(h.$("capHint").hidden, true);
  Object.assign(h.v, { preset: "sticker", boxed: true, scope: "one" });
  h.tab.paint();
  assert.equal(h.$("subScopeSeg").hidden, false);
  assert.equal(h.$("subScopeOne").classList.contains("on"), true);
  assert.equal(h.$("subScopeAll").classList.contains("on"), false);
  assert.equal(h.$("capHint").hidden, false);
  assert.equal(h.$("capHint").textContent, PICK_A_LINE);
  h.v.line = 3;
  h.tab.paint();
  assert.equal(h.$("capHint").textContent, "Line 3", "the tab names the selected subtitle");
  h.v.scope = "all";
  h.tab.paint();
  assert.equal(h.$("capHint").hidden, true);
});

test("every look is a tile over the video's frame, the current one ringed", () => {
  const h = harness({ preset: "sticker" });
  h.tab.paint();
  const grid = h.$("subStyleMenu");
  assert.deepEqual(grid.cards.map((c) => c.dataset.preset), ["clean", "sticker", "black-box"]);
  assert.match(grid.innerHTML, /\/api\/dub\/jobs\/j1\/thumb/);
  assert.match(grid.innerHTML, /class="cap-sample sub-ov-black-box">Hola</);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, true, false]);
  // Painting again does not rebuild the grid (it is painted on every tick of
  // the player); a pick moves the ring.
  const before = grid.cards;
  h.v.preset = "clean";
  h.tab.paint();
  assert.equal(grid.cards, before);
  assert.deepEqual(grid.cards.map((c) => c.attrs["aria-pressed"]), ["true", "false", "false"]);
  grid.fire("click", { target: { closest: () => ({ dataset: { preset: "black-box" } }) } });
  assert.deepEqual(h.picked, ["black-box"]);
});

test("the sample word is the subtitles' first, kept short", () => {
  assert.equal(sampleWord([{ text: "" }, { text: "  Bienvenidos de nuevo" }]), "Bienven…");
  assert.equal(sampleWord([{ text: "안녕하세요 여러분" }]), "안녕하세요");
  assert.equal(sampleWord([]), "Aa");
  // No frame to show: a plain tile, and the words are escaped either way.
  const html = styleCardsHtml([["clean", "Clean"]], "<b>", "");
  assert.doesNotMatch(html, /background-image/);
  assert.match(html, /&lt;b&gt;/);
});

test("the tab is shut until there is a dub, and opens once there is", () => {
  assert.equal(captionsLocked({ dubbed: false }), true, "a draft, a running or failed job, or nothing open");
  assert.equal(captionsLocked({ dubbed: true }), false);
  const h = harness({ dubbed: false });
  h.tab.paint();
  assert.deepEqual(h.locks, [true]);
  assert.equal(h.$("videoStyleBtn").disabled, true, "the video panel's button is dim with the tab");
  assert.equal(h.$("videoStyleBtn").title, LOCKED_TIP);
  h.v.dubbed = true;
  h.tab.paint();
  assert.deepEqual(h.locks, [true, false]);
  assert.equal(h.$("videoStyleBtn").disabled, false);
  assert.equal(h.$("videoStyleBtn").title, "");
});

// The tab's looks moved into the dub's last step (owner, 2026-10-22): a
// button left of Download opens the same twelve over the video.
test("Subtitle style in the video panel opens the same looks, the current one ringed", () => {
  const h = harness({ preset: "sticker" });
  h.tab.paint();
  const grid = h.$("videoStyleGrid");
  assert.equal(grid.innerHTML, h.$("subStyleMenu").innerHTML, "the tab's tiles, over the same frame");
  assert.deepEqual(grid.cards.map((c) => c.attrs["aria-pressed"]), ["false", "true", "false"]);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, true, false]);
  // Shut until its button is pressed; the press opens it and goes no further.
  h.$("videoStylePop").hidden = true;
  h.press("videoStyleBtn");
  assert.equal(h.$("videoStylePop").hidden, false);
  assert.equal(h.$("videoStyleBtn").attrs["aria-expanded"], "true");
  // A press inside it leaves it open; the button again shuts it.
  h.press("videoStylePop");
  assert.equal(h.$("videoStylePop").hidden, false);
  h.press("videoStyleBtn");
  assert.equal(h.$("videoStylePop").hidden, true);
  assert.equal(h.$("videoStyleBtn").attrs["aria-expanded"], "false");
  // Painting again keeps both grids and moves both rings.
  const before = grid.cards;
  h.v.preset = "black-box";
  h.tab.paint();
  assert.equal(grid.cards, before);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, false, true]);
  assert.deepEqual(h.$("subStyleMenu").cards.map((c) => c.classList.contains("on")), [false, false, true]);
});

test("a look picked over the video is the tab's own pick, and it shuts the panel", () => {
  const h = harness();
  h.tab.paint();
  h.press("videoStyleBtn");
  h.pick("videoStyleGrid", "black-box");
  assert.deepEqual(h.picked, ["black-box"], "the same onPick the tab's tiles press");
  assert.equal(h.$("videoStylePop").hidden, true, "shut, so the look is seen on the whole picture");
  assert.equal(h.$("videoStyleBtn").attrs["aria-expanded"], "false");
  // The tab's tiles go on picking as before.
  h.pick("subStyleMenu", "sticker");
  assert.deepEqual(h.picked, ["black-box", "sticker"]);
});

test("the video panel's looks shut on a press elsewhere, on Escape, and when they go dim", () => {
  const h = harness();
  h.tab.paint();
  h.press("videoStyleBtn");
  h.doc.fire("click", {});
  assert.equal(h.$("videoStylePop").hidden, true, "a press anywhere else");
  h.press("videoStyleBtn");
  h.doc.fire("keydown", { key: "Space" });
  assert.equal(h.$("videoStylePop").hidden, false, "another key leaves it");
  h.doc.fire("keydown", { key: "Escape" });
  assert.equal(h.$("videoStylePop").hidden, true, "Escape");
  // Open when the screen changes under it (a dub starts, Home): shut.
  h.press("videoStyleBtn");
  h.v.screen = "running";
  h.v.dubbed = false;
  h.tab.paint();
  assert.equal(h.$("videoStyleBtn").disabled, true);
  assert.equal(h.$("videoStylePop").hidden, true);
});
