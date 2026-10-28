# Development guide

User-facing documentation lives in [README.md](../README.md). This document is
for people working on the code itself.

## Architecture overview

PersoDub's core is a FastAPI web app, wrapped by the desktop app (`desktop/`,
Electron) that installs the kit, launches the app and its engines, and shows
the app's page in its window. The app itself is a lightweight
**orchestrator**; the heavy AI work (source separation, speech recognition,
speaker diarization, translation, speech synthesis) runs in local
subprocesses, a separately launched voice sidecar, a local Ollama server, or a
online service (the Perso API makes the whole dub when chosen, and by default in the
production edition).

What runs where, the six pipeline stages and the files each leaves in a job's
folder, the module map, the extension points, the contracts other programs
rely on and the quality gates are described in
**[Architecture](architecture.md)**.

Heavy Python libraries (torch, onnxruntime, faster-whisper, ...) are **never
installed** into the core Python 3.11 virtualenv (`.venv`). Each heavy stage
gets its own interpreter via environment variables (`SEP_PYTHON`,
`DIAR_PYTHON`, `STT_PYTHON`, `QWEN_SCORER_PYTHON`). A subprocess failure never
takes the core app down: a stage whose engine fails fails the job with a
sentence of its own, and no stage switches to a different engine. Only helpers
inside a stage carry on without their result, with a warning in the job log
(CAM++ keeps the existing speaker labels; High quality keeps the first take
when the takes cannot be scored).

## Dependent services

| Service | Role | Required? | How the app finds it |
|---|---|---|---|
| **Qwen3-TTS sidecar** | Voice cloning + speech synthesis (the TTS engine). Vendored at `desktop/vendor/sidecar/server.py`, run as a separate process | Required | Inside a kit: the `tts_url` the desktop shell writes to `<kit>/runtime.json`. Without a kit: `QWEN_TTS_URL` (default `http://127.0.0.1:3901`) |
| **Translation engine** (pick one) | Translates lines into the target language | Required (one of) | `TRANSLATE_ENGINE`, or the job's own choice. **ChatGPT** through the Codex CLI's sign-in (the default) / Local: **Ollama** with Hunyuan, Gemma or Qwen (`ollama_url` in `runtime.json` inside a kit, else `OLLAMA_URL`) / Cloud: **Google Gemini API** (`GEMINI_API_KEY`) or Vertex AI |
| **Perso API** | Whole-video dubbing (`DUB_MODE=perso`, the production edition's default), separation, speech recognition + speaker labels | Optional; needed for `DUB_MODE=perso` | `PERSO_API_KEY` / `PERSO_SPACE_SEQ` / `PERSO_MEDIA_HOST`. Without a key, speech recognition uses local **Whisper** |
| **Local separation** (Mel-Band RoFormer or Demucs) | Splits voices from background audio, in a subprocess: Mel-Band RoFormer when its model is downloaded into the kit, else Demucs | Required (Demucs is built in) | `SEP_PYTHON`, `SEP_MODEL_DIR` (Demucs); the RoFormer weights in `<kit>/models/melband-roformer` |
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

On Windows (PowerShell), skip step 1 and let uvicorn load `.env` itself
(`uvicorn[standard]` brings what it needs for that):

```powershell
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8860 --env-file .env
```

If `.venv` doesn't exist yet:
`python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt`
(on Windows: `py -3.11 -m venv .venv`, then
`.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt`).
`requirements-dev.txt` adds the pinned `ruff` that the lint check runs.

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
| `DUB_MODE` | `local` (`perso` when `PERSODUB_EDITION=production`) | `perso` = the Perso API makes the whole dub (needs `PERSO_API_KEY`), `local` = the six stages on this computer |
| `TRANSLATE_ENGINE` | `chatgpt` (`hunyuan` on a kit that already has the Hunyuan model) | `chatgpt` = ChatGPT through the Codex CLI, `hunyuan` / `gemma` / `qwen` = local Ollama, `gemini` = Google Gemini API, `vertex` = Vertex AI |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `gemma3:12b` | Local Ollama server and model |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | (none) / `gemini-flash-latest` | Google Gemini API key (secret) and model |
| `STT_ENGINE` | (none; `perso` when a Perso key exists) | `perso`, or empty for local Whisper |
| `PERSO_API_KEY` / `PERSO_SPACE_SEQ` / `PERSO_MEDIA_HOST` | (none; secrets) | Perso account settings (dubbing, separation, speech recognition) |
| `PERSO_RECHARGE_URL` | the Perso subscription page | Recharge page shown when credits run out |
| `SEP_PYTHON` / `SEP_MODEL_DIR` | `python3` / `models/demucs` | Interpreter for local separation (Mel-Band RoFormer or Demucs) / Demucs's model path |
| `DIAR_PYTHON` / `PERSODUB_CAMPPLUS_MODEL` | `python3` / `models/campplus/campplus.onnx` | Interpreter and model for local CAM++ |
| `QWEN_SCORER_PYTHON` / `QWEN_N_TAKES` | `python3` / `4` | Take-scoring interpreter · candidates per line (best-of-N) |
| `PERSODUB_LOG_DIR` | `logs` | Where `persodub.log` and the per-job `job-<id>.log` files are written: `logs` for a server run, while the desktop app sets it to its own logs folder, beside `shell.log` |
| `PERSODUB_DEBUG` | (unset) | `1` = DEBUG detail in `persodub.log` instead of INFO |

A number this table gives that the environment sets to something unreadable
(`QWEN_N_TAKES=abc`) does not raise at import any more: `app/config.py` falls
back to the default and records the reason in `CONFIG_ERRORS`, and startup
logs every entry at ERROR and carries on with those defaults. The app always
starts; check `persodub.log` for the line naming the setting.

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

PersoDub does not time-stretch the dub to fit a translation. Length is solved
in the **translation stage**: every translator that can follow a length rule is
asked to land each line within ±15% of its subtitle slot (the small local
Hunyuan model is asked for the line alone), and a watchdog in the assembly code
checks that no resampling changed a line's length. The one deliberate
exception, applied after that check, is small: a line that would run into the next one is played up to
10% faster (`QWEN_MAX_SPEEDUP`, pitch kept) before the rest of it is cut.

Length-fitting retry policy (each translator's `max_budget_retries`):
- Local (free) engines: up to 3 re-translations per line.
- ChatGPT: at most one re-ask round, since every re-ask is a message off the
  user's own allowance.
- Paid Google engines (Gemini, Vertex): exactly **one** call per batch — the
  prompt asks for 3 candidate translations per line and the best-fitting
  candidate is picked locally (best-of-3 quality with no extra calls).

## Tests

```bash
.venv/bin/python -m pytest tests/ -q       # Python (pipeline)
node --test ui/src/*.test.mjs              # browser UI modules
node ui/check-inline.mjs                   # the page's inline module blocks parse
(cd desktop && npm ci && npm test)         # Electron desktop shell
node --test relay/*.test.mjs               # the failure-report relay's rules
.venv/bin/ruff check app tests             # lint (pinned in requirements-dev.txt)
```

On Windows, use `.venv\Scripts\python` and `.venv\Scripts\ruff` in place of
`.venv/bin/python` and `.venv/bin/ruff`, and run `npm ci` and then `npm test`
inside `desktop\`; the other node commands are the same.

All tests are pure-logic tests — they run without any external service (TTS
sidecar, Ollama, Perso). What each suite protects, and the tests that pin the
contracts a refactor must not change, are listed in
[Architecture](architecture.md#6-quality-gates).

## Building an edition

The desktop app is built as one of two editions from the same code. The
open-source edition is PersoDub: it dubs on this computer when nothing is
chosen, reads its updates from the public repository's releases, and its
GitHub button, Send feedback, Help documents and release notes open there.
The production edition, the company build, is PersoDubbing: it dubs on
the Perso API when nothing is chosen, signs in to Perso in the browser and
takes the account's API key by itself, has no GitHub button or link, opens
`https://perso.ai/dubbing/desktop-app` for its guide and release notes, sends
Customer support's inquiries straight to the support web app it was built
with (never through the relay), and reads its updates only from its own
address, never from the public releases.

| | open source | production |
|---|---|---|
| `PERSODUB_EDITION` | unset (or `opensource`) | `production` |
| Name (window, dock, taskbar, installer, About, every `{app}` in a sentence) | `PersoDub` | `PersoDubbing` |
| App id | `com.persodub.desktop` | `ai.perso.desktopapp` |
| Installers | `PersoDub-Setup-<version>.exe`, `PersoDub-<version>-arm64.dmg` | `PersoDubbing-Setup-<version>.exe`, `PersoDubbing-<version>-arm64.dmg` |
| Kit folder | `~/Library/Application Support/PersoDub`, `%LOCALAPPDATA%\PersoDub` | `~/Library/Application Support/PersoDubbing`, `%LOCALAPPDATA%\PersoDubbing` |
| Electron's data folder (logs, sign-in) | `persodub-desktop-shell` | `perso-desktopapp-shell` |
| Updates | the repository's GitHub Releases | `PRODUCTION_UPDATE_URL` in `src/edition.js`, or none while it is empty |

Each edition has its own names and folders, so both can be installed on one
computer. The names and app ids are `PRODUCTS` in `src/edition.js`; the
production update address is the `PRODUCTION_UPDATE_URL` constant beside it
(an electron-updater generic feed: `latest.yml`, `latest-mac.yml` and the
files beside them). While it is empty the production app never checks for
updates, and `shell.log` says so once a launch.

The production build takes one value from the environment it is built in
(`BUILD_KEYS` in `src/edition.js`). Nothing in the repository names it:
`scripts/collect-payload.mjs` writes it, when set, into the payload's
`build.env`, and the packaged app reads it from there. The open-source
build ignores it.

| Variable | Used by | What it does | When it is not set |
|---|---|---|---|
| `PERSODUB_EDITION` | both | which edition the payload, and so the app, is (`--edition` on `collect-payload.mjs` wins over it) | the open-source edition |
| `PERSODUB_INQUIRY_URL` | production | the support web app's address (a Google Apps Script web app's `/exec` URL) that Customer support's inquiries are posted to as JSON; it mails each one to the support inbox and answers `{ok, id}` | Send says it could not send, and `shell.log` says `inquiry no destination` |
| `CAMPPLUS_SRC` | both | the path of your `campplus.onnx` | the build stops |

Set them when the payload is collected. `electron-builder.js` reads the
collected payload's edition, so `electron-builder` needs no variables of its
own. A Mac release needs the dmg, the zip and `latest-mac.yml` (auto-update
reads the last two), so collect the payload and build both targets in one
run, in `desktop/`. The build copies the dmg as `<name>-mac.dmg`, the name a
download button links to.

```bash
# open source
CAMPPLUS_SRC=/path/to/campplus.onnx node scripts/collect-payload.mjs
npx electron-builder --mac dmg zip --arm64 --publish never

# production (the same as npm run dist:dmg:prod)
CAMPPLUS_SRC=/path/to/campplus.onnx PERSODUB_INQUIRY_URL=<support web app address> \
  node scripts/collect-payload.mjs --edition production
npx electron-builder --mac dmg zip --arm64 --publish never
```

On Windows, `npm run dist:win` (or `npm run dist:win:prod`) with the same
variables builds the installer. `npm run dist:dmg` would build the dmg alone.
An unknown edition stops the build. Before a release, check what the packaged
app carries: `cat dist/mac-arm64/<name>.app/Contents/Resources/payload/EDITION`
must print the edition you meant, and for production `payload/build.env` must
hold the support web app's address. A development run (`npm start`, no
payload) reads them from its own environment. The Windows workflows set the
edition from their input, and the public release workflow refuses a
production build. `build-windows.yml` gives a production build
`PERSODUB_INQUIRY_URL` from the repository secret of that name, so the secret
must exist in the repository (Settings > Secrets and variables > Actions);
without it the installer is built with nowhere to send an inquiry.

## Project layout

| Folder | What it holds |
|---|---|
| `app/` | the backend: `main.py`, the HTTP routers in `api/`, the pipeline, the engines and adapters, and the worker programs in `scripts/` |
| `static/` | the page's markup (`index.html`), stylesheets (`css/`), fonts and logo |
| `ui/` | the page's ES modules in `src/` (served at `/js/`, each with a `node:test` file), the test helpers in `testlib/`, and `check-inline.mjs` |
| `desktop/` | the Electron shell: `main.js`, its modules in `src/`, `preload.cjs`, the install screens, and the vendored voice sidecar |
| `tests/` | the Python suite |
| `relay/` | the Cloudflare Worker that turns failure reports into GitHub issues |

The module-by-module map, layer by layer, is in
[Architecture](architecture.md#3-module-map).

## Working conventions

- **Experiments happen on branches**, not in copied folders. Copying the
  pipeline into dated snapshot folders was retired: it made `main` carry
  dead code, let scripts drift from `app/`, and blurred which copy was real.
- **Reproducible runs are frozen with git tags**, not folder copies.
- When an experiment ends, either fold the result into `app/` with tests, or
  leave a one-line note explaining why not. Skipping that step is how the app
  and experiment code diverge.
