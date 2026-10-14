// The Captions tab draws itself from the page's subtitle state, so the tests
// hand it a paper-thin page and a view object, and read the elements back.
//
// Run with: node --test ui/src/captionsTab.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initCaptionsTab, captionsEmpty, captionsLocked, sampleWord, styleCardsHtml,
         AFTER_DUB, NO_SUBTITLES, PICK_A_LINE } from "./captionsTab.mjs";
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
  const tab = initCaptionsTab({ $, styles: STYLES, getView: () => v,
    onPick: (p) => picked.push(p), onShow: () => { shown++; }, setLocked: (on) => locks.push(on) });
  return { $, v, tab, picked, locks, shown: () => shown };
}

test("the tab says why it is empty: before dubbing, and with no subtitles", () => {
  assert.equal(captionsEmpty({ screen: "running", lines: 3 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "failed", lines: 0 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "draft", lines: 0 }), AFTER_DUB);
  assert.equal(captionsEmpty({ screen: "done", lines: 0 }), NO_SUBTITLES);
  assert.equal(captionsEmpty({ screen: "done", lines: 2 }), "");
  assert.equal(NO_SUBTITLES, "No captions for this project");
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
  h.v.dubbed = true;
  h.tab.paint();
  assert.deepEqual(h.locks, [true, false]);
});
