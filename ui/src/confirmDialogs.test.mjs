// The Delete dialog asked about something that is not a project (Python +
// PyTorch or Ollama in Settings > Models): its two buttons, the backdrop and
// a project's own Delete afterwards.
//
// Run with: node --test ui/src/confirmDialogs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initConfirmDialogs } from "./confirmDialogs.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", disabled: false, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
    focus() {},
  };
}

function page() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const real = { document: globalThis.document, fetch: globalThis.fetch };
  const calls = [];
  globalThis.document = makeEl("document");
  globalThis.fetch = async (url, opts) => { calls.push(`${opts.method} ${url}`); return { ok: true, json: async () => ({}) }; };
  const dialogs = initConfirmDialogs({
    $, state: { jobId: null }, forgetDraft: () => {}, resetForNewJob: () => {},
    getLastJobId: () => null, forgetLastJob: () => {}, projects: { renderHistory: async () => {} },
  });
  const isOpen = () => $("deleteOverlay").classList.contains("open");
  return { $, dialogs, calls, isOpen, restore: () => Object.assign(globalThis, real) };
}

const PYTORCH = { title: "Delete Python + PyTorch?",
                  line: "Without it, local models cannot separate audio, transcribe or make voices." };

test("the Delete dialog asks what is asked of it and answers Delete with yes", async (t) => {
  const p = page();
  t.after(p.restore);
  const answer = p.dialogs.askToDelete(PYTORCH);
  assert.equal(p.isOpen(), true);
  assert.equal(p.$("deleteTitle").textContent, "Delete Python + PyTorch?");
  assert.equal(p.$("deleteMessage").textContent, PYTORCH.line);
  p.$("deleteConfirmBtn").click();
  assert.equal(await answer, true);
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.calls, [], "the dialog itself deletes nothing: the asker does");
});

test("Keep it, the X and the backdrop all answer no", async (t) => {
  const p = page();
  t.after(p.restore);
  for (const out of ["deleteCancelBtn", "deleteCloseX", "deleteOverlay"]) {
    const answer = p.dialogs.askToDelete(PYTORCH);
    p.$(out).click();
    assert.equal(await answer, false, out);
    assert.equal(p.isOpen(), false, out);
  }
});

test("asked again before an answer, the first asker hears no; a project's Delete afterwards still deletes it", async (t) => {
  const p = page();
  t.after(p.restore);
  const first = p.dialogs.askToDelete(PYTORCH);
  const second = p.dialogs.askToDelete({ title: "Delete Ollama?", line: "Without it, local models cannot translate." });
  assert.equal(await first, false);
  p.$("deleteCancelBtn").click();
  assert.equal(await second, false);

  p.dialogs.askDelete({ id: "j1", status: "done" });
  assert.equal(p.$("deleteTitle").textContent, "Delete this project?");
  p.$("deleteConfirmBtn").click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.calls, ["DELETE /api/dub/jobs/j1/workspace"]);

  // A project's question left open is not answered by the next ask's Delete.
  p.dialogs.askDelete({ id: "j2", status: "done" });
  const third = p.dialogs.askToDelete(PYTORCH);
  p.$("deleteConfirmBtn").click();
  assert.equal(await third, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.calls, ["DELETE /api/dub/jobs/j1/workspace"], "j2 was not deleted");
});
