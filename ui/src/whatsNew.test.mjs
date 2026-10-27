// Run with: node --test ui/src/whatsNew.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initWhatsNew } from "./whatsNew.mjs";

// The notice's elements, GET /api/whats-new answering `version`, and the
// browser's storage as `store` holds it.
async function launch(version, store) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      els.set(id, { textContent: "", hidden: true, listeners: {}, classList: { add() {}, remove() {} },
                    addEventListener(ev, fn) { this.listeners[ev] = fn; }, replaceChildren() {} });
    }
    return els.get(id);
  };
  const real = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version, notes: ["One thing"] }) });
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const steps = [];
  try {
    initWhatsNew({ $, record: (name, props) => steps.push([name, props]) });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.fetch = real.fetch;
    globalThis.localStorage = real.localStorage;
  }
  return { $, steps };
}

// The charts' update_installed (ui/src/events.mjs): the first launch on a new
// version, once, while the notice stays launch after launch until closed.
test("the first launch after an update is update_installed with its version, once; a fresh install is none", async () => {
  const store = new Map();
  assert.deepEqual((await launch("0.9.1", store)).steps, [], "a fresh install only records the version");
  const first = await launch("0.9.2", store);
  assert.deepEqual(first.steps, [["update_installed", { version: "0.9.2" }]]);
  assert.equal(first.$("updatedNotice").hidden, false);
  const again = await launch("0.9.2", store);
  assert.deepEqual(again.steps, [], "the notice is still up, the step is not taken twice");
  assert.equal(again.$("updatedNotice").hidden, false);
});
