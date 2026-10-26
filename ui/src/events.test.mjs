import test from "node:test";
import assert from "node:assert/strict";
import { SCREEN_EVENT, createCollector, pressedName, slug, startEvents } from "./events.mjs";

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
