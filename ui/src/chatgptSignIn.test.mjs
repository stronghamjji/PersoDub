// The ChatGPT sign-in window says whose sign-in it asks for: a dub's
// ("Translation uses your ChatGPT account.", then "Starting...") or the Dub
// Agent's ("Codex uses your ChatGPT account.", then "Ready"). One video and a
// draft hand it a retry of their own, and those were given the agent's words
// (2026-10-10). The page here is paper-thin: elements that are plain objects,
// a server that says signed in at the first look, and waits that are over at
// once, so a Sign In press runs to its end inside the test.
//
// Run with: node --test ui/src/chatgptSignIn.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initChatgptSignIn } from "./chatgptSignIn.mjs";

function makeEl() {
  const classes = new Set();
  const listeners = [];
  return {
    textContent: "", innerHTML: "", hidden: false, firstElementChild: { style: {} },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    addEventListener: (ev, fn) => listeners.push(fn),
    // Awaits the window's own handler, so a Sign In press is over when this is.
    click: () => Promise.all(listeners.map((fn) => fn())),
  };
}

function harness() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  const real = { window: globalThis.window, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const windowListeners = [];
  globalThis.window = { addEventListener: (name, fn) => windowListeners.push({ name, fn }) };
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (url === "/api/agent/status?login=1" ? { agents: [{ id: "chatgpt", logged_in: true }] } : {}),
  });
  globalThis.setTimeout = (fn) => setImmediate(fn);
  // What each sign-in went on with, and the window's line at that moment.
  const ran = [];
  const signIn = initChatgptSignIn({
    $, startDubbing: async () => { ran.push(["startDubbing", $("csLine").textContent]); },
    onTranslateHere: () => { ran.push(["translate here"]); },
  });
  return {
    $, signIn, ran,
    line: () => $("csLine").textContent,
    // What ui/src/agentStrip.mjs's emit does: the event, with what to do next as its detail.
    agentAsks: (then) => windowListeners
      .filter((l) => l.name === "persodub:chatgpt-signin")
      .forEach((l) => l.fn({ detail: then })),
    restore: () => {
      globalThis.window = real.window;
      globalThis.fetch = real.fetch;
      globalThis.setTimeout = real.setTimeout;
    },
  };
}

test("a dub asks with the translation words, with its own retry (one video, a draft) or none (a batch)", async () => {
  const page = harness();
  try {
    page.signIn.askChatgptSignIn(() => { page.ran.push(["retry", page.line()]); });
    assert.equal(page.line(), "Translation uses your ChatGPT account.");
    await page.$("csSignIn").click();

    page.signIn.askChatgptSignIn();
    assert.equal(page.line(), "Translation uses your ChatGPT account.");
    await page.$("csSignIn").click();

    assert.deepEqual(page.ran, [["retry", "✓ Starting…"], ["startDubbing", "✓ Starting…"]]);
  } finally {
    page.restore();
  }
});

test("the Dub Agent's sign-in asks with the Codex words, and a dub after it has its own again", async () => {
  const page = harness();
  try {
    page.agentAsks(() => { page.ran.push(["agent", page.line()]); });
    assert.equal(page.line(), "Codex uses your ChatGPT account.");
    await page.$("csSignIn").click();
    assert.deepEqual(page.ran, [["agent", "✓ Ready"]]);

    page.signIn.askChatgptSignIn(() => {});
    assert.equal(page.line(), "Translation uses your ChatGPT account.");
  } finally {
    page.restore();
  }
});

// A dub's window also offers the way round the sign-in: translate with a
// local model (Hunyuan) instead. Without it a user with no ChatGPT account stopped
// here unless they knew the Advanced options (owner, 2026-10-18).
test("a dub's window offers translating with a local model, and the Dub Agent's does not", () => {
  const page = harness();
  try {
    page.signIn.askChatgptSignIn(() => {});
    assert.equal(page.$("csLocal").hidden, false);
    page.agentAsks(() => {});
    assert.equal(page.$("csLocal").hidden, true, "Codex has no translator to switch");
  } finally {
    page.restore();
  }
});

test("translating with a local model switches the translator, closes the window and goes on with the dub", async () => {
  const page = harness();
  try {
    page.signIn.askChatgptSignIn(() => { page.ran.push(["retry"]); });
    await page.$("csLocal").click();
    assert.deepEqual(page.ran, [["translate here"], ["retry"]]);
    assert.equal(page.$("chatgptSignInOverlay").classList.contains("open"), false);
  } finally {
    page.restore();
  }
});

test("the link is gone while the sign-in runs", async () => {
  const page = harness();
  try {
    page.signIn.askChatgptSignIn(() => {});
    await page.$("csSignIn").click();
    assert.equal(page.$("csLocal").hidden, true);
  } finally {
    page.restore();
  }
});
