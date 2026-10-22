// The keys every pick list of the dubbing options shares (ui/src/pickList.mjs):
// the list can take the focus itself, so a press on a greyed option, which
// takes none, leaves Escape working; from there Down goes to the first option
// that can be chosen and Up to the last (Mac check, 2026-10-22, remark 6).
//
// Run with: node --test ui/src/pickList.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { listKeys } from "./pickList.mjs";

// The focus, as the arrows read it.
function useDocument(t) {
  const real = globalThis.document;
  const doc = { activeElement: null };
  globalThis.document = doc;
  t.after(() => { globalThis.document = real; });
  return doc;
}

// A list of options by name, some greyed, that hears keys.
function fakeList(names, greyed = []) {
  const opts = names.map((name) => ({ name, disabled: greyed.includes(name),
                                      focus() { globalThis.document.activeElement = this; } }));
  const keydown = [];
  return {
    addEventListener: (type, fn) => { if (type === "keydown") keydown.push(fn); },
    querySelectorAll: (sel) => (sel === ".model-opt:not([disabled])" ? opts.filter((o) => !o.disabled) : []),
    querySelector: () => null,
    key(name) {
      const e = { key: name, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
      for (const fn of keydown) fn(e);
      return e;
    },
  };
}

test("a press on a greyed option leaves the focus in the list, so Escape still closes it", (t) => {
  const doc = useDocument(t);
  const list = fakeList(["Oriole", "Linnet 4", "Nightingale"], ["Linnet 4"]);
  let closed = 0;
  listKeys(list, () => { closed += 1; });
  // A greyed option takes no focus, and a browser hands it to the nearest
  // box around it that can take one: the list, now (Chrome, 2026-10-22).
  assert.equal(list.tabIndex, -1);
  doc.activeElement = list;
  const e = list.key("Escape");
  assert.equal(closed, 1);
  assert.ok(e.stopped, "the dialog under the list stays open");
});

test("from the list itself Down goes to the first option that can be chosen and Up to the last", (t) => {
  const doc = useDocument(t);
  const list = fakeList(["Oriole", "Linnet 4", "Wren", "Nightingale"], ["Linnet 4"]);
  listKeys(list, () => {});
  doc.activeElement = list;
  list.key("ArrowDown");
  assert.equal(doc.activeElement.name, "Oriole");
  doc.activeElement = list;
  list.key("ArrowUp");
  assert.equal(doc.activeElement.name, "Nightingale");
  // On from an option the greyed one is passed by.
  list.key("ArrowUp");
  list.key("ArrowUp");
  assert.equal(doc.activeElement.name, "Oriole");
});
