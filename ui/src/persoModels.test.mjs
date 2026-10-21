// Which Perso voice models the Dubbing model choice offers, what it says of
// each, and which languages each of them can dub into.
//
// Run with: node --test ui/src/persoModels.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, isModelId, languagesFor, modelCaption, modelHint, modelInfo, modelLabel, modelsIn }
  from "./persoModels.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

const ko = { id: "ko", models: ["NIGHTINGALE", "ORIOLE", "WREN"] };
const gb = { id: "en-GB", models: ["ORIOLE", "NIGHTINGALE"] };
const au = { id: "en-AU", models: ["NIGHTINGALE"] };

test("the choice offers every model the list names, the known ones first in their order, Oriole selected first", () => {
  assert.deepEqual(modelsIn([ko, gb, au]), ["ORIOLE", "WREN", "NIGHTINGALE"]);
  assert.deepEqual(modelsIn([{ id: "x", models: ["NEW_ONE", "FINCH", "LINNET_4", "bad id"] }]), ["LINNET_4", "FINCH", "NEW_ONE"]);
  assert.equal(DEFAULT_MODEL, "ORIOLE");
});

test("before the list answers, the known models are offered", () => {
  assert.deepEqual(modelsIn([{ id: "en" }]), ["ORIOLE", "LINNET_4", "LINNET_3", "WREN", "FINCH", "NIGHTINGALE"]);
});

test("a model lists every language that has it, and no other", () => {
  const list = [ko, gb, au];
  assert.deepEqual(languagesFor(list, "NIGHTINGALE").map((l) => l.id), ["ko", "en-GB", "en-AU"]);
  assert.deepEqual(languagesFor(list, "ORIOLE").map((l) => l.id), ["ko", "en-GB"]);
  assert.deepEqual(languagesFor(list, "WREN").map((l) => l.id), ["ko"]);
});

test("an entry that names no models stays under every model", () => {
  // The ten shown until Perso's list answers carry no models.
  assert.deepEqual(languagesFor([{ id: "en" }, au], "WREN").map((l) => l.id), ["en"]);
});

test("a model's name as the screen says it, a new one's made from its id", () => {
  assert.equal(modelLabel("WREN"), "Wren");
  assert.equal(modelLabel("LINNET_4"), "Linnet 4");
  assert.equal(modelLabel("NEW_ONE"), "New One");
  assert.equal(modelLabel("bad id"), "");
  assert.equal(modelLabel(undefined), "");
  assert.equal(isModelId("DODO"), true);
  assert.equal(isModelId("dodo"), false);
});

test("the line under a model and under the choice", () => {
  assert.equal(modelCaption(modelInfo("ORIOLE"), 77), "Default · 1 credits per second · 77 languages");
  assert.equal(modelCaption(modelInfo("NEW_ONE"), 3), "3 languages");
  assert.equal(modelHint(modelInfo("NIGHTINGALE"), 102), "6 credits per second · 102 languages with this model · Perso Pro plan and up");
  assert.equal(modelHint(modelInfo("WREN"), 32), "1 credits per second · 32 languages with this model");
});

// Help says "100+" for every model together; the line under the choice says
// the chosen one's own count, so the two are not read as one number (owner, 2026-10-21).
test("in Korean the line under the choice says the count is this model's", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
  assert.equal(modelHint(modelInfo("ORIOLE"), 77), "1초 1크레딧 · 이 모델은 언어 77개");
  assert.equal(modelCaption(modelInfo("ORIOLE"), 77), "기본 · 1초 1크레딧 · 언어 77개", "the list's own lines stay as they were");
});
