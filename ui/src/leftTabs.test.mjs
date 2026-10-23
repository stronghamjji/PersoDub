// The left panel's tabs: one body on show at a time, and Erase as a way out
// rather than a body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initLeftTabs } from "./leftTabs.mjs";

function harness() {
  const els = {};
  const button = (tab) => {
    const attrs = {};
    const classes = new Set();
    return {
      disabled: false, title: "",
      dataset: { tab },
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k],
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      closest: function () { return this; },
    };
  };
  // The page's order (static/index.html): Home's tools.
  const buttons = ["dubbing", "erase", "captions", "save"].map(button);
  let onClick = null;
  els.leftTabs = {
    querySelectorAll: () => buttons,
    addEventListener: (ev, fn) => { if (ev === "click") onClick = fn; },
  };
  for (const id of ["tabDubbing", "tabCaptions"]) els[id] = { hidden: false };
  const erased = [];
  const saved = [];
  const api = initLeftTabs({ $: (id) => els[id], onErase: () => erased.push(1), onSave: () => saved.push(1) });
  const press = (tab) => onClick({ target: buttons.find((b) => b.dataset.tab === tab) });
  const lit = () => buttons.filter((b) => b.classList.contains("on")).map((b) => b.dataset.tab);
  return { els, api, press, lit, erased, saved, buttons };
}

test("Dubbing is the tab on show to begin with, and only its body is", () => {
  const h = harness();
  assert.equal(h.api.current(), "dubbing");
  assert.deepEqual(h.lit(), ["dubbing"]);
  assert.equal(h.els.tabDubbing.hidden, false);
  assert.equal(h.els.tabCaptions.hidden, true);
  assert.equal(h.buttons[0].getAttribute("aria-selected"), "true");
  assert.equal(h.buttons[1].getAttribute("aria-selected"), "false");
});

test("pressing a tab shows its body and hides the rest", () => {
  const h = harness();
  h.press("captions");
  assert.equal(h.api.current(), "captions");
  assert.deepEqual(h.lit(), ["captions"]);
  assert.equal(h.els.tabCaptions.hidden, false);
  assert.equal(h.els.tabDubbing.hidden, true);
  h.press("dubbing");
  assert.equal(h.els.tabDubbing.hidden, false);
  assert.equal(h.els.tabCaptions.hidden, true);
});

test("Erase goes to the erase screen and leaves the row as it was", () => {
  const h = harness();
  h.press("captions");
  h.press("erase");
  assert.equal(h.erased.length, 1);
  assert.equal(h.api.current(), "captions");
  assert.deepEqual(h.lit(), ["captions"]);
  assert.equal(h.els.tabCaptions.hidden, false);
});

test("the page can put a tab on show itself", () => {
  const h = harness();
  h.api.show("captions");
  assert.deepEqual(h.lit(), ["captions"]);
  assert.equal(h.els.tabCaptions.hidden, false);
});

test("Save video saves the project's video and leaves the row as it was", () => {
  const h = harness();
  h.press("captions");
  h.press("save");
  assert.equal(h.saved.length, 1);
  assert.equal(h.api.current(), "captions");
  assert.deepEqual(h.lit(), ["captions"]);
});
