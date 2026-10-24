// The Captions tab draws itself from the page's subtitle state, so the tests
// hand it a paper-thin page and a view object, and read the elements back.
//
// Run with: node --test ui/src/captionsTab.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initCaptionsTab, captionsEmpty, styleCardsHtml,
         AFTER_DUB, NO_SUBTITLES, PICK_A_LINE, SRT_SUB, NOT_SRT } from "./captionsTab.mjs";
import { clearDraft, setDraft } from "./draft.mjs";

const STYLES = [["clean", "Clean"], ["sticker", "Sticker"], ["black-box", "Black Box"]];

function makeEl(id) {
  const classes = new Set();
  const el = {
    id, textContent: "", hidden: false, dataset: {}, listeners: {}, attrs: {}, cards: [], style: {},
    // Where it is on screen, set by the test that needs it.
    rect: { left: 0, top: 0, width: 0, height: 0 },
    getBoundingClientRect() { return this.rect; },
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

function harness(view = {}, extra = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const v = { screen: "done", lines: [{ text: "Hola amigos" }], preset: "clean",
              size: 100, boxed: false, scope: "all", line: 0, enabled: true, ...view };
  const picked = [];
  let shown = 0;
  // The page: a press anywhere on it, and its keys.
  const doc = makeEl("document");
  // The video panel the looks open in: 800 x 400 from the window's corner.
  const pane = makeEl("videoPane");
  pane.rect = { left: 0, top: 0, width: 800, height: 400 };
  Object.assign($("videoStylePop"), { offsetParent: pane, offsetWidth: 560, offsetHeight: 200 });
  const tab = initCaptionsTab({ $, styles: STYLES, getView: () => v, doc,
    onPick: (p) => picked.push(p), onShow: () => { shown++; }, ...extra });
  // A press on an element that stops it there, as the button and the panel do.
  const press = (id) => {
    const e = { stopped: false, stopPropagation() { this.stopped = true; } };
    $(id).fire("click", e);
    if (!e.stopped) doc.fire("click", e);
  };
  // A press on one look's tile in a grid.
  const pick = (grid, preset) => $(grid).fire("click", {
    target: { closest: () => ({ dataset: { preset } }) }, stopPropagation() {} });
  return { $, v, tab, picked, shown: () => shown, doc, press, pick };
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

test("every look is a tile of the same words alone, no frame of the video, the current one ringed", () => {
  const h = harness({ preset: "sticker" });
  h.tab.paint();
  const grid = h.$("subStyleMenu");
  assert.deepEqual(grid.cards.map((c) => c.dataset.preset), ["clean", "sticker", "black-box"]);
  assert.doesNotMatch(grid.innerHTML, /thumb|background-image/);
  assert.match(grid.innerHTML, /class="cap-sample sub-ov-black-box">Abc 123</);
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

test("a tile's words are escaped", () => {
  assert.match(styleCardsHtml([["clean", "Clean"]], "<b>"), /&lt;b&gt;/);
});


// The looks over a dub's picture (owner, 2026-10-23): the chip just above
// the subtitle opens the same twelve.
test("the Subtitle style chip opens the same looks, the current one ringed", () => {
  const h = harness({ preset: "sticker" });
  h.tab.paint();
  const grid = h.$("videoStyleGrid");
  assert.equal(grid.innerHTML, h.$("subStyleMenu").innerHTML, "the tab's tiles, over the same frame");
  assert.deepEqual(grid.cards.map((c) => c.attrs["aria-pressed"]), ["false", "true", "false"]);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, true, false]);
  // Shut until its chip is pressed; the press opens it and goes no further.
  h.$("videoStylePop").hidden = true;
  h.press("subStyleChip");
  assert.equal(h.$("videoStylePop").hidden, false);
  assert.equal(h.$("subStyleChip").attrs["aria-expanded"], "true");
  // A press inside it leaves it open; the chip again shuts it.
  h.press("videoStylePop");
  assert.equal(h.$("videoStylePop").hidden, false);
  h.press("subStyleChip");
  assert.equal(h.$("videoStylePop").hidden, true);
  assert.equal(h.$("subStyleChip").attrs["aria-expanded"], "false");
  // Painting again keeps both grids and moves both rings.
  const before = grid.cards;
  h.v.preset = "black-box";
  h.tab.paint();
  assert.equal(grid.cards, before);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, false, true]);
  assert.deepEqual(h.$("subStyleMenu").cards.map((c) => c.classList.contains("on")), [false, false, true]);
});

// Never below the chip (owner, 2026-10-23): its foot 8px over the chip,
// centred on it inside the panel, and held 8px from the panel's top.
test("the chip's looks open above it, centred on it and inside the panel", () => {
  const h = harness();
  h.tab.paint();
  h.$("videoStylePop").hidden = true;
  h.$("subStyleChip").rect = { left: 280, top: 300, width: 100, height: 26 };
  h.press("subStyleChip");
  assert.equal(h.$("videoStylePop").style.top, "92px", "300 - 200 - 8");
  assert.equal(h.$("videoStylePop").style.maxHeight, "284px", "the room above the chip, 300 - 16");
  assert.equal(h.$("videoStylePop").style.left, "50px", "centred on the chip at 330");
  h.press("subStyleChip");
  // A chip at the panel's right edge and near its top.
  h.$("subStyleChip").rect = { left: 740, top: 120, width: 60, height: 26 };
  h.press("subStyleChip");
  assert.equal(h.$("videoStylePop").style.left, "232px", "800 - 560 - 8");
  assert.equal(h.$("videoStylePop").style.top, "8px");
  // Too little room for the whole window: it is cut to the room and scrolls.
  assert.equal(h.$("videoStylePop").style.maxHeight, "104px", "120 - 16");
});

test("a look picked over the video is the tab's own pick, and it shuts the panel", () => {
  const h = harness();
  h.tab.paint();
  h.press("subStyleChip");
  h.pick("videoStyleGrid", "black-box");
  assert.deepEqual(h.picked, ["black-box"], "the same onPick the tab's tiles press");
  assert.equal(h.$("videoStylePop").hidden, true, "shut, so the look is seen on the whole picture");
  assert.equal(h.$("subStyleChip").attrs["aria-expanded"], "false");
  // The tab's tiles go on picking as before.
  h.pick("subStyleMenu", "sticker");
  assert.deepEqual(h.picked, ["black-box", "sticker"]);
});

test("the chip's looks shut on a press elsewhere, on Escape, and when the chip goes", () => {
  const h = harness();
  h.tab.paint();
  h.press("subStyleChip");
  h.doc.fire("click", {});
  assert.equal(h.$("videoStylePop").hidden, true, "a press anywhere else");
  h.press("subStyleChip");
  h.doc.fire("keydown", { key: "Space" });
  assert.equal(h.$("videoStylePop").hidden, false, "another key leaves it");
  h.doc.fire("keydown", { key: "Escape" });
  assert.equal(h.$("videoStylePop").hidden, true, "Escape");
  // Open when the video plays or the screen changes (the page hides the chip): shut.
  h.press("subStyleChip");
  h.$("subStyleChip").hidden = true;
  h.tab.paint();
  assert.equal(h.$("videoStylePop").hidden, true);
});

// ---- Starting a burn-in project (owner, 2026-10-22, 2026-10-23): a video and a subtitle file ----

// The page's side of it: what was said on the line, sent, and opened.
function aloneHarness(view = {}, { upload } = {}) {
  const said = [];
  const sent = [];
  const opened = [];
  const held = [];
  const alone = {
    importSource: () => Promise.resolve(),
    hold: (from) => { held.push(from.erase ? `erase:${from.id}` : from.id); return Promise.resolve(`held-${from.id}`); },
    say: (text, isError = false) => said.push([text, isError]),
    upload: upload || ((id, file) => { sent.push([id, file.name]); return Promise.resolve("c1"); }),
    openJob: (jid) => { opened.push(jid); return Promise.resolve(); },
  };
  const h = harness({ screen: "done", lines: [], alone: true, from: null, files: null, ...view },
                    { alone });
  return { ...h, said, sent, opened, held, alone };
}

test("with no project open the tab takes a video and a subtitle file, the looks dim under them", () => {
  clearDraft();
  const h = aloneHarness({ preset: "sticker" });
  h.tab.paint();
  assert.equal(h.$("capAlone").hidden, false);
  assert.equal(h.$("capZone").hidden, false, "the shared Import block for the video");
  assert.equal(h.$("capVideoCard").hidden, true);
  assert.equal(h.$("capSrtSub").textContent, SRT_SUB);
  assert.equal(SRT_SUB, "Drop a subtitle file here or press to choose one");
  // The twelve looks stay on show, but cannot be pressed until both are in.
  assert.equal(h.$("capEmpty").hidden, true);
  assert.equal(h.$("capMain").hidden, false);
  assert.equal(h.$("capMain").inert, true);
  assert.equal(h.$("capMain").classList.contains("cap-off"), true);
  const grid = h.$("subStyleMenu");
  assert.equal(grid.cards.length, 3);
  assert.doesNotMatch(grid.innerHTML, /background-image/, "no project, so no frame behind them");
  assert.match(grid.innerHTML, />Abc 123</);
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, false, false]);
  assert.equal(h.$("capFiles").hidden, true);
});

test("a held video shows as its card in the Import block's place", () => {
  setDraft({ downloadId: "d1", name: "paris_steps.mp4", duration: 24.7, videoUrl: "/v" });
  const h = aloneHarness();
  h.tab.paint();
  assert.equal(h.$("capZone").hidden, true);
  assert.equal(h.$("capVideoCard").hidden, false);
  assert.match(h.$("capVideoCard").innerHTML, /paris_steps\.mp4/);
  assert.match(h.$("capVideoCard").innerHTML, /00:24/);
  clearDraft();
});

test("a subtitle file waits for its video, then the two are sent and opened", async () => {
  clearDraft();
  const h = aloneHarness();
  h.tab.paint();
  await h.tab.takeSrt({ name: "notes.txt" });
  assert.deepEqual(h.said.at(-1), [NOT_SRT, true], "only an .srt");
  assert.deepEqual(h.sent, []);
  await h.tab.takeSrt({ name: "paris_ko.SRT" });
  assert.deepEqual(h.sent, [], "no video yet: nothing to send");
  assert.equal(h.$("capSrtSub").textContent, "paris_ko.SRT", "the file waits, by name");
  // The video coming in sends the two.
  setDraft({ downloadId: "d2", name: "paris.mp4", duration: 10, videoUrl: "/v" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.sent, [["d2", "paris_ko.SRT"]]);
  assert.deepEqual(h.opened, ["c1"]);
  assert.equal(h.$("capSrtSub").textContent, SRT_SUB, "and it is let go");
  clearDraft();
});

test("a subtitle file with a video already there is sent at once; a refusal is said and the file let go", async () => {
  setDraft({ downloadId: "d3", name: "a.mp4", duration: 5, videoUrl: "/v" });
  const err = Object.assign(new Error("This subtitle file has no lines PersoDub can read."), { status: 422 });
  const h = aloneHarness({}, { upload: () => Promise.reject(err) });
  await h.tab.takeSrt({ name: "empty.srt" });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.said.at(-1), ["This subtitle file has no lines PersoDub can read.", true]);
  assert.equal(h.$("capSrtSub").textContent, SRT_SUB);
  clearDraft();
});

test("once the two are a project, its two files are named over the looks, which open", () => {
  const h = aloneHarness({ alone: false, preset: "sticker",
                           lines: [{ text: "Bonjour" }, { text: "Salut" }, { text: "Ciao" }],
                           files: { name: "paris_steps", duration: 24.7, srt: "paris_ko.srt" } });
  h.tab.paint();
  assert.equal(h.$("capAlone").hidden, true);
  assert.equal(h.$("capFiles").hidden, false);
  assert.match(h.$("capFileVideo").innerHTML, /paris_steps/);
  assert.match(h.$("capFileVideo").innerHTML, /00:24/);
  assert.equal(h.$("capFileSrtName").textContent, "paris_ko.srt");
  assert.equal(h.$("capFileSrtLines").textContent, "3 lines");
  assert.equal(h.$("capMain").inert, false);
  assert.equal(h.$("capMain").classList.contains("cap-off"), false);
  const grid = h.$("subStyleMenu");
  assert.deepEqual(grid.cards.map((c) => c.classList.contains("on")), [false, true, false]);
});

// In a dub or any other project (owner, 2026-10-23): not the dub's style, but
// the way to burn a subtitle file into this project's own video, held again.
test("in another project the tab starts from its video, held again, and makes a burn-in project", async () => {
  setDraft({ downloadId: "beside", name: "erase-draft.mp4", duration: 3, videoUrl: "/v" });
  for (const screen of ["done", "running"]) {
    const h = aloneHarness({ screen, from: { id: "j1", name: "paris_steps", duration: 24.7 },
                             lines: [{ text: "Hola" }] });
    h.tab.paint();
    assert.equal(h.$("capEmpty").hidden, true, `${screen}: never empty, never shut`);
    assert.equal(h.$("capAlone").hidden, false);
    assert.equal(h.$("capZone").hidden, true, "no Import block: the video is the project's");
    assert.match(h.$("capVideoCard").innerHTML, /paris_steps/, "its card, not the draft held beside it");
    assert.equal(h.$("capFiles").hidden, true);
    assert.equal(h.$("capMain").inert, true, "the looks dim: they are not this dub's");
    // The chip's looks over the dub still ring the dub's own; the dim tab's ring none.
    assert.deepEqual(h.$("videoStyleGrid").cards.map((c) => c.classList.contains("on")), [true, false, false]);
    assert.deepEqual(h.$("subStyleMenu").cards.map((c) => c.classList.contains("on")), [false, false, false]);
    await h.tab.takeSrt({ name: "paris_ko.srt" });
    assert.deepEqual(h.held, ["j1"]);
    assert.deepEqual(h.sent, [["held-j1", "paris_ko.srt"]]);
    assert.deepEqual(h.opened, ["c1"]);
  }
  clearDraft();
});

// On the erase screen (owner, 2026-10-23): the erased video is the one, held
// the way the Dubbing button holds it; never the erase job's original.
test("on the erase screen the tab starts from the erased video", async () => {
  setDraft({ downloadId: "orig", name: "paris.mp4", duration: 30, videoUrl: "/v" });
  const h = aloneHarness({ screen: "erase", from: { id: "e1", name: "paris", duration: 12, erase: true } });
  h.tab.paint();
  assert.equal(h.$("capZone").hidden, true);
  assert.match(h.$("capVideoCard").innerHTML, /00:12/, "the erased length, not the draft's");
  await h.tab.takeSrt({ name: "paris_ko.srt" });
  assert.deepEqual(h.held, ["erase:e1"]);
  assert.deepEqual(h.sent, [["held-e1", "paris_ko.srt"]]);
  clearDraft();
});

// A dub cut from a longer original (owner, 2026-10-23): the burn-in holds the
// original, so its card shows the original's whole length, not the dub's.
test("a dub's card shows the length of the original it is held from", async () => {
  clearDraft();
  const asked = [];
  const h = aloneHarness({ from: { id: "j1", name: "paris_steps", duration: 12, downloadId: "d9" } });
  h.alone.lengthOf = (id) => { asked.push(id); return Promise.resolve(95); };
  h.tab.paint();
  assert.match(h.$("capVideoCard").innerHTML, /00:12/, "its own length until the answer");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(h.$("capVideoCard").innerHTML, /01:35/);
  h.tab.paint();
  assert.deepEqual(asked, ["d9"], "asked once");
});
