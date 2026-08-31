// Run with: node --test ui/src/modelsUi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { gb, neededModelId, modelStatusLine, dubStartDialog, overallProgress, allReady } from "./modelsUi.mjs";

test("neededModelId maps each dropdown choice to its catalog model", () => {
  assert.equal(neededModelId("stt", "local"), "whisper");
  assert.equal(neededModelId("stt", "perso"), null);
  assert.equal(neededModelId("translate", "gemma"), "gemma");
  assert.equal(neededModelId("translate", "hunyuan"), "hunyuan");
  assert.equal(neededModelId("translate", "gemini"), null);
  assert.equal(neededModelId("voice", "qwen3"), "qwen3-tts");
});

test("modelStatusLine covers the four states with the mockup's words", () => {
  assert.deepEqual(modelStatusLine(null), { cls: "", text: "", button: null });
  assert.deepEqual(modelStatusLine({ state: "ready" }),
    { cls: "model-ok", text: "Ready", button: null });
  assert.deepEqual(
    modelStatusLine({ state: "downloading", name: "Whisper", progress: 41 }),
    { cls: "model-busy", text: "Downloading Whisper… 41%", button: "cancel" });
  assert.deepEqual(
    modelStatusLine({ state: "downloading", name: "Whisper", progress: null }),
    { cls: "model-busy", text: "Waiting to download Whisper…", button: "cancel" });
  assert.deepEqual(modelStatusLine({ state: "paused" }),
    { cls: "model-busy", text: "Paused", button: "resume" });
  assert.deepEqual(modelStatusLine({ state: "paused", error: "network died" }),
    { cls: "model-busy", text: "Paused: network died", button: "resume" });
  assert.deepEqual(
    modelStatusLine({ state: "not_downloaded", bytes: 7.6 * 1024 ** 3 }),
    { cls: "", text: "7.6 GB", button: "download" });
});

test("dubStartDialog: several models get the total, one gets its name", () => {
  const many = dubStartDialog({ missing: [
    { id: "qwen3-tts", name: "Qwen3-TTS", bytes: 4.3 * 1024 ** 3 },
    { id: "whisper", name: "Whisper", bytes: 2.9 * 1024 ** 3 },
  ], total_bytes: 7.2 * 1024 ** 3 });
  assert.equal(many.title, "Download 7.2 GB of AI models to dub?");
  assert.deepEqual(many.ids, ["qwen3-tts", "whisper"]);

  const one = dubStartDialog({ missing: [{ id: "gemma", name: "Gemma 3", bytes: 7.6 * 1024 ** 3 }] });
  assert.equal(one.title, "Download Gemma 3 (7.6 GB) to dub?");
});

test("overallProgress is byte-weighted and treats ready as done", () => {
  const rows = [
    { id: "a", bytes: 100, state: "ready" },
    { id: "b", bytes: 300, state: "downloading", progress: 50 },
    { id: "c", bytes: 100, state: "not_downloaded" },
  ];
  // (100*100% + 300*50% + 100*0%) / 500 = 50%
  assert.equal(overallProgress(rows, ["a", "b", "c"]), 50);
  assert.equal(overallProgress(rows, []), 0);
});

test("allReady flips only when every needed model is ready", () => {
  const rows = [{ id: "a", state: "ready" }, { id: "b", state: "downloading" }];
  assert.equal(allReady(rows, ["a"]), true);
  assert.equal(allReady(rows, ["a", "b"]), false);
});
