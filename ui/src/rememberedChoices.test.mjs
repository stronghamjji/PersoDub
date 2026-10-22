// Run with: node --test ui/src/rememberedChoices.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readRemembered, rememberChoice, choicesToPutBack } from "./rememberedChoices.mjs";

function storage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}
// A storage the browser has blocked: every read and write throws.
const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };

const DEFAULTS = { dub_mode: "local", separation: "local", stt: "local", translator: "chatgpt",
                   voice_quality: "fast", voice: "qwen3" };
const ALL_KEYS = { perso: true, gemini: true };
const setup = (over = {}) => ({ defaults: DEFAULTS, keys: ALL_KEYS, models: [], ...over });

// The Windows B7 run (2026-10-06): Perso API with Wren, as the person chose it.
function rememberB7(s) {
  for (const [name, value] of [["dubMode", "perso"], ["persoModel", "WREN"], ["target", "ko"],
                               ["sep", "perso"], ["stt", "perso"], ["translator", "gemini"],
                               ["quality", "high"], ["voice", "qwen3"], ["speakers", "2"]]) {
    rememberChoice(s, name, value, DEFAULTS);
  }
}

test("nothing remembered, or a storage that cannot be read, puts nothing back", () => {
  assert.deepEqual(readRemembered(storage()), {});
  assert.deepEqual(readRemembered(blocked), {});
  assert.deepEqual(readRemembered(null), {});
  assert.deepEqual(readRemembered(storage({ "persodub.lastChoices": "not json" })), {});
  assert.deepEqual(choicesToPutBack(readRemembered(storage()), setup()), {});
  // Remembering into a blocked storage is a no-op, not an error.
  rememberChoice(blocked, "dubMode", "perso", DEFAULTS);
  rememberChoice(null, "dubMode", "perso", DEFAULTS);
});

test("every choice the person made comes back, the paid Perso ones too", () => {
  const s = storage();
  rememberB7(s);
  assert.deepEqual(choicesToPutBack(readRemembered(s), setup()), {
    dubMode: "perso", persoModel: "WREN", target: "ko", sep: "perso", stt: "perso",
    translator: "gemini", quality: "high", voice: "qwen3", speakers: "2",
  });
  // The next choice of the same control replaces it; the others stay.
  rememberChoice(s, "persoModel", "NIGHTINGALE", DEFAULTS);
  assert.equal(choicesToPutBack(readRemembered(s), setup()).persoModel, "NIGHTINGALE");
  assert.equal(choicesToPutBack(readRemembered(s), setup()).dubMode, "perso");
});

test("a choice that needs a key no longer saved gives way to the default, and stays remembered", () => {
  const s = storage();
  rememberB7(s);
  const back = choicesToPutBack(readRemembered(s), setup({ keys: { perso: false, gemini: false } }));
  for (const name of ["dubMode", "sep", "stt", "translator"]) assert.equal(back[name], undefined, name);
  // What needs no key still comes back.
  assert.equal(back.persoModel, "WREN");
  assert.equal(back.quality, "high");
  // Nothing was overwritten: with the key back, so is the choice.
  assert.equal(choicesToPutBack(readRemembered(s), setup()).dubMode, "perso");
});

test("a local translator no longer downloaded gives way; one that is here, or coming, stays", () => {
  const s = storage();
  rememberChoice(s, "translator", "hunyuan", DEFAULTS);
  const rows = (state) => ({ models: [{ id: "ollama-runtime", state: "ready" }, { id: "hunyuan", state }] });
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("not_downloaded"))).translator, undefined);
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("ready"))).translator, "hunyuan");
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("downloading"))).translator, "hunyuan");
});

test("the RoFormer gives way once it is no longer downloaded, like a local translator", () => {
  const s = storage();
  rememberChoice(s, "sep", "roformer", DEFAULTS);
  const rows = (state) => ({ models: [{ id: "engine", state: "ready" }, { id: "vocal-separator", state }] });
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("not_downloaded"))).sep, undefined);
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("ready"))).sep, "roformer");
  rememberChoice(s, "sep", "local", DEFAULTS);
  assert.equal(choicesToPutBack(readRemembered(s), setup(rows("not_downloaded"))).sep, "local", "Demucs needs no download");
});

test("a saved default changed since the choice was made (the Dub Agent's set_default) wins", () => {
  const s = storage();
  rememberChoice(s, "dubMode", "local", DEFAULTS);
  rememberChoice(s, "quality", "high", DEFAULTS);
  const changed = setup({ defaults: { ...DEFAULTS, dub_mode: "perso" } });
  assert.equal(choicesToPutBack(readRemembered(s), changed).dubMode, undefined);
  assert.equal(choicesToPutBack(readRemembered(s), changed).quality, "high");
});

test("without the app's setup only the choices that need nothing from it come back", () => {
  const s = storage();
  rememberB7(s);
  assert.deepEqual(choicesToPutBack(readRemembered(s), null),
                   { persoModel: "WREN", target: "ko", speakers: "2" });
});

test("a Perso model that is no model id, or a speaker count that is not a number, is left out", () => {
  // Any model id is put back (one Perso adds is offered without an app
  // update); the dialog falls back to the default when Perso's list no longer has it.
  const s = storage();
  rememberChoice(s, "persoModel", "not a model", DEFAULTS);
  rememberChoice(s, "speakers", "two", DEFAULTS);
  assert.deepEqual(choicesToPutBack(readRemembered(s), setup()), {});
  // An emptied speaker count is a choice too: back to Auto-detect.
  rememberChoice(s, "speakers", "", DEFAULTS);
  assert.equal(choicesToPutBack(readRemembered(s), setup()).speakers, "");
});
