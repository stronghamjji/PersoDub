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

// English labels for each pipeline stage, keyed by the "N" in "N/6 ..." log
// lines (the product's UI language is English -- design decision, spec v2). Stage 5
// never appears in the backend's own logs (the pipeline jumps 4/6 -> 6/6),
// so a label is still defined for it in case that changes, and the progress
// bar treats "furthest stage seen" as the current stage either way.
const STAGE_LABELS = {
  1: "Separating background audio",
  2: "Transcribing & detecting speakers",
  3: "Preparing translated subtitles",
  4: "Cloning & synthesizing voices",
  5: "Finishing touches",
  6: "Building the final file",
};
const TOTAL_STAGES = 6;

// Plain-language phrases for the DEFAULT (end-user) progress view -- no model
// names or internal stage jargon (the raw log is hidden by default for end
// users). The full STAGE_LABELS above are still used in the developer-details
// raw log.
const PLAIN_STAGE_LABELS = {
  1: "Preparing audio",
  2: "Transcribing",
  3: "Translating",
  4: "Generating voices",
  5: "Finishing",
  6: "Finishing",
};

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
export function directionToLanguage(direction) {
  if (direction === "ko_to_en") return { language: "English", language_code: "en" };
  if (direction === "en_to_ko") return { language: "Korean", language_code: "ko" };
  throw new Error(`Unknown dubbing direction: ${direction}`);
}

// Friendly quality mode -> n_takes (Qwen3-TTS best-of-N selection count).
export function qualityModeToNTakes(qualityMode) {
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

  return fd;
}

/**
 * One-time migration for the localStorage-backed settings object: builds
 * before 2026-08-04 persisted "fast" as an implicit default the moment
 * Settings was opened, silently forcing n_takes=1 on every future dub. Runs
 * once per stored object (guarded by the qualityDefaultMigrated marker) so a
 * user's later, deliberate "fast" choice is preserved after the one-time
 * cleanup. Never touches any other key.
 *
 * @param {Object} s - the parsed stored-settings object (may be {})
 * @returns {Object} the migrated settings object
 */
export function migrateStoredSettings(s) {
  const out = { ...s };
  if (!out.qualityDefaultMigrated && out.defaultQualityMode === "fast") {
    delete out.defaultQualityMode;
  }
  out.qualityDefaultMigrated = true;
  return out;
}

/**
 * Progressive-enhancement decision logic for GET /api/engines: given the
 * engine-availability payload and the Upload form's current translate/STT
 * selections, decides what to disable, whether the translate selection must
 * move off a dead engine, and what warning (if any) to show. Never changes
 * an already-available current selection.
 *
 * @param {Object} av - GET /api/engines JSON: {gemma_available, qwen_available, gemini_available, perso_available}
 * @param {Object} current - {translate, stt} the Upload form's current select values
 * @returns {{disable: {gemma: boolean, gemini: boolean, perso: boolean}, translate: string, warning: (string|null)}}
 */
export function applyEngineAvailability(av, current) {
  // gemini belongs here as much as gemma does: without it, "Gemini (cloud,
  // needs API key)" stayed selectable with no key saved and the user only
  // learned otherwise from dub_start's 422 after pressing Start dubbing.
  const disable = {
    gemma: !av.gemma_available,
    gemini: !av.gemini_available,
    perso: !av.perso_available,
  };

  const isAvailable = { gemma: av.gemma_available, gemini: av.gemini_available };
  let translate = current.translate;
  let warning = null;
  if (!isAvailable[translate]) {
    const fallback = ["gemma", "gemini"].find((engine) => isAvailable[engine]);
    if (fallback) {
      translate = fallback;
    } else {
      // Not "install Ollama": the desktop installer downloads and runs its
      // own, so a user has nothing to install by hand. Restarting is the
      // advice that works for both ways this state is reached -- a kit
      // missing the runtime/model re-enters the installer on boot, and a
      // complete kit whose Ollama failed to start gets a fresh launch.
      warning = "No translation engine is ready. Restart PersoDub, or save a Gemini API key in Settings.";
    }
  }

  return { disable, translate, warning };
}

/** POST /api/dub/start and return the new job id. */
export async function startDubJob(formData, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/start`, { method: "POST", body: formData });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Failed to start dubbing (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.job_id;
}

/** GET /api/dub/jobs/{jobId}: raw job status object. */
export async function fetchJob(jobId, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Failed to check job status (HTTP ${res.status})`);
  return res.json();
}

/** URL for GET /api/dub/result/{jobId} (cache-busted). */
export function resultUrl(jobId, { baseUrl = "" } = {}) {
  return `${baseUrl}/api/dub/result/${jobId}?t=${Date.now()}`;
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

/**
 * GET /api/dub/result/{jobId}/srt -- the translated subtitles as plain text,
 * for the Export tab's subtitle viewer. Returns null (not an error) if the
 * job has no subtitle file on record, so callers can just hide that section.
 */
export async function fetchResultSrt(jobId, { baseUrl = "" } = {}) {
  const res = await fetch(`${baseUrl}/api/dub/result/${jobId}/srt`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load subtitles (HTTP ${res.status})`);
  return res.text();
}

/**
 * Parse a job's log lines and find the furthest "N/6 ..." stage reached.
 * Returns { stage, total, label, plainLabel, percent }. stage=0 means nothing
 * logged yet. label is the detailed (developer-view) phrase; plainLabel is
 * the jargon-free phrase for the default end-user progress bar.
 */
export function parseProgress(logs) {
  let stage = 0;
  let label = "Waiting to start";
  let plainLabel = "Waiting to start";
  for (const raw of logs || []) {
    const m = /^(\d)\/6\s+(.*)$/.exec(String(raw).trim());
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= stage) {
      stage = n;
      label = STAGE_LABELS[n] || m[2];
      plainLabel = PLAIN_STAGE_LABELS[n] || label;
    }
  }
  return { stage, total: TOTAL_STAGES, label, plainLabel, percent: Math.round((stage / TOTAL_STAGES) * 100) };
}

/**
 * Poll a job until it settles into a final state (done/error/cancelled),
 * calling onUpdate(job, progress) on every poll. Resolves with the final job
 * object. "cancelling" (see cancelDubJob below) is still in-progress -- the
 * pipeline stops at its next stage boundary, not immediately -- so polling
 * continues through it just like "running".
 *
 * @param {string} jobId
 * @param {Object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.intervalMs=3000]
 * @param {(job: object, progress: object) => void} [options.onUpdate]
 * @param {() => boolean} [options.shouldStop] - return true to abort polling early
 */
export async function pollDubJob(jobId, { baseUrl = "", intervalMs = 3000, onUpdate, shouldStop } = {}) {
  for (;;) {
    const job = await fetchJob(jobId, { baseUrl });
    const progress = parseProgress(job.logs);
    if (onUpdate) onUpdate(job, progress);
    if (job.status !== "running" && job.status !== "cancelling") return job;
    if (shouldStop && shouldStop()) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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

export const TOTAL_DUB_STAGES = TOTAL_STAGES;
