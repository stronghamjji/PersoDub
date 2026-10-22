// Which Perso voice models the Dubbing model choice offers, what it says of
// each, and which languages each of them can dub into.
//
// Run with: node --test ui/src/persoModels.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, defaultLanguages, defaultModelFor, isModelId, languagesFor, modelCaption, modelHint, modelInfo,
         modelLabel, modelsIn } from "./persoModels.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

const ko = { id: "ko", models: ["NIGHTINGALE", "ORIOLE", "WREN"] };
const gb = { id: "en-GB", models: ["ORIOLE", "NIGHTINGALE"] };
const au = { id: "en-AU", models: ["NIGHTINGALE"] };

test("the choice offers every model the list names, the known ones first in their order, Linnet 4 the default", () => {
  assert.deepEqual(modelsIn([ko, gb, au]), ["ORIOLE", "WREN", "NIGHTINGALE"]);
  assert.deepEqual(modelsIn([{ id: "x", models: ["NEW_ONE", "FINCH", "LINNET_4", "bad id"] }]), ["LINNET_4", "FINCH", "NEW_ONE"]);
  assert.equal(DEFAULT_MODEL, "LINNET_4");
});

// Perso's own API default since 2026-10-12, which the app follows as it
// always names the model (owner, 2026-10-22).
test("nobody choosing, a language is dubbed with Linnet 4, or with Oriole where it lacks Linnet 4", () => {
  const de = { id: "de", models: ["ORIOLE", "LINNET_4", "NIGHTINGALE"] };
  const es = { id: "es-ES", models: ["ORIOLE", "NIGHTINGALE"] };
  const yue = { id: "yue", models: ["LINNET_4"] };
  assert.equal(defaultModelFor(de), "LINNET_4");
  assert.equal(defaultModelFor(yue), "LINNET_4");
  assert.equal(defaultModelFor(es), "ORIOLE");
  assert.equal(defaultModelFor(gb), "ORIOLE");
  // Before the list answers its entries name no models; no language at all is the same.
  assert.equal(defaultModelFor({ id: "en" }), "LINNET_4");
  assert.equal(defaultModelFor(undefined), "LINNET_4");
  // The languages offered then are every one either has, and only those.
  assert.deepEqual(defaultLanguages([de, es, au, yue, { id: "en" }]).map((l) => l.id), ["de", "es-ES", "yue", "en"]);
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

// What each model costs a second, as Perso charges it: Nightingale is 4, not
// the 6 this table said (owner, 2026-10-22); Finch 0.2; the rest 1.
test("each known model's credits a second are Perso's own", () => {
  const rates = Object.fromEntries(["ORIOLE", "LINNET_4", "LINNET_3", "WREN", "FINCH", "NIGHTINGALE"]
    .map((id) => [id, modelInfo(id).rate]));
  assert.deepEqual(rates, { ORIOLE: 1, LINNET_4: 1, LINNET_3: 1, WREN: 1, FINCH: 0.2, NIGHTINGALE: 4 });
});

// The count reads "N supported languages", one unit that a wrapping line
// never breaks: its spaces are no-break spaces (owner, 2026-10-22).
test("the line under a model and under the choice", () => {
  // What each is for, in the words the owner approved from Perso's page (2026-10-22).
  assert.equal(modelCaption(modelInfo("LINNET_4"), 80),
    "Default · New model that follows the context. Honours audio tags · 1 credit per second · 80\u00a0supported\u00a0languages");
  assert.equal(modelCaption(modelInfo("ORIOLE"), 77),
    "Natural local pronunciation, steady voice. Lectures and corporate video · 1 credit per second · 77\u00a0supported\u00a0languages");
  assert.equal(modelCaption(modelInfo("NIGHTINGALE"), 102),
    "Rich emotion for drama and shows. No per-line remake · 4 credits per second · 102\u00a0supported\u00a0languages");
  assert.equal(modelCaption(modelInfo("WREN"), 32),
    "Steady narration. Lecture scripts, company intros, read-aloud; most even Korean voice · 1 credit per second · 32\u00a0supported\u00a0languages");
  assert.equal(modelCaption(modelInfo("NEW_ONE"), 3), "3\u00a0supported\u00a0languages");
  assert.equal(modelHint(modelInfo("NIGHTINGALE"), 102), "4 credits per second · 102\u00a0supported\u00a0languages · Perso Pro plan and up");
  assert.equal(modelHint(modelInfo("WREN"), 32), "1 credit per second · 32\u00a0supported\u00a0languages");
  // One credit is singular; a part of one is not (2026-10-22).
  assert.equal(modelHint(modelInfo("FINCH"), 79), "0.2 credits per second · 79\u00a0supported\u00a0languages · Perso Pro plan and up");
});

// Help says "100+" for every model together; the line under the choice says
// the chosen one's own count (owner, 2026-10-21), as 지원 언어 N개 without
// 이 모델은, the way each model's line in the list says it (owner, 2026-10-22).
test("in Korean the line under the choice and each model's line say 지원 언어 N개, as one unit", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
  assert.equal(modelHint(modelInfo("ORIOLE"), 77), "1초 1크레딧 · 지원\u00a0언어\u00a077개");
  assert.equal(modelHint(modelInfo("LINNET_4"), 80), "1초 1크레딧 · 지원\u00a0언어\u00a080개");
  // Every model's line, as approved (owner, 2026-10-22).
  assert.equal(modelCaption(modelInfo("ORIOLE"), 77), "자연스러운 억양, 일정한 목소리. 강의·기업 영상에 · 1초 1크레딧 · 지원\u00a0언어\u00a077개");
  assert.equal(modelCaption(modelInfo("LINNET_4"), 80),
    "기본 · 맥락을 이해하는 새 모델. 오디오 태그 반영 · 1초 1크레딧 · 지원\u00a0언어\u00a080개");
  assert.equal(modelCaption(modelInfo("LINNET_3"), 34), "이전 표현형 모델 · 1초 1크레딧 · 지원\u00a0언어\u00a034개");
  assert.equal(modelCaption(modelInfo("WREN"), 32),
    "안정적인 나레이션. 강의 대본·기업 소개·낭독에. 한국어 목소리가 가장 고르게 · 1초 1크레딧 · 지원\u00a0언어\u00a032개");
  assert.equal(modelCaption(modelInfo("FINCH"), 79), "내 목소리 유지, 가장 저렴. 인터뷰·채널 전체 더빙에 · 1초 0.2크레딧 · 지원\u00a0언어\u00a079개");
  assert.equal(modelCaption(modelInfo("NIGHTINGALE"), 102),
    "감정 표현이 풍부한 드라마·예능에. 한 줄씩 고치기는 안 돼요 · 1초 4크레딧 · 지원\u00a0언어\u00a0102개");
  assert.ok(!/이 모델은/.test(modelHint(modelInfo("WREN"), 32)), "no 이 모델은");
});
