// The Dub Agent strip turns a run of calls to the SAME tool into one chip that
// lists the lines: the assistant calls edit_script_line once per line, so twenty
// rewritten lines used to leave twenty chips all reading "Rewriting a line".
//
// The code under test lives in the agent's inline module in static/index.html
// (the whole feature is one block, so it stays there), so this test lifts that
// one stretch of it out of the page and runs it against a hand-made DOM -- no
// browser, no server, no agent. If the anchors below ever stop matching, the
// test fails rather than quietly checking nothing.
//
// Run with: node --test ui/src/agentChips.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("../../static/index.html", import.meta.url));

function chipSource() {
  const html = readFileSync(INDEX, "utf8");
  const from = html.indexOf("const MARK_RUNNING");
  const to = html.indexOf("function thinking(", from);
  assert.ok(from > 0 && to > from, "the chip code was not found in static/index.html");
  return html.slice(from, to);
}

// Just enough DOM for the chip code: an element that can hold children, take a
// class, and hand back its mark.
function element() {
  const node = {
    className: "",
    innerHTML: "",
    kids: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (c) => { if (!node.className.split(" ").includes(c)) node.className += " " + c; },
      remove: (c) => {
        node.className = node.className.split(" ").filter((x) => x !== c).join(" ");
      },
    },
    appendChild: (k) => { node.kids.push(k); },
    querySelector: (sel) =>
      (sel === ".chip-mark" ? (node.mark ||= { innerHTML: node.innerHTML }) : null),
    querySelectorAll: (sel) => {
      assert.equal(sel, ".chip:not(.chip-done)");
      return node.kids.filter(
        (k) => k.className.includes("chip") && !k.className.includes("chip-done"));
    },
  };
  return node;
}

function strip() {
  const log = element();
  const document = { createElement: element, createTextNode: (t) => ({ nodeValue: t }) };
  const api = new Function(
    "document", "log",
    chipSource() + "\nreturn { chipStep, chipFinished, settlePrevious };")(document, log);
  // What is on screen: every chip's words, and whether it is still spinning.
  api.chips = () => log.kids.map((c) => ({
    text: c.kids.map((k) => k.nodeValue).join(""),
    running: !c.className.includes("chip-done"),
  }));
  // The turn as the panel receives it: one event per line, exactly the events
  // app/agents/claude.py and codex.py send.
  api.stream = (events) => {
    for (const ev of events) {
      if (ev.done) api.chipFinished();
      else api.chipStep(ev.label, ev.line);
    }
  };
  return api;
}

const edit = (line) => ({ label: "Rewriting a line", line });
const remake = (line) => ({ label: "Remaking this line", line });
const landed = { done: true };

test("a run of calls to the same tool is one chip listing its lines", () => {
  const s = strip();
  s.stream([edit(1), landed, edit(3), landed,
            remake(1), landed, remake(3), landed]);

  assert.deepEqual(s.chips().map((c) => c.text),
    ["Rewriting lines 1, 3", "Remaking lines 1, 3"]);
  // Every call is back, so both chips are ticked and neither still counts.
  assert.deepEqual(s.chips().map((c) => c.running), [false, false]);
});

test("a chip counts its own run while a call is still out", () => {
  const s = strip();
  s.stream([edit(1), landed, edit(3)]);
  assert.deepEqual(s.chips(), [{ text: "Rewriting lines 1, 3 \u00b7 1 of 2", running: true }]);
  s.stream([landed]);
  assert.deepEqual(s.chips(), [{ text: "Rewriting lines 1, 3", running: false }]);
});

test("one call on its own is not counted at the user", () => {
  const s = strip();
  s.stream([edit(3)]);
  assert.deepEqual(s.chips(), [{ text: "Rewriting line 3", running: true }]);
  s.stream([landed]);
  assert.deepEqual(s.chips(), [{ text: "Rewriting line 3", running: false }]);
});

test("the numbers come out sorted, and a line rewritten twice is named once", () => {
  const s = strip();
  s.stream([edit(3), landed, edit(12), landed, edit(3), landed, edit(2), landed]);
  assert.deepEqual(s.chips().map((c) => c.text), ["Rewriting lines 2, 3, 12"]);
});

test("a step that names no line keeps its label, and repeats do not pile up", () => {
  const s = strip();
  s.stream([{ label: "Reading the script" }, landed,
            { label: "Reading the script" }, landed,
            { label: "Checking the timing" }, landed]);
  assert.deepEqual(s.chips().map((c) => c.text),
    ["Reading the script", "Checking the timing"]);
});

test("a word from the assistant between two edits keeps the order truthful", () => {
  const s = strip();
  s.stream([edit(1), landed]);
  s.settlePrevious();               // what the text, error and done events do
  s.stream([edit(3), landed]);
  assert.deepEqual(s.chips().map((c) => c.text),
    ["Rewriting line 1", "Rewriting line 3"]);
});

test("a run cut short is ticked rather than left counting", () => {
  const s = strip();
  s.stream([edit(1), landed, edit(3)]);   // the second call never comes back
  s.settlePrevious();                     // the turn ends anyway
  assert.deepEqual(s.chips(), [{ text: "Rewriting lines 1, 3", running: false }]);
});
