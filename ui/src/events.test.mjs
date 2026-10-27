import test from "node:test";
import assert from "node:assert/strict";
import { SCREEN_EVENT, cleanProps, createCollector, mediaKind, pressedName, record, slug, startEvents } from "./events.mjs";

// The least of an element pressedName needs: closest() over its own chain of
// parents, an id, its data- words, and the first marked child.
function el({ tag = "button", id = "", i18n, aria, child, parent = null, role } = {}) {
  const node = {
    tag, id, role, parentElement: parent,
    dataset: { ...(i18n !== undefined ? { i18n } : {}), ...(aria ? { i18nAriaLabel: aria } : {}) },
    querySelector: () => (child ? { dataset: { i18n: child } } : null),
    closest(sel) {
      for (let n = this; n; n = n.parentElement) {
        if (sel === "[id]" ? n.id : (["button", "a", "summary"].includes(n.tag) || (n.role && sel.includes(`[role=${n.role}]`)))) return n;
      }
      return null;
    },
  };
  return node;
}

test("ids become snake_case names, at most 40 long, and must start with a letter", () => {
  assert.equal(slug("homeNavSettings"), "home_nav_settings");
  assert.equal(slug("settingsTab-privacy"), "settings_tab_privacy");
  assert.equal(slug("Save changes"), "save_changes");
  assert.equal(slug("x".repeat(60)).length, 40);
  assert.equal(pressedName(el({ id: "2col" })), null);
});

test("a press is named by its id, then its English words, then the nearest id around it", () => {
  assert.equal(pressedName(el({ id: "homeNavSettings" })), "home_nav_settings");
  assert.equal(pressedName(el({ i18n: "Save" })), "save");
  assert.equal(pressedName(el({ aria: "Close" })), "close");
  assert.equal(pressedName(el({ child: "Download" })), "download");
  const icon = { tag: "svg", id: "", dataset: {}, parentElement: el({ id: "settingsSaveBtn" }) };
  icon.closest = el().closest;
  assert.equal(pressedName(icon), "settings_save_btn", "a press on the icon inside a button is the button's");
  assert.equal(pressedName(el({ tag: "div", role: "tab", id: "leftTab-script" })), "left_tab_script");
});

test("a button named only by what the person wrote is recorded by where it is, never by its words", () => {
  // A project card's button: its text and aria-label are the project's name.
  const card = el({ tag: "div", id: "queueRows" });
  const b = el({ parent: card });
  b.textContent = "My wedding video";
  b.ariaLabel = "More for My wedding video";
  assert.equal(pressedName(b), "in_queue_rows");
  assert.equal(pressedName(el({ parent: el({ tag: "div" }) })), null);
  assert.equal(pressedName({ tag: "div", closest: () => null }), null, "not on something pressable");
  assert.equal(pressedName(null), null);
});

test("nothing is kept until the shell says recording is on, and an empty batch is how the page asks", async () => {
  const sent = [];
  let on = false;
  const c = createCollector({ send: async (list) => { sent.push(list); return { on }; }, now: () => 7 });
  c.record("save", "home");
  await c.flush();
  assert.deepEqual(sent, [[]]);
  on = true;
  await c.flush();
  c.record("save", "home");
  c.record("cancel", "a-very-long-screen-name-that-goes-on-and-on");
  await c.flush();
  assert.deepEqual(sent[2], [{ name: "save", screen: "home", t: 7 }, { name: "cancel", screen: "a_very_long_screen_name_that_goe", t: 7 }]);
  on = false;
  await c.flush();
  c.record("save", "home");
  await c.flush();
  assert.deepEqual(sent.slice(3), [[], []], "turned off: nothing more is recorded");
});

test("a shell that does not answer is off", async () => {
  const c = createCollector({ send: async () => { throw new Error("gone"); } });
  await c.flush();
  assert.equal(c.isOn(), false);
});

test("500 presses are sent at once rather than waiting for the half minute", async () => {
  const sent = [];
  const c = createCollector({ send: async (list) => { sent.push(list.length); return { on: true }; } });
  await c.flush();
  for (let i = 0; i < 500; i += 1) c.record("save", "home");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [0, 500]);
});

test("startEvents: one capture listener, screen changes, every 30 s and as the page goes away", async () => {
  const docListeners = {};
  const winListeners = {};
  let observer = null;
  let every = 0;
  const sent = [];
  const doc = {
    body: { dataset: { screen: "home" } },
    visibilityState: "visible",
    addEventListener: (ev, fn, capture) => { docListeners[ev] = { fn, capture }; },
  };
  const win = {
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    setInterval: (fn, ms) => { every = ms; },
    addEventListener: (ev, fn) => { winListeners[ev] = fn; },
  };
  const shell = { sendEvents: async (list) => { sent.push(list); return { on: true }; } };
  startEvents({ doc, win, shell });
  await new Promise((r) => setImmediate(r));
  assert.equal(docListeners.click.capture, true);
  assert.equal(every, 30000);
  docListeners.click.fn({ target: el({ id: "homeNavSettings" }) });
  doc.body.dataset.screen = "done";
  observer();
  observer();
  winListeners.pagehide();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.at(-1).map((e) => [e.name, e.screen]),
    [[SCREEN_EVENT, "home"], ["home_nav_settings", "home"], [SCREEN_EVENT, "done"]]);
  assert.equal(startEvents({ doc, win, shell: undefined }), null, "outside the desktop shell it does nothing");
});

// ---- The steps (0.9.1) ------------------------------------------------------------

// A page in the shell, as startEvents sees it: the document's listeners, the
// screen observer, a clock the test moves, and every batch the shell was sent.
function shellPage({ on = true, screen = "home" } = {}) {
  const docListeners = {};
  const winListeners = {};
  let observer = null;
  let clock = 1793000000000;
  const sent = [];
  const doc = {
    body: { dataset: { screen } },
    visibilityState: "visible",
    addEventListener: (ev, fn) => { docListeners[ev] = fn; },
  };
  const win = {
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    setInterval: () => {},
    addEventListener: (ev, fn) => { winListeners[ev] = fn; },
  };
  const shell = { sendEvents: async (list) => { sent.push(list); return { on }; } };
  startEvents({ doc, win, shell, now: () => clock });
  const page = {
    doc, sent,
    tick: (ms) => { clock += ms; },
    go: (name) => { doc.body.dataset.screen = name; observer(); },
    on: (ev, e) => docListeners[ev](e),
    out: async () => { await new Promise((r) => setImmediate(r)); winListeners.pagehide(); await new Promise((r) => setImmediate(r)); return sent.flat(); },
  };
  return page;
}
const steps = (events) => events.filter((e) => e.props && e.name !== SCREEN_EVENT).map((e) => [e.name, e.props]);

test("a step recorded as the page loads waits for the shell's first answer, and goes with it or is dropped", async () => {
  const sent = [];
  let on = true;
  const c = createCollector({ send: async (list) => { sent.push(list); return { on }; }, now: () => 7 });
  c.record("update_installed", "home", { version: "0.9.2" });
  await c.flush();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [[], [{ name: "update_installed", screen: "home", t: 7, props: { version: "0.9.2" } }]]);
  on = false;
  const off = createCollector({ send: async (list) => { sent.push(list); return { on }; } });
  off.record("update_installed", "home", { version: "0.9.2" });
  await off.flush();
  await off.flush();
  assert.deepEqual(sent.slice(2), [[], []], "off: the early step is dropped");
});

test("record() is a step on the screen the person is on, with its props held to their shape", async () => {
  const page = shellPage({ screen: "done" });
  record("dub_started", { mode: "local", target_lang: "ko", minutes: 2.6, title: "My wedding", file: "a b.mp4" });
  assert.deepEqual(steps(await page.out()), [["dub_started", { mode: "local", target_lang: "ko", minutes: 3 }]]);
  assert.deepEqual(cleanProps({ ok: true, n: 1.4, word: "perso-dubbing", Bad: 1, text: "Hello there" }), { ok: true, n: 1, word: "perso-dubbing" });
});

test("a screen change says the screen before it and how long that one was up", async () => {
  const page = shellPage();
  await new Promise((r) => setImmediate(r));
  page.tick(12_400);
  page.go("running");
  page.tick(3_000);
  page.go("done");
  const screens = (await page.out()).filter((e) => e.name === SCREEN_EVENT);
  assert.deepEqual(screens.map((e) => [e.screen, e.props]), [
    ["home", {}],
    ["running", { previous_screen: "home", seconds_on_previous: 12 }],
    ["done", { previous_screen: "running", seconds_on_previous: 3 }],
  ]);
});

test("a video or a sound picked or dropped is media_added by its kind alone; a subtitle file is not media", async () => {
  const page = shellPage();
  const file = (name, type) => ({ name, type });
  page.on("change", { target: { type: "file", files: [file("My wedding.mp4", "video/mp4")] } });
  page.on("change", { target: { type: "text", value: "https://x.y/v" } });
  page.on("drop", { dataTransfer: { files: [file("voice.wav", "audio/wav"), file("subs.srt", "")] } });
  page.on("drop", { dataTransfer: { files: [] } });
  const out = await page.out();
  assert.deepEqual(steps(out), [["media_added", { source: "file", kind: "video" }], ["media_added", { source: "drop", kind: "audio" }]]);
  assert.ok(!JSON.stringify(out).includes("wedding"), "never the file's name");
  assert.equal(mediaKind({ type: "image/png" }), "");
});

test("a recharge or key link pressed is its own step beside the press", async () => {
  const page = shellPage();
  page.on("click", { target: el({ tag: "a", id: "draftRechargeLink" }) });
  page.on("click", { target: el({ tag: "a", id: "keyLink" }) });
  page.on("click", { target: el({ id: "homeNavSettings" }) });
  const out = await page.out();
  assert.deepEqual(out.filter((e) => e.name !== SCREEN_EVENT).map((e) => [e.name, e.props]), [
    ["draft_recharge_link", undefined], ["recharge_opened", { from: "draft" }],
    ["key_link", undefined], ["signup_link_opened", { from: "key_window" }],
    ["home_nav_settings", undefined],
  ]);
});
