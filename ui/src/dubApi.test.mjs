// Plain node:test unit tests for the framework-agnostic dubApi plumbing layer.
// Run with: node --test ui/src/dubApi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGES,
  directionToLanguage,
  qualityModeToNTakes,
  buildDubFormData,
  parseProgress,
  fetchResultSrt,
  pollDubJob,
  cancelDubJob,
  migrateStoredSettings,
  applyEngineAvailability,
} from "./dubApi.mjs";

test("directionToLanguage maps ko_to_en / en_to_ko to the API's (language, language_code) pair", () => {
  assert.deepEqual(directionToLanguage("ko_to_en"), { language: "English", language_code: "en" });
  assert.deepEqual(directionToLanguage("en_to_ko"), { language: "Korean", language_code: "ko" });
  assert.throws(() => directionToLanguage("xx"));
});

test("qualityModeToNTakes: fast=1 take, high=4 takes (matches server QWEN_N_TAKES default)", () => {
  assert.equal(qualityModeToNTakes("fast"), 1);
  assert.equal(qualityModeToNTakes("high"), 4);
  assert.throws(() => qualityModeToNTakes("nope"));
});

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

test("fetchResultSrt returns subtitle text, null on 404, throws on other errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.endsWith("/api/dub/result/ok123/srt")) {
        return new Response("1\n00:00:00,000 --> 00:00:01,000\nhi\n", { status: 200 });
      }
      if (url.endsWith("/api/dub/result/none123/srt")) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 500 });
    };

    assert.match(await fetchResultSrt("ok123"), /hi/);
    assert.equal(await fetchResultSrt("none123"), null);
    await assert.rejects(() => fetchResultSrt("boom"));
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

test("buildDubFormData sends trim_start/trim_end only when a trim is given", () => {
  const fd = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko", trim: { start: 2, end: 8 } });
  assert.equal(fd.get("trim_start"), "2"); assert.equal(fd.get("trim_end"), "8");
  const fd2 = buildDubFormData({ video: new Blob(["x"]), targetLang: "ko" });
  assert.equal(fd2.get("trim_start"), null);
});

// --- migrateStoredSettings: one-time stale-"fast" default migration -------
test("migrateStoredSettings: implicit 'fast' (pre-migration) is dropped and the marker is set", () => {
  const out = migrateStoredSettings({ defaultQualityMode: "fast" });
  assert.equal("defaultQualityMode" in out, false);
  assert.equal(out.qualityDefaultMigrated, true);
});

test("migrateStoredSettings: sets the marker even when there is nothing to migrate", () => {
  const out = migrateStoredSettings({});
  assert.equal(out.qualityDefaultMigrated, true);
});

test("migrateStoredSettings: a user's explicit 'fast' choice made AFTER migration is preserved", () => {
  const alreadyMigrated = { qualityDefaultMigrated: true, defaultQualityMode: "fast" };
  const out = migrateStoredSettings(alreadyMigrated);
  assert.equal(out.defaultQualityMode, "fast");
  assert.equal(out.qualityDefaultMigrated, true);
});

test("migrateStoredSettings: 'high' is left untouched", () => {
  const out = migrateStoredSettings({ defaultQualityMode: "high" });
  assert.equal(out.defaultQualityMode, "high");
  assert.equal(out.qualityDefaultMigrated, true);
});

test("migrateStoredSettings: never touches other keys", () => {
  const out = migrateStoredSettings({ defaultTranslateEngine: "gemini", defaultQualityMode: "fast" });
  assert.equal(out.defaultTranslateEngine, "gemini");
  assert.equal("defaultQualityMode" in out, false);
});

// --- applyEngineAvailability: GET /api/engines progressive enhancement ----
const ALL_AVAILABLE = { gemma_available: true, qwen_available: true, gemini_available: true, perso_available: true };

test("applyEngineAvailability: all engines available -> no disabling, no switch, no warning", () => {
  const result = applyEngineAvailability(ALL_AVAILABLE, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: false, perso: false });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: gemma dead -> disabled and translate switches to gemini", () => {
  const av = { ...ALL_AVAILABLE, gemma_available: false };
  const result = applyEngineAvailability(av, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: true, gemini: false, perso: false });
  assert.equal(result.translate, "gemini");
  assert.equal(result.warning, null);
});

// Gemini used to be the one engine the form never greyed out: disable only
// carried gemma/perso, so "Gemini (cloud, needs API key)" stayed selectable
// with no key and the user only found out at Start dubbing (a 422 from
// dub_start's preflight).
test("applyEngineAvailability: gemini dead -> disabled and translate switches to gemma", () => {
  const av = { ...ALL_AVAILABLE, gemini_available: false };
  const result = applyEngineAvailability(av, { translate: "gemini", stt: "local" });
  assert.deepEqual(result.disable, { gemma: false, gemini: true, perso: false });
  assert.equal(result.translate, "gemma");
  assert.equal(result.warning, null);
});

test("applyEngineAvailability: both translate engines dead -> warning shown, current selection kept", () => {
  const av = { ...ALL_AVAILABLE, gemma_available: false, gemini_available: false };
  const result = applyEngineAvailability(av, { translate: "gemma", stt: "local" });
  assert.deepEqual(result.disable, { gemma: true, gemini: true, perso: false });
  assert.equal(result.translate, "gemma"); // kept, nothing else to switch to
  // "install Ollama" was stale advice: the desktop installer downloads and
  // runs its own Ollama, so there is nothing for a user to install by hand.
  // Restarting is what actually helps -- boot re-runs the installer for a kit
  // missing the runtime or the model (checkKit), and relaunches the server for
  // a kit that has both but failed to start it.
  assert.equal(result.warning, "No translation engine is ready. Restart PersoDub, or save a Gemini API key in Settings.");
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
