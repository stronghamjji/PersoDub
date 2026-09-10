// The Dub Agent strip talks to a page, a server and a stream, so the tests hand
// it a paper-thin page: elements that are plain objects, a $ that makes more of
// them, a document that creates them, a localStorage that is a Map and a fetch
// that answers from a script -- including the chat's line-per-event body, which
// is handed over a chunk at a time the way the real one arrives.
//
// What is asserted is what the user would see: the words each login state puts
// under a name, a row of the picker, the chip that counts a run of edits, the
// four parts of the strip coming up one by one (and one broken part leaving the
// other three alone), a pick surviving to localStorage, the body of the message
// that goes to /api/agent/chat with the open job's id in it, and Stop.
//
// The numbers and the wording are not this file's opinion: every assertion below
// was first run against static/index.html's own copy of this code as it stood at
// HEAD (`git show HEAD:static/index.html`, the strip's <script type="module">
// block, wrapped in a function against this same fake page) and matched there
// before the code moved out. A word that changes has to change on purpose.
//
// Run with: node --test ui/src/agentStrip.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initAgentStripUi, loginWords, loginKnown, labelFor, aliasOf, chipText,
         menuRow, replyHtml } from "./agentStrip.mjs";

function makeEl(id) {
  const el = {
    id, textContent: "", type: "", title: "", value: "",
    placeholder: "", disabled: false, hidden: false, scrollTop: 0,
    scrollHeight: 0, focused: false,
    style: {}, dataset: {}, attrs: {}, classes: new Set(), listeners: {},
    children: [],
    set innerHTML(v) { this.html = v; if (!v) this.children = []; },
    get innerHTML() { return this.html || ""; },
    querySelector(sel) { return this.qs1 && this.qs1[sel] ? this.qs1[sel] : null; },
    querySelectorAll(sel) {
      if (sel !== ".chip:not(.chip-done)") throw new Error(`unexpected query ${sel}`);
      return this.children.filter((c) => String(c.className).includes("chip")
                                      && !String(c.className).includes("chip-done"));
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(kid) { kid.parent = this; this.children.push(kid); return kid; },
    append(...kids) { this.children.push(...kids); },
    // The thinking dots are taken off the page, not just marked: the log's own
    // children are read back below, and a removed node is not on screen.
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    },
    contains(node) { return this.children.includes(node); },
    focus() { this.focused = true; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
  // className and classList are two views of one thing, as they are in a
  // browser: the chip is given its class as a word and ticked off as a list.
  Object.defineProperty(el, "className", {
    get() { return [...el.classes].join(" "); },
    set(v) { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(...c) { for (const x of c) el.classes.add(x); },
    remove(...c) { for (const x of c) el.classes.delete(x); },
    contains(c) { return el.classes.has(c); },
    toggle(c, on) {
      const want = on === undefined ? !el.classes.has(c) : on;
      if (want) el.classes.add(c); else el.classes.delete(c);
      return want;
    },
  };
  // The chip's mark is looked up by selector. A chip writes it as part of its
  // own HTML, so the fake hands back the same node every time it is asked for.
  el.qs1 = {
    get ".chip-mark"() {
      if (!el.innerHTML.includes("chip-mark")) return null;
      return (el.mark ||= { innerHTML: el.innerHTML });
    },
  };
  return el;
}

/** The words of a node and everything under it -- what the user reads. */
function words(node) {
  if (node.nodeValue !== undefined) return node.nodeValue;
  const own = node.textContent || "";
  return own + node.children.map(words).join("");
}

/** A page, a fetch log, and the globals the strip reads. */
function harness({ agents = [], stored = {}, screen = "done", jobId = "job-1",
                   chat = null, breakPicker = false } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const el = makeEl(id);
      // As the page ships them (static/index.html): three of the nine start
      // hidden, and the picker opening at all depends on it.
      el.hidden = ["assistantState", "assistantMenu", "assistantFold"].includes(id);
      els.set(id, el);
    }
    return els.get(id);
  };
  if (breakPicker) {
    // The one thing the picker does that can throw: writing its own label.
    Object.defineProperty($("assistantModelLabel"), "textContent", {
      set() { throw new Error("no label"); }, get() { return ""; },
    });
  }
  const log = { calls: [], emitted: [], errors: [], timers: [],
                stored: new Map(Object.entries(stored)) };

  const real = { document: globalThis.document, localStorage: globalThis.localStorage,
                 MutationObserver: globalThis.MutationObserver,
                 setTimeout: globalThis.setTimeout,
                 clearTimeout: globalThis.clearTimeout,
                 console: globalThis.console };
  const docListeners = {};
  const body = makeEl("body");
  body.dataset.screen = screen;
  globalThis.document = {
    body,
    activeElement: null,
    createElement: (tag) => { const e = makeEl(tag); e.tag = tag; return e; },
    createTextNode: (t) => ({ nodeValue: t }),
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
  };
  log.fireDoc = async (ev, arg) => {
    for (const fn of docListeners[ev] || []) await fn(arg);
  };
  globalThis.localStorage = {
    getItem: (k) => (log.stored.has(k) ? log.stored.get(k) : null),
    setItem: (k, v) => log.stored.set(k, String(v)),
    removeItem: (k) => log.stored.delete(k),
  };
  // The strip watches document.body for a screen change; nothing here changes
  // the screen behind its back, so the callback is only held.
  globalThis.MutationObserver = class {
    constructor(fn) { log.observer = fn; }
    observe(el, opts) { log.observed = [el.id, opts]; }
  };
  // Held rather than run: the 1.2s second look at the logins and the 12s "still
  // working" line would otherwise fire long after the test is over.
  globalThis.setTimeout = (fn) => { log.timers.push(fn); return log.timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.console = { ...real.console, error: (...a) => log.errors.push(a) };
  log.restore = () => {
    globalThis.document = real.document;
    globalThis.localStorage = real.localStorage;
    globalThis.MutationObserver = real.MutationObserver;
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
    globalThis.console = real.console;
  };

  const fetch = async (url, init = {}) => {
    log.calls.push({ url, method: init.method || "GET", body: init.body,
                     headers: init.headers, signal: init.signal });
    if (url.startsWith("/api/agent/status")) {
      return { ok: true, json: async () => ({ agents }) };
    }
    if (url === "/api/agent/chat") {
      if (!chat) throw new Error("no chat scripted");
      return chat;
    }
    return { ok: true, json: async () => ({}) };
  };

  initAgentStripUi({
    $, fetch,
    getScreen: () => document.body.dataset.screen,
    getJobId: () => jobId,
    emit: (name) => log.emitted.push(name),
  });
  return { $, log, body };
}

/** Let every promise the strip started settle. */
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A chat response whose body hands over one JSON event per line. */
function stream(events, { tail = null } = {}) {
  const enc = new TextEncoder();
  const chunks = events.map((e) => enc.encode(JSON.stringify(e) + "\n"));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return tail ? tail() : { value: undefined, done: true };
        },
      }),
    },
  };
}

/**
 * A chat response the test hands events to one at a time, so a turn can be read
 * WHILE a call is still out -- which is when the chip says how far in it is.
 * `stream` above cannot: it has every event before the strip asks for the first.
 */
function heldStream() {
  const enc = new TextEncoder();
  const waiting = [];   // reads the strip has made and nothing has answered yet
  const ready = [];     // events sent before the strip asked for them
  const hand = (chunk) => (waiting.length ? waiting.shift()(chunk) : ready.push(chunk));
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => new Promise((resolve) => {
          if (ready.length) resolve(ready.shift());
          else waiting.push(resolve);
        }),
      }),
    },
    send: (ev) => hand({ value: enc.encode(JSON.stringify(ev) + "\n"), done: false }),
    end: () => hand({ value: undefined, done: true }),
  };
}

/** Type a message and press Enter, the way the user starts a turn. */
async function say(h, text) {
  h.$("assistantInput").value = text;
  await h.$("assistantInput").fire("keydown", { key: "Enter", isComposing: false,
                                                keyCode: 13, preventDefault() {} });
  await flush(60);
}

/** The chips on screen: what each says, and whether it is still spinning. */
function chips(h) {
  return h.$("assistantLog").children
    .filter((c) => String(c.className).includes("chip"))
    .map((c) => ({ text: words(c), running: !String(c.className).includes("chip-done") }));
}

// The events the server sends per tool call (app/agents/claude.py, codex.py).
const EDIT = (line) => ({ kind: "progress", label: "Rewriting a line", line,
                          tool: "edit_script_line" });
const LANDED = { kind: "progress", done: true };

const CLAUDE = { id: "claude", name: "Claude", installed: true, supported: true,
                 models: ["opus", "sonnet"], logged_in: true, account: "me@example.com" };
const CODEX = { id: "codex", name: "Codex", installed: true, supported: true,
                models: ["gpt"], logged_in: false, login_command: "codex login" };

// -- the pure helpers -----------------------------------------------------

test("what a row says under a name, in every login state", () => {
  // Not asked yet, not installed, not supported: silence, never "signed out".
  assert.equal(loginWords(null), "");
  assert.equal(loginWords({ installed: true, supported: true, logged_in: null }), "");
  assert.equal(loginWords({ installed: false, supported: true, logged_in: true }), "");
  assert.equal(loginWords({ installed: true, supported: false, logged_in: true }), "");
  assert.equal(loginKnown({ installed: true, supported: true, logged_in: false }), true);

  assert.equal(loginWords(CLAUDE), "signed in as me@example.com");
  assert.equal(loginWords({ ...CLAUDE, account: "" }), "signed in");
  // A service's name is not an account: "signed in as claude.ai" said nothing
  // the row's own name had not (user, 2026-09-10). An address is.
  assert.equal(loginWords({ ...CLAUDE, account: "claude.ai" }), "signed in");
  assert.equal(loginWords({ ...CLAUDE, account: "ChatGPT" }), "signed in");
  assert.equal(loginWords(CODEX), "not signed in");
  assert.equal(loginWords({ ...CODEX, login_command: "" }), "not signed in");
});

test("the picker's label names the assistant and the model actually served", () => {
  const chosen = { agent: "claude", model: "opus", name: "Claude" };
  assert.equal(labelFor({ agent: "" }, [], ""), "Model");
  assert.equal(labelFor(chosen, [CLAUDE], ""), "Claude · Opus");
  // The list has not come back: the name saved with the pick stands in.
  assert.equal(labelFor(chosen, [], ""), "Claude · Opus");
  assert.equal(labelFor({ agent: "claude", model: "opus" }, [], ""), "claude · Opus");
  // What the CLI said it ran wins over what was asked for.
  assert.equal(labelFor(chosen, [CLAUDE], "haiku"), "Claude · Haiku");
  assert.equal(labelFor({ agent: "codex", model: "" }, [CODEX], ""), "Codex");

  assert.equal(aliasOf("claude-opus-4-6-20260514"), "opus");
  assert.equal(aliasOf("gpt-5"), "");
  assert.equal(aliasOf(null), "");
});

test("a run of edits is one chip that lists its lines", () => {
  assert.equal(chipText("Reading the script", []), "Reading the script");
  assert.equal(chipText("Rewriting a line", [3]), "Rewriting line 3");
  assert.equal(chipText("Rewriting a line", [1, 3]), "Rewriting lines 1, 3");
  assert.equal(chipText("Remaking this line", [2]), "Remaking line 2");
});

test("the assistant's markdown comes back as three tags and nothing else", () => {
  assert.equal(replyHtml("**bold** and *slanted* and _also_ and `code`"),
    "<strong>bold</strong> and <em>slanted</em> and <em>also</em> and <code>code</code>");
  // Nothing an answer contains can become a tag of its own.
  assert.equal(replyHtml('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("a row of the picker: the name, the reason, the tick and the chevron", () => {
  const real = globalThis.document;
  globalThis.document = {
    createElement: (tag) => { const e = makeEl(tag); e.tag = tag; return e; },
    createTextNode: (t) => ({ nodeValue: t }),
  };
  try {
    const plain = menuRow("Claude", { note: "not installed" });
    assert.equal(plain.type, "button");
    assert.equal(plain.className, "menu-item");
    assert.equal(plain.disabled, false);
    const [name, right] = plain.children;
    assert.equal(name.className, "menu-name");
    assert.equal(words(name), "Claude");
    assert.equal(right.className, "menu-right");
    // A note is text, never markup: a CLI's own words end up here.
    assert.equal(right.textContent, "not installed");
    assert.equal(right.innerHTML, "");

    const off = menuRow("Codex", { sub: "needs a newer version", disabled: true });
    assert.equal(off.disabled, true);
    assert.equal(words(off.children[0]), "Codexneeds a newer version");
    // The reason is an <em> under the name, built as text -- never as markup.
    assert.equal(off.children[0].children[1].tag, "em");
    assert.equal(off.children[0].children[1].innerHTML, "");

    assert.match(menuRow("Opus", { tick: true }).children[1].innerHTML,
      /^<span class="tick"><svg class="icon icon-sm"/);
    assert.match(menuRow("Claude", { chevron: true }).children[1].innerHTML,
      /^<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"\/><\/svg>$/);
  } finally {
    globalThis.document = real;
  }
});

// -- the strip, wired -----------------------------------------------------

test("the four parts come up: the state line, the picker, the input and the button", async () => {
  const h = harness({ agents: [CLAUDE, CODEX] });
  try {
    await flush();
    assert.equal(h.$("assistantState").textContent, "Claude · signed in as me@example.com");
    assert.equal(h.$("assistantModelLabel").textContent, "Claude · Opus");
    assert.equal(h.$("assistantGo").getAttribute("aria-label"), "Send");
    // Nothing typed yet, so there is nothing to send.
    assert.equal(h.$("assistantGo").disabled, true);
    // Nothing was remembered, so the strip opens open -- and says so both ways.
    assert.equal(h.$("assistantFold").getAttribute("aria-expanded"), "true");
    assert.equal(h.$("assistantFold").title, "Hide the conversation");
    assert.equal(h.log.stored.get("persodub.layout.agentOpen"), "1");
    assert.equal(h.$("assistantInput").placeholder, "Ask anything");
    assert.equal(h.$("assistantInput").focused, true);
    // The strip follows the app's screens through document.body alone.
    assert.deepEqual(h.log.observed, ["body", { attributeFilter: ["data-screen"] }]);
    assert.deepEqual(h.log.errors, []);
  } finally { h.log.restore(); }

  // Folded away, as it was left last time: the input row is on its own, so the
  // one line it has says what to ask for.
  const shut = harness({ agents: [CLAUDE], stored: { "persodub.layout.agentOpen": "0" } });
  try {
    await flush();
    assert.equal(shut.$("assistantInput").placeholder,
      `Ask for a fix - e.g. "Shorten line 4 naturally so it matches the original's length"`);
    assert.equal(shut.$("assistantFold").getAttribute("aria-expanded"), "false");
  } finally { shut.log.restore(); }
});

test("a part that throws is said once and leaves the other three working", async () => {
  const h = harness({ agents: [CLAUDE], breakPicker: true });
  try {
    await flush();
    assert.equal(h.$("assistantState").textContent, "Claude · signed in as me@example.com");
    assert.equal(h.$("assistantInput").placeholder, "Ask anything");
    assert.equal(h.$("assistantGo").title, "Send");
    // Said once, however many repaints ran -- and it names the part.
    const said = h.log.errors.filter((a) => String(a[0]).includes("picker"));
    assert.equal(said.length, 1);
    assert.equal(said[0][0], "Dub Agent: the picker failed");
  } finally { h.log.restore(); }
});

test("a job that stopped early locks the row and says why", async () => {
  const h = harness({ agents: [CLAUDE], screen: "failed" });
  try {
    await flush();
    assert.equal(h.$("assistantInput").disabled, true);
    assert.equal(h.$("assistantModelBtn").disabled, true);
    assert.equal(h.$("assistantInput").placeholder,
      "Nothing to fix here - dubbing did not finish");
  } finally { h.log.restore(); }
});

// It used to lock this one too, and the strip was off the page besides. A dub
// in progress is exactly when someone asks the assistant to stop it (user,
// 2026-09-09).
test("a dub in progress leaves the row open", async () => {
  const h = harness({ agents: [CLAUDE], screen: "running" });
  try {
    await flush();
    assert.equal(h.$("assistantInput").disabled, false);
    assert.equal(h.$("assistantModelBtn").disabled, false);
    assert.equal(h.$("assistantGo").getAttribute("aria-label"), "Send");
  } finally { h.log.restore(); }
});

test("picking a model writes the choice down, and a saved one is read back", async () => {
  const h = harness({ agents: [CLAUDE, CODEX] });
  try {
    await flush();
    const menu = h.$("assistantMenu");
    await h.$("assistantModelBtn").fire("click");
    await flush();
    assert.equal(menu.hidden, false);
    // A heading, then one row per assistant.
    assert.deepEqual(menu.children.slice(1).map((r) => words(r.children[0])),
      ["Claudesigned in as me@example.com", "Codexnot signed in"]);

    // Into Codex, then its one model.
    await menu.children[2].fire("click", { stopPropagation() {} });
    await menu.children[1].fire("click");
    assert.equal(JSON.parse(h.log.stored.get("persodub.assistantChoice")).agent, "codex");
    assert.equal(h.$("assistantModelLabel").textContent, "Codex · gpt");
    assert.equal(menu.hidden, true);
  } finally { h.log.restore(); }

  // The saved pick is what the next launch opens on.
  const back = harness({ agents: [CLAUDE, CODEX],
    stored: { "persodub.assistantChoice": '{"agent":"codex","model":"gpt","name":"Codex"}' } });
  try {
    await flush();
    assert.equal(back.$("assistantModelLabel").textContent, "Codex · gpt");
  } finally { back.log.restore(); }
});

// -- a turn ---------------------------------------------------------------

// The strip was unlocked on the running screen but submit() still turned the
// message away, in silence: the words stayed in the box and nothing happened.
// That is exactly what "why won't it stop when I ask?" was (user, 2026-09-09).
test("a message sent while a dub runs actually goes out", async () => {
  const chat = stream([
    { kind: "start", model: "claude-opus-4-6" },
    { kind: "text", text: "Stopping it." },
    { kind: "done" },
  ]);
  const h = harness({ agents: [CLAUDE], chat, screen: "running" });
  try {
    await flush();
    const input = h.$("assistantInput");
    input.value = "중단해줘";
    await input.fire("input", {});
    await h.$("assistantGo").fire("click", {});
    await flush(60);

    const post = h.log.calls.find((c) => c.url === "/api/agent/chat");
    assert.ok(post, "the turn was sent");
    assert.equal(JSON.parse(post.body).message, "중단해줘");
    assert.equal(input.value, "", "and the box is emptied, as on every other screen");
  } finally { h.log.restore(); }
});

test("a message carries the open job, and a rewritten line tells the page twice", async () => {
  const chat = stream([
    { kind: "start", model: "claude-opus-4-6" },
    { kind: "progress", label: "Rewriting a line", line: 4, tool: "edit_script_line" },
    { kind: "progress", done: true },
    { kind: "text", text: "Shortened **line 4**." },
    { kind: "done" },
  ]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    const input = h.$("assistantInput");
    input.value = "Shorten line 4";
    let prevented = false;
    await input.fire("keydown", { key: "Enter", shiftKey: false, isComposing: false,
                                  keyCode: 13, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    await flush(60);

    const post = h.log.calls.find((c) => c.url === "/api/agent/chat");
    assert.equal(post.method, "POST");
    assert.deepEqual(post.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(post.body),
      { message: "Shorten line 4", agent: "claude", model: "opus", job_id: "job-1" });
    // The box is emptied and the strip opened the moment it is sent.
    assert.equal(input.value, "");
    assert.equal(h.log.stored.get("persodub.layout.agentOpen"), "1");

    // Once when the tool was called, once when the turn was over -- the first is
    // for the eye, the second is the one that is certainly true.
    assert.deepEqual(h.log.emitted, ["persodub:script-changed", "persodub:script-changed"]);

    const drawn = h.$("assistantLog").children;
    assert.equal(drawn[0].className, "bubble me");
    assert.equal(drawn[0].textContent, "Shorten line 4");
    const chip = drawn.find((d) => d.className.includes("chip"));
    assert.equal(words(chip), "Rewriting line 4");
    const said = drawn.find((d) => d.className.includes("bubble ai"));
    assert.equal(said.innerHTML, "Shortened <strong>line 4</strong>.");
    // The model the CLI actually ran is what the picker ends up saying.
    assert.equal(h.$("assistantModelLabel").textContent, "Claude · Opus");
  } finally { h.log.restore(); }
});

test("one chip per run of calls, ticked, in the order things happened", async () => {
  // The assistant calls its tool once per line; twenty lines must not become
  // twenty chips. A word from it in between closes the run, so the column stays
  // in the order things actually happened.
  const chat = stream([
    { kind: "progress", label: "Rewriting a line", line: 3, tool: "edit_script_line" },
    { kind: "progress", done: true },
    { kind: "progress", label: "Rewriting a line", line: 1, tool: "edit_script_line" },
    { kind: "progress", done: true },
    { kind: "text", text: "Both shortened." },
    { kind: "progress", label: "Remaking this line", line: 1, tool: "remake_line_voice" },
    { kind: "progress", done: true },
    { kind: "done" },
  ]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    h.$("assistantInput").value = "Shorten lines 1 and 3";
    await h.$("assistantInput").fire("keydown", { key: "Enter", isComposing: false,
                                                  keyCode: 13, preventDefault() {} });
    await flush(60);
    const drawn = h.$("assistantLog").children;
    assert.deepEqual(drawn.map((d) => d.className),
      ["bubble me", "chip chip-done", "bubble ai", "chip chip-done"]);
    // Sorted, said once each, and the label's own "a line" is gone.
    assert.equal(words(drawn[1]), "Rewriting lines 1, 3");
    assert.equal(words(drawn[3]), "Remaking line 1");
    // Every call is back, so both chips wear the tick rather than the spinner.
    assert.equal(drawn[1].mark.innerHTML, drawn[3].mark.innerHTML);
    assert.match(drawn[1].mark.innerHTML, /M5 13l4 4L19 7/);
  } finally { h.log.restore(); }
});

test("a chip counts its own run while a call is still out", async () => {
  const chat = heldStream();
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    await say(h, "Shorten lines 1 and 3");
    chat.send(EDIT(1)); chat.send(LANDED); chat.send(EDIT(3));
    await flush(40);
    // Two calls in the chip and one of them still out: how far in it is is worth
    // saying, because the row is locked until the turn is over.
    assert.deepEqual(chips(h), [{ text: "Rewriting lines 1, 3 · 1 of 2", running: true }]);

    chat.send(LANDED);
    await flush(40);
    // Everything is back, so the count goes and the tick arrives -- without
    // waiting for the turn to end.
    assert.deepEqual(chips(h), [{ text: "Rewriting lines 1, 3", running: false }]);
    chat.end();
    await flush(40);
  } finally { h.log.restore(); }
});

test("one call on its own is not counted at the user", async () => {
  const chat = heldStream();
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    await say(h, "Shorten line 3");
    chat.send(EDIT(3));
    await flush(40);
    // "· 0 of 1" would be noise: there is nothing to be part-way through.
    assert.deepEqual(chips(h), [{ text: "Rewriting line 3", running: true }]);

    chat.send(LANDED);
    await flush(40);
    assert.deepEqual(chips(h), [{ text: "Rewriting line 3", running: false }]);
    chat.end();
    await flush(40);
  } finally { h.log.restore(); }
});

test("the numbers come out sorted, and a line rewritten twice is named once", async () => {
  // 12 after 2 and 3, not between them: they are numbers, not words.
  const chat = stream([EDIT(3), LANDED, EDIT(12), LANDED, EDIT(3), LANDED,
                       EDIT(2), LANDED, { kind: "done" }]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    await say(h, "Shorten lines 2, 3 and 12");
    assert.deepEqual(chips(h).map((c) => c.text), ["Rewriting lines 2, 3, 12"]);
  } finally { h.log.restore(); }
});

test("a step that names no line keeps its label, and repeats do not pile up", async () => {
  const read = { kind: "progress", label: "Reading the script", tool: "get_script" };
  const chat = stream([read, LANDED, read, LANDED,
                       { kind: "progress", label: "Checking the timing", tool: "check_fit" },
                       LANDED, { kind: "done" }]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    await say(h, "Does line 4 fit?");
    // Reading the script twice is one chip -- a step is a step, however many
    // times the assistant takes it -- and the next step is its own.
    assert.deepEqual(chips(h).map((c) => c.text),
      ["Reading the script", "Checking the timing"]);
  } finally { h.log.restore(); }
});

test("a run cut short is ticked rather than left counting", async () => {
  // The second call never comes back and the turn ends anyway: a chip left
  // saying "1 of 2" under a finished turn is counting nothing.
  const chat = stream([EDIT(1), LANDED, EDIT(3), { kind: "done" }]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    await say(h, "Shorten lines 1 and 3");
    assert.deepEqual(chips(h), [{ text: "Rewriting lines 1, 3", running: false }]);
  } finally { h.log.restore(); }
});

test("a remake tells the page once, at the end, and never mid-write", async () => {
  const chat = stream([
    { kind: "progress", label: "Remaking the voices", tool: "remake_voices" },
    { kind: "progress", done: true },
    { kind: "done", text: "Done." },
  ]);
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    const input = h.$("assistantInput");
    input.value = "Remake the voices";
    await input.fire("keydown", { key: "Enter", isComposing: false, keyCode: 13,
                                  preventDefault() {} });
    await flush(60);
    assert.deepEqual(h.log.emitted, ["persodub:voices-remade"]);
    // Nothing was said, so the server's own last word is what shows.
    const said = h.$("assistantLog").children.find((d) => d.className.includes("bubble ai"));
    assert.equal(said.innerHTML, "Done.");
  } finally { h.log.restore(); }
});

test("Stop cuts the stream, asks the server to end the turn, and frees the row", async () => {
  // The stream stalls after its first word, the way a long answer does.
  let release;
  const held = new Promise((r) => { release = r; });
  const chat = stream([{ kind: "text", text: "Working" }],
                      { tail: () => held });
  const h = harness({ agents: [CLAUDE], chat });
  try {
    await flush();
    const input = h.$("assistantInput");
    input.value = "Shorten line 4";
    await input.fire("keydown", { key: "Enter", isComposing: false, keyCode: 13,
                                  preventDefault() {} });
    await flush(40);
    // A turn is on air: the button is Stop, and it can be pressed.
    assert.equal(h.$("assistantGo").title, "Stop");
    assert.equal(h.$("assistantGo").disabled, false);

    await h.$("assistantGo").fire("click");
    await flush();
    const stop = h.log.calls.find((c) => c.url === "/api/agent/stop");
    assert.equal(stop.method, "POST");
    // The row is free again straight away -- the point of Stop is typing next.
    assert.equal(h.$("assistantGo").title, "Send");
    // And the stream it was reading was cut rather than left pouring in.
    const post = h.log.calls.find((c) => c.url === "/api/agent/chat");
    assert.equal(post.signal.aborted, true);
    release({ value: undefined, done: true });
    await flush(40);
  } finally { h.log.restore(); }
});

test("Enter is ignored while an IME is still settling a syllable", async () => {
  const h = harness({ agents: [CLAUDE], chat: stream([{ kind: "done", text: "hi" }]) });
  try {
    await flush();
    const input = h.$("assistantInput");
    input.value = "해";
    await input.fire("keydown", { key: "Enter", isComposing: true, keyCode: 229,
                                  preventDefault() { assert.fail("must not act"); } });
    await input.fire("keydown", { key: "Enter", isComposing: false, keyCode: 229,
                                  preventDefault() { assert.fail("must not act"); } });
    await flush(20);
    assert.equal(h.log.calls.some((c) => c.url === "/api/agent/chat"), false);
    assert.equal(input.value, "해");
  } finally { h.log.restore(); }
});

test("a signed-out choice: the line and the box name both assistants, the log says how once", async () => {
  const h = harness({ agents: [CLAUDE, CODEX],
                      stored: { "persodub.assistantChoice": JSON.stringify({ agent: "codex", model: "gpt", name: "Codex" }) } });
  try {
    await flush();
    assert.equal(h.$("assistantState").textContent, "Sign in to Claude or Codex.");
    assert.equal(h.$("assistantState").classList.contains("warn"), true);
    assert.equal(h.$("assistantInput").placeholder, "Sign in to Claude or Codex");
    // Asked twice (see below), said once -- and only the commands that apply.
    assert.equal(h.log.calls.filter((c) => c.url.startsWith("/api/agent/status")).length, 2);
    assert.deepEqual(h.$("assistantLog").children.map((d) => d.innerHTML),
      ["To sign in, run codex login in Terminal."]);
  } finally { h.log.restore(); }
});

test("with no assistant ready the strip says so once and sends nothing", async () => {
  const h = harness({ agents: [{ id: "claude", name: "Claude", installed: false,
                                 supported: true, models: [] }] });
  try {
    await flush();
    const said = h.$("assistantLog").children.map((d) => d.innerHTML);
    // The list is asked for twice on a screen where the strip is in use (the
    // plain load, then the one that checks logins); the sentence shows once.
    assert.equal(h.log.calls.filter((c) => c.url.startsWith("/api/agent/status")).length, 2);
    assert.deepEqual(said, ["Install Claude Code or Codex."]);
    assert.equal(h.$("assistantInput").placeholder, "Install Claude Code or Codex");
    assert.equal(h.$("assistantModelLabel").textContent, "Model");
  } finally { h.log.restore(); }
});
