// Run with: node --test ui/src/modelsUi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gb, neededModelId, neededPackIds, modelStatusLine, downloadChipText, dubStartDialog, overallProgress, downloadStopped, allReady, groupModels } from "./modelsUi.mjs";

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
    modelStatusLine({ state: "downloading", name: "Whisper", progress: null, queued: true }),
    { cls: "model-busy", text: "Waiting to download Whisper…", button: "cancel" });
  // A pack is never queued: no figure yet is its set-up (Windows C2).
  assert.deepEqual(
    modelStatusLine({ state: "downloading", role: "pack", name: "Python + PyTorch", progress: null }),
    { cls: "model-busy", text: "Getting ready…", button: "cancel" });
  assert.deepEqual(modelStatusLine({ state: "paused" }),
    { cls: "model-busy", text: "Paused", button: "resume" });
  // The server's reason, then what to do: never the exception (Windows H9/H10, 2026-10-06).
  assert.deepEqual(modelStatusLine({ state: "paused", error: "Connection lost." }),
    { cls: "model-busy", text: "Connection lost. Press Resume to continue.", button: "resume" });
  assert.deepEqual(
    modelStatusLine({ state: "not_downloaded", bytes: 7.6e9 }),
    { cls: "", text: "7.6 GB", button: "download" });
});

test("a download says Getting ready… until its first byte, then its percent, 0 included", () => {
  // "Downloading… 0%" from the press on, held 4 s before the first percent,
  // read as stuck (Windows C2, 2026-10-21).
  const row = { state: "downloading", name: "Mel-Band RoFormer", queued: false };
  assert.deepEqual(modelStatusLine({ ...row, progress: null }),
    { cls: "model-busy", text: "Getting ready…", button: "cancel" });
  assert.deepEqual(modelStatusLine({ ...row, progress: 0 }),
    { cls: "model-busy", text: "Downloading Mel-Band RoFormer… 0%", button: "cancel" });
});

test("dubStartDialog says only the size and what it is for", () => {
  const voice = dubStartDialog({ missing: [
    { id: "engine", kind: "pack", name: "Python + PyTorch", bytes: 2.0e9 },
  ] });
  assert.equal(voice.title, "Download 2.0 GB?");
  assert.equal(voice.line, "One-time download for making voices.");
  assert.equal(voice.perso, true, "the voice parts point to Perso dubbing");

  const stt = dubStartDialog({ missing: [{ id: "whisper", kind: "model", name: "Whisper", bytes: 2.9e9 }] });
  assert.equal(stt.line, "One-time download for transcribing.");
  assert.equal(stt.perso, false);

  const tr = dubStartDialog({ missing: [{ id: "gemma", name: "Gemma 3", bytes: 7.6e9 }] });
  assert.equal(tr.title, "Download 7.6 GB?");
  assert.equal(tr.line, "One-time download for translating.");
});

test("dubStartDialog splits packs from models and keeps the 409's order", () => {
  const d = dubStartDialog({ missing: [
    { id: "engine", kind: "pack", name: "Python + PyTorch", bytes: 2.0e9 },
    { id: "whisper", kind: "model", name: "Whisper", bytes: 2.9e9 },
  ] });
  assert.deepEqual(d.packs, ["engine"]);
  assert.deepEqual(d.models, ["whisper"]);
  assert.deepEqual(d.ids, ["engine", "whisper"]);
  assert.equal(d.title, "Download 4.9 GB?");
});

test("neededPackIds names the pack behind each dropdown choice", () => {
  assert.deepEqual(neededPackIds("stt", "local"), ["engine"]);
  assert.deepEqual(neededPackIds("stt", "perso"), []);
  assert.deepEqual(neededPackIds("translate", "hunyuan"), ["ollama-runtime"]);
  assert.deepEqual(neededPackIds("translate", "gemini"), []);
  assert.deepEqual(neededPackIds("voice", "qwen3"), ["engine"]);
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

test("downloadStopped: one stopped and none on its way, never while another still downloads", () => {
  const failedPack = { id: "engine", state: "paused", error: "This build carries no bundled files to install from." };
  const whisper = { id: "whisper", state: "not_downloaded" };
  assert.equal(downloadStopped([failedPack, whisper], ["engine", "whisper"]), true);
  assert.equal(downloadStopped([{ id: "gemma", state: "not_downloaded", error: "Connection lost." }], ["gemma"]), true);
  assert.equal(downloadStopped([failedPack, { ...whisper, state: "downloading", progress: 5 }], ["engine", "whisper"]), false);
  // Not started yet is not stopped.
  assert.equal(downloadStopped([whisper], ["whisper"]), false);
});

test("the topbar chip has no number while the download has none, never null% or 0%", () => {
  assert.equal(downloadChipText({ name: "Python + PyTorch", progress: null }), "Python + PyTorch · Getting ready…");
  assert.equal(downloadChipText({ name: "Python + PyTorch", progress: 0 }), "Python + PyTorch · 0%");
  assert.equal(downloadChipText({ name: "Whisper", progress: 41 }), "Whisper · 41%");
});

test("overallProgress has no number while nothing on its way has a figure yet", () => {
  const pack = { id: "engine", role: "pack", bytes: 900, state: "downloading", progress: null };
  const whisper = { id: "whisper", bytes: 100, state: "not_downloaded" };
  // A pack still making its venv: null, never the 0% that read as stuck (Windows C2).
  assert.equal(overallProgress([pack, whisper], ["engine", "whisper"]), null);
  assert.equal(overallProgress([{ ...pack, progress: 10 }, whisper], ["engine", "whisper"]), 9);
  // A queued model beside one with a figure: the figure.
  assert.equal(overallProgress([{ ...whisper, state: "downloading", progress: 50 }, { ...pack, role: "tts" }],
                               ["engine", "whisper"]), 5);
});

test("overallProgress holds what is in while the next download gets ready", () => {
  // The next one has no figure before its first byte: the bar keeps the share
  // already in, never back to Getting ready… and 0 between two downloads.
  const rows = [
    { id: "engine", role: "pack", bytes: 900, state: "ready" },
    { id: "whisper", bytes: 100, state: "downloading", progress: null },
  ];
  assert.equal(overallProgress(rows, ["engine", "whisper"]), 90);
});

test("allReady flips only when every needed model is ready", () => {
  const rows = [{ id: "a", state: "ready" }, { id: "b", state: "downloading" }];
  assert.equal(allReady(rows, ["a"]), true);
  assert.equal(allReady(rows, ["a", "b"]), false);
});

test("a start that is not a dubbing's names its own purpose and offers no Perso dubbing", () => {
  const d = dubStartDialog({ missing: [{ id: "engine", kind: "pack", bytes: 2e9 }], purpose: "separating audio" });
  assert.equal(d.line, "One-time download for separating audio.");
  assert.equal(d.perso, false);
  assert.deepEqual(d.packs, ["engine"]);
});

// The rows /api/models serves today, in the catalog's order (packs first).
const CATALOG_ROWS = [
  { id: "engine", role: "pack", bytes: 2.0e9, state: "ready" },
  { id: "ollama-runtime", role: "pack", bytes: 0.5e9, state: "not_downloaded" },
  { id: "subtitle-eraser", role: "pack", bytes: 4.4e9, state: "ready" },
  { id: "qwen3-tts", role: "tts", bytes: 4.5e9, state: "downloading", progress: 30 },
  { id: "whisper", role: "stt", bytes: 3.1e9, state: "ready" },
  { id: "vocal-separator", role: "sep", bytes: 0.9e9, state: "ready" },
  { id: "gemma", role: "translate", bytes: 8.1e9, state: "paused" },
  { id: "hunyuan", role: "translate", bytes: 1.1e9, state: "ready" },
];

test("groupModels puts each row under its purpose, in the order a dub uses them", () => {
  assert.deepEqual(groupModels(CATALOG_ROWS).map((g) => [g.title, g.rows.map((r) => r.id)]), [
    ["Audio separation", ["vocal-separator"]],
    ["Speech-to-text", ["whisper"]],
    ["Translation", ["gemma", "hunyuan"]],
    ["Text-to-speech", ["qwen3-tts"]],
    ["Erase subtitles", ["subtitle-eraser"]],
    ["Base programs", ["engine", "ollama-runtime"]],
  ]);
  // A role with no group of its own is still listed, with the base programs.
  const later = groupModels([...CATALOG_ROWS, { id: "lipsync", role: "lipsync", bytes: 1e9, state: "ready" }]);
  assert.deepEqual(later.at(-1).rows.map((r) => r.id), ["engine", "ollama-runtime", "lipsync"]);
});

test("a group's size counts only what is on this computer", () => {
  const bytes = Object.fromEntries(groupModels(CATALOG_ROWS).map((g) => [g.title, g.bytes]));
  assert.equal(bytes["Translation"], 1.1e9, "paused Gemma does not count, ready Hunyuan does");
  assert.equal(bytes["Text-to-speech"], 0, "a download under way does not count yet");
  assert.equal(bytes["Base programs"], 2.0e9, "Ollama is not installed");
});

test("a group with no rows is left out", () => {
  assert.deepEqual(groupModels([]), []);
  const one = groupModels([{ id: "whisper", role: "stt", bytes: 3.1e9, state: "not_downloaded" }]);
  assert.deepEqual(one.map((g) => [g.title, g.bytes]), [["Speech-to-text", 0]]);
});

test("every group title is in the page's tables, so Korean shows it in Korean", () => {
  const titles = groupModels(CATALOG_ROWS).map((g) => g.title);
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.deepEqual(titles.filter((s) => !Object.hasOwn(table, s)), [], `missing from ui.${code}.json`);
  }
});
