// Plain node:test unit tests for the framework-agnostic dubApi plumbing layer.
// Run with: node --test ui/src/dubApi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGES,
  STAGES,
  stagePattern,
  stepLabels,
  buildDubFormData,
  parseProgress,
  pollDubJob,
  cancelDubJob,
  applyEngineAvailability,
  engineChips,
  startedLabel,
} from "./dubApi.mjs";

test("buildDubFormData sends exactly the fields app/main.py:dub_start expects", () => {
  const video = new Blob(["fake video bytes"], { type: "video/mp4" });
  const fd = buildDubFormData({ video, direction: "en_to_ko", qualityMode: "fast" });

  assert.equal(fd.get("language"), "Korean");
  assert.equal(fd.get("language_code"), "ko");
  assert.equal(fd.get("n_takes"), "1");
  // "auto" STT engine means: don't send the field, so the server default applies
  assert.equal(fd.get("stt_engine"), null);
});

test("buildDubFormData: advanced overrides (n_takes, speakers, translate engine, stt engine)", () => {
  const video = new Blob(["v"], { type: "video/mp4" });
  const fd = buildDubFormData({
    video,
    direction: "ko_to_en",
    qualityMode: "fast",
    nTakesOverride: 6,
    numSpeakers: 2,
    translateEngine: "gemini",
    sttEngine: "perso",
  });

  assert.equal(fd.get("n_takes"), "6"); // override wins over qualityMode
  assert.equal(fd.get("num_speakers"), "2");
  assert.equal(fd.get("translate_engine"), "gemini");
  assert.equal(fd.get("stt_engine"), "perso");
});

test("buildDubFormData: high quality is 4 takes, and an unknown mode or direction is refused", () => {
  // "High quality" is a real choice in the New project dialog, and the number
  // of takes is the whole of what it means. Asserted through the form because
  // the mapping itself is not exported.
  const video = new Blob(["v"], { type: "video/mp4" });
  const fd = buildDubFormData({ video, direction: "en_to_ko", qualityMode: "high" });
  assert.equal(fd.get("n_takes"), "4");

  assert.throws(() => buildDubFormData({ video, direction: "en_to_ko", qualityMode: "nope" }),
                /quality mode/);
  assert.throws(() => buildDubFormData({ video, direction: "xx" }), /direction/);
});

test("buildDubFormData requires a video file", () => {
  assert.throws(() => buildDubFormData({ direction: "en_to_ko" }), /video/);
});

test("parseProgress reads the real '1/6 ... 6/6' log lines app/pipeline.py emits", () => {
  const logs = [
    "1/6 Separating background audio locally (Demucs)…",
    "2/6 Transcribing locally (Whisper, no container)…",
    "   2 dialogue lines prepared",
  ];
  const p = parseProgress(logs);
  assert.equal(p.stage, 2);
  assert.equal(p.total, 4);
  assert.equal(p.percent, 18);
});

test("parseProgress: furthest stage wins even if an indented detail line follows", () => {
  const logs = [
    "1/6 Separating background audio locally (Demucs)…",
    "2/6 Transcribing locally (Whisper, no container)…",
    "3/6 Translating from source subtitles (5 lines)…",
    "4/6 Cloning & synthesizing voices (Qwen3-TTS)…",
    "6/6 Building the finished file…",
    "✅ Done!",
  ];
  const p = parseProgress(logs);
  assert.equal(p.stage, 4);
  // raw reaches 6 ("6/6 Building..."), which floors percent at 97 (see the
  // percent-never-regresses test below) -- there's no voiceTotal here, so
  // the voice-line math alone would only reach 69.
  assert.equal(p.percent, 97);
});

test("parseProgress on an empty/just-started job", () => {
  const p = parseProgress([]);
  assert.equal(p.stage, 0);
  assert.equal(p.percent, 0);
  assert.equal(p.label, "Waiting to start");
});

test("parseProgress labels are the plain global stage names, not internal jargon", () => {
  const logs = ["1/6 Separating background audio locally (Demucs)…"];
  const p = parseProgress(logs);
  assert.equal(p.label, "Separating audio");
  assert.doesNotMatch(p.label, /Demucs|Whisper|Qwen/);

  const logs4 = [...logs, "4/6 Cloning & synthesizing voices (Qwen3-TTS)…"];
  assert.equal(parseProgress(logs4).label, "Dubbing");
});

test("parseProgress folds the six pipeline stages into four and reads voice progress", () => {
  const logs = ["1/6 Separating…", "2/6 Transcribing…", "3/6 Translating…",
    "4/6 Cloning & synthesizing voices (Qwen3-TTS — fast)…", "   line 0: chose take 0", "   line 1: chose take 0"];
  const p = parseProgress(logs, { lineCount: 4 });
  assert.equal(p.stage, 4); assert.equal(p.total, 4);
  assert.equal(p.label, "Dubbing");
  assert.equal(p.voiceDone, 2); assert.equal(p.voiceTotal, 4);
  assert.ok(p.percent > 55 && p.percent < 80, String(p.percent));
  assert.equal(parseProgress(["6/6 Building the finished file…"]).stage, 4);
});

// A job in progress can't be asked its lineCount (the script API answers 409
// until the job finishes -- see app/main.py), so when the caller has no
// lineCount, parseProgress falls back to reading it from the pipeline's own
// "N dialogue lines prepared" log line (app/pipeline.py:512). An explicit
// lineCount still wins when both are available.
test("parseProgress reads voiceTotal from the 'dialogue lines prepared' log line when lineCount isn't passed", () => {
  const logs = ["4/6 Cloning & synthesizing voices (Qwen3-TTS — fast)…", "   4 dialogue lines prepared",
    "   line 0: chose take 0", "   line 1: chose take 0", "   line 2: chose take 0"];
  const p = parseProgress(logs);
  assert.equal(p.voiceTotal, 4);
  assert.equal(p.voiceDone, 3);
  assert.equal(p.percent, 85); // 55 (stages 1-3) + round(40 * 3/4)

  const withExplicitCount = parseProgress(logs, { lineCount: 10 });
  assert.equal(withExplicitCount.voiceTotal, 10); // explicit lineCount wins over the log line
});

// Controller ruling: percent must never decrease as logs grow, even right at
// the finish line. Before this fix, voices finishing (55 + 45 = 100) then the
// "6/6 Building..." line arriving forced percent back down to 95 -- a visible
// backward jump. The voice math is now capped at 40 (95 max) and raw 5/6 use
// a floor (96/97) instead of an override, so it only ever goes up.
test("parseProgress: percent never regresses as voices finish and the pipeline reaches Check/Build", () => {
  const lines = [
    "4/6 Cloning & synthesizing voices (Qwen3-TTS — fast)…",
    "   line 0: chose take 0",
    "   line 1: chose take 0",
    "5/6 Checking for original-voice leakage…",
    "6/6 Building the finished file…",
  ];
  const percents = [];
  for (let i = 1; i <= lines.length; i++) {
    percents.push(parseProgress(lines.slice(0, i), { lineCount: 2 }).percent);
  }
  for (let i = 1; i < percents.length; i++) {
    assert.ok(percents[i] >= percents[i - 1], `percent regressed: ${percents.join(", ")}`);
  }
  assert.equal(percents[percents.length - 1], 97);
});

test("pollDubJob keeps polling through a 'cancelling' status and stops once it resolves to 'cancelled'", async () => {
  const realFetch = globalThis.fetch;
  const statuses = ["running", "cancelling", "cancelling", "cancelled"];
  let call = 0;
  try {
    globalThis.fetch = async () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      return new Response(JSON.stringify({ id: "j1", status, logs: [] }), { status: 200 });
    };
    const seen = [];
    const job = await pollDubJob("j1", { intervalMs: 0, onUpdate: (j) => seen.push(j.status) });
    assert.equal(job.status, "cancelled");
    assert.deepEqual(seen, statuses);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The server going quiet says nothing about the dub, which carries on behind
// it -- so a failed request must only slow the asking down, never end it.
test("pollDubJob rides out failed requests, tells the caller, and picks the job back up", async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  try {
    globalThis.fetch = async () => {
      call += 1;
      if (call <= 3) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ id: "j1", status: "done", logs: [] }), { status: 200 });
    };
    const unreachable = [];
    const job = await pollDubJob("j1", {
      intervalMs: 0, maxIntervalMs: 0,
      onUnreachable: (e) => unreachable.push(e.message),
    });
    assert.equal(job.status, "done");
    assert.equal(unreachable.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pollDubJob stops retrying once the caller has left the job", async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  try {
    globalThis.fetch = async () => { call += 1; throw new TypeError("Failed to fetch"); };
    const job = await pollDubJob("j1", {
      intervalMs: 0, maxIntervalMs: 0, shouldStop: () => call >= 1,
    });
    assert.equal(job, null);
    assert.equal(call, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A server that answers "no such job" is not an outage: it is right there, and
// it will keep saying that. Retrying under "still trying" would never recover.
test("pollDubJob stops with a readable line when the server says the job is gone", async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  try {
    globalThis.fetch = async () => {
      call += 1;
      return new Response("", { status: 404 });
    };
    const unreachable = [];
    await assert.rejects(
      pollDubJob("j1", { intervalMs: 0, maxIntervalMs: 0, onUnreachable: (e) => unreachable.push(e) }),
      /no longer on the app server/,
    );
    assert.equal(call, 1);
    assert.equal(unreachable.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("cancelDubJob posts to the cancel endpoint and returns the resulting status", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      assert.equal(url, "/api/dub/jobs/j1/cancel");
      assert.equal(opts.method, "POST");
      return new Response(JSON.stringify({ job_id: "j1", status: "cancelling" }), { status: 200 });
    };
    assert.equal(await cancelDubJob("j1"), "cancelling");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("cancelDubJob throws the server's detail message on 409 (job already finished)", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Job already done, nothing to cancel" }), { status: 409 });
    await assert.rejects(() => cancelDubJob("j1"), /nothing to cancel/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Source/target language pair (the Direction dropdown was split) --------
test("LANGUAGES lists the 10 Qwen3-TTS languages, English and Korean first", () => {
  assert.equal(LANGUAGES.length, 10);
  assert.deepEqual(LANGUAGES.slice(0, 2).map((l) => l.code), ["en", "ko"]);
  // From the model's own config.json codec_language_id table.
  const codes = LANGUAGES.map((l) => l.code).sort();
  assert.deepEqual(codes, ["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh"]);
});

test("buildDubFormData accepts a source/target pair and sends the whisper hint", () => {
  const fd = buildDubFormData({
    video: new Blob(["v"]), sourceLang: "en", targetLang: "ko", qualityMode: "high",
  });
  assert.equal(fd.get("language"), "Korean");
  assert.equal(fd.get("language_code"), "ko");
  assert.equal(fd.get("source_language_code"), "en");
});

test("buildDubFormData rejects a same-language pair", () => {
  assert.throws(() => buildDubFormData({ video: new Blob(["v"]), sourceLang: "ko", targetLang: "ko" }));
});

test("buildDubFormData omits source_language_code when source is empty (auto-detect)", () => {
  const fd = buildDubFormData({
    video: new Blob(["v"]), sourceLang: "", targetLang: "ko", qualityMode: "high",
  });
  assert.equal(fd.get("language"), "Korean");
  assert.equal(fd.get("language_code"), "ko");
  assert.equal(fd.get("source_language_code"), null);
});

test("buildDubFormData: same-language guard does not fire when source is auto (empty)", () => {
  assert.doesNotThrow(() =>
    buildDubFormData({ video: new Blob(["v"]), sourceLang: "", targetLang: "en", qualityMode: "high" })
  );
});

test("a video the app is already holding is sent by id, and by id alone", () => {
  // The dialog hands over all three: the dropped file it is playing, the link
  // it was pasted, and the id of the copy in the holding area. Sending the file
  // or the link as well would upload or fetch the same video a second time --
  // and the server rejects two sources outright.
  const fd = buildDubFormData({ downloadId: "d1", video: new Blob(["x"]),
                                sourceUrl: "https://x/y", targetLang: "ko" });

  assert.equal(fd.get("download_id"), "d1");
  assert.equal(fd.get("video"), null);
  assert.equal(fd.get("source_url"), null);
});

test("a held video is a source of its own -- no file and no link needed", () => {
  const fd = buildDubFormData({ downloadId: "d1", targetLang: "ko", trim: { start: 2, end: 8 } });

  assert.equal(fd.get("download_id"), "d1");
  assert.equal(fd.get("trim_start"), "2");
  assert.throws(() => buildDubFormData({ targetLang: "ko" }), /video/);
});

test("buildDubFormData sends trim_start/trim_end only when a trim is given", () => {
  const fd = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", trim: { start: 2, end: 8 } });
  assert.equal(fd.get("trim_start"), "2"); assert.equal(fd.get("trim_end"), "8");
  const fd2 = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko" });
  assert.equal(fd2.get("trim_start"), null);
});

// --- applyEngineAvailability: GET /api/engines progressive enhancement ----
const ALL_AVAILABLE = { gemma_available: true, qwen_available: true, hunyuan_available: true, gemini_available: true, perso_available: true };

test("applyEngineAvailability: all engines available -> no disabling, no switch, no warning", () => {
  const result = applyEngineAvailability(ALL_AVAILABLE, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: false, perso: false });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: a missing local Gemma is neither disabled nor switched away", () => {
  // Its Download line under the dropdown handles absence now (the catalog);
  // greying it out or hopping to Gemini would hide the way to get it.
  const av = { ...ALL_AVAILABLE, gemma_available: false };
  const result = applyEngineAvailability(av, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: false, perso: false });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

// Gemini used to be the one engine the form never greyed out: disable only
// carried gemma/perso, so "Gemini (cloud, needs API key)" stayed selectable
// with no key and the user only found out at Start dubbing (a 422 from
// dub_start's preflight).
test("applyEngineAvailability: gemini without a key is greyed but the selection is kept", () => {
  const av = { ...ALL_AVAILABLE, gemini_available: false };
  const result = applyEngineAvailability(av, { translate: "gemini", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: true, perso: false });
  assert.equal(result.translate, "gemini");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: nothing available -> no warning, no switch (the catalog handles it)", () => {
  const av = { ...ALL_AVAILABLE, gemma_available: false, gemini_available: false };
  const result = applyEngineAvailability(av, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: true, perso: false });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: perso dead -> disabled only, translate untouched (already available)", () => {
  const av = { ...ALL_AVAILABLE, perso_available: false };
  const result = applyEngineAvailability(av, { translate: "gemma", stt: "perso" });
  assert.deepEqual(result.disable, { gemma: false, gemini: false, perso: true });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: never auto-changes an available current translate selection", () => {
  const av = { ...ALL_AVAILABLE, gemma_available: false };
  const result = applyEngineAvailability(av, { translate: "gemini", stt: "local" });
  assert.equal(result.translate, "gemini"); // already available -- stays, even though gemma (dead) is "first" in order
});

test("engineChips: the local stack, quality first and every role named", () => {
  const chips = engineChips(
    { stt_engine: "whisper", translator: "gemma", tts: "qwen3", quality: 4,
      source_lang: "es", language_code: "en" },
  );
  assert.deepEqual(chips.map((c) => `${c.role} ${c.label}`.trim()),
    ["High quality mode", "STT Whisper", "Translation Gemma 3", "TTS Qwen3-TTS"]);
  assert.deepEqual(chips.map((c) => c.api), [false, false, false, false]);
});

test("engineChips: the paid engines are marked, and 1 take is Fast mode", () => {
  const chips = engineChips({ stt_engine: "perso", translator: "gemini", tts: "qwen3", quality: 1 });
  assert.deepEqual(chips.map((c) => `${c.role} ${c.label}`.trim()),
    ["Fast mode", "STT Perso", "Translation Gemini", "TTS Qwen3-TTS"]);
  assert.deepEqual(chips.map((c) => c.api), [false, true, true, false]);
});

test("engineChips: a sidebar row keeps only what differs between jobs", () => {
  const chips = engineChips({ stt_engine: "whisper", translator: "gemma", tts: "qwen3", quality: 4,
                              source_lang: "es", language_code: "en" },
                            { withQuality: false, withTts: false });
  assert.deepEqual(chips.map((c) => c.label), ["Whisper", "Gemma 3"]);
});

test("engineChips: a job saved before the fields existed shows nothing", () => {
  assert.deepEqual(engineChips({ project: "old", language_code: "en" }), []);
  assert.deepEqual(engineChips(null), []);
});

test("engineChips: an unknown engine is left out, and the rest keep their roles", () => {
  const chips = engineChips({ stt_engine: "whisper", translator: "made-up", tts: "qwen3", language_code: "ko" });
  assert.deepEqual(chips.map((c) => `${c.role} ${c.label}`), ["STT Whisper", "TTS Qwen3-TTS"]);
});

test("startedLabel formats the job's start as local YYYY-MM-DD HH:MM", () => {
  assert.equal(startedLabel("2026-08-26T13:41:07.123456"), "2026-08-26 13:41");
  assert.equal(startedLabel(null), "");
  assert.equal(startedLabel("not a date"), "");
});

test("buildDubFormData always names the separation, local included", () => {
  // A blank used to mean local on the server; now it means the saved default,
  // which may be Perso -- so the dialog's local choice has to be said out loud.
  const fd = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", sepEngine: "perso" });
  assert.equal(fd.get("sep_engine"), "perso");
  const fd2 = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", sepEngine: "local" });
  assert.equal(fd2.get("sep_engine"), "local");
  const fd3 = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko" });
  assert.equal(fd3.get("sep_engine"), "local");
});

test("applyEngineAvailability: a missing Hunyuan keeps the selection (picking it starts the download)", () => {
  const av = { ...ALL_AVAILABLE, hunyuan_available: false };
  const result = applyEngineAvailability(av, { translate: "hunyuan", stt: "local" });
  assert.equal(result.translate, "hunyuan");
  assert.equal(result.warning, null);
});

test("engineChips: Perso separation gets a chip, local Demucs (the default) stays silent", () => {
  const chips = engineChips({ separation: "perso", stt_engine: "whisper", translator: "gemma",
                              tts: "qwen3", quality: 1 });
  assert.deepEqual(chips.map((c) => `${c.role} ${c.label}`.trim()),
    ["Fast mode", "Separation Perso", "STT Whisper", "Translation Gemma 3", "TTS Qwen3-TTS"]);
  const local = engineChips({ separation: "demucs", stt_engine: "whisper", translator: "gemma",
                              tts: "qwen3", quality: 1 });
  assert.ok(!local.some((c) => c.role === "Separation"));
});

test("buildDubFormData always names the dub mode, local included", () => {
  const fd = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", dubMode: "perso" });
  assert.equal(fd.get("dub_mode"), "perso");
  const fd2 = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", dubMode: "local" });
  assert.equal(fd2.get("dub_mode"), "local");
});

test("engineChips: a cloud dub gets a Dubbing chip; a local one stays silent", () => {
  const cloud = engineChips({ dub_mode: "perso", quality: 1 });
  assert.deepEqual(cloud.map((c) => `${c.role} ${c.label}`.trim()), ["Fast mode", "Dubbing Perso"]);
  const local = engineChips({ dub_mode: "local", stt_engine: "whisper", translator: "gemma", tts: "qwen3", quality: 1 });
  assert.ok(!local.some((c) => c.role === "Dubbing"));
});

test("parseProgress follows the three Perso cloud phases", () => {
  const logs = ["clip.mp4", "1/1 Dubbing in the Perso cloud…", "   Uploading the video to Perso…"];
  let p = parseProgress(logs);
  assert.equal(p.label, "Uploading to Perso");
  assert.equal(p.percent, 15);
  logs.push("   Perso is dubbing… this takes a few minutes.");
  p = parseProgress(logs);
  assert.equal(p.label, "Dubbing at Perso");
  assert.equal(p.percent, 55);
  logs.push("   Downloading the finished video…");
  p = parseProgress(logs);
  assert.equal(p.label, "Delivering");
  assert.equal(p.percent, 90);
});

test("pollDubJob keeps watching a queued job until it runs and finishes", async () => {
  // The queue starts a waiting job by itself; a watcher that stopped at
  // "queued" would never see it happen.
  const answers = [
    { id: "j1", status: "queued", logs: [] },
    { id: "j1", status: "running", logs: [] },
    { id: "j1", status: "done", logs: [] },
  ];
  let i = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => answers[Math.min(i++, 2)] });
  globalThis.fetch = fetchImpl;
  const seen = [];
  const job = await pollDubJob("j1", { intervalMs: 1, onUpdate: (j) => seen.push(j.status) });
  assert.equal(job.status, "done");
  assert.deepEqual(seen, ["queued", "running", "done"]);
});

// ---- The stage table is the single source of the "N/6" numbering ------------
// Everything parseProgress knows about stages now comes from STAGES, so adding
// the seventh stage (subtitle removal) means adding one row -- not editing a
// regex, two weight tables and a dozen Python literals. These tests build a
// pretend seven-stage table and check the derivations follow it.

test("stagePattern reads the stage count off the table it is given", () => {
  assert.ok(stagePattern(STAGES).test("3/6 Translating…"));

  const seven = [...STAGES, { name: "desubtitle", label: "Cleaning up", weight: 0 }];
  const p7 = stagePattern(seven);
  assert.ok(p7.test("7/7 Removing burned-in subtitles…"), "a 7-stage table matches 7/7 lines");
  assert.ok(p7.test("1/7 Separating background audio locally (Demucs)…"));
  assert.equal(p7.exec("4/7 Cloning & synthesizing voices…")[1], "4", "the stage number is captured");
  assert.ok(!p7.test("3/6 Translating…"), "and no longer matches the old six-stage marker");
});

test("a stage with a label of its own is one more step on the progress card", () => {
  // The card (ui/src/runningScreen.mjs) draws one step per name this returns, so
  // a seventh stage must arrive there by adding a row here and nothing else.
  assert.deepEqual(stepLabels(STAGES),
    ["Separating audio", "Transcribing", "Translating", "Dubbing"]);

  const seven = [...STAGES, { name: "desubtitle", label: "Cleaning up", weight: 0 }];
  assert.deepEqual(stepLabels(seven), [...stepLabels(STAGES), "Cleaning up"]);
  assert.equal(stepLabels(seven).length, stepLabels(STAGES).length + 1);
  // A stage that reuses its neighbour's label is folded into it instead --
  // which is how the pipeline's six stages read as four.
  assert.deepEqual(stepLabels([...STAGES, { name: "verify", label: "Dubbing", weight: 0 }]),
    stepLabels(STAGES));
});

test("the stage table describes the four bar steps the UI shows", () => {
  // One step per distinct label, in order, and the weights add up to 100.
  const labels = [...new Set(STAGES.map((s) => s.label))];
  assert.deepEqual(labels, ["Separating audio", "Transcribing", "Translating", "Dubbing"]);
  assert.equal(STAGES.reduce((n, s) => n + (s.weight || 0), 0), 100);
  // Exactly one stage drives the per-line voice math, and the stages that
  // floor the bar come after it.
  const synth = STAGES.findIndex((s) => s.kind === "synthesis");
  assert.equal(STAGES.filter((s) => s.kind === "synthesis").length, 1);
  assert.ok(STAGES.every((s, i) => !s.floor || i > synth), "floors only after synthesis");
});

test("every stage's own marker parses back to that stage", () => {
  // The contract with app/pipeline.py's stage_marker(): stage i logs "i+1/6".
  STAGES.forEach((s, i) => {
    const p = parseProgress([`${i + 1}/${STAGES.length} ${s.label}…`]);
    assert.equal(p.raw, i + 1, `${s.name} should parse as raw ${i + 1}`);
    assert.equal(p.label, s.label, `${s.name} should show as "${s.label}"`);
    assert.ok(p.stage >= 1 && p.stage <= p.total);
  });
});
