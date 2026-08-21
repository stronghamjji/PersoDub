import os
import shutil
import uuid
from datetime import date
from typing import List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.config import OLLAMA_GEMMA_MODEL, OLLAMA_QWEN_MODEL, TRANSLATE_ENGINE, default_stt_engine
from app.engines.base import (
    SynthesisRequest,
    get_engine,
    list_engines,
    register_engine,
)
from app.engines.qwen_tts import QwenTTSEngine
from app.engines_status import (
    gemini_available,
    gemma_available,
    gemma_status,
    perso_available,
    qwen_available,
    qwen_status,
)
from app.jobs import JobStore
from app.perso_client import APP_VERSION, SIGNUP_LINK, list_dubbing_spaces
from app.pipeline import run_dub
from app.text.naming import next_free, safe_name
from app.settings_env import (read_analytics_off, read_key_status, read_value,
                              write_analytics_off, write_keys)
from app.source_fetch import FetchError, fetch as fetch_source, probe as probe_source
from app.translate import get_translator

app = FastAPI(title="PersoDub", version=APP_VERSION)
# GET /api/settings returns saved API key values (single-user desktop app, the
# user owns the file they live in). That makes DNS rebinding the one remote
# read path -- a hostile page whose domain re-resolves to 127.0.0.1 becomes
# same-origin with this server in the victim's browser -- and its requests
# arrive with the attacker's domain in Host, so a strict allowlist shuts it
# out. (Tests pass base_url="http://127.0.0.1" so no test-only host ships here.)
app.add_middleware(TrustedHostMiddleware,
                   allowed_hosts=["127.0.0.1", "localhost"])


# TrustedHost can't stop cross-origin WRITES: a hostile page POSTing to
# 127.0.0.1 sends Host: 127.0.0.1 (passes the allowlist) and, without CORS
# middleware, the browser withholds the response but the side effect still
# fires -- e.g. swapping in an attacker's Perso key via /api/settings.
# Browsers always attach Origin to cross-origin POSTs, so rejecting foreign
# Origins closes that; requests without Origin (our Electron UI same-origin
# GETs, curl, tests) are untouched.
@app.middleware("http")
async def reject_cross_origin_writes(request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return Response("Cross-origin requests are not allowed", status_code=403)
    return await call_next(request)

# Register the installed TTS engine (Qwen3-TTS)
register_engine(QwenTTSEngine())

# Translator (selects Ollama/Gemini based on the TRANSLATE_ENGINE setting)
translator = get_translator()

# Store for background dubbing jobs
job_store = JobStore()

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.path.join(APP_DIR, "workspace")
STATIC_DIR = os.path.join(APP_DIR, "static")

# Serves the UI's plumbing-layer JS module (ui/src/dubApi.mjs) so static/index.html
# can import it directly, e.g. <script type="module" src="/js/dubApi.mjs">. Mounted
# straight from ui/src (not copied into static/) so there is a single source of
# truth -- the same file the node:test unit tests in ui/src/dubApi.test.mjs cover.
app.mount("/js", StaticFiles(directory=os.path.join(APP_DIR, "ui", "src")), name="js")


@app.get("/", response_class=HTMLResponse)
def index():
    """Dubbing app screen."""
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/health")
def health():
    """Health check to confirm the app is alive."""
    return {"status": "ok"}


@app.get("/api/tts/engines")
def tts_engines():
    """List of installed TTS engines."""
    return {
        "engines": [
            {
                "id": e.id,
                "display_name": e.display_name,
                "supports_cloning": e.supports_cloning,
                "available": e.is_available(),
            }
            for e in list_engines()
        ]
    }


class SayRequest(BaseModel):
    text: str
    engine: str = "qwen3_tts"
    ref_audio: Optional[str] = None
    ref_text: Optional[str] = None
    language: Optional[str] = None
    duration: Optional[float] = None
    num_step: int = 32
    guidance_scale: float = 2.0
    speed: float = 1.0
    seed: Optional[int] = None


@app.post("/api/tts/say")
def tts_say(body: SayRequest):
    """One line of text → speech (wav). Choose which engine to use via body.engine."""
    engine = get_engine(body.engine)
    if engine is None:
        raise HTTPException(status_code=404, detail=f"Unknown engine: {body.engine}")

    req = SynthesisRequest(
        text=body.text,
        ref_audio=body.ref_audio,
        ref_text=body.ref_text,
        language=body.language,
        duration=body.duration,
        num_step=body.num_step,
        guidance_scale=body.guidance_scale,
        speed=body.speed,
        seed=body.seed,
    )
    result = engine.synthesize(req)
    headers = {"x-engine-id": result.engine_id}
    if result.duration is not None:
        headers["x-audio-duration"] = str(result.duration)
    if result.seed is not None:
        headers["x-seed"] = str(result.seed)
    return Response(content=result.audio_bytes, media_type="audio/wav", headers=headers)


class SettingsRequest(BaseModel):
    gemini_api_key: Optional[str] = None
    perso_api_key: Optional[str] = None
    perso_space_seq: Optional[str] = None
    analytics_off: Optional[bool] = None


@app.get("/api/settings")
def settings_get():
    """The saved keys and workspace from kit.env, values included.

    Values come back verbatim (user decision 2026-08-06): this is a
    single-user desktop app and the keys live in a file that user owns, so
    hiding them behind set/unset booleans only made a saved key look like an
    empty field. Localhost-only exposure comes from the 127.0.0.1 bind; the
    TrustedHost middleware above adds the DNS-rebinding defense on top --
    changing the bind to 0.0.0.0 WOULD expose these values."""
    status = read_key_status()
    if status is None:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    # perso_signup_link carries the UTM tag, which is built from the running platform --
    # the static page can't know it, so it comes from here.
    return {"gemini_key_set": status["GEMINI_API_KEY"], "perso_key_set": status["PERSO_API_KEY"],
            "gemini_api_key": read_value("GEMINI_API_KEY"),
            "perso_api_key": read_value("PERSO_API_KEY"),
            "perso_space_seq": read_value("PERSO_SPACE_SEQ"),
            "perso_signup_link": SIGNUP_LINK,
            "analytics_off": read_analytics_off(),
            "app_version": APP_VERSION}


@app.post("/api/settings")
def settings_post(body: SettingsRequest):
    """Write non-empty API keys (and the picked Perso workspace) into kit.env,
    backing it up first.

    The engines read kit.env once at startup, so a change only applies after
    the app restarts -- restart_required tells the UI to say so."""
    space = None if body.perso_space_seq is None else body.perso_space_seq.strip()
    # The picker only ever posts a seq it got from /api/perso/spaces; anything
    # else is hand-crafted and must not reach the engine env file. isascii +
    # isdigit (not isdigit alone): "²" passes isdigit but crashes int(), and
    # Arabic-Indic digits silently convert to a different workspace number.
    if space and not (space.isascii() and space.isdigit() and len(space) <= 10):
        raise HTTPException(422, "perso_space_seq must be a workspace number")
    try:
        # None = field not sent (leave alone); "" = clear the saved value.
        status = write_keys({
            "GEMINI_API_KEY": None if body.gemini_api_key is None else body.gemini_api_key.strip(),
            "PERSO_API_KEY": None if body.perso_api_key is None else body.perso_api_key.strip(),
            "PERSO_SPACE_SEQ": space,
        })
    except FileNotFoundError:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    except ValueError as e:
        raise HTTPException(422, str(e))
    # Unlike the keys, this one needs no restart: the desktop shell re-reads
    # kit.env before every count, so the next event already obeys the switch.
    if body.analytics_off is not None:
        write_analytics_off(body.analytics_off)
    return {"gemini_key_set": status["GEMINI_API_KEY"], "perso_key_set": status["PERSO_API_KEY"],
            "perso_space_seq": read_value("PERSO_SPACE_SEQ"),
            "restart_required": True}


@app.get("/api/perso/spaces")
def perso_spaces():
    """Workspaces the saved Perso key can dub in, for the Settings picker.

    The key comes from kit.env first (a key saved moments ago, before any
    restart) and the process env second (server deployments with no kit) --
    otherwise picking a workspace right after saving the key would take two
    restarts. The key itself is used server-side only and never returned.
    """
    key = read_value("PERSO_API_KEY") or os.environ.get("PERSO_API_KEY")
    if not key:
        raise HTTPException(409, "Save a Perso API key first")
    try:
        spaces = list_dubbing_spaces(key)
    except Exception as e:
        # Never interpolate str(e): an httpx error can echo request details.
        raise HTTPException(502, f"Could not list Perso workspaces ({type(e).__name__})")
    return {"spaces": spaces}


@app.get("/api/dub/jobs/{jid}")
def dub_job(jid: str):
    """Query the progress of a dubbing job."""
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    return j


@app.post("/api/dub/jobs/{jid}/cancel")
def dub_job_cancel(jid: str):
    """Cancel a running dubbing job.

    Cooperative cancellation: run_dub polls for this request at stage
    boundaries (see app/pipeline.py's cancel_check checkpoints) rather than
    being killed mid-stage, so the job's status goes running -> cancelling ->
    cancelled, not straight to cancelled. 404 for an unknown job id, 409 if
    the job already finished (done/error) or was already cancelled -- there
    is nothing left to interrupt.
    """
    status = job_store.request_cancel(jid)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if status in ("done", "error", "cancelled"):
        raise HTTPException(status_code=409, detail=f"Job already {status}, nothing to cancel")
    return {"job_id": jid, "status": status}


@app.get("/api/engines")
def engines_status():
    """Which translation/transcription engines actually work on this machine right now.

    No caching -- always live. Each check is exception-safe (a down Ollama server
    can never turn this into a 500); used by the UI to grey out unusable engines
    and by dub_start's preflight below.
    """
    return {
        "gemma_available": gemma_available(),
        "qwen_available": qwen_available(),
        "gemini_available": gemini_available(),
        "perso_available": perso_available(),
    }


def _ollama_unavailable_message(engine_name: str, status: str, model_tag: str) -> str:
    """422 detail for a gemma/qwen preflight failure -- distinguishes an
    unreachable Ollama server from one that's reachable but just hasn't
    pulled the model yet, so a busy-but-valid Ollama isn't misreported as
    "not running" (see engines_status.ollama_model_status)."""
    if status == "unreachable":
        return (
            f"Local {engine_name} translation is not available on this machine "
            "(Ollama is not running or not reachable). Choose Gemini in the "
            "Translation dropdown, or make sure Ollama is running."
        )
    return (
        f"Local {engine_name} translation is not available on this machine "
        f"(the model is not pulled). Choose Gemini in the Translation dropdown, "
        f"or run: ollama pull {model_tag}"
    )


@app.post("/api/dub/start")
def dub_start(
    video: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    srt: Optional[UploadFile] = File(None),
    source_srt: Optional[UploadFile] = File(None),
    language: str = Form("English"),
    language_code: str = Form("en"),
    num_speakers: Optional[int] = Form(None),
    translate_engine: Optional[str] = Form(None),
    stt_engine: Optional[str] = Form(None),
    n_takes: Optional[int] = Form(None),
    source_language_code: Optional[str] = Form(None),
    project: Optional[str] = Form(None),
):
    """Start dubbing by uploading a video (+ optional subtitles) from the screen.

    srt = translated subtitles (used as is) / source_srt = source subtitles (translate
    this instead of transcribing — with a script, transcription errors & omissions vanish).
    n_takes = how many candidate takes per line the best-of-N selection (Qwen3-TTS,
    the app's only TTS engine) scores before picking a winner; omitted uses the
    server's QWEN_N_TAKES default.
    stt_engine = "perso" for cloud STT+diarization (best quality); if omitted, the
    server default applies (see app.config.default_stt_engine) — "perso" when a
    PERSO_API_KEY is configured, else local Whisper. A Perso failure FAILS the
    job with an actionable message (no silent local substitute — the engine was
    chosen for a reason); pick Whisper explicitly for the free offline path.
    """
    # Exactly one source. Accepting both would silently pick a winner, and the
    # user would watch the wrong video get dubbed.
    source_url = (source_url or "").strip() or None
    has_upload = video is not None and bool(video.filename)
    if has_upload == bool(source_url):
        raise HTTPException(422, "Provide either a video file or a source_url, not both.")

    # Normalize like translate_engine below: without this, "Perso" (capital P)
    # skipped both the preflight and the Perso branch and silently ran the
    # free local engine -- the exact downgrade the no-fallback rule forbids.
    stt_engine = (stt_engine or "").strip().lower() or None
    if stt_engine not in (None, "local", "perso"):
        raise HTTPException(422, f"Unknown stt_engine: {stt_engine}")
    effective_translate_engine = (translate_engine or TRANSLATE_ENGINE or "").lower()
    if effective_translate_engine == "gemma":
        status = gemma_status()
        if status != "available":
            raise HTTPException(422, _ollama_unavailable_message("Gemma", status, OLLAMA_GEMMA_MODEL))
    if effective_translate_engine == "qwen":
        status = qwen_status()
        if status != "available":
            raise HTTPException(422, _ollama_unavailable_message("Qwen", status, OLLAMA_QWEN_MODEL))
    if effective_translate_engine == "gemini" and not gemini_available():
        raise HTTPException(
            422, "Gemini translation needs an API key. Open Settings and save your Gemini API key first."
        )
    if stt_engine == "perso" and not perso_available():
        raise HTTPException(
            422,
            "Perso transcription needs an API key. Open Settings and save your Perso "
            "API key, or choose Local transcription.",
        )
    if stt_engine == "perso" and not (read_value("PERSO_SPACE_SEQ") or os.environ.get("PERSO_SPACE_SEQ")):
        # No workspace pinned: a single-workspace account resolves silently in
        # the pipeline, but several would fail AFTER minutes of separation
        # work. Catch that here, before the upload is accepted.
        key = read_value("PERSO_API_KEY") or os.environ.get("PERSO_API_KEY")
        try:
            spaces = list_dubbing_spaces(key)
        except Exception:
            spaces = None  # can't tell right now -- let the pipeline decide
        if spaces is not None and len(spaces) != 1:
            raise HTTPException(
                422,
                "This Perso key has no dubbing workspace." if not spaces else
                "Select a Perso workspace in Settings.",
            )

    # Names the job's folder. The caller may pass a title it already knows (the
    # screen probes a link before starting, and app/source_fetch.py's fetch()
    # returns nothing, so the server never learns it otherwise). Without one,
    # fall back to the uploaded filename or the URL.
    project = safe_name(project or "")
    if not project:
        project = safe_name(
            os.path.splitext(video.filename or "")[0] if has_upload else (source_url or "")
        )
    work = _job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    if has_upload:
        with open(video_path, "wb") as f:
            shutil.copyfileobj(video.file, f)

    srt_path = None
    if srt is not None and srt.filename:
        srt_path = os.path.join(work, "sub.srt")
        with open(srt_path, "wb") as f:
            shutil.copyfileobj(srt.file, f)
    source_srt_path = None
    if source_srt is not None and source_srt.filename:
        source_srt_path = os.path.join(work, "source.srt")
        with open(source_srt_path, "wb") as f:
            shutil.copyfileobj(source_srt.file, f)
    out_path = os.path.join(work, "dubbed.mp4")

    jid = job_store.create()
    # The download filenames are built from this; the job record is the only
    # place the result endpoints can read the user's choice back from.
    # project/day/from_link are read back by the download endpoints and by the
    # desktop shell, which builds the save folder from them. `day` is stamped
    # here rather than recomputed later: a job started at 23:59 must not land in
    # tomorrow's folder when it finishes.
    job_store._update(jid, language_code=language_code,
                      project=project or os.path.basename(work),
                      day=_today(),
                      from_link=bool(source_url))
    # First log line names the source -- log files are job-<id>.log, so without
    # this there is no way to tell which video a log belongs to.
    job_store.append_log(jid, f"🎬 {source_url or video.filename or 'video'}")

    def _target(log):
        if source_url:
            fetch_source(
                source_url, video_path, log=log,
                cancel_check=lambda: job_store.is_cancel_requested(jid),
            )
        return run_dub(
            video_path=video_path,
            srt_path=srt_path,
            source_srt_path=source_srt_path,
            out_path=out_path,
            language=language,
            language_code=language_code,
            num_speakers=num_speakers,
            translate_engine=translate_engine,
            stt_engine=stt_engine or default_stt_engine() or None,
            n_takes=n_takes,
            source_language_code=source_language_code,
            cancel_check=lambda: job_store.is_cancel_requested(jid),
            on_notice=lambda n: job_store.append_notice(jid, n),
            log=log,
        )

    job_store.start(jid, _target)
    return {"job_id": jid, "status": "running"}


class ProbeRequest(BaseModel):
    url: str


@app.post("/api/source/probe")
def source_probe(body: ProbeRequest):
    """Read a link's title/duration/thumbnail without downloading it.

    Answers in seconds, which is what lets the UI show a confirm card before
    committing the user to an hours-long dub.
    """
    try:
        return probe_source(body.url)
    except FetchError as e:
        raise HTTPException(422, {"reason": e.reason, "message": e.message})


class TranslateRequest(BaseModel):
    texts: List[str]
    target_lang: str
    source_lang: Optional[str] = None
    durations: Optional[List[float]] = None


@app.post("/api/translate")
def translate_api(body: TranslateRequest):
    """Translate multiple dialogue lines into the target language (Gemini)."""
    try:
        out = translator.translate(
            body.texts, body.target_lang, body.source_lang, body.durations
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")
    return {"translations": out}


def _today():
    # type: () -> str
    """Today as YYYY-MM-DD. Split out so tests can pin the date."""
    return date.today().isoformat()


def _job_dir(title, lang_code):
    # type: (str, str) -> str
    """Create and return this job's workspace folder.

    Named <date>/<title>_<lang> so the folder says what it holds -- the old
    random hex said nothing. The language is part of the name because each
    language is a separate job with its own video, script and voice pieces;
    sharing one folder would overwrite them.

    Falls back to the old random name whenever a usable title cannot be built
    (unusable characters, empty title, or 999 runs of the same name today).
    """
    day = os.path.join(WORKSPACE, _today())
    os.makedirs(day, exist_ok=True)

    base = safe_name(title)
    name = next_free("%s_%s" % (base, lang_code), os.listdir(day)) if base else None
    if name is None:
        name = uuid.uuid4().hex[:8]

    work = os.path.join(day, name)
    os.makedirs(work, exist_ok=True)
    return work


def _target_code(job: dict) -> str:
    return job.get("language_code") or "out"


@app.get("/api/dub/result/{jid}")
def dub_result(jid: str):
    """Return the finished dubbed file."""
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out or not os.path.exists(out):
        raise HTTPException(status_code=404, detail="Result file not found")
    return FileResponse(out, media_type="video/mp4",
                        filename=f"dub_{_target_code(j)}.mp4")


@app.get("/api/dub/result/{jid}/original")
def dub_result_original(jid: str):
    """Return the source video a link job downloaded.

    Only offered for link jobs. A file the user uploaded is already on their
    machine, so handing it back is pure noise; a video pulled from a link is
    the only original they cannot otherwise get.
    """
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if not j.get("from_link"):
        raise HTTPException(status_code=404,
                            detail="This job started from a file you already have")
    out = (j.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=404, detail="Result file not found")
    original = os.path.join(os.path.dirname(out), "input.mp4")
    if not os.path.exists(original):
        raise HTTPException(status_code=404, detail="Original file not found")
    return FileResponse(original, media_type="video/mp4", filename="org.mp4")


@app.get("/api/dub/result/{jid}/srt")
def dub_result_srt(jid: str, download: int = 0):
    """Return the translated subtitles used for the dub, as plain text (for the UI's
    subtitle viewer). run_dub()'s result dict doesn't carry the srt path, but it
    always writes/copies it into the same job workspace folder as out_path, under
    one of two fixed names: "translated.srt" (auto-translated) or "sub.srt" (the
    caller's own pre-translated subtitles, see app/main.py:dub_start). Looked up by
    filename here rather than changing run_dub's return shape.
    """
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=404, detail="Result file not found")
    work_dir = os.path.dirname(out)
    for name in ("translated.srt", "sub.srt"):
        candidate = os.path.join(work_dir, name)
        if os.path.exists(candidate):
            with open(candidate, encoding="utf-8-sig") as f:
                text = f.read()
            headers = None
            if download:
                headers = {"Content-Disposition":
                           f'attachment; filename="dub_{_target_code(j)}.srt"'}
            return Response(content=text,
                            media_type="text/plain; charset=utf-8",
                            headers=headers)
    raise HTTPException(status_code=404, detail="Subtitle file not found")
