// Run with: node --test ui/src/importBlock.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wireImportBlock } from "./importBlock.mjs";
import { NOT_A_LINK } from "./linkField.mjs";

function makeEl(id) {
  return {
    id, value: "", listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire(ev, arg = {}) { for (const fn of this.listeners[ev] || []) fn(arg); },
  };
}

// The block wired the way a tab wires it, with what it hands on written down.
function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const log = { links: [], notLinks: [] };
  wireImportBlock($, {
    id: "zone", linkId: "link", input: { click() {} },
    onFiles: () => {},
    onLink: (url) => log.links.push(url),
    onNotLink: (message) => log.notLinks.push(message),
  });
  const field = $("linkInput");
  const type = (text) => { field.value = text; field.fire("input", { inputType: "insertText" }); };
  const paste = (text) => { field.value = text; field.fire("input", { inputType: "insertFromPaste" }); };
  const enter = () => field.fire("keydown", { key: "Enter", preventDefault() {} });
  return { field, type, paste, enter, log, tick: (ms) => t.mock.timers.tick(ms) };
}

test("a pasted link starts by itself, once, 400 ms after the last paste", (t) => {
  const h = harness(t);
  h.paste("https://youtu.be/abc");
  h.tick(399);
  assert.deepEqual(h.log.links, [], "not while a paste may still be settling");
  h.paste("https://youtu.be/abcd");   // pasted over: the wait starts again
  h.tick(399);
  assert.deepEqual(h.log.links, []);
  h.tick(1);
  assert.deepEqual(h.log.links, ["https://youtu.be/abcd"]);
  h.tick(1000);
  assert.equal(h.log.links.length, 1);
});

test("a link typed by hand waits for Enter: a pause mid-address starts nothing", (t) => {
  const h = harness(t);
  h.type("https://youtu.be/ab");
  h.tick(1000);
  assert.deepEqual(h.log.links, []);
  h.type("https://youtu.be/abc");
  h.enter();
  assert.deepEqual(h.log.links, ["https://youtu.be/abc"]);
});

test("Enter on a link starts it at once, and the paste wait does not start it again", (t) => {
  const h = harness(t);
  h.paste("https://youtu.be/abc");
  h.enter();
  assert.deepEqual(h.log.links, ["https://youtu.be/abc"]);
  h.tick(1000);
  assert.equal(h.log.links.length, 1);
});

test("something that is not a link says nothing while typed, and says so on Enter", (t) => {
  const h = harness(t);
  h.type("youtu.be/abc");
  h.tick(1000);
  assert.deepEqual(h.log.links, []);
  assert.deepEqual(h.log.notLinks, [], "no telling off mid-word");
  h.enter();
  assert.deepEqual(h.log.notLinks, [NOT_A_LINK]);
});

test("a block wired with no file input takes the link field alone: no click, key or drop on the block", () => {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const links = [];
  wireImportBlock($, { id: "zone", linkId: "link", onLink: (url) => links.push(url), onNotLink: () => {} });
  assert.deepEqual(Object.keys($("zone").listeners), []);
  $("linkInput").value = "https://youtu.be/abc";
  $("linkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(links, ["https://youtu.be/abc"]);
});
