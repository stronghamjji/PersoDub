// Run with: node --test ui/src/homeSidebar.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { homeAgentHidden, initHomeSidebar, openHomeAgent, whatsNewTitle } from "./homeSidebar.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, value: "", textContent: "", dataset: {}, listeners: {}, focused: false, events: [],
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire(ev, arg) { for (const fn of this.listeners[ev] || []) fn(arg); },
    click() { this.fire("click"); },
    dispatchEvent(e) { this.events.push(e.type); },
    focus() { this.focused = true; },
  };
}

function makeBody(screen, classes = []) {
  const set = new Set(classes);
  return {
    dataset: { screen },
    classList: {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    },
  };
}

function harness({ screen = "home", classes = [], version = "0.7.1" } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const body = makeBody(screen, classes);
  // Pressing the hidden fold is what opens the strip on the page.
  $("assistantFold").addEventListener("click", () => body.classList.toggle("agent-open", !body.classList.contains("agent-open")));
  const log = { urls: [], calls: [], events: [] };
  const realWindow = globalThis.window;
  globalThis.window = { dispatchEvent: (e) => log.events.push(e.type) };
  log.restore = () => { globalThis.window = realWindow; };
  initHomeSidebar({
    $, body, repoUrl: "https://example.test/owner/PersoDub",
    persoUrl: () => "https://perso.test/workspace/vt?utm_content=home",
    openUrl: (u) => log.urls.push(u),
    onDubbing: () => log.calls.push("dub"),
    onErase: () => log.calls.push("erase"),
    onAudio: () => log.calls.push("audio"),
    onSaveVideo: () => log.calls.push("save"),
    onSettings: (...args) => log.calls.push(`settings(${args.length})`),
    onHelp: () => log.calls.push("help"),
    loadWhatsNew: async () => ({ version }),
  });
  return { $, body, log };
}

const clickOn = (target) => ({ target: { closest: (sel) => (sel === "[data-prompt]" ? target : null) } });

test("the agent column is held back on Home only, until Home opens it", () => {
  assert.equal(homeAgentHidden(makeBody("home")), true);
  assert.equal(homeAgentHidden(makeBody("home", ["home-agent"])), false);
  assert.equal(homeAgentHidden(makeBody("done")), false);
});

test("the GitHub button opens the repo, perso.ai the workspace link, and Send feedback the issues page", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("homeGhName").fire("click");
  h.$("homePerso").fire("click");
  h.$("homeFeedback").fire("click");
  assert.deepEqual(h.log.urls, [
    "https://example.test/owner/PersoDub",
    "https://perso.test/workspace/vt?utm_content=home",
    "https://example.test/owner/PersoDub/issues",
  ]);
});

test("the tool items and the four tool cards open the same four ways in", (t) => {
  const h = harness();
  t.after(h.log.restore);
  for (const id of ["homeNavDub", "homeNavAudio", "homeNavErase", "homeNavSave",
                    "homeDubCard", "homeAudioCard", "homeEraseCard", "homeSaveCard"]) {
    h.$(id).fire("click", {});
  }
  assert.deepEqual(h.log.calls, ["dub", "audio", "erase", "save", "dub", "audio", "erase", "save"]);
});

// Projects left the Management group (2026-10-21); Settings is its one item.
test("Settings opens the dialog with no section named, and Projects is not wired", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("homeNavSettings").fire("click", { type: "click" });
  assert.deepEqual(h.log.calls, ["settings(0)"]);
  assert.equal(h.$("homeNavProjects").listeners.click, undefined);
});

test("Help opens the Help dialog and nothing else", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("homeHelp").fire("click");
  assert.deepEqual(h.log.calls, ["help"]);
  assert.deepEqual(h.log.urls, []);
});

test("the What's new card asks the update window to open, and names the version", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("homeWhatsNew").fire("click");
  assert.deepEqual(h.log.events, ["persodub:open-update"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.$("homeWhatsNewTitle").textContent, "What’s new in 0.7.1");
});

// The update module may have named a downloaded update on the card before
// the running version's answer came in; that answer does not write over it.
test("the What's new card keeps an update's ready title", async (t) => {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  $("homeWhatsNew").classList.add("ready");
  $("homeWhatsNewTitle").textContent = "Update 0.8.6 is ready";
  const realWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  t.after(() => { globalThis.window = realWindow; });
  const none = () => {};
  initHomeSidebar({ $, body: makeBody("home"), repoUrl: "", persoUrl: () => "", openUrl: none, onDubbing: none,
    onErase: none, onSaveVideo: none, onSettings: none, onHelp: none, loadWhatsNew: async () => ({ version: "0.8.5" }) });
  await new Promise((r) => setImmediate(r));
  assert.equal($("homeWhatsNewTitle").textContent, "Update 0.8.6 is ready");
});

test("a build with no version number says just What's new", () => {
  assert.equal(whatsNewTitle("0.0.0"), "What’s new");
  assert.equal(whatsNewTitle(""), "What’s new");
});

test("a chip opens the agent with its sentence in the box, not sent", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("homeAgentCard").fire("click", clickOn({ dataset: { prompt: "Fix lines that run long" } }));
  assert.equal(h.body.classList.contains("home-agent"), true);
  assert.equal(h.body.classList.contains("agent-open"), true);
  assert.equal(h.$("assistantInput").value, "Fix lines that run long");
  assert.deepEqual(h.$("assistantInput").events, ["input"]);
  assert.equal(h.$("assistantInput").focused, true);
  assert.equal(homeAgentHidden(h.body), false);
});

test("the card's button opens the agent as it is, and never closes an open one", (t) => {
  const h = harness({ classes: ["agent-open"] });
  t.after(h.log.restore);
  h.$("assistantInput").value = "half a question";
  h.$("homeAgentCard").fire("click", clickOn(null));
  assert.equal(h.body.classList.contains("agent-open"), true);
  assert.equal(h.$("assistantInput").value, "half a question");
  assert.deepEqual(h.$("assistantInput").events, []);
});

test("openHomeAgent works from the top bar's pane button too", () => {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const body = makeBody("home");
  let presses = 0;
  $("assistantFold").addEventListener("click", () => { presses++; body.classList.add("agent-open"); });
  openHomeAgent($, body);
  assert.equal(presses, 1);
  assert.equal(homeAgentHidden(body), false);
});
