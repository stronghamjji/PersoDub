// Run with: node --test ui/src/modelsUi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gb, neededModelId, neededPackIds, stageNeeds, modelStatusLine, downloadChipText, dubStartDialog, overallProgress, downloadStopped, allReady, groupModels } from "./modelsUi.mjs";

test("neededModelId maps each dropdown choice to its catalog model", () => {
  assert.equal(neededModelId("sep", "roformer"), "vocal-separator");
  assert.equal(neededModelId("sep", "local"), null, "Demucs comes with Python + PyTorch");
  assert.equal(neededModelId("sep", "perso"), null);
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
    { cls: "model-busy", text: "Connection lost. Press Resume to pick up where it stopped.", button: "resume" });
  // A reason that already says to press Resume is not told it twice.
  const blocked = "A company network or security program blocked the connection. "
    + "Connect to another Wi-Fi or a hotspot, then press Resume.";
  assert.deepEqual(modelStatusLine({ state: "paused", error: blocked }),
    { cls: "model-busy", text: blocked, button: "resume" });
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

test("dubStartDialog says the size, that it is a download apart from the app install, and the room left", () => {
  const voice = dubStartDialog({ missing: [
    { id: "engine", kind: "pack", name: "Python + PyTorch", bytes: 2.0e9 },
  ], free_bytes: 112.4e9 });
  assert.equal(voice.title, "Download 2.0 GB?");
  assert.equal(voice.line, "A one-time download, separate from the app install.");
  assert.equal(voice.free, "112.4 GB free");
  assert.equal(voice.perso, true, "the voice parts point to Perso dubbing");

  const stt = dubStartDialog({ missing: [{ id: "whisper", kind: "model", name: "Whisper", bytes: 2.9e9 }] });
  assert.equal(stt.line, "A one-time download, separate from the app install.");
  assert.equal(stt.free, "", "no free_bytes (the engine could not tell): nothing said");
  assert.equal(stt.perso, false);

  const tr = dubStartDialog({ missing: [{ id: "gemma", name: "Gemma 3", bytes: 7.6e9 }], free_bytes: 0 });
  assert.equal(tr.title, "Download 7.6 GB?");
  assert.equal(tr.free, "");
});

test("the size before a download counts Python + PyTorch once, under the first field that needs it", () => {
  const rows = { engine: { id: "engine", name: "Python + PyTorch", bytes: 2.0e9, state: "not_downloaded" },
                 whisper: { id: "whisper", name: "Whisper", bytes: 3.1e9, state: "not_downloaded" },
                 "qwen3-tts": { id: "qwen3-tts", name: "Qwen3-TTS", bytes: 4.5e9, state: "not_downloaded" },
                 demucs: { id: "demucs", bytes: 0.081e9, state: "not_downloaded", comes_with: "engine" } };
  const rowOf = (id) => rows[id] || null;
  const stages = [["sep", "local"], ["stt", "local"], ["translate", "chatgpt"], ["voice", "qwen3"]];
  const lines = stageNeeds(stages, rowOf);
  assert.deepEqual(lines.map((l) => l.needs.map((r) => r.id)), [[], ["engine", "whisper"], [], ["qwen3-tts"]],
                   "5.1 GB and 4.5 GB, not 5.1 and 6.5");
  const total = lines.reduce((n, l) => n + l.needs.reduce((m, r) => m + r.bytes, 0), 0);
  assert.equal(gb(total), "9.6", "the 409's total: each thing once");
  assert.deepEqual(lines.map((l) => l.ready), [false, false, false, false],
                   "a line whose part is listed above is not Ready: its choice still needs that part");

  // Mel-Band RoFormer first in the form: Python + PyTorch goes with it.
  const roformer = stageNeeds([["sep", "roformer"], ...stages.slice(1)],
                              (id) => (id === "vocal-separator" ? { id, bytes: 0.9e9, state: "not_downloaded" } : rowOf(id)));
  assert.deepEqual(roformer.map((l) => l.needs.map((r) => r.id)),
                   [["engine", "vocal-separator"], ["whisper"], [], ["qwen3-tts"]]);

  // Python + PyTorch here: each line lists only its own model, and once all
  // is here the line is Ready.
  rows.engine.state = "ready";
  rows.whisper.state = "ready";
  const later = stageNeeds(stages, rowOf);
  assert.deepEqual(later.map((l) => l.needs.map((r) => r.id)), [[], [], [], ["qwen3-tts"]]);
  assert.deepEqual(later.map((l) => l.ready), [false, true, false, false], "Demucs and ChatGPT need nothing to download");
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
  assert.deepEqual(neededPackIds("sep", "roformer"), ["engine"]);
  assert.deepEqual(neededPackIds("sep", "local"), []);
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

test("a start that is not a dubbing's says the same line and offers no Perso dubbing", () => {
  const d = dubStartDialog({ missing: [{ id: "engine", kind: "pack", bytes: 2e9 }], purpose: "separating audio" });
  assert.equal(d.line, "A one-time download, separate from the app install.");
  assert.equal(d.ram, "", "Separate audio is not held to the dub's memory");
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
    ["Required programs", ["engine", "ollama-runtime"]],
  ]);
  // A role with no group of its own is still listed, with the required programs.
  const later = groupModels([...CATALOG_ROWS, { id: "lipsync", role: "lipsync", bytes: 1e9, state: "ready" }]);
  assert.deepEqual(later.at(-1).rows.map((r) => r.id), ["engine", "ollama-runtime", "lipsync"]);
});

test("a group's size counts only what is on this computer", () => {
  const bytes = Object.fromEntries(groupModels(CATALOG_ROWS).map((g) => [g.title, g.bytes]));
  assert.equal(bytes["Translation"], 1.1e9, "paused Gemma does not count, ready Hunyuan does");
  assert.equal(bytes["Text-to-speech"], 0, "a download under way does not count yet");
  assert.equal(bytes["Required programs"], 2.0e9, "Ollama is not installed");
});

test("only the programs' group has a note, saying what they are there for", () => {
  assert.deepEqual(groupModels(CATALOG_ROWS).map((g) => [g.key, g.note]), [
    ["sep", ""], ["stt", ""], ["translate", ""], ["tts", ""], ["eraser", ""],
    ["base", "Needed to run the models"],
  ]);
});

test("a group with no rows is left out", () => {
  assert.deepEqual(groupModels([]), []);
  const one = groupModels([{ id: "whisper", role: "stt", bytes: 3.1e9, state: "not_downloaded" }]);
  assert.deepEqual(one.map((g) => [g.title, g.bytes]), [["Speech-to-text", 0]]);
});

test("every group title and note is in the page's tables, so Korean shows it in Korean", () => {
  const words = groupModels(CATALOG_ROWS).flatMap((g) => [g.title, g.note]).filter(Boolean);
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.deepEqual(words.filter((s) => !Object.hasOwn(table, s)), [], `missing from ui.${code}.json`);
  }
  // The programs' group in the owner's words (2026-10-22): "바탕 프로그램"
  // said nothing to someone who did not already know.
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Required programs"], "필수 프로그램");
  assert.equal(ko["Needed to run the models"], "모델을 돌리는 데 필요해요");
  assert.equal(Object.hasOwn(ko, "Base programs"), false, "the old name is gone");
});
