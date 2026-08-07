# Development guide

User-facing documentation lives in [README.md](../README.md). This document is
for people working on the code itself.

## Architecture overview

PersoDub's core is a FastAPI web app, wrapped by the desktop app (`desktop/`,
Electron) that launches it. The app itself is a lightweight **orchestrator**;
the heavy AI work (source separation, speech recognition, speaker diarization,
translation, speech synthesis) runs in local subprocesses or a separately
launched sidecar service.

Heavy Python libraries (torch, onnxruntime, faster-whisper, ...) are **never
installed** into the core Python 3.11 virtualenv (`.venv`). Each heavy stage
gets its own interpreter via environment variables (`SEP_PYTHON`,
`DIAR_PYTHON`, `STT_PYTHON`, `QWEN_SCORER_PYTHON`). A subprocess failure never
takes the core app down — the affected stage either falls back or fails
cleanly on its own.

## Dependent services

| Service | Role | Required? | How the app finds it |
|---|---|---|---|
| **Qwen3-TTS sidecar** | Voice cloning + speech synthesis (the TTS engine). Vendored at `desktop/vendor/sidecar/server.py`, run as a separate process | Required | `QWEN_TTS_URL` (default `http://127.0.0.1:3901`) |
| **Translation engine** (pick one) | Translates lines into the target language | Required (one of) | Local: **Ollama** (`OLLAMA_URL`, `OLLAMA_MODEL`) / Cloud: **Google Gemini API** — `TRANSLATE_ENGINE=gemini` + `GEMINI_API_KEY` |
| **Perso STT** | Cloud speech recognition + speaker labels | Optional | `PERSO_API_KEY` / `PERSO_SPACE_SEQ` / `PERSO_MEDIA_HOST`. Without a key, local **Whisper** is used |
| **Local Demucs** (source separation) | Splits voices from background audio — runs as an in-app subprocess | Required (built in) | `SEP_PYTHON`, `SEP_MODEL_DIR` |
| **Local CAM++** (speaker diarization) | Labels lines by speaker (optional feature) | Optional | `DIAR_PYTHON`, `PERSODUB_CAMPPLUS_MODEL` |
| **ffmpeg** | Audio/video cutting and final muxing | Required | Must be on `PATH` |

## Running locally

Start the Qwen3-TTS sidecar (`desktop/vendor/sidecar/server.py`) first and
point `QWEN_TTS_URL` at it. Then run the backend with uvicorn — this is the
supported local path:

```bash
# 1) Copy the template into your own .env and load it (see "Configuration"
#    below -- never commit secrets)
set -a; source .env; set +a

# 2) Run the server
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8860

# 3) Open in a browser
#    http://127.0.0.1:8860/
```

If `.venv` doesn't exist yet:
`python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt`

### Docker (currently unverified)

A `Dockerfile` and `docker-compose.yml` are in the repository, but they do not
yet provision the subprocess interpreters the pipeline needs. The supported
path is the local uvicorn setup above.

## Configuration (environment variables)

Copy `env.server.example` to your own `.env` and fill in the values. Secrets
(API keys, key-file paths) must never be committed — `.gitignore` already
blocks `.env`, `*.env`, and `config/`.

| Variable | Default | Meaning |
|---|---|---|
| `QWEN_TTS_URL` | `http://127.0.0.1:3901` | Qwen3-TTS sidecar address |
| `TRANSLATE_ENGINE` | `gemma` | `gemma` / `qwen` = local Ollama, `gemini` = Google Gemini API |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `gemma3:12b` | Local Ollama server and model |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | (none) / `gemini-flash-latest` | Google Gemini API key (secret) and model |
| `STT_ENGINE` | (none; `perso` when a Perso key exists) | `perso`, or empty for local Whisper |
| `PERSO_API_KEY` / `PERSO_SPACE_SEQ` / `PERSO_MEDIA_HOST` | (none; secrets) | Perso STT account settings |
| `PERSO_RECHARGE_URL` | the Perso subscription page | Recharge page shown when credits run out |
| `SEP_PYTHON` / `SEP_MODEL_DIR` | `python3` / `models/demucs` | Interpreter and model path for local Demucs |
| `DIAR_PYTHON` / `PERSODUB_CAMPPLUS_MODEL` | `python3` / `models/campplus/campplus.onnx` | Interpreter and model for local CAM++ |
| `QWEN_SCORER_PYTHON` / `QWEN_N_TAKES` | `python3` / `4` | Take-scoring interpreter · candidates per line (best-of-N) |

## Quality checks

### Original-voice leakage check (required before shipping a dub)

Every finished dub must pass this check — it fails if the original speaker's
voice remains audible under the dub:

```bash
python3 -m app.scripts.check_leakage FINAL.mp4 WORKSPACE/vocals.wav   # exit code 0 = pass
```

It measures residual original-voice content in the final mix per 100 ms window
(lag-0 projection plus a shifted-lag significance test that filters out
coincidental correlation). If a run fails because the TTS echoed its voice
reference, `python3 -m app.scripts.suppress_vocal_echo` can surgically remove
just those spans; re-check afterwards.

### The no-time-stretch policy (with a watchdog)

PersoDub never speeds audio up or slows it down to fit a translation. Length
is solved in the **translation stage**: each line is asked to land within ±15%
of its subtitle slot, and the assembly code carries a stretch-rate watchdog
that verifies no time-stretch ever happens.

Length-fitting retry policy:
- Local (free) engines: up to 3 re-translations per line.
- Cloud engines: exactly **one** call per batch — the prompt asks for 3
  candidate translations per line and the best-fitting candidate is picked
  locally (best-of-3 quality with no extra calls).

## Tests

```bash
.venv/bin/python -m pytest tests/ -q       # Python (pipeline)
cd desktop && npm test                     # Electron desktop shell
```

All tests are pure-logic tests — they run without any external service (TTS
sidecar, Ollama, Perso).

## Project layout

```
app/
  main.py                FastAPI endpoints (upload, dub, progress, download, translation API)
  pipeline.py            run_dub(): orchestrates the whole pipeline
  qwen_pipeline.py       TTS dub path: voice registration -> synthesis -> line placement
  qwen_assemble.py       line placement, loudness matching, final audio assembly
  translate.py           translation engines (Ollama / Google Gemini API)
  text/length_fit.py     the ±15% length-budget retranslation logic
  text/srt.py            subtitle parsing / timing utilities
  separate.py            local Demucs source separation
  stt_local.py           local Whisper speech recognition
  perso_client.py        Perso STT client
  diar_campplus_client.py  local CAM++ speaker diarization
  scripts/check_leakage.py        required pre-ship leakage check
  scripts/suppress_vocal_echo.py  surgical removal of TTS reference echo
  engines/               TTS engine interface + the Qwen3-TTS adapter
  config.py              every environment variable, defined in one place
desktop/                 Electron desktop shell (install, engine management, window)
static/index.html        the web UI
ui/src/                  UI plugin-layer JS modules (with node:test unit tests)
tests/                   unit tests
```

## Working conventions

- **Experiments happen on branches**, not in copied folders. Copying the
  pipeline into dated snapshot folders was retired: it made `master` carry
  dead code, let scripts drift from `app/`, and blurred which copy was real.
- **Reproducible runs are frozen with git tags**, not folder copies.
- When an experiment ends, either fold the result into `app/` with tests, or
  leave a one-line note explaining why not. Skipping that step is how the app
  and experiment code diverge.
