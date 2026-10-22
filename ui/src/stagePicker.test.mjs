// The four stage buttons of Advanced options: what their lists say (every
// choice, the models not downloaded included, with size and state) and that
// a pick goes through the hidden <select> the rest of the page listens to.
//
// Run with: node --test ui/src/stagePicker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stageView, stateWord, choiceReady, initStagePickers } from "./stagePicker.mjs";

const ROWS = {
  engine: { id: "engine", role: "pack", bytes: 2.0e9, state: "ready" },
  "ollama-runtime": { id: "ollama-runtime", role: "pack", bytes: 0.46e9, state: "not_downloaded" },
  demucs: { id: "demucs", role: "sep", bytes: 0.081e9, state: "ready", comes_with: "engine" },
  "vocal-separator": { id: "vocal-separator", role: "sep", bytes: 0.913e9, state: "not_downloaded" },
  whisper: { id: "whisper", role: "stt", bytes: 3.091e9, state: "ready" },
  hunyuan: { id: "hunyuan", role: "translate", bytes: 1.1e9, state: "downloading", progress: 43 },
  gemma: { id: "gemma", role: "translate", bytes: 8.149e9, state: "paused" },
  "qwen3-tts": { id: "qwen3-tts", role: "tts", bytes: 4.544e9, state: "downloading", progress: null },
};
const rowOf = (id) => ROWS[id] || null;
const select = (value, options, disabled = false) =>
  ({ value, disabled, options: options.map(([v, text]) => ({ value: v, textContent: text })) });

test("the separation list holds every choice, the RoFormer not downloaded included", () => {
  const view = stageView("sep", select("local", [["local", "Demucs"], ["roformer", "Mel-Band RoFormer"], ["perso", "Perso API"]]), rowOf);
  assert.deepEqual(view.options.map((o) => [o.name, o.line, o.state && o.state.text, o.on]), [
    ["Demucs", "Default · Fast · 0.1 GB", "Ready", true],
    ["Mel-Band RoFormer", "Cleaner background · Slower · 0.9 GB", "Not downloaded", false],
    ["Perso API", "Most accurate · Perso credits", null, false],
  ]);
  assert.equal(view.name, "Demucs");
  assert.equal(view.ready, true, "Demucs is here, so its button says Ready");
});

test("each model says its state in a word or two, a download its percent", () => {
  assert.deepEqual(stateWord({ state: "ready" }), { text: "Ready", cls: "st-ok" });
  assert.deepEqual(stateWord({ state: "downloading", progress: 43 }), { text: "Downloading 43%", cls: "st-busy" });
  assert.deepEqual(stateWord({ state: "downloading", progress: null }), { text: "Getting ready…", cls: "st-busy" });
  assert.deepEqual(stateWord({ state: "paused" }), { text: "Paused", cls: "st-busy" });
  assert.deepEqual(stateWord({ state: "not_downloaded" }), { text: "Not downloaded", cls: "st-before" });
});

test("the translation list sizes the two local models and leaves the two services bare", () => {
  const view = stageView("translate", select("chatgpt", [["chatgpt", "ChatGPT"], ["hunyuan", "Hunyuan (1.8B)"],
                                                         ["gemma", "Gemma 3 (12B)"], ["gemini", "Gemini API"]]), rowOf);
  assert.deepEqual(view.options.map((o) => [o.line, o.state && o.state.text]), [
    ["ChatGPT sign-in · No download", null],
    ["Small and fast · 1.1 GB", "Downloading 43%"],
    ["Bigger and more careful · 8.1 GB", "Paused"],
    ["Most accurate · Gemini key", null],
  ]);
  assert.equal(view.ready, false, "ChatGPT downloads nothing, so it has no Ready");
});

test("Ready only once the model and the pack it runs in are both here", () => {
  assert.equal(choiceReady("stt", "local", rowOf), true);
  assert.equal(choiceReady("stt", "local", (id) => (id === "engine" ? { state: "downloading" } : rowOf(id))), false);
  assert.equal(choiceReady("translate", "hunyuan", (id) => (id === "hunyuan" ? { state: "ready" } : rowOf(id))), false,
               "Hunyuan is here, Ollama is not");
  assert.equal(choiceReady("voice", "qwen3", rowOf), false);
  assert.equal(choiceReady("stt", "perso", rowOf), false);
  // Greyed for a Perso dubbing: no Ready on a choice that will not run.
  assert.equal(stageView("stt", select("local", [["local", "Whisper"]], true), rowOf).ready, false);
});

test("every line the lists say is in the page's tables", () => {
  const lines = [];
  for (const [role, opts] of [["sep", ["local", "roformer", "perso"]], ["stt", ["local", "perso"]],
                              ["translate", ["chatgpt", "hunyuan", "gemma", "gemini"]], ["voice", ["qwen3"]]]) {
    const view = stageView(role, select(opts[0], opts.map((v) => [v, v])), () => null);
    lines.push(...view.options.map((o) => o.line));
  }
  lines.push("Not downloaded");
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.deepEqual(lines.filter((s) => !Object.hasOwn(table, s)), [], `missing from ui.${code}.json`);
  }
});

// A page thin enough to run the buttons on: elements that keep their
// children, attributes and listeners, and a document that makes them.
function makeEl(tag) {
  const el = {
    tag, id: "", className: "", textContent: "", hidden: false, disabled: false, value: "",
    type: "", dataset: {}, style: {}, attrs: {}, children: [], parent: null, listeners: {},
    offsetHeight: 90,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(kid) { kid.parent = this; this.children.push(kid); return kid; },
    append(...kids) { for (const k of kids) this.appendChild(k); },
    replaceChildren(...kids) { this.children = []; this.append(...kids); },
    after(kid) { const p = this.parent; kid.parent = p; p.children.splice(p.children.indexOf(this) + 1, 0, kid); },
    remove() { const p = this.parent; if (p) p.children.splice(p.children.indexOf(this), 1); this.parent = null; },
    contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    dispatchEvent(e) { (this.events ||= []).push(e.type); for (const fn of this.listeners[e.type] || []) fn(e); },
    click() { this.dispatchEvent({ type: "click" }); },
    focus() { globalThis.document.activeElement = this; },
    getBoundingClientRect: () => ({ left: 10, right: 310, top: 100, bottom: 124, width: 300 }),
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, "").split(/[.:]/)[0];
      const out = [];
      const walk = (n) => { for (const k of n.children) { if (k.className.split(" ").includes(cls)) out.push(k); walk(k); } };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    get options() { return this.children; },
  };
  return el;
}

function page() {
  const row = makeEl("div");
  const label = makeEl("label");
  const els = {};
  for (const [id, opts] of [["sepSelect", [["local", "Demucs"], ["roformer", "Mel-Band RoFormer"], ["perso", "Perso API"]]],
                            ["sttSelect", [["local", "Whisper"], ["perso", "Perso API"]]],
                            ["translateSelect", [["chatgpt", "ChatGPT"], ["hunyuan", "Hunyuan (1.8B)"]]],
                            ["voiceSelect", [["qwen3", "Qwen3-TTS"]]]]) {
    const sel = makeEl("select");
    sel.id = id;
    sel.value = opts[0][0];
    for (const [v, text] of opts) { const o = makeEl("option"); o.value = v; o.textContent = text; sel.appendChild(o); }
    row.appendChild(sel);
    els[id] = sel;
  }
  const real = { document: globalThis.document, setTimeout: globalThis.setTimeout };
  globalThis.document = Object.assign(makeEl("document"), {
    createElement: makeEl,
    querySelector: (sel) => (sel === 'label[for="sepSelect"]' ? label : null),
  });
  globalThis.setTimeout = () => 0;   // the list's first focus; nothing waits on it here
  return { els, label, restore: () => Object.assign(globalThis, real) };
}

test("a button takes the select's place, and a pick sets the select and fires its change", (t) => {
  const p = page();
  t.after(p.restore);
  const { paint } = initStagePickers({ $: (id) => p.els[id], rowOf });
  const sel = p.els.sepSelect;
  const btn = sel.parent.children[sel.parent.children.indexOf(sel) + 1].children[0];
  assert.equal(sel.hidden, true);
  assert.equal(btn.id, "sepSelectBtn");
  assert.equal(btn.getAttribute("aria-labelledby"), "sepSelectLabel sepSelectBtn", "the field's label names it");
  assert.deepEqual(btn.children.map((c) => [c.className, c.textContent]),
                   [["model-name", "Demucs"], ["model-state st-ok", "Ready"]]);

  const changes = [];
  sel.addEventListener("change", () => changes.push(sel.value));
  btn.click();
  const list = btn.parent.children[1];
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(list.tabIndex, -1, "the list can take the focus itself (ui/src/pickList.mjs)");
  assert.deepEqual(list.children.map((o) => o.dataset.value), ["local", "roformer", "perso"]);
  const roformer = list.children[1];
  assert.equal(roformer.children[0].children[1].children[0].textContent, "Not downloaded");
  roformer.click();
  assert.deepEqual(changes, ["roformer"]);
  assert.deepEqual(sel.events, ["focus", "change"], "focus first: the key window keeps the value to put back");
  assert.equal(btn.parent.children.length, 1, "the list is gone");
  assert.equal(globalThis.document.activeElement, btn);
  assert.deepEqual(btn.children.map((c) => c.textContent), ["Mel-Band RoFormer"], "not here yet: no Ready");

  // A value set without a change event (the saved defaults put back) shows at the next paint.
  sel.value = "perso";
  paint();
  assert.deepEqual(btn.children.map((c) => c.textContent), ["Perso API"]);
});

test("the greyed select greys its button, and picking the same choice again changes nothing", (t) => {
  const p = page();
  t.after(p.restore);
  const { paint } = initStagePickers({ $: (id) => p.els[id], rowOf });
  const sel = p.els.sttSelect;
  const btn = sel.parent.children[sel.parent.children.indexOf(sel) + 1].children[0];
  sel.disabled = true;
  paint();
  assert.equal(btn.disabled, true);
  assert.deepEqual(btn.children.map((c) => c.textContent), ["Perso"], "Perso does the stage, and no Ready");
  assert.equal(sel.value, "local", "the choice for this computer is kept underneath");
  sel.disabled = false;
  paint();
  assert.deepEqual(btn.children.map((c) => c.textContent), ["Whisper", "Ready"], "back in sight with Local model");
  btn.click();
  btn.parent.children[1].children[0].click();
  assert.equal(sel.events, undefined, "Whisper again: no change for the page to answer");
});
