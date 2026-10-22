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
import { readFileSync } from "node:fs";
import { initSettingsUi, SETTINGS_TABS } from "./settingsDialog.mjs";
import { currentLanguage, setLanguage } from "./i18n.mjs";

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
    focus: function () { this.focused = true; },
    addEventListener: function (ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    fire: async function (ev, arg) { for (const fn of this.listeners[ev] || []) await fn(arg); },
  };
}

/** A page, a fetch log and a stopped clock. `responses` answers per URL;
    `shell` stands in for the desktop shell, none for a browser. */
function harness({ responses = {}, refreshModelCatalog = null, shell = null } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { calls: [], bodies: [], timers: [], saved: 0, models: 0, docKeydown: [],
                  stored: new Map(), startedAgain: 0 };

  const real = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.document = {
    documentElement: {},
    body: { dataset: {} },
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "keydown") state.docKeydown.push(fn); },
  };
  globalThis.localStorage = {
    getItem: (k) => (state.stored.has(k) ? state.stored.get(k) : null),
    setItem: (k, v) => state.stored.set(k, String(v)),
    removeItem: (k) => state.stored.delete(k),
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
    globalThis.localStorage = real.localStorage;
    Object.defineProperty(globalThis, "navigator", {
      value: real.navigator, configurable: true, writable: true,
    });
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  };

  const api = initSettingsUi({
    $,
    onSaved: () => { state.saved += 1; },
    refreshModelCatalog: () => { state.models += 1; return refreshModelCatalog && refreshModelCatalog($); },
    startAgain: () => { state.startedAgain += 1; },
    shell,
  });
  return { $, api, state };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const SAVED = {
  perso_api_key: "perso-key-for-this-test",
  gemini_api_key: "gem-key",
  perso_space_seq: "7",
  perso_signup_link: "https://developers.perso.ai/api-keys?utm=x",
  app_version: "0.5.0",
  analytics_off: true,
};
const SPACES = { spaces: [{ seq: 7, name: "Studio", tier: "Pro", credits: 120 }] };

test("loadSavedSetup fills the fields from GET /api/settings", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);

  await h.api.loadSavedSetup();

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

  await h.api.loadSavedSetup();

  assert.equal(h.$("aboutVersion").textContent, "");
});

test("a settings request that fails says so in the key fields", async (t) => {
  const h = harness({ responses: { "/api/settings": { ok: false, status: 500, json: async () => ({}) } } });
  t.after(h.state.restore);

  await h.api.loadSavedSetup();

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

  await h.api.loadSavedSetup();
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

  await h.api.loadSavedSetup();
  await settle();

  assert.equal(h.$("persoSpaceSelect").children[0].textContent, "Studio (Free, 0 credits left)");
  assert.equal(h.$("persoSpaceWarning").style.display, "");
});

test("a key that has only been typed is previewed: the key is posted, its spaces are painted", async (t) => {
  const preview = { spaces: [{ seq: 3, name: "Team", tier: "Pro", credits: 9 },
                             { seq: 4, name: "Solo", tier: "Free", credits: 0 }] };
  const h = harness({ responses: { "/api/perso/spaces/preview": ok(preview) } });
  t.after(h.state.restore);

  h.$("persoKeyInput").value = "another-key-for-this-test";
  await h.$("persoKeyInput").fire("blur");
  await settle();

  assert.deepEqual(h.state.bodies.map((b) => b.url), ["/api/perso/spaces/preview"]);
  assert.deepEqual(h.state.bodies[0].body, { api_key: "another-key-for-this-test" });
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
  await h.api.loadSavedSetup();
  await settle();

  h.$("persoKeyInput").value = "";
  await h.$("persoKeyInput").fire("blur");

  const sel = h.$("persoSpaceSelect");
  assert.deepEqual(sel.children.map((o) => o.textContent),
    ["Add a Perso API key first"]);
  assert.equal(sel.disabled, true);
});

test("an edited key is posted with the workspace chosen for it when Save is pressed, then the page is told", async (t) => {
  const preview = { spaces: [{ seq: 3, name: "Team", tier: "Pro", credits: 9 }] };
  const h = harness({
    responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES),
                 "/api/perso/spaces/preview": ok(preview) },
  });
  t.after(h.state.restore);
  await h.api.openSettings();
  await settle();

  h.$("persoKeyInput").value = "another-key-for-this-test";
  await h.$("persoKeyInput").fire("blur");   // previews, so the picker holds seq 3
  await settle();
  h.$("geminiKeyInput").value = "new-gem";
  await h.$("geminiKeyInput").fire("input");
  assert.equal(h.state.bodies.some((b) => b.url === "/api/settings"), false, "nothing saves before Save");
  assert.equal(h.$("settingsChanges").textContent, "2 changes");
  assert.equal(h.$("settingsSaveBtn").disabled, false);

  await h.$("settingsSaveBtn").fire("click");

  const post = h.state.bodies.find((b) => b.url === "/api/settings");
  assert.deepEqual(post.body, {
    gemini_api_key: "new-gem",
    perso_api_key: "another-key-for-this-test",
    perso_space_seq: "3",
  });
  assert.equal(h.state.saved, 1);   // onSaved: the page re-checks its engines
  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
});

test("with nothing changed Save rests and nothing is posted", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);
  await h.api.openSettings();
  await settle();

  assert.equal(h.$("settingsSaveBtn").disabled, true);
  assert.equal(h.$("settingsChanges").textContent, "");
  assert.equal(h.state.bodies.length, 0);
});

test("a save the engine refuses keeps the sheet open and says so beside Save", async (t) => {
  const h = harness({
    responses: { "/api/settings": () => ({ ok: false, status: 500, json: async () => ({}) }) },
  });
  t.after(h.state.restore);
  h.$("settingsOverlay").classList.add("open");

  h.$("geminiKeyInput").value = "new-gem";
  await h.api.saveSettings();

  assert.equal(h.$("settingsOverlay").classList.has("open"), true);
  assert.equal(h.$("settingsChanges").textContent, "Could not save. Is PersoDub running?");
});

test("Cancel with nothing changed closes at once; closing from code leaves without saving", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  // As the sheet shows them before it has read anything: both switches on.
  h.$("analyticsToggle").checked = true;
  h.$("reportsToggle").checked = true;

  h.$("settingsOverlay").classList.add("open");
  await h.$("settingsCancelBtn").fire("click");
  await settle();
  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
  assert.equal(h.$("settingsDiscardOverlay").classList.has("open"), false, "nothing to ask about");

  h.$("geminiKeyInput").value = "typed-then-closed";
  h.$("settingsOverlay").classList.add("open");
  h.api.closeSettings();
  await settle();
  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
  assert.equal(h.state.bodies.some((b) => b.url === "/api/settings"), false);
});

test("Cancel with something typed asks once: Keep editing stays, Discard leaves without saving", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  // As the sheet shows them before it has read anything: both switches on.
  h.$("analyticsToggle").checked = true;
  h.$("reportsToggle").checked = true;

  h.$("geminiKeyInput").value = "typed-then-cancelled";
  h.$("settingsOverlay").classList.add("open");
  await h.$("settingsCancelBtn").fire("click");
  assert.equal(h.$("settingsDiscardOverlay").classList.has("open"), true);
  assert.equal(h.$("settingsOverlay").classList.has("open"), true, "still there under the question");

  await h.$("settingsDiscardKeep").fire("click");
  assert.equal(h.$("settingsDiscardOverlay").classList.has("open"), false);
  assert.equal(h.$("settingsOverlay").classList.has("open"), true);
  assert.equal(h.$("geminiKeyInput").value, "typed-then-cancelled", "what was typed is kept");

  await h.$("settingsCancelBtn").fire("click");
  await h.$("settingsDiscardYes").fire("click");
  await settle();
  assert.equal(h.$("settingsDiscardOverlay").classList.has("open"), false);
  assert.equal(h.$("settingsOverlay").classList.has("open"), false);
  assert.equal(h.state.bodies.some((b) => b.url === "/api/settings"), false);
});

test("Escape closes the sheet only while it is open", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  // As the sheet shows them before it has read anything: both switches on.
  h.$("analyticsToggle").checked = true;
  h.$("reportsToggle").checked = true;
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

test("the Show keys switch unmasks both fields, and masks them again when turned off", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.$("persoKeyInput").type = "password";
  h.$("geminiKeyInput").type = "password";

  h.$("showKeysToggle").checked = true;
  await h.$("showKeysToggle").fire("change");
  assert.equal(h.$("persoKeyInput").type, "text");
  assert.equal(h.$("geminiKeyInput").type, "text");

  h.$("showKeysToggle").checked = false;
  await h.$("showKeysToggle").fire("change");
  assert.equal(h.$("persoKeyInput").type, "password");
  assert.equal(h.$("geminiKeyInput").type, "password");
});

test("the finished-videos button is named for this computer and asks the engine to open the folder", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  assert.equal(h.$("revealOutputBtn").textContent, "Show in Finder");

  await h.$("revealOutputBtn").fire("click");

  assert.deepEqual(h.state.calls, ["POST /api/settings/reveal-output"]);
  assert.equal(h.$("storageHint").textContent, "");
});

// The folder Change in the Download dialog picks (owner, 2026-10-22): Storage
// says it in one line and has nothing to change it with.
test("Storage says where downloads go, as the shell says it each time the sheet opens", async (t) => {
  let now = { folder: "/Users/me/Downloads", chosen: "", missing: false };
  const h = harness({ shell: { downloadFolder: async () => now } });
  t.after(h.state.restore);
  const opened = async () => { await h.api.openSettings(); await new Promise((r) => setImmediate(r)); };

  await opened();
  assert.equal(h.$("downloadFolderRow").hidden, false);
  assert.equal(h.$("downloadFolderLine").textContent, "Download folder: /Users/me/Downloads");
  now = { folder: "/Volumes/Work SSD", chosen: "/Volumes/Work SSD", missing: false };
  await opened();
  assert.equal(h.$("downloadFolderLine").textContent, "Download folder: /Volumes/Work SSD");
  // Gone (a drive taken out): the folder the files go to meanwhile.
  now = { folder: "/Users/me/Downloads", chosen: "/Volumes/Work SSD", missing: true };
  await opened();
  assert.equal(h.$("downloadFolderLine").textContent, "Download folder: /Users/me/Downloads");
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Download folder: {path}"], "다운로드 폴더: {path}");
});

test("in a browser, which saves where it is set to, Storage has no download-folder line", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.$("downloadFolderRow").hidden, true);
  assert.equal(h.$("downloadFolderLine").textContent, "");
});

test("the download-folder line is a line of words in Storage, with nothing to press", () => {
  const page = readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
  const storage = page.slice(page.indexOf('id="settingsPanel-storage"'), page.indexOf('id="settingsPanel-privacy"'));
  const row = /<div class="set-row" id="downloadFolderRow" hidden>([^]*?)<\/div>/.exec(storage);
  assert.ok(row, "the row is in the Storage panel");
  assert.equal(row[1].trim(), '<span class="set-line" id="downloadFolderLine"></span>');
});

test("a folder that will not open says so under the button", async (t) => {
  const h = harness({
    responses: { "/api/settings/reveal-output": { ok: false, status: 500, json: async () => ({}) } },
  });
  t.after(h.state.restore);

  await h.$("revealOutputBtn").fire("click");

  assert.equal(h.$("storageHint").textContent,
    "Could not open the folder.");
});

test("the two switches are saved with Save, each as its own setting", async (t) => {
  const h = harness({ responses: { "/api/settings": ok({ analytics_off: false, reports_off: false }) } });
  t.after(h.state.restore);
  await h.api.openSettings();

  h.$("analyticsToggle").checked = false;
  await h.$("analyticsToggle").fire("change");
  h.$("reportsToggle").checked = false;
  await h.$("reportsToggle").fire("change");
  assert.equal(h.$("settingsChanges").textContent, "2 changes");

  await h.$("settingsSaveBtn").fire("click");

  assert.deepEqual(h.state.bodies.map((b) => b.body),
    [{ analytics_off: true }, { reports_off: true }]);
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

// ---------------- the five tabs ----------------
const selected = (h) => SETTINGS_TABS.filter((t) => h.$(`settingsTab-${t}`).attrs["aria-selected"] === "true");
const showing = (h) => SETTINGS_TABS.filter((t) => h.$(`settingsPanel-${t}`).hidden === false);
const tick = () => new Promise((r) => setImmediate(r));

test("the tabs are Models, API keys, Storage, Privacy and About", () => {
  assert.deepEqual(SETTINGS_TABS, ["models", "keys", "storage", "privacy", "about"]);
});

test("the gear opens on Models the first time, one tab selected and one panel showing", async (t) => {
  const h = harness();
  t.after(h.state.restore);

  // The gear hands over its click event, which is not a tab.
  await h.api.openSettings({ type: "click" });

  assert.deepEqual(selected(h), ["models"]);
  assert.deepEqual(showing(h), ["models"]);
  assert.equal(h.$("settingsTab-models").tabIndex, 0);
  assert.equal(h.$("settingsTab-keys").tabIndex, -1);
});

test("clicking a tab shows its panel alone", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();

  await h.$("settingsTab-privacy").fire("click");

  assert.deepEqual(selected(h), ["privacy"]);
  assert.deepEqual(showing(h), ["privacy"]);
  assert.equal(h.api.currentTab(), "privacy");
});

test("the arrow keys move along the tabs and wrap, Home and End go to the ends", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();
  const press = (from, key) => h.$(`settingsTab-${from}`).fire("keydown", { key, preventDefault() {} });

  await press("models", "ArrowRight");
  assert.deepEqual(selected(h), ["keys"]);
  assert.equal(h.$("settingsTab-keys").focused, true);
  await press("keys", "ArrowLeft");
  await press("models", "ArrowLeft");
  assert.deepEqual(selected(h), ["about"]);
  await press("about", "ArrowRight");
  assert.deepEqual(selected(h), ["models"]);
  await press("models", "End");
  assert.deepEqual(showing(h), ["about"]);
  await press("about", "Home");
  assert.deepEqual(showing(h), ["models"]);
  // Any other key is left alone.
  await press("models", "a");
  assert.deepEqual(showing(h), ["models"]);
});

test("the sheet reopens on the tab last chosen", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();
  await h.$("settingsTab-storage").fire("click");
  h.api.closeSettings();

  await h.api.openSettings();

  assert.deepEqual(showing(h), ["storage"]);
});

test("a way in that needs a key opens API keys, and does not change the tab to come back to", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();
  await h.$("settingsTab-about").fire("click");
  h.api.closeSettings();

  await h.api.openSettings("keys");
  assert.deepEqual(showing(h), ["keys"]);
  h.api.closeSettings();

  await h.api.openSettings();
  assert.deepEqual(showing(h), ["about"]);
});

test("a model that needs attention opens Models, whatever tab was last", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  await h.api.openSettings();
  await h.$("settingsTab-privacy").fire("click");
  h.api.closeSettings();
  h.$("modelsFold").dataset.attention = "1";

  await h.api.openSettings();

  assert.deepEqual(showing(h), ["models"]);
});

test("a model problem found just after opening moves to Models, unless a tab was chosen meanwhile", async (t) => {
  const late = async ($) => { await tick(); $("modelsFold").dataset.attention = "1"; };
  const h = harness({ refreshModelCatalog: late });
  t.after(h.state.restore);
  await h.api.openSettings();
  await h.$("settingsTab-about").fire("click");
  h.api.closeSettings();
  h.$("modelsFold").dataset.attention = "";

  await h.api.openSettings();
  assert.deepEqual(showing(h), ["about"]);
  await tick(); await tick();
  assert.deepEqual(showing(h), ["models"]);

  h.api.closeSettings();
  h.$("modelsFold").dataset.attention = "";
  await h.api.openSettings();
  await h.$("settingsTab-storage").fire("click");
  await tick(); await tick();
  assert.deepEqual(showing(h), ["storage"]);
});

test("a key asked for wins over a model that needs attention", async (t) => {
  const h = harness();
  t.after(h.state.restore);
  h.$("modelsFold").dataset.attention = "1";

  await h.api.openSettings("keys");
  await tick();

  assert.deepEqual(showing(h), ["keys"]);
});

test("Save rests until something changed, and rests again when it is changed back", async (t) => {
  const h = harness({ responses: { "/api/settings": ok(SAVED), "/api/perso/spaces": ok(SPACES) } });
  t.after(h.state.restore);
  await h.api.openSettings();
  assert.equal(h.$("settingsSaveBtn").disabled, true);
  assert.equal(h.$("settingsChanges").textContent, "");

  h.$("geminiKeyInput").value = "another-key";
  await h.$("geminiKeyInput").fire("input");
  assert.equal(h.$("settingsSaveBtn").disabled, false);
  assert.equal(h.$("settingsChanges").textContent, "1 change");

  h.$("geminiKeyInput").value = "gem-key";
  await h.$("geminiKeyInput").fire("input");
  assert.equal(h.$("settingsSaveBtn").disabled, true);
  assert.equal(h.$("settingsChanges").textContent, "");
});

// ---------------- the language (About) ----------------
test("the language picker shows the saved setting, and Auto when there is none", async (t) => {
  const h = harness({ responses: { "/api/settings": ok({ ui_language: "ko" }) } });
  t.after(h.state.restore);
  await h.api.loadSavedSetup();
  assert.equal(h.$("uiLanguageSelect").value, "ko");

  const older = harness({ responses: { "/api/settings": ok({}) } });
  t.after(older.state.restore);
  await older.api.loadSavedSetup();
  assert.equal(older.$("uiLanguageSelect").value, "auto");
});

test("a changed language is one change, saved with Save, and the page starts again in it", async (t) => {
  const h = harness({ responses: { "/api/settings": ok({ ui_language: "auto" }) } });
  t.after(h.state.restore);
  await h.api.openSettings();

  h.$("uiLanguageSelect").value = "ko";
  await h.$("uiLanguageSelect").fire("change");
  assert.equal(h.$("settingsChanges").textContent, "1 change");

  await h.$("settingsSaveBtn").fire("click");

  assert.deepEqual(h.state.bodies.map((b) => b.body), [{ ui_language: "ko" }]);
  // Started again from the saved setting, which is what every screen reads.
  assert.equal(h.state.startedAgain, 1);
});

test("while the Dub Agent is answering, a changed language redraws the page in place instead", async (t) => {
  const h = harness({ responses: { "/api/settings": ok({ ui_language: "auto" }) } });
  t.after(h.state.restore);
  // Leaving the page would end the agent's turn (app/api/agent.py).
  globalThis.document.body.dataset.agentTurn = "on";
  // The redraw walks the page's marked words; this page has none.
  globalThis.document.querySelectorAll = () => [];
  t.after(() => setLanguage("en"));
  await h.api.openSettings();

  h.$("uiLanguageSelect").value = "ko";
  await h.$("uiLanguageSelect").fire("change");
  await h.$("settingsSaveBtn").fire("click");

  assert.deepEqual(h.state.bodies.map((b) => b.body), [{ ui_language: "ko" }]);
  assert.equal(h.state.startedAgain, 0);
  assert.ok(h.state.calls.includes("GET /i18n/ui.ko.json"), "the Korean table was read");
  assert.equal(currentLanguage(), "ko");
});

test("a sheet that could not read the settings has no language change to save", async (t) => {
  const h = harness({ responses: { "/api/settings": { ok: false, status: 503, json: async () => ({}) } } });
  t.after(h.state.restore);
  await h.api.openSettings();
  const before = h.$("settingsChanges").textContent;
  h.$("uiLanguageSelect").value = "ko";
  await h.$("uiLanguageSelect").fire("change");
  assert.equal(h.$("settingsChanges").textContent, before);
});
