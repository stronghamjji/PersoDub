// The Settings sheet talks to /api/settings and /api/perso/spaces and paints
// real elements, so the tests hand it a paper-thin page: elements that are
// plain objects, a fetch that answers from a script, and a setTimeout that
// records the debounce instead of running it. What is asserted is what the
// user would see (the values in the fields, the options in the picker) and
// what the engine would receive (which endpoints, with which body).
//
// Run with: node --test ui/src/settingsDialog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initSettingsUi } from "./settingsDialog.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", className: "", value: "", type: "", href: "",
    placeholder: "", checked: false, disabled: false, hidden: false,
    style: {}, dataset: {}, children: [], listeners: {},
    attrs: {},
    // The picker empties itself with innerHTML = "", the way the page does.
    set innerHTML(v) { if (v === "") this.children = []; },
    get innerHTML() { return ""; },
    get options() { return this.children; },
    get selectedOptions() { return this.children.filter((o) => o.value === this.value); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      has: (c) => classes.has(c),
    },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    appendChild: function (kid) { this.children.push(kid); },
    append: function (...kids) { this.children.push(...kids); },
    replaceChildren: function () { this.children = []; },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire: async function (ev, arg) { for (const fn of this.listeners[ev] || []) await fn(arg); },
  };
}

/** A page, a fetch log and a stopped clock. `responses` answers per URL. */
function harness({ responses = {} } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { calls: [], bodies: [], timers: [], saved: 0, models: 0, docKeydown: [] };

  const real = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    navigator: globalThis.navigator,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "keydown") state.docKeydown.push(fn); },
  };
  // The reveal button names the file browser after this; Mac is the default here.
  Object.defineProperty(globalThis, "navigator", {
    value: { platform: "MacIntel" }, configurable: true, writable: true,
  });
  globalThis.setTimeout = (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url, opts) => {
    state.calls.push(`${(opts && opts.method) || "GET"} ${url}`);
    if (opts && opts.body) state.bodies.push({ url, body: JSON.parse(opts.body) });
    const r = responses[url];
    if (typeof r === "function") return r();
    return r ?? { ok: true, json: async () => ({}) };
  };
  state.restore = () => {
    globalThis.fetch = real.fetch;
    globalThis.document = real.document;
    Object.defineProperty(globalThis, "navigator", {
      value: real.navigator, configurable: true, writable: true,
    });
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  };

  const api = initSettingsUi({
    $,
    onSaved: () => { state.saved += 1; },
    renderModelsList: () => { state.models += 1; },
  });
  return { $, api, state };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const SAVED = {
  perso_api_key: "perso-key-0123456789abcdef",
  gemini_api_key: "gem-key",
  perso_space_seq: "7",
  perso_signup_link: "https://developers.perso.ai/api-keys?utm=x",
  app_version: "0.5.0",
  analytics_off: true,
};
const SPACES = { spaces: [{ seq: 7, name: "Studio", tier: "Pro", credits: 120 }] };

test("loadSettings fills the fields from GET /api/settings", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);

  await h.api.loadSettings();

  assert.equal(h.$("persoKeyInput").value, SAVED.perso_api_key);
  assert.equal(h.$("geminiKeyInput").value, "gem-key");
  assert.equal(h.$("persoSignupLink").href, SAVED.perso_signup_link);
  assert.equal(h.$("aboutVersion").textContent, "PersoDub 0.5.0");
  // analytics_off: true means the "send counts" switch is OFF.
  assert.equal(h.$("analyticsToggle").checked, false);
  assert.ok(h.state.calls.includes("GET /api/settings"));
});

test("a version of 0.0.0 is not put on screen", async (t) => {
  const h = harness({ responses: { "/api/settings": ok({ ...SAVED, app_version: "0.0.0" }) } });
  t.after(h.state.restore);

  await h.api.loadSettings();

  assert.equal(h.$("aboutVersion").textContent, "");
});

test("a settings request that fails says so in the key fields", async (t) => {
  const h = harness({ responses: { "/api/settings": { ok: false, status: 500, json: async () => ({}) } } });
  t.after(h.state.restore);

  await h.api.loadSettings();

  assert.equal(h.$("persoKeyInput").placeholder, "Unavailable");
  assert.equal(h.$("geminiKeyInput").placeholder, "Unavailable");
});

test("opening loads the settings, repaints the models catalog and shows the sheet", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);

  await h.api.openSettings();

  assert.equal(h.state.models, 1);
  assert.ok(h.$("settingsOverlay").classList.has("open"));
});

test("the saved key's workspaces fill the picker, and one of them is preselected", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);

  await h.api.loadSettings();
  await settle();

  const sel = h.$("persoSpaceSelect");
  assert.deepEqual(sel.children.map((o) => o.textContent), ["Studio (Pro, 120 credits left)"]);
  assert.equal(sel.value, "7");
  assert.equal(sel.disabled, false);
  assert.equal(h.$("persoSpaceWarning").style.display, "none");
  assert.ok(h.state.calls.includes("GET /api/perso/spaces"));
});

test("a 0-credit workspace warns before it can cost a failed dub", async (t) => {
  const zero = { spaces: [{ seq: 7, name: "Studio", tier: "Free", credits: 0 }] };
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(zero) } });
  t.after(h.state.restore);

  await h.api.loadSettings();
  await settle();

  assert.equal(h.$("persoSpaceSelect").children[0].textContent, "Studio (Free, 0 credits left)");
  assert.equal(h.$("persoSpaceWarning").style.display, "");
});

test("a key that has only been typed is previewed: the key is posted, its spaces are painted", async (t) => {
  const preview = { spaces: [{ seq: 3, name: "Team", tier: "Pro", credits: 9 },
                             { seq: 4, name: "Solo", tier: "Free", credits: 0 }] };
  const h = harness({ responses: { "/api/perso/spaces/preview": ok(preview) } });
  t.after(h.state.restore);

  h.$("persoKeyInput").value = "another-key-0123456789abc";
  await h.$("persoKeyInput").fire("blur");
  await settle();

  assert.deepEqual(h.state.bodies.map((b) => b.url), ["/api/perso/spaces/preview"]);
  assert.deepEqual(h.state.bodies[0].body, { api_key: "another-key-0123456789abc" });
  const sel = h.$("persoSpaceSelect");
  assert.deepEqual(sel.children.map((o) => o.textContent),
    ["Choose a workspace…", "Team (Pro, 9 credits left)", "Solo (Free, 0 credits left)"]);
  // Several workspaces and none saved: the user has to choose, so nothing is picked.
  assert.equal(sel.value, "");
});

test("a key too short to be one is not looked up", async (t) => {
  const h = harness();
  t.after(h.state.restore);

  h.$("persoKeyInput").value = "short";
  await h.$("persoKeyInput").fire("blur");
  await settle();

  assert.deepEqual(h.state.calls, []);
});

test("emptying the key field empties the picker instead of leaving the old key's workspaces", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);
  await h.api.loadSettings();
  await settle();

  h.$("persoKeyInput").value = "";
  await h.$("persoKeyInput").fire("blur");

  const sel = h.$("persoSpaceSelect");
  assert.deepEqual(sel.children.map((o) => o.textContent),
    ["Enter a Perso API key to see its workspaces"]);
  assert.equal(sel.disabled, true);
});

test("an edited key posts the change with the workspace chosen for it, then tells the page", async (t) => {
  const preview = { spaces: [{ seq: 3, name: "Team", tier: "Pro", credits: 9 }] };
  const h = harness({
    responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES),
                 "/api/perso/spaces/preview": ok(preview) },
  });
  t.after(h.state.restore);
  await h.api.loadSettings();
  await settle();

  h.$("persoKeyInput").value = "another-key-0123456789abc";
  await h.$("persoKeyInput").fire("blur");   // previews, so the picker holds seq 3
  await settle();
  h.$("geminiKeyInput").value = "new-gem";
  await h.$("persoKeyInput").fire("change");

  const post = h.state.bodies.find((b) => b.url === "/api/settings");
  assert.deepEqual(post.body, {
    gemini_api_key: "new-gem",
    perso_api_key: "another-key-0123456789abc",
    perso_space_seq: "3",
  });
  assert.equal(h.$("settingsSaveError").style.display, "none");
  assert.equal(h.state.saved, 1);   // onSaved: the page re-checks its engines
});

test("nothing edited posts nothing, but the page is still told", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);
  await h.api.loadSettings();
  await settle();
  h.state.calls.length = 0;

  await h.$("geminiKeyInput").fire("change");

  assert.deepEqual(h.state.calls, []);
  assert.equal(h.state.saved, 1);
});

test("a save the engine refuses shows the alert", async (t) => {
  const h = harness({
    responses: { "/api/settings": () => ({ ok: false, status: 500, json: async () => ({}) }) },
  });
  t.after(h.state.restore);

  h.$("geminiKeyInput").value = "new-gem";
  await h.$("geminiKeyInput").fire("change");

  assert.equal(h.$("settingsSaveError").style.display, "");
});

test("closing the sheet hides it and saves what was still in the fields", async (t) => {
  const h = harness();
  t.after(h.state.restore);

  h.$("geminiKeyInput").value = "typed-then-escaped";
  h.$("settingsOverlay").classList.add("open");
  h.api.closeSettings();
  await settle();

  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
  const post = h.state.bodies.find((b) => b.url === "/api/settings");
  assert.equal(post.body.gemini_api_key, "typed-then-escaped");
});

test("Escape closes the sheet only while it is open", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  const onKey = h.state.docKeydown[0];
  assert.ok(onKey, "the sheet has to answer Escape");

  await onKey({ key: "Escape" });        // shut: nothing to do
  assert.deepEqual(h.state.calls, []);

  h.$("settingsOverlay").classList.add("open");
  await onKey({ key: "a" });             // any other key leaves it open
  assert.equal(h.$("settingsOverlay").classList.has("open"), true);
  await onKey({ key: "Escape" });
  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
});

test("Show keys unmasks both fields and the button offers the way back", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.$("persoKeyInput").type = "password";
  h.$("geminiKeyInput").type = "password";

  await h.$("showKeysToggle").fire("click");
  assert.equal(h.$("persoKeyInput").type, "text");
  assert.equal(h.$("geminiKeyInput").type, "text");
  assert.equal(h.$("showKeysToggle").textContent, "Hide keys");

  await h.$("showKeysToggle").fire("click");
  assert.equal(h.$("persoKeyInput").type, "password");
  assert.equal(h.$("showKeysToggle").textContent, "Show keys");
});

test("the finished-videos button is named for this computer and asks the engine to open the folder", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  assert.equal(h.$("revealOutputBtn").textContent, "Show in Finder");

  await h.$("revealOutputBtn").fire("click");

  assert.deepEqual(h.state.calls, ["POST /api/settings/reveal-output"]);
  assert.equal(h.$("storageHint").textContent, "");
});

test("a folder that will not open says so under the button", async (t) => {
  const h = harness({
    responses: { "/api/settings/reveal-output": { ok: false, status: 500, json: async () => ({}) } },
  });
  t.after(h.state.restore);

  await h.$("revealOutputBtn").fire("click");

  assert.equal(h.$("storageHint").textContent,
    "Could not open the folder. Is the engine running?");
});

test("the usage-counts switch posts the new setting", async (t) => {
  const h = harness();
  t.after(h.state.restore);

  h.$("analyticsToggle").checked = false;
  await h.$("analyticsToggle").fire("change");

  assert.deepEqual(h.state.bodies, [{ url: "/api/settings", body: { analytics_off: true } }]);
  assert.equal(h.$("analyticsToggle").checked, false);
  assert.equal(h.$("analyticsHint").textContent, "");
});

test("a usage-counts save that fails flips the switch back", async (t) => {
  const h = harness({
    responses: { "/api/settings": { ok: false, status: 500, json: async () => ({}) } },
  });
  t.after(h.state.restore);

  h.$("analyticsToggle").checked = true;
  await h.$("analyticsToggle").fire("change");

  assert.equal(h.$("analyticsToggle").checked, false);
  assert.equal(h.$("analyticsHint").textContent, "Could not save that. Is the engine running?");
});

test("Acknowledgements folds open and shut", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.$("ackList").hidden = true;

  await h.$("ackToggle").fire("click");
  assert.equal(h.$("ackList").hidden, false);
  assert.equal(h.$("ackToggle").attrs["aria-expanded"], "true");

  await h.$("ackToggle").fire("click");
  assert.equal(h.$("ackList").hidden, true);
  assert.equal(h.$("ackToggle").attrs["aria-expanded"], "false");
});

/** Let the module's own awaits run out (its fetches resolve immediately). */
function settle() { return new Promise((r) => setImmediate(r)); }
