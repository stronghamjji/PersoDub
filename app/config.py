import os

# Settings whose value in the environment could not be used. Filled in by the
# two readers below, checked once at startup (app/main.py's lifespan), which is
# what turns a typo in a .env file into one clear message instead of a stack
# trace at import time -- or, worse, a number silently doing nothing like what
# the user wrote.
CONFIG_ERRORS = []


def _env_int(name, default, minimum=None):
    """int(os.environ[name]), except that a bad value is recorded, not raised.

    Raising here would abort the import of app.config, which every module in
    the app imports -- so one stray character in a .env file used to take the
    whole app down with a traceback nobody could act on. The default is used
    instead and the reason goes in CONFIG_ERRORS for startup to report.
    """
    return _env_number(int, "an integer", name, default, minimum)


def _env_float(name, default, minimum=None):
    """float(os.environ[name]) under the same rule as _env_int."""
    return _env_number(float, "a number", name, default, minimum)


def _env_number(cast, expected, name, default, minimum):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        CONFIG_ERRORS.append("%s: got %r, expected %s (default %s)" % (name, raw, expected, default))
        return default
    if minimum is not None and value < minimum:
        CONFIG_ERRORS.append("%s: got %r, expected %s >= %s (default %s)"
                             % (name, raw, expected, minimum, default))
        return default
    return value


# Address of the Qwen3-TTS local sidecar (internal only).
QWEN_TTS_URL = os.environ.get("QWEN_TTS_URL", "http://127.0.0.1:3901")

# Qwen3-TTS voice-clone mode: "timbre" (speaker-embedding-only, clones from
# reference audio alone -- no transcript needed) | "icl" (in-context-learning,
# requires a transcript of the reference audio). Default = timbre (user's
# choice: removes the ref-transcript machinery from the critical path).
QWEN_VOICE_MODE = os.environ.get("QWEN_VOICE_MODE", "timbre")

# Gemini (Google AI Studio) translation — consumer API key, NOT Vertex.
# Kept for back-compat only: it freezes whatever the environment held at import
# time, so a key saved in Settings would never show up here. Everything that
# needs the key reads settings_env.current_value("GEMINI_API_KEY") instead.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")

# Vertex AI Gemini translation (official service-account path, paid quota -- no free-tier
# 429s, unlike GEMINI_API_KEY above). Service-account key file path (NEVER printed/logged --
# app/translate.py only ever passes it to google-auth, which reads it internally), region,
# and model.
VERTEX_SA_KEY_PATH = os.environ.get("VERTEX_SA_KEY_PATH", "")
VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
VERTEX_MODEL = os.environ.get("VERTEX_MODEL", "gemini-2.5-flash")

# Translation engine choice: "gemini" (cloud, needs key) | "vertex" (cloud, service account,
# see VERTEX_* above) | "qwen" | "gemma" | "hunyuan" (local).
# Default = hunyuan (user decision 2026-09-04): the 1.1 GB model, so a dub started
# without an explicit choice -- the screen's default, the Dub Agent's queue_dub --
# asks for a 1.1 GB download at most, never the 7.6 GB Gemma.
# Gemma 3 stays a choice for anyone who downloads it (on the 44-line Joker A/B it was
# the most natural Korean; Hunyuan is more literal and lines can run short).
TRANSLATE_ENGINE_DEFAULT = "hunyuan"
TRANSLATE_ENGINE = os.environ.get("TRANSLATE_ENGINE", TRANSLATE_ENGINE_DEFAULT)

# Ollama (local LLM) translation settings (internal only)
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
# Stock Ollama tags, so a fresh machine works after a plain `ollama pull`.
# The server's custom qwen-dub/gemma-dub aliases can still be set via env.
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma3:12b")
OLLAMA_QWEN_MODEL = os.environ.get("OLLAMA_QWEN_MODEL", "qwen2.5:7b")
OLLAMA_GEMMA_MODEL = os.environ.get("OLLAMA_GEMMA_MODEL", "gemma3:12b")
# Tencent Hunyuan MT2 1.8B, served by Ollama from the Hugging Face GGUF. The
# GGUF ships without a usable chat template, so the in-app installer
# (app/models.py) bakes HUNYUAN_TEMPLATE/HUNYUAN_PARAMETERS in via /api/create
# under the OLLAMA_HUNYUAN_MODEL tag. Template and parameters are the exact
# values validated in the 2026-08-18 translation model comparison.
OLLAMA_HUNYUAN_MODEL = os.environ.get("OLLAMA_HUNYUAN_MODEL", "hy-mt2:1.8b")
HUNYUAN_PULL_SOURCE = "hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M"
HUNYUAN_TEMPLATE = "<｜hy_begin▁of▁sentence｜><｜hy_User｜>{{ .Prompt }}<｜hy_Assistant｜>"
HUNYUAN_PARAMETERS = {
    "repeat_penalty": 1.05,
    "stop": ["<｜hy_place▁holder▁no▁2｜>", "<｜hy_User｜>"],
    "temperature": 0.7,
    "top_k": 20,
    "top_p": 0.6,
}


# Best-of-N take selection on the Qwen dub path (app/qwen_pipeline.synth_lines).
# N_TAKES <= 1 disables selection entirely (single take per line, matching the
# pre-selection behavior). The scorer runs as a subprocess under a separate
# interpreter (QWEN_SCORER_PYTHON) because it needs onnxruntime/torchaudio,
# which the app's own Python 3.8 venv does not have.
QWEN_N_TAKES = _env_int("QWEN_N_TAKES", 4, minimum=0)
# Default "python3" only works if that interpreter has onnxruntime/torchaudio
# installed. On a dev box with a dedicated venv for this, set QWEN_SCORER_PYTHON
# to that venv's interpreter (see env.server.example).
QWEN_SCORER_PYTHON = os.environ.get("QWEN_SCORER_PYTHON", "python3")


# Local Demucs source separation (app/separate.py, app/scripts/demucs_separate.py) --
# the app's only separation path (no container, no fallback). Runs under a separate
# interpreter (SEP_PYTHON) for the same reason QWEN_SCORER_PYTHON does -- torch/
# torchaudio/demucs are not in the app's own Python 3.8 venv.
SEP_PYTHON = os.environ.get("SEP_PYTHON", "python3")
# Relative to the process working directory by default; set SEP_MODEL_DIR to an
# absolute path if you run the app from somewhere else (see env.server.example).
SEP_MODEL_DIR = os.environ.get("SEP_MODEL_DIR", "models/demucs")


# Local CAM++ speaker diarization (app/diar_campplus_client.py,
# app/scripts/campplus_diarize.py) -- runs under a separate interpreter
# (DIAR_PYTHON) for the same reason QWEN_SCORER_PYTHON/SEP_PYTHON do --
# onnxruntime/torch/torchaudio/scikit-learn are not in the app's own Python
# 3.8 venv.
DIAR_PYTHON = os.environ.get("DIAR_PYTHON", "python3")


# Original-vocals gating margin (app/qwen_assemble.gate_vocals_chunks/place_lines).
# Each speech region is padded by this many seconds on both sides (then
# overlapping regions are merged) before the original vocals track is gated
# to silence -- STT cue timestamps (especially local Whisper's, which can be
# whole-second-rounded) are often a bit tighter than the real speech, so an
# unpadded gate can leave a sliver of the original-language audio audible
# right at a line's edge. 0.25s default; raise it if leakage is still heard,
# lower it if too much of the between-line "gap" gets muted.
QWEN_GATE_PAD_SEC = _env_float("QWEN_GATE_PAD_SEC", 0.25, minimum=0.0)

# Gate ducking (app/qwen_assemble.py _gate_chunk/gate_vocals_chunks): a gated
# span of the original vocals is attenuated by this many dB instead of hard-
# muted to true digital silence. A dialogue-heavy clip's gated spans can cover
# most of the clip, and Demucs' vocals stem often carries room tone/breaths
# along with the dialogue -- hard-muting turns all of that into a stark silent
# "hole" between/around dub lines. Ducking instead of zeroing lets that ambient
# presence bleed through at a low level (the original-language dialogue leaks
# through too, at the same level -- keep this high enough that it reads as
# ambience, not intelligible speech). 18dB default (~0.126x).
QWEN_GATE_DUCK_DB = _env_float("QWEN_GATE_DUCK_DB", 18.0)

# Energy-VAD gate extension (app/qwen_assemble.detect_speech_regions +
# place_lines): detect speech directly on the Demucs vocals stem (RMS envelope
# over the stem's own noise floor) and gate the UNION of (padded transcribed
# spans) + (detected speech) + (placed-line spans). Transcribed cue spans alone
# are not a safe gate -- STT can miss a line entirely or time it tighter than
# the real speech, leaving the original voice audible at full level under or
# next to the dub (observed on the 2026-07-30 edit60s delivery: a whole
# 23.0-25.5s stretch of original dialogue had no STT cue at all). 1 = on.
QWEN_GATE_VAD = _env_int("QWEN_GATE_VAD", 1)

# Two-tier ducking: a gated span that the energy VAD flagged as actual SPEECH
# is ducked this deep (near-silent -- it's original-language dialogue, the one
# thing that must never stay audible), while gated non-speech spans keep the
# gentler QWEN_GATE_DUCK_DB ambience duck (room tone/breaths bleed through so
# the mix doesn't fall into vacuum silence). 40dB default (~0.01x).
QWEN_GATE_SPEECH_DUCK_DB = _env_float("QWEN_GATE_SPEECH_DUCK_DB", 40.0)

# A/B escape hatch: 1 = do NOT extend the gate with detected-speech-only
# regions (things STT missed stay un-gated -- preserves laughter/shouts the
# VAD may flag, at the cost of possible original-dialogue leakage). Detected
# speech inside already-gated spans still gets the deep speech duck.
QWEN_GATE_KEEP_NONSPEECH = _env_int("QWEN_GATE_KEEP_NONSPEECH", 0)

# Bed-residue duck (app/qwen_assemble.place_lines): Demucs' background stem is
# not perfectly free of the original dialogue -- on dialogue-heavy clips it
# carries an audible bleed of the voice (measured at up to -5..-15dB relative
# to the finished mix on the 2026-07-30 deliveries), which no amount of
# vocals-stem gating can remove. Where a detected-speech region's bed content
# is MOSTLY that bleed (lag-0 correlation with the vocals stem explains most
# of the bed's energy there), the bed is ducked too, at the speech duck depth.
# Genuine music/effects under dialogue don't correlate with the vocals stem at
# lag 0, so they are left untouched. 1 = on.
QWEN_GATE_BED_RESIDUE = _env_int("QWEN_GATE_BED_RESIDUE", 1)

# Original-vocals gate mode (app/qwen_pipeline.run_qwen_dub ->
# app/qwen_assemble.place_lines). "safe" (default): the original vocals track
# is not mixed into the output at all (place_lines is called with
# vocals_path=None) -- background is the separated no_vocals stem only, so
# leaking the original actor's voice is structurally impossible. This matches
# how professional dubs are assembled (they never mix original vocals into
# the final output either). "preserve" (opt-in):
# keeps laughter/breaths/room tone between lines by leaving the
# original-vocals gate on, but detected-SPEECH regions
# (app.qwen_assemble.detect_speech_regions) are HARD-MUTED (zeroed, not just
# ducked to QWEN_GATE_SPEECH_DUCK_DB) so no original dialogue can bleed
# through even faintly; non-speech regions inside the gate still keep the
# gentler QWEN_GATE_DUCK_DB ambience duck. "company" (opt-in): the
# professional-dub approach -- safe assembly first, then a speech-erased
# original-vocals ambience layer added to the bed (app/audio/ambience.py): the
# union of (speech cue spans +-0.3s), (energetic VAD regions NOT
# whisper-verified nonverbal, fail-closed) and (placed dub-line spans +-0.1s)
# is erased to TRUE ZERO with 60-80ms raised-cosine crossfades (no ducking
# anywhere); verified laughter/breaths and quiet room tone stay at FULL
# original volume. In company mode QWEN_KEEP_NONVERBAL is auto-disabled (the
# layer already carries that content -- overlaying it too would clip/echo).
QWEN_GATE_MODE = os.environ.get("QWEN_GATE_MODE", "safe")

# Leakage-gate rollout mode (app/pipeline.leakage_gate, stage 5/6) -- kill
# switch for a check that's new/unvalidated on Mac. "on" (default): measure +
# auto-fix, today's behavior. "measure": measure and log only, never rewrite
# the mix. "off": skip stage 5/6 entirely. Any other value behaves as "on".
PERSODUB_LEAKAGE_GATE = os.environ.get("PERSODUB_LEAKAGE_GATE", "on").strip().lower()

# Laughter/breath whitelist on top of safe mode (app/nonverbal.py, wired in
# app/qwen_pipeline.run_qwen_dub). Safe mode drops the whole original-vocals
# stem, which also kills laughter/breaths/sighs; with this on (default), the
# non-speech vocal segments that a local-whisper veto verifies contain NO real
# words are copied back into the mix at ORIGINAL volume (a copy of approved
# pieces -- no ducking involved). 0 = plain safe mode, nothing copied.
QWEN_KEEP_NONVERBAL = _env_int("QWEN_KEEP_NONVERBAL", 1)
# Interpreter for the whisper veto subprocess -- openai-whisper is not in the
# app's own venv (same pattern as QWEN_SCORER_PYTHON/SEP_PYTHON). CPU is fine:
# the veto only transcribes sub-second candidate clips. Default = the server
# MUST point at a venv where openai-whisper is installed; with a bare
# "python3" every nonverbal candidate is fail-closed-dropped and an ERROR is
# logged (see app/nonverbal.py), so set this in your .env for real runs.
NONVERBAL_WHISPER_PYTHON = os.environ.get("NONVERBAL_WHISPER_PYTHON", "python3")
NONVERBAL_WHISPER_MODEL = os.environ.get("NONVERBAL_WHISPER_MODEL", "base")

# Where per-job progress logs are written (app/jobs.py). Relative to the working
# directory, so a desktop run lands them next to the code the app is serving.
PERSODUB_LOG_DIR = os.environ.get("PERSODUB_LOG_DIR", "logs")

# Cap, in seconds, on how much leading silence app/qwen_assemble.py's
# _trim_lead_tail_silence will ever trim off a synthesized line before it's
# measured (match_line_gains) or placed (place_lines). Qwen's TTS output can
# start with real dead air (observed up to ~0.6s) that otherwise opens a
# silent gap at the start of the line's cue slot and drags dub_rms down with
# silence instead of voice; this cap just guards against an unusually quiet/
# noisy take's envelope being misread as "all silence" and trimming far more
# than that.
QWEN_TRIM_LEAD_SEC = _env_float("QWEN_TRIM_LEAD_SEC", 1.0, minimum=0.0)

# Cap on the gain ratio allowed between two cue-adjacent lines in
# match_line_gains. Each line's gain is individually "correct" for matching
# its own cue span's loudness, but two independent per-line measurements can
# still swing sharply from one line to the next (observed steps of -10dB/
# +14.6dB) -- capping the step keeps loudness changing gradually, the way a
# real actor's volume moves between adjacent lines rather than jumping.
QWEN_GAIN_STEP_MAX = _env_float("QWEN_GAIN_STEP_MAX", 1.5)


# Ultra-short-line handling on the Qwen dub path (app/audio/merge.py): a line
# whose usable slot (app.text.cues.effective_slots) is under this many seconds
# gets synthesized together with its previous same-speaker/adjacent line in
# one TTS call, then split back apart at the quiet energy valley between the
# two sentences -- otherwise a slot this short can truncate the line's TTS
# output mid-word (observed: "Where's Dent?" / "덴트는?" losing its tail).
QWEN_SHORT_LINE_SEC = _env_float("QWEN_SHORT_LINE_SEC", 0.8, minimum=0.0)
# A short line only merges with its predecessor if the silence between them
# is no more than this many seconds -- otherwise the merged take would carry
# an unnaturally long pause baked into one continuous generation.
QWEN_MERGE_MAX_GAP_SEC = _env_float("QWEN_MERGE_MAX_GAP_SEC", 1.5, minimum=0.0)


def default_stt_engine() -> str:
    """Resolve the STT engine to use when the caller doesn't pick one explicitly.

    The rule itself lives in app/setup.py, which owns every stage's default:
    STT_ENGINE from kit.env wins (the Settings screen and the Dub Agent write
    it there), then the process env, then "perso" when a Perso API key is
    configured (best quality in our comparisons), else the local engine. The
    key is read live (not cached at import time), so a key just saved in
    Settings picks Perso for the very next dub instead of waiting for a
    restart, and tests can monkeypatch the env per case.

    Only the word for "local" differs: setup says "local", this answers ""
    (local Whisper, optionally + diar_engine="campplus"), which is what this
    function's callers have always read as "nobody picked, use the free local
    engine".

    A configured value that is neither engine (STT_ENGINE=whisperx, a typo) is
    handed back untouched rather than quietly replaced: app/api/dub.py answers
    422 "Unknown stt_engine: whisperx" on it, and a person who wrote a name we
    do not have deserves to be told so instead of getting a dub made with a
    different engine. setup.default_for cannot say this -- it treats anything
    outside its own list as "not chosen" -- so the raw value is read here
    first.

    Imported inside the function on purpose: app/setup.py imports this module,
    so importing it at the top would be a cycle.
    """
    from app import setup
    from app.settings_env import current_value

    # current_value already falls back to the process env for a key kit.env
    # never mentions, so this one read covers both places a value can come from.
    configured = (current_value("STT_ENGINE") or "").strip()
    if configured and configured.lower() not in ("local", "perso"):
        return configured
    return "" if setup.default_for("stt") == "local" else "perso"


# The ten languages the bundled voice model speaks, by code -- the same table
# the screen keeps (ui/src/dubApi.mjs LANGUAGES). One copy here, read by the
# server (app/api/dub.py) and by the agent's tools (app/mcp_server.py).
LANGUAGE_NAMES = {
    "en": "English", "ko": "Korean", "zh": "Chinese", "fr": "French",
    "de": "German", "it": "Italian", "ja": "Japanese", "pt": "Portuguese",
    "ru": "Russian", "es": "Spanish",
}
