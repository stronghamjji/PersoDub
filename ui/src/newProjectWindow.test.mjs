// The top bar's New project window, on a paper-thin page: elements that are
// plain objects, and a document that only holds the Escape listener.
//
// Run with: node --test ui/src/newProjectWindow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initNewProjectWindow } from "./newProjectWindow.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", files: null, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 contains: (c) => classes.has(c) },
    focus() { this.focused = true; },
    click() { this.clicked = (this.clicked || 0) + 1; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire(ev, arg = {}) { for (const fn of this.listeners[ev] || []) fn(arg); },
  };
}

function harness({ emptyImport } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const docKeys = [];
  const realDoc = globalThis.document;
  globalThis.document = { addEventListener: (ev, fn) => { if (ev === "keydown") docKeys.push(fn); } };
  // Every call in order, so a test can see the job is left BEFORE the draft
  // (or the dialog) opens.
  const got = { files: [], links: [], calls: [] };
  initNewProjectWindow({
    $,
    checkFile: (f) => (/\.(mp4|mov)$/i.test(f.name) ? null : "Please choose an MP4 or MOV video file."),
    leaveJob: () => got.calls.push("leaveJob"),
    openDraft: (s) => {
      got.calls.push("openDraft");
      if (s.file) got.files.push([s.file.name]); else got.links.push(s.link);
    },
    openNewProject: (s) => { got.calls.push("openNewProject"); got.files.push(s.files.map((f) => f.name)); },
    emptyImport,
  });
  const isOpen = () => $("newProjOverlay").classList.contains("open");
  const esc = () => docKeys.forEach((fn) => fn({ key: "Escape" }));
  return { $, got, isOpen, esc, restore: () => { globalThis.document = realDoc; } };
}

const ev = (extra = {}) => ({ preventDefault() {}, stopPropagation() { this.stopped = true; }, ...extra });

test("New project opens the window over the screen, with the link field inside the drop area", (t) => {
  const h = harness();
  t.after(h.restore);
  const block = h.$("newProjImportSlot").outerHTML;
  assert.match(block, /^<div class="import-block" id="newProjDrop" tabindex="0">/);
  assert.match(block, />Import<\/div><div class="import-sub">Drop videos here, or click to choose<\/div><label class="import-link" id="newProjLinkRow">/);
  assert.match(block, /id="newProjLinkInput"/);
  assert.ok(!/import-or|>Add</.test(block), "no or line and no Add button");
  h.$("newProjError").textContent = "old";
  h.$("newProjectBtn").fire("click");
  assert.equal(h.isOpen(), true);
  assert.equal(h.$("newProjError").textContent, "", "last time's refusal is gone");
  // No focus is put on the drop area: its blue ring is for a drag only.
  assert.notEqual(h.$("newProjDrop").focused, true);
  h.esc();
  assert.equal(h.isOpen(), false);
});

// The same block twice, one over the other, on an empty project (2026-10-21).
test("on an empty project New project blinks the link field already on screen and opens no window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ emptyImport: () => "dubbingLink" });
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  assert.equal(h.isOpen(), false);
  assert.equal(h.$("dubbingLinkInput").focused, true);
  assert.equal(h.$("dubbingLinkRow").classList.contains("ask"), true);
  t.mock.timers.tick(1000);
  assert.equal(h.$("dubbingLinkRow").classList.contains("ask"), false, "two blinks, then the caret alone");
  assert.deepEqual(h.got.calls, [], "the project is not left");
});

// A video in the project, a job open, or the left panel hidden.
test("with no empty block on screen New project opens the window, as before", (t) => {
  const h = harness({ emptyImport: () => null });
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  assert.equal(h.isOpen(), true);
});

test("a click on the drop area chooses files; a good one closes the window and is handed on", (t) => {
  const h = harness();
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  h.$("newProjDrop").fire("click");
  assert.equal(h.$("newProjFileInput").clicked, 1);
  h.$("newProjFileInput").files = [{ name: "a.mp4" }];
  h.$("newProjFileInput").fire("change");
  assert.deepEqual(h.got.files, [["a.mp4"]]);
  assert.equal(h.$("newProjFileInput").value, "", "the same file can be picked again");
  assert.equal(h.isOpen(), false);
});

test("a dropped batch is handed on whole; one bad file keeps the window open and says why", (t) => {
  const h = harness();
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  h.$("newProjDrop").fire("drop", ev({ dataTransfer: { files: [{ name: "a.mp4" }, { name: "b.txt" }] } }));
  assert.deepEqual(h.got.files, []);
  assert.equal(h.$("newProjError").textContent, "b.txt: Please choose an MP4 or MOV video file.");
  assert.equal(h.isOpen(), true);
  h.$("newProjDrop").fire("drop", ev({ dataTransfer: { files: [{ name: "a.mp4" }, { name: "b.mov" }] } }));
  assert.deepEqual(h.got.files, [["a.mp4", "b.mov"]]);
  assert.equal(h.isOpen(), false);
});

test("the link field keeps its clicks from the drop area, and Enter hands the link on", (t) => {
  const h = harness();
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  const click = ev({ target: h.$("newProjLinkInput") });
  h.$("newProjLinkRow").fire("click", click);
  assert.equal(click.stopped, true, "the file picker does not open");
  h.$("newProjLinkInput").value = "  https://youtu.be/x  ";
  h.$("newProjLinkInput").fire("keydown", ev({ key: "Enter" }));
  assert.deepEqual(h.got.links, ["https://youtu.be/x"]);
  assert.equal(h.isOpen(), false);

  h.$("newProjectBtn").fire("click");
  assert.equal(h.$("newProjLinkInput").value, "", "a fresh field each time");
  h.$("newProjLinkInput").value = "https://www.tiktok.com/@a/video/1";
  h.$("newProjLinkInput").fire("keydown", ev({ key: "Enter" }));
  assert.deepEqual(h.got.links, ["https://youtu.be/x", "https://www.tiktok.com/@a/video/1"]);
});

test("something typed that is not a link is answered in the window, and nothing typed is not", (t) => {
  const h = harness();
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  h.$("newProjLinkInput").fire("keydown", ev({ key: "Enter" }));
  assert.equal(h.$("newProjError").textContent, "");
  h.$("newProjLinkInput").value = "my holiday video";
  h.$("newProjLinkInput").fire("keydown", ev({ key: "Enter" }));
  assert.equal(h.$("newProjError").textContent, "That is not a link. Paste one that starts with https://");
  assert.deepEqual(h.got.links, []);
  assert.equal(h.isOpen(), true);
});

test("choosing a video leaves the open job before the new draft or dialog opens; closing leaves it alone", (t) => {
  const h = harness();
  t.after(h.restore);
  h.$("newProjectBtn").fire("click");
  h.$("newProjClose").fire("click");
  assert.deepEqual(h.got.calls, [], "only looking changes nothing");

  h.$("newProjectBtn").fire("click");
  h.$("newProjDrop").fire("drop", ev({ dataTransfer: { files: [{ name: "a.mp4" }] } }));
  h.$("newProjectBtn").fire("click");
  h.$("newProjLinkInput").value = "https://youtu.be/x";
  h.$("newProjLinkInput").fire("keydown", ev({ key: "Enter" }));
  h.$("newProjectBtn").fire("click");
  h.$("newProjDrop").fire("drop", ev({ dataTransfer: { files: [{ name: "a.mp4" }, { name: "b.mp4" }] } }));
  assert.deepEqual(h.got.calls,
    ["leaveJob", "openDraft", "leaveJob", "openDraft", "leaveJob", "openNewProject"]);

  // A refused file leaves the job where it is.
  h.got.calls.length = 0;
  h.$("newProjectBtn").fire("click");
  h.$("newProjDrop").fire("drop", ev({ dataTransfer: { files: [{ name: "c.txt" }] } }));
  assert.deepEqual(h.got.calls, []);
});
