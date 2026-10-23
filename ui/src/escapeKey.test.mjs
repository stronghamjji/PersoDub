import test from "node:test";
import assert from "node:assert/strict";
import { topOverlay, initEscapeKey, WAYS_OUT, MENU_BUTTONS } from "./escapeKey.mjs";
import { readPage } from "../testlib/readPage.mjs";

// The page with its script written back in (ui/testlib/readPage.mjs).
const html = readPage();

test("the dialog on top is the highest one, and between equals the later one", () => {
  assert.equal(topOverlay([]), null);
  assert.equal(topOverlay([{ id: "projectOverlay", z: 20, order: 0 }, { id: "keyOverlay", z: 20, order: 1 }]), "keyOverlay");
  assert.equal(topOverlay([{ id: "chatgptSignInOverlay", z: 30, order: 0 }, { id: "settingsOverlay", z: 20, order: 1 }]), "chatgptSignInOverlay");
});

test("every dialog in the page has a way out for Escape, and every way out exists", () => {
  const overlays = [...html.matchAll(/class="modal-overlay[^"]*" id="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(overlays.length >= 14);
  for (const id of overlays) assert.ok(WAYS_OUT[id], `${id} has no way out`);
  for (const buttons of Object.values(WAYS_OUT)) {
    for (const b of buttons) assert.ok(html.includes(`id="${b}"`), `#${b} is not in the page`);
  }
  for (const [, menus] of MENU_BUTTONS) {
    for (const m of menus) assert.ok(html.includes(`id="${m}"`), `#${m} is not in the page`);
  }
});

// The least of a page the listeners need: elements by id, the open dialogs,
// and a body whose click is counted.
function page({ open = [], hiddenIds = [], z = {} } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, hidden: hiddenIds.includes(id), disabled: false, clicks: 0, click() { this.clicks += 1; } });
    return els.get(id);
  };
  const listeners = { key: null, click: [], mousedown: [] };
  const doc = {
    body: { clicks: 0, click() { this.clicks += 1; } },
    getElementById: (id) => el(id),
    querySelectorAll: () => open.map((id) => el(id)),
    addEventListener: (ev, fn) => { listeners[ev].push(fn); },
  };
  const win = { addEventListener: (_, fn) => { listeners.key = fn; } };
  initEscapeKey({ doc, win, zOf: (e) => z[e.id] || 20 });
  const press = () => {
    const e = { key: "Escape", stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    listeners.key(e);
    return e;
  };
  const fire = (ev, target) => {
    const e = { target, stopped: false, stopPropagation() { this.stopped = true; } };
    for (const fn of listeners[ev]) fn(e);
    return e;
  };
  // A dimmed backdrop, open, as the click listener sees it.
  const backdrop = (id) => Object.assign(el(id), { classList: { contains: (c) => c === "modal-overlay" || c === "open" } });
  return { el, doc, press, backdrop, click: (target) => fire("click", target), down: (target) => fire("mousedown", target) };
}
const ALL_MENUS = ["ratioMenu", "previewMenu", "videoStylePop", "projectCardMenu"];

test("Escape closes only the dialog on top of a stack", () => {
  const p = page({ open: ["projectOverlay", "chatgptSignInOverlay"], z: { chatgptSignInOverlay: 30 }, hiddenIds: ALL_MENUS });
  const e = p.press();
  assert.equal(p.el("csCancel").clicks, 1);
  assert.equal(p.el("projectClose").clicks, 0);
  assert.equal(e.stopped, true);
});

test("Escape presses the download window's Hide while it is downloading, Cancel otherwise", () => {
  const busy = page({ open: ["modelsNeededOverlay"], hiddenIds: [...ALL_MENUS, "mnCancel"] });
  busy.press();
  assert.equal(busy.el("mnHide").clicks, 1);
  const idle = page({ open: ["modelsNeededOverlay"], hiddenIds: [...ALL_MENUS, "mnHide"] });
  idle.press();
  assert.equal(idle.el("mnCancel").clicks, 1);
});

test("Escape is left alone when nothing is open", () => {
  const nothing = page({ hiddenIds: ALL_MENUS });
  assert.equal(nothing.press().stopped, false);
});

test("a press on one menu's button reaches the other menus as a click outside", () => {
  const p = page({ hiddenIds: ALL_MENUS.filter((m) => m !== "previewMenu") });
  p.click({ closest: (sel) => (sel === "#ratioBtn" ? {} : null) });
  assert.equal(p.doc.body.clicks, 1);
  // Its own menu open: the press is that menu's toggle, nothing is added.
  p.click({ closest: (sel) => (sel === "#previewBtn" ? {} : null) });
  assert.equal(p.doc.body.clicks, 1);
  // Anywhere else is already a click outside.
  p.click({ closest: () => null });
  assert.equal(p.doc.body.clicks, 1);
});

// The Subtitle style chip over the picture opens its looks the way Ratio
// opens its menu (owner, 2026-10-22): one open at a time, whichever was pressed.
test("Subtitle style's press shuts the Ratio and Preview menus, and theirs shut its looks", () => {
  const style = { closest: (sel) => (sel === "#subStyleChip" ? {} : null) };
  const shut = page({ hiddenIds: ALL_MENUS });
  shut.click(style);
  assert.equal(shut.doc.body.clicks, 1, "opening it reaches the other menus as a click outside");
  const open = page({ hiddenIds: ALL_MENUS.filter((m) => m !== "videoStylePop") });
  open.click(style);
  assert.equal(open.doc.body.clicks, 0, "with its looks open, the press is its own toggle");
  open.click({ closest: (sel) => (sel === "#ratioBtn" ? {} : null) });
  assert.equal(open.doc.body.clicks, 1, "Ratio's press reaches the open looks");
});

test("a press on the backdrop is the dialog's own way out, and the dialog's listeners never hear it", () => {
  const p = page({ open: ["deleteOverlay"] });
  const dim = p.backdrop("deleteOverlay");
  p.down(dim);
  const e = p.click(dim);
  assert.equal(p.el("deleteCancelBtn").clicks, 1);
  assert.equal(e.stopped, true);
});

test("a press that began inside the dialog and ended on the backdrop closes nothing", () => {
  const p = page({ open: ["keyOverlay"] });
  p.down(p.el("keyInput"));
  p.click(p.backdrop("keyOverlay"));
  assert.equal(p.el("keyCancel").clicks, 0);
});

test("a dialog that is working stays under a press on the backdrop", () => {
  const p = page({ open: ["deleteOverlay"] });
  p.el("deleteCancelBtn").disabled = true;
  const dim = p.backdrop("deleteOverlay");
  p.down(dim);
  p.click(dim);
  assert.equal(p.el("deleteCancelBtn").clicks, 0);
});

test("no dialog keeps a corner X on screen: each way out is a button in its foot", () => {
  for (const m of html.matchAll(/<button class="(?:modal-close|upd-close)" id="([A-Za-z]+)"[^>]*>/g)) {
    assert.match(m[0], / hidden>$/, `#${m[1]} is a corner X on screen`);
  }
  for (const [overlay, buttons] of Object.entries(WAYS_OUT)) {
    const at = html.indexOf(`id="${overlay}"`);
    const dialog = html.slice(at, html.indexOf('<div class="modal-overlay"', at + 1));
    const foot = dialog.slice(dialog.indexOf('class="modal-foot'));
    for (const b of buttons) assert.ok(foot.includes(`id="${b}"`), `#${b} is not in ${overlay}'s foot`);
  }
});
