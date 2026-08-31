// dubApi.mjs
//
// Framework-agnostic "plumbing" layer for the PersoDub UI: builds the
// multipart/form-data contract for POST /api/dub/start, polls job status,
// and parses the "N/6 ..." progress log lines the backend pipeline emits
// (see app/pipeline.py) into a friendly stage/percent for the UI.
//
// No DOM code and no styling here on purpose -- this module stays usable
// no matter which frontend framework (or no framework) the approved visual
// design ends up using.

// The 10 languages the bundled Qwen3-TTS model supports -- read from the
// model's own config.json (codec_language_id). English/Korean first (product
// order), the rest alphabetical.
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
];

// Legacy direction -> the (language, language_code) pair the API expects
// (both name the TARGET language; see app/main.py DubStartRequest / run_dub).
// Not exported: buildDubFormData below is the only caller, and its own tests
// cover both mappings through the form it builds.
function directionToLanguage(direction) {
  if (direction === "ko_to_en") return { language: "English", language_code: "en" };
  if (direction === "en_to_ko") return { language: "Korean", language_code: "ko" };
  throw new Error(`Unknown dubbing direction: ${direction}`);
}

// Friendly quality mode -> n_takes (Qwen3-TTS best-of-N selection count).
// Not exported, for the same reason as directionToLanguage above.
function qualityModeToNTakes(qualityMode) {
  if (qualityMode === "fast") return 1;
  if (qualityMode === "high") return 4;
  throw new Error(`Unknown quality mode: ${qualityMode}`);
}

/**
 * Build the multipart/form-data body for POST /api/dub/start from friendly
 * UI option values. This is the single source of truth for the field names
 * the backend expects (app/main.py:dub_start).
 *
 * @param {Object} opts
 * @param {File|Blob} opts.video - required video file
 * @param {string} [opts.sourceLang] - source language code (with targetLang, the preferred path)
 * @param {string} [opts.targetLang] - target language code from LANGUAGES
 * @param {"ko_to_en"|"en_to_ko"} [opts.direction] - legacy dubbing direction (fallback)
 * @param {"auto"|"perso"|"local"} [opts.sttEngine="auto"] - transcription engine choice
 * @param {"fast"|"high"} [opts.qualityMode="fast"] - fast = 1 take, high = 4 takes
 * @param {number} [opts.nTakesOverride] - advanced: explicit take count, overrides qualityMode
 * @param {number} [opts.numSpeakers] - advanced: known speaker count (omit = auto-detect)
 * @param {"auto"|"gemma"|"gemini"} [opts.translateEngine] - advanced: translation engine
 * @param {File|Blob} [opts.srt] - advanced: pre-translated subtitles (used as-is)
 * @param {File|Blob} [opts.sourceSrt] - advanced: source-language script (translated instead of STT)
 * @param {{start: number, end: number}} [opts.trim] - dub only this part of the video, in seconds
 * @returns {FormData}
 */
export function buildDubFormData(opts) {
  if (!opts || (!opts.video && !opts.sourceUrl)) {
    throw new Error("A video file or a link is required.");
  }
  let language, language_code, sourceCode = null;
  if (opts.targetLang) {
    // New source/target pair path (the Direction dropdown was split 2026-08-04).
    // sourceLang is optional -- "" means auto-detect, so only targetLang is required here.
    if (opts.sourceLang === opts.targetLang) {
      throw new Error("Source and target languages must be different.");
    }
    const target = LANGUAGES.find((l) => l.code === opts.targetLang);
    if (!target) throw new Error(`Unsupported target language: ${opts.targetLang}`);
    language = target.name;
    language_code = target.code;
    sourceCode = opts.sourceLang;
  } else {
    ({ language, language_code } = directionToLanguage(opts.direction));
  }
  const nTakes = opts.nTakesOverride ?? qualityModeToNTakes(opts.qualityMode ?? "fast");

  const fd = new FormData();
  // Exactly one source -- the server rejects both (app/main.py:dub_start).
  if (opts.video) fd.append("video", opts.video);
  else fd.append("source_url", opts.sourceUrl);
  fd.append("language", language);
  fd.append("language_code", language_code);
  if (sourceCode) fd.append("source_language_code", sourceCode);
  fd.append("n_takes", String(nTakes));

  const stt = opts.sttEngine ?? "auto";
  if (stt !== "auto") fd.append("stt_engine", stt);

  // Voice/background separation: local Demucs is the server default, so only
  // the paid Perso choice is worth sending (app/main.py:dub_start sep_engine).
  if (opts.sepEngine === "perso") fd.append("sep_engine", "perso");

  // Whole-job cloud dubbing: local is the default; only the paid choice travels.
  if (opts.dubMode === "perso") fd.append("dub_mode", "perso");

  if (opts.numSpeakers != null) fd.append("num_speakers", String(opts.numSpeakers));
  if (opts.translateEngine && opts.translateEngine !== "auto") {
    fd.append("translate_engine", opts.translateEngine);
  }
  if (opts.srt) fd.append("srt", opts.srt);
  if (opts.sourceSrt) fd.append("source_srt", opts.sourceSrt);
  // Names the job's folder and the download folder. Sent from here because the
  // screen already knows a link's title from its own probe, while the server
  // only learns it after the download (app/source_fetch.py's fetch returns
  // nothing). Omitted, the server falls back to the filename or the URL.
  if (opts.project) fd.append("project", opts.project);
  // A chosen part of the video, in seconds. Both ends or neither: the server
  // rejects one alone, because half a range has no meaning.
  if (opts.trim) {
    fd.append("trim_start", String(opts.trim.start));
    fd.append("trim_end", String(opts.trim.end));
  }

  return fd;
}

/**
 * Progressive-enhancement decision logic for GET /api/engines: given the
 * engine-availability payload and the Upload form's current translate/STT
 * selections, decides what to grey out. Local models (Gemma, Hunyuan) are
 * never disabled and never switched away from -- a missing one shows its
 * Download line under the dropdown (the model catalog), and Start dubbing
 * explains the rest through the 409 dialog. Only key-gated cloud engines
 * grey out.
 *
 * @param {Object} av - GET /api/engines JSON: {gemma_available, qwen_available, hunyuan_available, gemini_available, perso_available}
 * @param {Object} current - {translate, stt} the Upload form's current select values
 * @returns {{disable: {gemma: boolean, gemini: boolean, perso: boolean}, translate: string, warning: (string|null)}}
 */
export function applyEngineAvailability(av, current) {
  // gemini belongs here as much as gemma does: without it, "Gemini (cloud,
  // needs API key)" stayed selectable with no key saved and the user only
  // learned otherwise from dub_start's 422 after pressing Start dubbing.
  const disable = {
    gemma: false,
    gemini: !av.gemini_available,
    perso: !av.perso_available,
  };
  return { disable, translate: current.translate, warning: null };
}

/** POST /api/dub/start and return the new job id. */
export async function startDubJob(formData, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/start`, { method: "POST", body: formData });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(text || `Failed to start dubbing (HTTP ${res.status})`);
    // The missing-models 409 carries a structured detail the caller renders
    // as the download dialog -- hand it over parsed, beside the status.
    err.status = res.status;
    try { err.detail = JSON.parse(text).detail; } catch { /* plain text error */ }
    throw err;
  }
  const data = await res.json();
  return data.job_id;
}

/** GET /api/dub/jobs/{jobId}: raw job status object. */
export async function fetchJob(jobId, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/jobs/${jobId}`);
  if (!res.ok) {
    const err = new Error(`Failed to check job status (HTTP ${res.status})`);
    // Carried so a caller can tell an answer from no answer: a server that is
    // not there throws before this, with no status on it at all.
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * URL for GET /api/dub/result/{jobId} -- stable, so a caller can tell whether
 * the player is already showing this job. A finished video only changes when a
 * line is remade, and the caller adds its own marker at that moment.
 */
export function resultUrl(jobId, { baseUrl = "" } = {}) {
  return `${baseUrl}/api/dub/result/${jobId}`;
}

/**
 * POST /api/source/probe -- read a link's title/duration/thumbnail without
 * downloading it. On failure the thrown Error carries a `.reason` (login /
 * geo / gone / network / unsupported / unknown) so the caller can steer the
 * user toward the upload tab with a sentence that fits.
 */
export async function probeSource(url, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/source/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail || {};
    const err = new Error(detail.message || "Couldn't fetch the video.");
    err.reason = detail.reason || "unknown";
    throw err;
  }
  return res.json();
}

// The pipeline logs six "N/6 ..." stages, but the UI shows four: stages 4-6
// (voice synthesis, the skipped leakage check, and file-building) all read
// as "Dubbing" to the user.
const STAGE_OF = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 4 };
const STAGE_LABELS4 = { 1: "Separating audio", 2: "Transcribing", 3: "Translating", 4: "Dubbing" };
const STAGE_WEIGHT = { 1: 10, 2: 25, 3: 20, 4: 45 }; // sums to 100
// The voice-line math only ever fills 40 of Dubbing's 45 points (not the full
// 45) so that raw 5 (Check) and raw 6 (Build) -- which land after every voice
// line is already done -- still have room to nudge percent up (96, then 97)
// instead of ever having to snap it back down. 100 is reserved for the UI to
// set once the job's status is actually "done".
const VOICE_CAP = 40;

/**
 * Parse a job's log lines and find the furthest "N/6 ..." stage reached,
 * folded into the four stages the UI shows. Returns
 * { stage, total: 4, label, percent, voiceDone, voiceTotal }. stage=0 means
 * nothing logged yet. percent never decreases as logs grow -- callers can
 * feed it a job's logs on every poll and just render whatever comes back.
 *
 * During stage 4 (voice synthesis), percent also tracks per-line progress
 * from the "line N: chose take" log lines (app/qwen_pipeline.py:472) against
 * voiceTotal -- opts.lineCount if the caller has it, else read from the
 * pipeline's own "N dialogue lines prepared" log line (app/pipeline.py:512),
 * since a running job's script can't be fetched (the script API 409s until
 * the job finishes). An explicit lineCount wins when both are available.
 */
export function parseProgress(logs, { lineCount = null } = {}) {
  let raw = 0, voiceDone = 0, loggedTotal = null;
  for (const line of logs || []) {
    const m = /^(\d)\/6\s/.exec(String(line).trim());
    if (m) raw = Math.max(raw, parseInt(m[1], 10));
    if (/^\s*line \d+: chose take/.test(line)) voiceDone += 1;
    const t = /^\s*(\d+) dialogue lines prepared/.exec(line);
    if (t) loggedTotal = parseInt(t[1], 10);
  }
  const stage = STAGE_OF[raw] || 0;
  const voiceTotal = lineCount ?? loggedTotal;
  let percent = 0;
  for (let s = 1; s < stage; s++) percent += STAGE_WEIGHT[s];
  if (stage === 4 && voiceTotal) percent += Math.round(VOICE_CAP * Math.min(voiceDone, voiceTotal) / voiceTotal);
  else if (stage >= 1) percent += Math.round(STAGE_WEIGHT[stage] * 0.3);
  if (raw >= 5) percent = Math.max(percent, raw === 6 ? 97 : 96);
  return { stage, total: 4, label: STAGE_LABELS4[stage] || "Waiting to start", percent, voiceDone, voiceTotal, raw };
}

/**
 * Poll a job until it settles into a final state (done/error/cancelled),
 * calling onUpdate(job, progress) on every poll. Resolves with the final job
 * object. "cancelling" (see cancelDubJob below) is still in-progress -- the
 * pipeline stops at its next stage boundary, not immediately -- so polling
 * continues through it just like "running".
 *
 * A failed request does NOT end the loop. The server going quiet for a while
 * -- a sleeping laptop, a restarting engine -- says nothing about the dub,
 * which carries on behind it; giving up there froze the running screen at its
 * last percent with no way back. So a failure only slows the asking down
 * (intervalMs, doubling up to maxIntervalMs) and tells the caller through
 * onUnreachable, and the next answer picks the job straight back up. The only
 * things that end the loop are the job finishing and shouldStop().
 *
 * @param {string} jobId
 * @param {Object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.intervalMs=3000]
 * @param {number} [options.maxIntervalMs=10000] - the slowest it backs off to
 * @param {(job: object, progress: object) => void} [options.onUpdate]
 * @param {(error: Error) => void} [options.onUnreachable] - a request failed; still trying
 * @param {() => boolean} [options.shouldStop] - return true to abort polling early
 */
export async function pollDubJob(jobId, {
  baseUrl = "", intervalMs = 3000, maxIntervalMs = 10000,
  onUpdate, onUnreachable, shouldStop,
} = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let wait = intervalMs;
  for (;;) {
    let job;
    try {
      job = await fetchJob(jobId, { baseUrl });
    } catch (e) {
      if (shouldStop && shouldStop()) return null;
      // A 404 is an answer, not an outage: the server is right there and says it
      // has no such job (its workspace was cleared, or the app was pointed at a
      // different one). Asking again every ten seconds would never bring it
      // back, and "still trying" would not be true.
      if (e.status === 404) {
        throw new Error("This job is no longer on the app server -- it may have been deleted.");
      }
      if (onUnreachable) onUnreachable(e);
      await sleep(wait);
      wait = Math.min(wait * 2, maxIntervalMs);
      continue;
    }
    wait = intervalMs;   // back in touch -- ask at the normal pace again
    const progress = parseProgress(job.logs);
    if (onUpdate) onUpdate(job, progress);
    if (job.status !== "running" && job.status !== "cancelling") return job;
    if (shouldStop && shouldStop()) return job;
    await sleep(wait);
  }
}

/**
 * POST /api/dub/jobs/{jobId}/cancel -- ask the backend to stop a running job
 * at its next stage boundary (app/pipeline.py's cooperative cancel_check).
 * Returns the job's status right after the call (normally "cancelling").
 * Throws on 404 (unknown job) or 409 (job already finished -- nothing left
 * to cancel), using the server's error detail when available.
 */
export async function cancelDubJob(jobId, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/jobs/${jobId}/cancel`, { method: "POST" });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch { /* ignore -- use the fallback message below */ }
    throw new Error(detail || `Failed to cancel (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.status;
}

// ---- What a finished job was made with -------------------------------------
// The server saves the four choices a job was started with on the job record
// (app/jobs.py SAVED_FIELDS). These turn them into the short human labels the
// finished screen and the Projects rows show. A job saved before those fields
// existed has none of them, and gets an empty list -- which is what makes the
// whole row disappear rather than showing half a sentence.
// The engine's own name only. Which job it did is said by the role word beside
// it, which comes from the field the id was read out of -- so "Perso STT" is
// now the role "STT" and the name "Perso", rather than one run-on label.
const ENGINE_LABELS = {
  whisper: { label: "Whisper", api: false },
  perso: { label: "Perso", api: true },
  gemma: { label: "Gemma 3", api: false },
  qwen: { label: "Qwen", api: false },
  hunyuan: { label: "Hunyuan 1.8B", api: false },
  gemini: { label: "Gemini", api: true },
  vertex: { label: "Vertex", api: true },
  qwen3: { label: "Qwen3-TTS", api: false },
};

// 1 take is the fast path; anything more is the best-of-N selection. The words
// are the New project dialog's own ("Fast" / "High quality"): a chip that
// renamed the choice to "Standard" left the user looking for a setting by that
// name and not finding one. No role word -- "mode" is what this chip is about.
function qualityChip(quality) {
  if (quality == null) return null;
  const takes = Number(quality);
  if (!Number.isFinite(takes)) return null;
  return { role: "", label: takes <= 1 ? "Fast mode" : "High quality mode", api: false };
}

/**
 * The chips for one job: the quality mode it was run at, then the engine that
 * did each of the three jobs. Every chip carries the role it played (""
 * for the quality one) so both screens can print the role in the muted grey
 * and the engine's own name in the reading colour, inside the one pill.
 * `api: true` marks a chip that cost money (a cloud engine), which both screens
 * colour differently. Unknown fields are left out; a record with no engine
 * fields at all returns [].
 *
 * @param {Object} job - a job record (or list row) from the API
 * @param {{withQuality?: boolean, withTts?: boolean}} [opts]
 *   What a sidebar row leaves out: the quality chip is long enough to wrap a
 *   130px column on its own, and it is the finished screen that is about how
 *   the job was made.
 */
export function engineChips(job, { withQuality = true, withTts = true } = {}) {
  const j = job || {};
  const chips = [];
  // The role is the field the id was read out of, which is the only place it
  // can be known from: "qwen" translates and "qwen3" speaks.
  for (const [role, key] of [["Dubbing", j.dub_mode], ["Separation", j.separation], ["STT", j.stt_engine],
                             ["Translation", j.translator], ["TTS", withTts ? j.tts : null]]) {
    const known = key ? ENGINE_LABELS[String(key).toLowerCase()] : null;
    if (known) chips.push({ role, ...known });
  }
  if (chips.length === 0) return [];   // nothing known -- say nothing at all
  const quality = withQuality ? qualityChip(j.quality) : null;
  // Quality leads the row: it is the one choice the user made by hand, where
  // the three engines below it are mostly whatever the app had installed.
  if (quality) chips.unshift(quality);
  return chips;
}

/** A job's start time as "YYYY-MM-DD HH:MM" in the user's own timezone. */
export function startedLabel(created) {
  if (!created) return "";
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
