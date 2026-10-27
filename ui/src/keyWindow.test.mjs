// Run with: node --test ui/src/keyWindow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initKeyWindow } from "./keyWindow.mjs";

// The window's elements, the four dropdowns that need a key, and the page's
// fetch answering POST /api/settings with `saved`.
function harness({ saved = true } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        id, value: "", textContent: "", hidden: false, disabled: false, href: "", options: [], selectedOptions: [], listeners: {},
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
        async fire(ev, e = {}) { for (const fn of this.listeners[ev] || []) await fn(e); },
        replaceChildren() {}, focus() {}, dispatchEvent() {},
      });
    }
    return els.get(id);
  };
  const real = { fetch: globalThis.fetch, document: globalThis.document };
  globalThis.document = { addEventListener() {} };
  globalThis.fetch = async () => ({ ok: saved, json: async () => ({}) });
  const steps = [];
  const win = initKeyWindow({ $, keySaved: { perso: false, gemini: false }, onSaved: () => {},
                              record: (name, props) => steps.push([name, props]) });
  const restore = () => { globalThis.fetch = real.fetch; globalThis.document = real.document; };
  return { $, win, steps, restore };
}

// The charts' key_saved (ui/src/events.mjs): which kind of key, and whether it
// was saved -- never the key.
test("Save in the key window is a step with the kind of key and whether it was saved, never the key", async (t) => {
  const ok = harness();
  t.after(ok.restore);
  ok.win.askKey("gemini", null, null);
  ok.$("keyInput").value = "AIza-secret-key";
  await ok.$("keySave").fire("click");
  assert.deepEqual(ok.steps, [["key_saved", { ok: true, kind: "gemini" }]]);
  ok.restore();
  const refused = harness({ saved: false });
  t.after(refused.restore);
  refused.win.askKey("gemini", null, null);
  refused.$("keyInput").value = "AIza-secret-key";
  await refused.$("keySave").fire("click");
  assert.deepEqual(refused.steps, [["key_saved", { ok: false, kind: "gemini" }]]);
  assert.ok(!JSON.stringify([ok.steps, refused.steps]).includes("secret"));
});
