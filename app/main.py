import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import List, Optional, Union
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import config
from app import models as model_store
from app import perso_materialize
from app.agents import base as agent_base
from app.agents import claude as claude_agent
from app.agents import codex as codex_agent
from app.subtitle_ass import PRESETS as SUBTITLE_PRESETS, build_ass
from app.config import (OLLAMA_GEMMA_MODEL, OLLAMA_HUNYUAN_MODEL,
                        OLLAMA_QWEN_MODEL, PERSODUB_LOG_DIR,
                        QWEN_N_TAKES, default_stt_engine)
from app import setup as dub_setup
from app.dub_script import (
    DUB_NAME, EDITED_NAME, edit_line, line_wav_path, load_lines, script_path,
)
from app.text.srt import build_srt, parse_srt
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
    hunyuan_available,
    hunyuan_status,
    perso_available,
    qwen_available,
    qwen_status,
)
from app.jobs import JobCancelled, JobStore
from app.perso_client import (PersoClient, PersoCreditExhaustedError,
                              PersoInvalidKeyError, PersoUnavailableError,
                              APP_VERSION, SIGNUP_LINK, list_dubbing_spaces,
                              perso_to_cues)
from app.pipeline import _video_duration, run_dub
from app.qwen_pipeline import rebuild_dub, resynth_one_line
from app.text.naming import next_free, safe_name
from app.settings_env import (current_value, read_analytics_off,
                              read_key_status, read_value,
                              write_analytics_off, write_keys)
from app.source_fetch import FetchError, fetch as fetch_source, probe as probe_source
from app.stt_local import transcribe_local
from app.translate import get_translator


def _dub_target_for(job: dict):
    """Rebuild a queued job's work from nothing but its saved record.

    A job that starts straight away runs a closure built in dub_start, with
    the request still in hand. A job that waited out an app restart has only
    its job.json and its folder -- this reads the same choices back out of
    those (the way "Try again" does) so the queue can start it as if the app
    had never closed.
    """
    jid = job["id"]
    work = job["work_dir"]
    video_path = os.path.join(work, "input.mp4")
    out_path = os.path.join(work, "dubbed.mp4")
    language_code = job.get("language_code") or "en"
    language = job.get("language") or _language_name(language_code)
    srt_path = os.path.join(work, "sub.srt")
    srt_path = srt_path if os.path.exists(srt_path) else None
    source_srt_path = os.path.join(work, "source.srt")
    source_srt_path = source_srt_path if os.path.exists(source_srt_path) else None
    trim = job.get("trim")
    source_url = job.get("source_url")

    def _target(log):
        if source_url and not os.path.exists(video_path):
            fetch_source(source_url, video_path, log=log,
                         cancel_check=lambda: job_store.is_cancel_requested(jid))
        if (job.get("trim_pending") and trim
                and trim.get("start") is not None and trim.get("end") is not None):
            def _cut_recorded():
                job_store._update(jid, trim_pending=False)
                job_store.persist(jid, work)
            _cut_video(video_path, trim["start"], trim["end"], on_cut=_cut_recorded)
        if job.get("dub_mode") == "perso":
            return _run_cloud_dub(jid, video_path, out_path,
                                  job.get("source_lang"), language_code,
                                  job.get("num_speakers"), log)
        return run_dub(
            video_path=video_path,
            srt_path=srt_path,
            source_srt_path=source_srt_path,
            out_path=out_path,
            language=language,
            language_code=language_code,
            num_speakers=job.get("num_speakers"),
            # The record keeps what _engines_used wrote down; the same mapping
            # "Try again" uses turns it back into run_dub's arguments.
            stt_engine="perso" if job.get("stt_engine") == "perso" else None,
            sep_engine="perso" if job.get("separation") == "perso" else None,
            translate_engine=job.get("translator"),
            n_takes=job.get("quality"),
            source_language_code=job.get("source_lang"),
            cancel_check=lambda: job_store.is_cancel_requested(jid),
            on_notice=lambda n: job_store.append_notice(jid, n),
            log=log,
        )

    return _target


def _rearm_queued_jobs() -> None:
    """Put restored queued jobs back in line, oldest first.

    Their threads never existed, so a restart cost them nothing -- but the
    functions they were queued with died with the process. Best-effort per
    job: one whose folder has gone missing becomes an error, not a crash."""
    waiting = sorted((j for j in (job_store.get(j["id"]) for j in job_store.all())
                      if j and j.get("status") == "queued"),
                     key=lambda j: j.get("created") or "")
    for job in waiting:
        try:
            if not job.get("work_dir"):
                raise RuntimeError("no folder on record")
            job_store.start(job["id"], _dub_target_for(job),
                            parallel=(job.get("dub_mode") == "perso"))
        except Exception as e:
            job_store._update(job["id"], status="error", error=str(e))


@asynccontextmanager
async def lifespan(_app):
    """Jobs from before this launch.

    The job store is a dictionary, so quitting the app used to lose every
    record even though the folders were all still there. Reading the job.json
    files back is what lets Projects reopen yesterday's work.

    On startup rather than at import: WORKSPACE is read when the server
    actually starts, so a test that redirects it (tests/conftest.py) is not
    racing an import that already scanned the real one. Best-effort by design
    -- a workspace that isn't there yet simply restores nothing, and one bad
    file is skipped rather than taking the app down.
    """
    job_store.restore(WORKSPACE)
    _rearm_queued_jobs()
    yield


app = FastAPI(title="PersoDub", version=APP_VERSION, lifespan=lifespan)
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


def _work_dir_of(job: dict) -> str:
    """Where this job's folder is -- the one answer, in one place.

    work_dir is stamped the moment the folder is made, so it is there even for a
    job that failed before it produced anything. dirname(out_path) is the older
    way of asking the same question, kept as the fallback so a record written
    before work_dir existed (or hand-built in a test) still resolves.

    Not for the script and subtitle routes: those ask out_path directly, because
    they say 409 when there is no result at all. In the product the two answers
    are the same folder -- run_dub always writes the result inside work_dir --
    so what really pins those routes is two tests whose fake run writes the
    result somewhere else (tests/test_dub_api.py, fake_run_dub).
    """
    return job.get("work_dir") or os.path.dirname((job.get("result") or {}).get("out_path") or "")


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
    """The saved keys and Perso workspace from kit.env, values included, plus
    the folder this app keeps its jobs in.

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
            # The folder every finished video is saved in. Only the server knows
            # it -- the desktop shell can point the workspace anywhere -- so the
            # screen cannot tell the user where their videos are without this.
            "workspace": WORKSPACE,
            "app_version": APP_VERSION}


@app.post("/api/settings")
def settings_post(body: SettingsRequest):
    """Write non-empty API keys (and the picked Perso workspace) into kit.env,
    backing it up first.

    Nothing here needs a restart any more: every reader of these three values
    goes through settings_env.current_value, which reads kit.env at use time,
    so the next dub already uses what was just saved. restart_required stays in
    the response as a False for older clients that still look for it."""
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
            "restart_required": False}


def _open_folder(path: str) -> None:
    """Show a folder in the desktop's own file browser (Finder, Explorer, or
    whatever xdg-open answers to). Separate so the endpoint below can be tested
    without opening windows on the test machine."""
    if sys.platform == "darwin":
        subprocess.Popen(["open", path])
    elif sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]  # Windows only
    else:
        subprocess.Popen(["xdg-open", path])


@app.get("/api/setup")
def setup_get():
    """One picture of the dub setup for the screen and the Dub Agent: the
    choice in force for every stage, every optional model's download state,
    and which cloud keys are saved. Defaults come from kit.env at call time."""
    keys = read_key_status() or {}
    return {
        "defaults": dub_setup.defaults(),
        "choices": {stage: list(spec[1]) for stage, spec in dub_setup.STAGES.items()},
        "models": model_store.status_rows(),
        "keys": {"perso": bool(keys.get("PERSO_API_KEY")), "gemini": bool(keys.get("GEMINI_API_KEY"))},
    }


class SetupRequest(BaseModel):
    dub_mode: Optional[str] = None
    separation: Optional[str] = None
    stt: Optional[str] = None
    translator: Optional[str] = None
    voice_quality: Optional[str] = None


@app.post("/api/setup")
def setup_post(body: SetupRequest):
    """Save new per-stage defaults into kit.env. Fields left out stay as they
    are. In force for the next dub without a restart."""
    try:
        new = dub_setup.set_defaults(body.model_dump())
    except FileNotFoundError:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"defaults": new}


@app.post("/api/settings/reveal-output")
def settings_reveal_output():
    """Open the folder finished videos are saved in. Settings used to print the
    raw path in a read-only field; a button that opens the folder is what a
    desktop app does instead (2026-08-28), and only the server knows the folder
    (the desktop shell can point the workspace anywhere)."""
    try:
        _open_folder(WORKSPACE)
    except OSError as e:
        raise HTTPException(500, f"Could not open the folder: {e}")
    return {"ok": True}


@app.get("/api/perso/spaces")
def perso_spaces():
    """Workspaces the saved Perso key can dub in, for the Settings picker.

    The key comes from kit.env first (a key saved moments ago, before any
    restart) and the process env second (server deployments with no kit) --
    otherwise picking a workspace right after saving the key would take two
    restarts. The key itself is used server-side only and never returned.
    """
    key = current_value("PERSO_API_KEY")
    if not key:
        raise HTTPException(409, "Enter a Perso API key to see its workspaces")
    try:
        spaces = list_dubbing_spaces(key)
    except Exception as e:
        # Never interpolate str(e): an httpx error can echo request details.
        raise HTTPException(502, f"Could not list Perso workspaces ({type(e).__name__})")
    return {"spaces": spaces}


class PersoSpacesPreviewRequest(BaseModel):
    api_key: str


# Last preview (key, when, spaces), so the typing/blur/paste triggers on the
# screen can all fire without three calls to Perso for one key. Not a cache with
# a policy -- just the 5-second window that collapses one burst into one call.
_preview_last = {"key": "", "at": 0.0, "spaces": None}
_PREVIEW_WINDOW_SEC = 5.0


@app.post("/api/perso/spaces/preview")
def perso_spaces_preview(body: PersoSpacesPreviewRequest):
    """Workspaces for a key the user has TYPED but not saved yet.

    This is what removes the second restart: without it the picker could only
    list workspaces for an already-saved key, so a new key meant save, restart,
    pick, save, restart. The key arrives in the body, is used server-side only,
    and is never echoed back -- the response carries workspaces and nothing
    else, so a key can't leak into logs or the screen through this route.
    """
    key = (body.api_key or "").strip()
    if not key:
        raise HTTPException(400, "Enter a Perso API key to see its workspaces")
    now = time.monotonic()
    if _preview_last["spaces"] is not None and _preview_last["key"] == key \
            and now - _preview_last["at"] < _PREVIEW_WINDOW_SEC:
        return {"spaces": _preview_last["spaces"]}
    try:
        spaces = list_dubbing_spaces(key)
    except Exception as e:
        # Same rule as above: the type name only, never str(e) -- an httpx
        # error message can carry the request, and the request carries the key.
        raise HTTPException(502, f"Could not list Perso workspaces ({type(e).__name__})")
    _preview_last.update(key=key, at=now, spaces=spaces)
    return {"spaces": spaces}


@app.get("/api/dub/jobs")
def dub_jobs():
    """Every job this app knows about, newest first -- the Projects sidebar.

    No logs: a row needs a name, a language and a status dot, and the logs of a
    few dozen jobs would be megabytes of JSON for a list nobody reads them in.
    """
    return {"jobs": job_store.all()}


@app.get("/api/dub/jobs/{jid}")
def dub_job(jid: str):
    """Query the progress of a dubbing job."""
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    return j


@app.get("/api/dub/jobs/{jid}/script")
def dub_job_script(jid: str):
    """This job's script, line by line, with the source line beside each one.

    The same reading app/mcp_server.py's get_script hands the assistant. Until
    now only the assistant could see it: the page had no route to ask for the
    original-language lines, so the export screen could only list the finished
    subtitles with nothing to compare them against.
    """
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") == "perso" and not _perso_is_materialized(job):
        # A Perso dub's script lives on Perso's side; read it back live.
        seq = job.get("perso_project_seq")
        if not seq:
            raise HTTPException(status_code=404, detail="No script was recorded for this job.")
        try:
            script = PersoClient().get_project_script(int(seq))
        except Exception:
            raise HTTPException(status_code=503,
                                detail="Could not reach Perso for this job's script. Try again in a moment.")
        lines = []
        for n, sent in enumerate(script.get("sentences") or [], start=1):
            start = (sent.get("offsetMs") or 0) / 1000.0
            dur = (sent.get("durationMs") or 0) / 1000.0
            lines.append({
                "line": n,
                "start": round(start, 2),
                "end": round(start + dur, 2),
                "slot": round(dur, 2),
                "source": sent.get("originalText"),
                "text": sent.get("translatedText") or "",
                # The voice already exists and fills its slot exactly -- there
                # is nothing to estimate and nothing stale.
                "estimated": round(dur, 2),
                "fits": True,
                "speaker": sent.get("speakerOrderIndex"),
                "audio_sec": None,
                "voice_stale": False,
                "edited": False,
                "was": None,
            })
        # Read-only until editing Perso lines lands (the next stage).
        return {"lines": lines, "edited": False, "readonly": True}
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409,
                            detail="This job has no finished script yet.")
    work_dir = os.path.dirname(out)
    try:
        lines = load_lines(work_dir, job.get("language_code") or "en")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No script was recorded for this job.")
    # Mark which lines differ from what the translation produced, so the page can
    # badge them and offer to put them back.
    for line, original in zip(lines, _dubbed_texts(work_dir)):
        line["was"] = original
        line["edited"] = original is not None and original != line["text"]
    return {"lines": lines,
            "edited": any(l.get("edited") for l in lines)}


def _dubbed_texts(work_dir: str) -> List[Optional[str]]:
    """What the translation wrote, line by line, before anything was rewritten.

    edit_line only ever changes a line's words, never the count or the timings,
    so line N here is line N there.
    """
    path = os.path.join(work_dir, DUB_NAME)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return [c["text"] for c in parse_srt(f.read())]


# A dub keeps its per-line voices now (app/pipeline.py), which is what makes
# redoing a single line possible -- and what makes a job need room. Measured on
# a real job 2026-08-21: the intermediates were about 61% of the folder.
FREE_SPACE_FLOOR = 3 * 1024 ** 3  # 3 GB


def free_bytes(path: str) -> int:
    """Free space on the disk holding path (its nearest existing parent)."""
    while path and not os.path.exists(path):
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return shutil.disk_usage(path or "/").free


def check_space(path: str) -> None:
    """Refuse to start when there is not enough room, and say what to do.

    Failing here beats failing three stages in: a dub that runs out of disk
    halfway leaves a half-written folder and no dub.
    """
    free = free_bytes(path)
    if free >= FREE_SPACE_FLOOR:
        return
    raise HTTPException(
        status_code=507,
        detail=("Not enough disk space (%.1f GB left). "
                "Delete an old job from the Projects list to free space."
                % (free / 1024 ** 3)),
    )


class ScriptLineRequest(BaseModel):
    text: str


def _script_work_dir(jid: str) -> tuple:
    """The job and its folder, or the right HTTP error."""
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail="This job has no finished script yet.")
    return job, os.path.dirname(out)


@app.post("/api/dub/jobs/{jid}/script/{line}")
def dub_job_script_edit(jid: str, line: int, body: ScriptLineRequest):
    """Rewrite one line. Same path the assistant takes -- edited.srt only."""
    job, work_dir = _script_work_dir(jid)
    try:
        return edit_line(work_dir, line, body.text, job.get("language_code") or "en")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No script was recorded for this job.")


@app.get("/api/dub/jobs/{jid}/script/{line}/audio")
def dub_job_line_audio(jid: str, line: int):
    """The voice that was made for one line, on its own."""
    _job, work_dir = _script_work_dir(jid)
    path = line_wav_path(work_dir, line)
    if not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail=("This job has no per-line audio. Per-line audio has only "
                    "been kept since 2026-08-24, so a job made before that "
                    "has to be dubbed again before you can listen to it."))
    return FileResponse(path, media_type="audio/wav")


def _line_manifest(work_dir: str) -> dict:
    """What the synthesizer recorded about each line, or the right HTTP error."""
    manifest = os.path.join(work_dir, "lines.json")
    if not os.path.exists(manifest):
        raise HTTPException(status_code=409, detail=(
            "This job cannot be remade one line at a time. It was made before "
            "2026-08-24, so it has no line information -- remake the whole job."))
    with open(manifest, encoding="utf-8") as f:
        return json.load(f)


def _remake_one_voice(work_dir: str, data: dict, line: int, text: str) -> None:
    """Speak one line again, over its own old wav. The video is NOT rebuilt here.

    Rebuilding is the caller's call: one line at a time rebuilds after each one,
    a sweep of several rebuilds once at the end.
    """
    entries = data.get("lines") or []
    if not 1 <= line <= len(entries):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")
    try:
        new_path = resynth_one_line(work_dir, entries[line - 1], text,
                                    data.get("language") or "English")
    except FileNotFoundError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if new_path is None:
        raise HTTPException(status_code=502, detail="Could not make the voice.")


@app.post("/api/dub/jobs/{jid}/script/{line}/voice")
def dub_job_line_voice(jid: str, line: int):
    """Speak ONE line again and rebuild the dub around it.

    Everything else is reused: the other lines' audio, the background bed and
    the speaker's cloned voice all stay on disk after a job (app/pipeline.py).
    Rewriting two lines of ten should not cost a whole synthesis pass.
    """
    job, work_dir = _script_work_dir(jid)
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    if not 1 <= line <= len(lines):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")

    _remake_one_voice(work_dir, data, line, lines[line - 1]["text"])
    rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"),
                (job.get("result") or {}).get("out_path"))
    return {"line": line, "ok": True}


@app.post("/api/dub/jobs/{jid}/voices/stale")
def dub_job_stale_voices(jid: str):
    """Remake only the lines whose words changed since their voice was made.

    Exactly the work the screen's filled wave buttons offer, in one press: each
    such line is spoken again in place and the video is put back together once
    at the end, instead of once per line. Nothing else moves -- no new job, no
    new folder, no status change, and a line nobody rewrote keeps its voice.

    Which lines those are is decided the same way the screen decides it
    (static/index.html: `l.edited && l.voice_stale`), so one press does the set
    of lines the buttons were offering and not a line more.
    """
    job, work_dir = _script_work_dir(jid)
    if job.get("status") in ("running", "cancelling"):
        raise HTTPException(status_code=409, detail="This job is still running.")
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    stale = [
        line for line, original in zip(lines, _dubbed_texts(work_dir))
        if original is not None and original != line["text"] and line["voice_stale"]
    ]
    if not stale:
        return {"remade": [], "skipped": len(lines)}

    for line in stale:
        _remake_one_voice(work_dir, data, line["line"], line["text"])
    # Once, at the end: the rebuild is the slow half, and laying down five new
    # lines five times over would spend it five times for the same video.
    rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"),
                (job.get("result") or {}).get("out_path"))
    return {"remade": [line["line"] for line in stale],
            "skipped": len(lines) - len(stale)}


@app.post("/api/dub/jobs/{jid}/script/{line}/revert")
def dub_job_script_revert(jid: str, line: int):
    """Put one line back to what the translation wrote."""
    job, work_dir = _script_work_dir(jid)
    texts = _dubbed_texts(work_dir)
    if not 1 <= line <= len(texts):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")
    return edit_line(work_dir, line, texts[line - 1], job.get("language_code") or "en")


@app.post("/api/dub/jobs/{jid}/redub")
def dub_job_redub(jid: str):
    """Make the voices again from this job's script, as it now stands.

    Transcription and translation are skipped: the script is handed in whole, the
    way a user-supplied subtitle file is (run_dub's srt_path). The old job is left
    untouched in its own folder so a rewrite that turns out worse can be compared
    against what came before.
    """
    job, work_dir = _script_work_dir(jid)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(status_code=409, detail="This job's video is no longer on disk.")

    language_code = job.get("language_code") or "en"
    project = job.get("project") or os.path.basename(work_dir)
    check_space(WORKSPACE)
    work = _job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    shutil.copyfile(source_video, video_path)
    srt_path = os.path.join(work, "sub.srt")
    shutil.copyfile(script_path(work_dir), srt_path)
    out_path = os.path.join(work, "dubbed.mp4")

    # The same engines the first run was given, not today's defaults: a Perso
    # job that failed used to come back transcribed by local Whisper (or the
    # other way round), with nothing on screen to say the choice had changed.
    # A job saved before these were kept has none of them, so that one still
    # falls back to what the app is set to now.
    engines = {k: job.get(k) for k in ("stt_engine", "translator", "tts", "quality")}
    if not engines.get("stt_engine"):
        engines = _engines_used()

    # Only the voices are made again -- no STT, no translation -- but a voice
    # model removed in the catalog must resurface as the dialog, not a crash.
    missing = _missing_models(False, None)
    if missing:
        _raise_models_needed(missing)

    new_jid = job_store.create()
    job_store._update(new_jid, language_code=language_code, project=project,
                      day=_today(), from_link=False, work_dir=work,
                      # The remake is the same video in the same two languages.
                      source_lang=job.get("source_lang"),
                      # ...and made with the same engines, so its finished
                      # screen says what the job it came from said.
                      **engines)
    # Same reason as in dub_start: quit the app mid-remake and this folder is
    # nameless without a file in it, so Projects could never show or clear it.
    job_store.persist(new_jid, work)
    edited = os.path.exists(os.path.join(work_dir, EDITED_NAME))
    job_store.append_log(new_jid, "%s (%s)"
                         % (project, "voices remade from the edited script" if edited
                            else "from the script as it was"))

    def _target(log):
        return run_dub(
            video_path=video_path,
            srt_path=srt_path,
            out_path=out_path,
            language=job.get("language") or language_code,
            language_code=language_code,
            # Only the voices are made again here, so the take count is the one
            # engine choice that still applies -- the same one the first run had.
            n_takes=engines["quality"],
            cancel_check=lambda: job_store.is_cancel_requested(new_jid),
            on_notice=lambda n: job_store.append_notice(new_jid, n),
            log=log,
        )

    job_store.start(new_jid, _target)
    # Stamped on the OLD job so the screen showing it can follow along when the
    # assistant, not the user, is the one who pressed go.
    job_store._update(jid, remade_as=new_jid)
    return {"job_id": new_jid}


@app.post("/api/dub/jobs/{jid}/retry")
def dub_job_retry(jid: str):
    """Run this job again from the top -- transcribe, translate, voices, all of it.

    "Try again" on a failed job used to mean downloading the original and
    uploading it back, which for a link job meant fetching the whole video a
    second time. The copy in the job's folder is right there, so the new job
    starts from it with the settings the old one was given.

    Not a redub: that one hands the finished script back in and only makes the
    voices again (above). A job that failed may never have had a script at all.
    """
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("status") in ("running", "cancelling"):
        raise HTTPException(status_code=409, detail="This job is still running.")
    # work_dir, not the result folder: a job that failed before it produced
    # anything is exactly the one this endpoint exists for.
    work_dir = _work_dir_of(job)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(status_code=409, detail="This job's video is no longer on disk.")

    language_code = job.get("language_code") or "en"
    # run_dub wants the language's name. A job saved before that name was kept
    # in job.json has only its code, so work the name back out of it -- handing
    # run_dub "ko" would put "ko" in the translation prompt and in what the
    # voice sidecar is told to speak.
    language = job.get("language") or _language_name(language_code)
    project = job.get("project") or os.path.basename(work_dir)
    check_space(WORKSPACE)
    work = _job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    shutil.copyfile(source_video, video_path)
    out_path = os.path.join(work, "dubbed.mp4")

    # A trim that was already made lives in input.mp4, so cutting the copy again
    # would take the same seconds out of a video that no longer has them -- which
    # is why this only cuts when the record says the cut is still owed. A link job
    # that died at (or before) its cut still holds the whole video, and without
    # this its second run would dub every minute the user cut away.
    trim = job.get("trim")
    cut_now = bool(job.get("trim_pending") and trim
                   and trim.get("start") is not None and trim.get("end") is not None)
    if cut_now:
        try:
            _cut_video(video_path, trim["start"], trim["end"])
        except RuntimeError as e:
            # No job record points at this folder yet, so nothing would ever
            # come back to clear it. _job_dir always makes a fresh one.
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))

    # The same engines the first run was given, not today's defaults: a Perso
    # job that failed used to come back transcribed by local Whisper (or the
    # other way round), with nothing on screen to say the choice had changed.
    # A job saved before these were kept has none of them, so that one still
    # falls back to what the app is set to now.
    engines = {k: job.get(k) for k in ("stt_engine", "translator", "tts", "quality", "separation")}
    if not engines.get("stt_engine"):
        engines = _engines_used()

    translate_missing_id = None
    if engines.get("translator") in ("gemma", "hunyuan"):
        status = gemma_status() if engines["translator"] == "gemma" else hunyuan_status()
        if status == "model_missing":
            translate_missing_id = engines["translator"]
    missing = _missing_models(engines.get("stt_engine") != "perso", translate_missing_id)
    if missing:
        _raise_models_needed(missing)

    new_jid = job_store.create()
    job_store._update(new_jid, language_code=language_code, project=project,
                      day=_today(), work_dir=work,
                      language=language,
                      # Cut just now, or copied from a video already cut: either
                      # way this job owes no cut.
                      trim=trim, trim_pending=False,
                      source_lang=job.get("source_lang"),
                      # The video is a local copy now, whatever the first job was
                      # started from -- there is no link to download again.
                      from_link=False,
                      **engines)
    # Same reason as in dub_start: quit the app mid-run and this folder is
    # nameless without a file in it, so Projects could never show or clear it.
    job_store.persist(new_jid, work)
    job_store.append_log(new_jid, "%s (run again)" % project)

    def _target(log):
        if job.get("dub_mode") == "perso":
            return _run_cloud_dub(new_jid, video_path, out_path,
                                  job.get("source_lang"), language_code,
                                  None, log)
        return run_dub(
            video_path=video_path,
            out_path=out_path,
            language=language,
            language_code=language_code,
            # The first run's own choices (see `engines` above). Left out,
            # run_dub falls back to local Whisper and the app's default
            # translator, so a Perso job came back transcribed by something
            # else with nothing on screen to say so.
            stt_engine="perso" if engines["stt_engine"] == "perso" else None,
            # Replay the first run's separation choice too. .get: jobs saved
            # before separation was selectable carry none and fall back local.
            sep_engine="perso" if engines.get("separation") == "perso" else None,
            translate_engine=engines["translator"],
            n_takes=engines["quality"],
            source_language_code=job.get("source_lang"),
            cancel_check=lambda: job_store.is_cancel_requested(new_jid),
            on_notice=lambda n: job_store.append_notice(new_jid, n),
            log=log,
        )

    job_store.start(new_jid, _target, parallel=(job.get("dub_mode") == "perso"))
    return {"job_id": new_jid, "status": job_store.get(new_jid)["status"]}


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
    was_queued = (job_store.get(jid) or {}).get("status") == "queued"
    status = job_store.request_cancel(jid)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    # A queued job comes back "cancelled" from the call that cancelled it --
    # that is this request doing its work, not a job with nothing left to stop.
    if status in ("done", "error", "cancelled") and not was_queued:
        raise HTTPException(status_code=409, detail=f"Job already {status}, nothing to cancel")
    return {"job_id": jid, "status": status}


@app.delete("/api/dub/jobs/{jid}/workspace")
def dub_job_delete_workspace(jid: str):
    """Delete a job's whole folder. Irreversible, so the screen asks first.

    Automatic cleanup (app/pipeline.py's cleanup_intermediates) only drops the
    audio a finished job no longer needs; deleting the results themselves is
    always the user's own call.
    """
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    # "cancelling" counts as running: the thread only stops at the next stage
    # boundary, and until it does it is still writing into this folder.
    if j["status"] in ("running", "cancelling"):
        raise HTTPException(status_code=409, detail="Job is still running")
    # work_dir is stamped the moment the folder is made, so a job that failed
    # before it produced anything can be cleared out too -- Projects lists
    # those now, and a row nothing can remove is a row that never goes away.
    out = _work_dir_of(j)
    if not out:
        raise HTTPException(status_code=404, detail="Nothing to delete")
    work = os.path.abspath(out)
    root = os.path.abspath(WORKSPACE)
    # A job record is the only thing naming this path; refuse anything that
    # somehow points outside the workspace rather than trusting it.
    if os.path.commonpath([work, root]) != root or work == root:
        raise HTTPException(status_code=400, detail="Refusing to delete outside the workspace")
    shutil.rmtree(work, ignore_errors=True)
    # The folder is gone, so its job.json is gone -- but the in-memory record
    # would still put the job in the list until the next restart.
    job_store.forget(jid)
    return {"job_id": jid, "deleted": True}


@app.get("/api/whats-new")
def whats_new():
    """The bundled release notes + the running version. The screen shows them
    once after an update (never on a fresh install) and again on demand from
    Settings; the file ships with each release."""
    path = os.path.join(os.path.dirname(__file__), "whats_new.json")
    notes = []
    try:
        with open(path, encoding="utf-8") as f:
            notes = [str(n) for n in (json.load(f).get("notes") or [])]
    except Exception:
        pass  # no notes is fine; the popup simply never shows
    return {"version": APP_VERSION, "notes": notes}


@app.get("/api/models")
def models_list():
    """The model catalog with each model's download state -- what the
    Settings catalog, the advanced-options status lines and the dub-start
    warning dialog all render from. Always-installed models stay out: the
    install itself guarantees them and there is nothing to manage."""
    return {"models": model_store.status_rows()}


def _model_or_404(mid: str):
    entry = model_store.find(mid)
    if entry is None or entry["role"] == "always":
        raise HTTPException(404, f"Unknown model: {mid}")
    return entry


@app.post("/api/models/{mid}/download")
def model_download(mid: str):
    entry = _model_or_404(mid)
    free = model_store.free_bytes_at(model_store.kit_dir())
    if free is not None and free < entry["bytes"] * 1.1:
        raise HTTPException(409, "Not enough space: needs %.1f GB, %.1f GB free"
                                 % (entry["bytes"] / 1024**3, free / 1024**3))
    started = model_store.request_download(entry)
    # 202 for a fresh start, 200 when it was already running -- a double-click
    # must never error or start a second download.
    return JSONResponse({"state": "downloading"}, status_code=202 if started == "started" else 200)


@app.post("/api/models/{mid}/cancel")
def model_cancel(mid: str):
    _model_or_404(mid)
    model_store.cancel_download(mid)
    # The pieces stay on disk -- the next GET shows "paused" with Resume.
    return {"state": "cancelling"}


@app.delete("/api/models/{mid}")
def model_remove(mid: str):
    entry = _model_or_404(mid)
    if model_store.dub_in_progress():
        raise HTTPException(409, "A dub is running right now. Wait for it to finish, then remove the model.")
    model_store.cancel_download(mid)
    model_store.remove_model(entry)
    return {"removed": mid}


class PersoSpeakerRequest(BaseModel):
    line: int


def _perso_is_materialized(job) -> bool:
    """True once a Perso dub's parts were fetched for local editing -- from
    then on its script (and every edit tool) runs on the local files."""
    out = (job.get("result") or {}).get("out_path")
    return bool(out and os.path.exists(os.path.join(os.path.dirname(out), DUB_NAME)))


@app.post("/api/dub/jobs/{jid}/perso/materialize")
def dub_job_perso_materialize(jid: str):
    """Fetch a Perso dub's parts (script, per-line audio, background bed) and
    write the local job files -- after this the dub edits like any other job.
    Downloads only; no Perso credits are spent."""
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail="Only Perso dubs can be fetched for editing.")
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail="This job has no finished video yet.")
    try:
        summary = perso_materialize.materialize(
            PersoClient(), int(job["perso_project_seq"]), os.path.dirname(out),
            job.get("language") or "English",
            log=lambda msg: job_store.append_log(jid, msg))
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=f"Could not fetch this dub from Perso ({str(e)[:80]}).")
    return summary


@app.post("/api/dub/jobs/{jid}/perso/speaker")
def dub_job_perso_speaker(jid: str, body: PersoSpeakerRequest):
    """Give one line of a Perso dub a NEW speaker, on Perso's side.

    The agent's change_speaker tool lands here. Line numbers are the same
    1-based order the script endpoint serves. The write is verified the way
    the official plugin does it: re-read the script and report what it says.
    """
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail="Only Perso dubs have server-side speakers.")
    seq = int(job["perso_project_seq"])
    pc = PersoClient()
    try:
        sents = (pc.get_project_script(seq).get("sentences") or [])
        if not 1 <= body.line <= len(sents):
            raise HTTPException(status_code=422, detail=f"There is no line {body.line}.")
        sent = sents[body.line - 1]
        old = sent.get("speakerOrderIndex")
        pc.add_speaker_from_sentence(seq, int(sent["seq"]))
        after = pc.get_project_script(seq).get("sentences") or []
        new = after[body.line - 1].get("speakerOrderIndex") if len(after) >= body.line else None
    except HTTPException:
        raise
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Perso did not accept the change ({str(e)[:80]}).")
    return {"line": body.line, "old_speaker": old, "new_speaker": new}


# ---------------------------------------------------------------------------
# Subtitles out of a plain video file, through Perso STT. These two routes are
# the agent's extract_subtitles tool: /estimate names the price (nothing is
# spent), /extract does the paid work. The .srt lands next to the video and an
# existing file is never written over.
# ---------------------------------------------------------------------------

class SubtitleExtractRequest(BaseModel):
    video_path: str
    # "perso" (paid, better quality) or "local" (free Whisper on this machine).
    engine: str = "perso"


def _subtitle_video(video_path: str, engine: str) -> str:
    """The checks both routes share, ending in the file's real path."""
    if engine not in ("perso", "local"):
        raise HTTPException(status_code=422, detail=f"Unknown engine: {engine}")
    if engine == "perso" and not perso_available():
        raise HTTPException(status_code=422,
                            detail="Perso is not set up. Add the API key in Settings first.")
    path = os.path.expanduser(video_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No such video: {video_path}")
    return path


def _free_path(base: str, ext: str) -> str:
    """base+ext, or base-1+ext.. when that name is taken. Never writes over."""
    cand = base + ext
    n = 0
    while os.path.exists(cand):
        n += 1
        cand = "%s-%d%s" % (base, n, ext)
    return cand


@app.get("/api/subtitles/estimate")
def subtitles_estimate(video_path: str, engine: str = "perso"):
    """What extracting this video's subtitles would cost, before spending it.

    Perso: about 1 credit per 5 seconds of video -- measured 2026-08-31,
    2 credits for a 10s clip. Local Whisper is free, so its estimate is 0.
    The balance is best-effort: a workspace that will not answer must not
    block the question.
    """
    path = _subtitle_video(video_path, engine)
    try:
        seconds = _video_duration(path)
    except Exception:
        raise HTTPException(status_code=422,
                            detail="That file does not look like a video.")
    if engine == "local":
        return {"seconds": seconds, "credits_estimate": 0, "credits_balance": None}
    balance = None
    try:
        ws = PersoClient().describe_workspace()
        balance = ws.get("credits") if ws else None
    except Exception:
        pass
    return {"seconds": seconds,
            "credits_estimate": math.ceil(seconds / 5.0),
            "credits_balance": balance}


@app.post("/api/subtitles/extract")
def subtitles_extract(body: SubtitleExtractRequest):
    """Transcribe one video on Perso and write the result beside it as .srt.

    THIS SPENDS PERSO CREDITS. The confirmation lives in the agent tool (the
    same needs_confirmation pattern as change_speaker); by the time this route
    is called the user has already said yes.
    """
    path = _subtitle_video(body.video_path, body.engine)
    try:
        if body.engine == "local":
            cues = transcribe_local(path)
            if not cues:
                raise RuntimeError("Whisper heard no speech in this video.")
        else:
            cues = perso_to_cues(PersoClient().transcribe(path))
            if not cues:
                raise RuntimeError("Perso heard no speech in this video.")
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=f"Could not transcribe this video ({str(e)[:120]}).")
    out = _free_path(os.path.splitext(path)[0], ".srt")
    with open(out, "w", encoding="utf-8") as f:
        f.write(build_srt(cues))
    return {"srt_path": out, "lines": len(cues)}


# ---------------------------------------------------------------------------
# Cutting a stretch of a video into its own file -- the agent's cut_clip tool.
# All local ffmpeg work: free, no Perso, no confirm gate. The clip lands next
# to the original, which is never touched.
# ---------------------------------------------------------------------------

class ClipCutRequest(BaseModel):
    video_path: str
    start: Union[float, str]
    end: Union[float, str]


def _parse_timecode(value) -> float:
    """Seconds ("85", 85, 85.5) or colon timecodes ("1:25", "0:01:25")."""
    if isinstance(value, bool):
        raise ValueError("not a time: %r" % (value,))
    if isinstance(value, (int, float)):
        return float(value)
    parts = str(value).strip().split(":")
    if not 1 <= len(parts) <= 3:
        raise ValueError("not a time: %r" % (value,))
    total = 0.0
    for p in parts:
        total = total * 60.0 + float(p)
    return total


def _clip_stamp(sec: float) -> str:
    """A time for a file name: 10 -> "10s", 65 -> "1m5s", 3700 -> "1h1m40s"."""
    sec = int(round(sec))
    m, s = divmod(sec, 60)
    h, m = divmod(m, 60)
    if h:
        return "%dh%dm%ds" % (h, m, s)
    if m:
        return "%dm%ds" % (m, s)
    return "%ds" % s


@app.post("/api/clips/cut")
def clips_cut(body: ClipCutRequest):
    """Cut [start, end) of a video into a new file beside it.

    Re-encoded rather than stream-copied, the way the official Perso plugin
    cuts: -c copy can only cut on keyframes, so the first second of a copied
    clip is often frozen or missing.
    """
    path = os.path.expanduser(body.video_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No such video: {body.video_path}")
    try:
        start = _parse_timecode(body.start)
        end = _parse_timecode(body.end)
    except ValueError:
        raise HTTPException(status_code=422,
                            detail='Times must be seconds ("85") or timecodes ("1:25").')
    if start < 0 or end <= start:
        raise HTTPException(status_code=422, detail="The clip must start before it ends.")
    try:
        duration = _video_duration(path)
    except Exception:
        raise HTTPException(status_code=422,
                            detail="That file does not look like a video.")
    if start >= duration:
        raise HTTPException(status_code=422,
                            detail=f"This video is only {duration:.0f}s long.")
    end = min(end, duration)
    base, ext = os.path.splitext(path)
    out = _free_path("%s-clip-%s-%s" % (base, _clip_stamp(start), _clip_stamp(end)),
                     ext or ".mp4")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-ss", "%.3f" % start, "-t", "%.3f" % (end - start), "-i", path,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
           "-movflags", "+faststart", out]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0:
        raise HTTPException(status_code=503,
                            detail="ffmpeg could not cut this video (%s)."
                                   % (run.stderr or "no detail")[-120:].strip())
    return {"clip_path": out, "seconds": round(end - start, 3)}


class SubtitleBurnRequest(BaseModel):
    video_path: str
    srt_path: str = ""
    preset: str = "clean"
    pos: Optional[float] = None
    size: Optional[float] = None


# The font must hold Korean: each platform's own gothic, with Noto for the
# Linux server case. The presets themselves are the official plugin's ten,
# ported in app/subtitle_ass.py.
_BURN_FONT = ("Apple SD Gothic Neo" if sys.platform == "darwin"
              else "Malgun Gothic" if sys.platform == "win32"
              else "Noto Sans CJK KR")
# The first three styles shipped under our own names for a day (2026-09-01);
# anything stored or asked for under those keeps working.
_PRESET_ALIASES = {"variety": "neon-yellow", "box": "sticker"}


def _norm_preset(preset: str) -> str:
    preset = _PRESET_ALIASES.get(preset, preset)
    if preset not in SUBTITLE_PRESETS:
        raise HTTPException(status_code=422,
                            detail="preset must be one of: %s"
                                   % ", ".join(sorted(SUBTITLE_PRESETS)))
    return preset


def _video_dims(path: str):
    """The video's width and height, for drawing subtitles in its own
    coordinates. check_output on purpose: tests fake subprocess.run for the
    burn itself, and this probe must not be caught in that net. Unreadable
    file: a plain 1080p canvas -- fractions keep everything proportional."""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
            text=True, timeout=30)
        w, h = (int(x) for x in out.strip().split(",")[:2])
        if w > 0 and h > 0:
            return w, h
    except Exception:
        pass
    return 1920, 1080


def _srt_cues(path: str):
    """The srt as [{start, end, text}], in block order."""
    with open(path, encoding="utf-8-sig") as f:
        blocks = f.read().split("\n\n")
    cues = []
    for block in blocks:
        m = _SRT_TIMING.search(block)
        if not m:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = (int(g) for g in m.groups())
        text = block[m.end():].strip()
        cues.append({"start": h1 * 3600 + m1 * 60 + s1 + ms1 / 1000.0,
                     "end": h2 * 3600 + m2 * 60 + s2 + ms2 / 1000.0,
                     "text": text})
    return cues


def _write_burn_ass(srt: str, preset: str, pos, size, work: str, video: str,
                    box_width=None, line_widths=None) -> str:
    """The styled .ass beside the job, rebuilt for every burn (cheap)."""
    w, h = _video_dims(video)
    ass = build_ass(_srt_cues(srt), preset, width=w, height=h,
                    pos=pos, size=size, font=_BURN_FONT,
                    box_width=box_width, line_widths=line_widths)
    out = os.path.join(work, "subtitle_render.ass")
    with open(out, "w", encoding="utf-8") as f:
        f.write(ass)
    return out


def _filter_path(path: str) -> str:
    """A file path as ffmpeg's filter parser wants it.

    Inside -vf, backslash starts an escape, colon ends the argument and an
    apostrophe ends the quoted run -- all three appear in real paths (Windows
    drives, "it's.srt")."""
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _check_pos_size(pos: Optional[float], size: Optional[float]) -> None:
    if pos is not None and not 0 <= pos <= 100:
        raise HTTPException(status_code=422, detail="pos must be between 0 and 100")
    if size is not None and not 50 <= size <= 300:
        raise HTTPException(status_code=422, detail="size must be between 50 and 300")


def _pos_size_suffix(pos: Optional[float], size: Optional[float]) -> str:
    """The cache-name tail: every position and size is its own file."""
    return (("" if pos is None else "-p%d" % round(pos))
            + ("" if size is None else "-s%d" % round(size)))


@app.post("/api/subtitles/burn")
def subtitles_burn(body: SubtitleBurnRequest):
    """Lay an .srt onto a video as a new file beside the original.

    The srt defaults to the video's own name next to it -- exactly where
    /api/subtitles/extract leaves one. Rendering text onto frames forces a
    re-encode (same x264 settings as the clip route); the audio is untouched
    and copied through.
    """
    preset = _norm_preset(body.preset)
    path = os.path.expanduser(body.video_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No such video: {body.video_path}")
    base, ext = os.path.splitext(path)
    srt = os.path.expanduser(body.srt_path) if body.srt_path else base + ".srt"
    if not os.path.isfile(srt):
        raise HTTPException(status_code=404,
                            detail="No subtitle file to lay on. Extract subtitles "
                                   "first, or name an .srt file.")
    out = _free_path("%s-sub-%s" % (base, preset), ext or ".mp4")
    _check_pos_size(body.pos, body.size)
    work = os.path.dirname(path)
    ass = _write_burn_ass(srt, preset, body.pos, body.size, work, path)
    vf = "ass=filename='%s'" % _filter_path(ass)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", path, "-vf", vf,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "copy",
           "-movflags", "+faststart", out]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0:
        raise HTTPException(status_code=503,
                            detail="ffmpeg could not subtitle this video (%s)."
                                   % (run.stderr or "no detail")[-120:].strip())
    return {"out_path": out, "preset": preset}


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
        "hunyuan_available": hunyuan_available(),
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


def _cut_video(path: str, start: float, end: float, on_cut=None) -> None:
    """Keep only [start, end] of the video, in place. Re-encodes so the cut is
    exact (a copy-cut lands on the nearest keyframe, seconds away).

    `on_cut` runs the instant the cut file takes the original's place, before
    anything else can happen. That is where a caller records "this video is cut
    now": recording it a statement later leaves a window where a force-quit
    saves a record that still owes a cut over a video that has already had one,
    and the next run would take the same seconds out twice.
    """
    tmp = path + ".cut.mp4"
    try:
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                            "-i", path, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            # Only ffmpeg's last line, which is the complaint itself. The lines
            # before it name the input file, so a tail of the whole thing put the
            # user's folders on screen (and into a bug report) for nothing.
            last = ([ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip()] or [""])[-1]
            # ffmpeg names files by their full path even in that last line, so
            # each one is cut back to its own name: the user learns which file
            # upset it without their folders ending up on screen.
            last = re.sub(r"\S*/(\S+)", r"\1", last)
            raise RuntimeError(("Could not trim the video: " + last) if last
                               else "Could not trim the video.")
        os.replace(tmp, path)
        if on_cut is not None:
            on_cut()
    finally:
        # A cut that died with the output already open (out of disk, a killed
        # encoder) would otherwise leave a half-written .cut.mp4 beside a good
        # input.mp4, in a folder the pipeline later walks.
        if os.path.exists(tmp):
            os.remove(tmp)


def _engines_used(stt_engine=None, translate_engine=None, n_takes=None, sep_engine=None) -> dict:
    """The engine choices this job is really being made with, resolved now.

    The form may leave any of them out, in which case the app's own setting
    decides -- so what is saved on the job is the answer, never the blank. That
    is what lets the finished screen say "Whisper, Gemma, 4 takes" months later,
    and what "Try again" repeats instead of whatever the defaults are that day.
    "whisper" covers both ways of asking for the free local engine (an explicit
    "local" and no choice at all); qwen3 is the app's only voice engine.
    """
    resolved_stt = (stt_engine or default_stt_engine() or "").lower()
    resolved_sep = (sep_engine or dub_setup.default_for("separation")).lower()
    return {
        "stt_engine": "perso" if resolved_stt == "perso" else "whisper",
        "translator": (translate_engine or dub_setup.default_for("translator")).lower() or None,
        "tts": "qwen3",
        "quality": n_takes if n_takes is not None else (dub_setup.default_n_takes() or QWEN_N_TAKES),
        "separation": "perso" if resolved_sep == "perso" else "demucs",
    }


def _missing_models(need_whisper: bool, translate_missing_id, need_tts: bool = True):
    """Catalog entries this job still needs, in catalog order.

    Pure lookups (disk markers via the catalog; the caller already resolved
    the Ollama-side statuses) so tests can drive it without a network. The
    409 built from it is what the screen's "Download N GB of AI models to
    dub?" dialog renders.
    """
    kit = model_store.kit_dir()
    wanted = []
    if need_whisper:
        wanted.append("whisper")
    if need_tts:
        wanted.append("qwen3-tts")
    missing = []
    for m in model_store.load_catalog():
        if m["id"] in wanted and model_store.model_state(m, kit) != "ready":
            missing.append({"id": m["id"], "name": m["name"], "bytes": m["bytes"]})
        if translate_missing_id and m["id"] == translate_missing_id:
            missing.append({"id": m["id"], "name": m["name"], "bytes": m["bytes"]})
    return missing


def _run_cloud_dub(jid, video_path, out_path, source_code, target_code, num_speakers, log):
    """The whole-job Perso path: upload -> cloud dub -> download. Same failure
    grammar as the Perso STT/separation stages (no silent local fallback)."""
    log("1/1 Dubbing in the Perso cloud…")
    pc = PersoClient()
    pc.cancel_check = lambda: job_store.is_cancel_requested(jid)
    ws = getattr(pc, "describe_workspace", lambda: None)()
    if ws:
        log(f"   Perso workspace: {ws.get('name') or ws.get('seq')} (#{ws.get('seq')})")
    try:
        pc.dub_video(video_path, out_path, source_code, target_code, num_speakers=num_speakers, log=log)
        # The Perso project number is how the script viewer (and later the
        # agent) finds this job's sentences again -- persist it with the job.
        seq = getattr(pc, "last_dub_project_seq", None)
        if seq:
            job_store._update(jid, perso_project_seq=seq)
            job_store.persist(jid, os.path.dirname(out_path))
    except JobCancelled:
        raise
    except PersoCreditExhaustedError as e:
        msg = "Perso credits are used up. Recharge to continue."
        log(f"   Error: {msg} ({e.link})")
        job_store.append_notice(jid, {"type": "perso_credit_exhausted", "message": msg, "link": e.link})
        raise RuntimeError(msg) from e
    except PersoInvalidKeyError as e:
        msg = "Perso rejected the API key. Open Settings and check the key."
        log(f"   Error: {msg}")
        job_store.append_notice(jid, {"type": "perso_invalid_key", "message": msg})
        raise RuntimeError(msg) from e
    except PersoUnavailableError as e:
        msg = "Perso's server is temporarily unavailable. Wait a few minutes, then run this job again."
        log(f"   Error: {msg}")
        job_store.append_notice(jid, {"type": "perso_unavailable", "message": msg})
        raise RuntimeError(msg) from e
    try:
        if ws and ws.get("credits") is not None:
            after = (getattr(pc, "describe_workspace", lambda: None)() or {}).get("credits")
            if after is not None:
                log(f"   Perso credits used: {int(ws['credits']) - int(after)} ({after} left)")
    except Exception:
        pass
    return {"job_id": jid, "out_path": out_path, "num_segments": 0, "dub_mode": "perso"}


def _raise_models_needed(missing):
    free = model_store.free_bytes_at(model_store.kit_dir())
    raise HTTPException(409, {
        "missing": missing,
        "total_bytes": sum(m["bytes"] for m in missing),
        "free_bytes": int(free or 0),
    })


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
    sep_engine: Optional[str] = Form(None),
    dub_mode: Optional[str] = Form(None),
    n_takes: Optional[int] = Form(None),
    source_language_code: Optional[str] = Form(None),
    project: Optional[str] = Form(None),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
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
    trim_start/trim_end = dub only these seconds of the video. Both or neither:
    the video is cut down to that part and the cut IS this job's original.
    """
    # Half a range means nothing, and a backwards one would produce an empty
    # video minutes later -- both are caught here, before anything is saved.
    # isfinite keeps out inf and nan, which would otherwise reach ffmpeg as
    # "-to inf"; the half-second floor is the same one the screen's handles
    # enforce, so both sides agree on what counts as a trim.
    if (trim_start is None) != (trim_end is None):
        raise HTTPException(400, "Send both trim_start and trim_end, or neither.")
    if trim_start is not None and not (
        math.isfinite(trim_start) and math.isfinite(trim_end)
        and 0 <= trim_start and trim_end - trim_start >= 0.5
    ):
        raise HTTPException(
            400,
            "The trim must start at 0 seconds or later and keep at least half a second of video.",
        )
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
    # Same normalization for the same reason: "Perso" with a capital P must not
    # silently skip the preflight and run the free local engine instead.
    # Blanks take the app's saved defaults (app/setup.py): what the Settings
    # screen or the Dub Agent's set_default chose, in force without a restart.
    sep_engine = (sep_engine or "").strip().lower() or dub_setup.default_for("separation")
    if sep_engine not in ("local", "demucs", "perso"):
        raise HTTPException(422, f"Unknown sep_engine: {sep_engine}")
    dub_mode = (dub_mode or "").strip().lower() or dub_setup.default_for("dub_mode")
    if dub_mode not in ("local", "perso"):
        raise HTTPException(422, f"Unknown dub_mode: {dub_mode}")
    if n_takes is None:
        n_takes = dub_setup.default_n_takes()  # None when no quality was ever saved
    if dub_mode == "perso":
        # The cloud does everything -- the per-stage engine choices (and their
        # preflights, including the local-model 409) do not apply.
        stt_engine = sep_engine = translate_engine = None
    if not _valid_language_code(language_code):
        raise HTTPException(422, f"Unknown language_code: {language_code}")
    effective_translate_engine = "" if dub_mode == "perso" else (translate_engine or dub_setup.default_for("translator")).lower()
    translate_missing_id = None
    if effective_translate_engine == "gemma":
        status = gemma_status()
        if status == "unreachable":
            raise HTTPException(422, _ollama_unavailable_message("Gemma", status, OLLAMA_GEMMA_MODEL))
        if status == "model_missing":
            translate_missing_id = "gemma"
    if effective_translate_engine == "qwen":
        status = qwen_status()
        if status != "available":
            raise HTTPException(422, _ollama_unavailable_message("Qwen", status, OLLAMA_QWEN_MODEL))
    if effective_translate_engine == "hunyuan":
        status = hunyuan_status()
        if status == "unreachable":
            raise HTTPException(422, _ollama_unavailable_message("Hunyuan", status, OLLAMA_HUNYUAN_MODEL))
        if status == "model_missing":
            translate_missing_id = "hunyuan"
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
    if sep_engine == "perso" and not perso_available():
        raise HTTPException(
            422,
            "Perso separation needs an API key. Open Settings and save your Perso "
            "API key, or choose Local separation.",
        )
    if dub_mode == "perso" and not perso_available():
        raise HTTPException(
            422,
            "Perso cloud dubbing needs an API key. Open Settings and save your "
            "Perso API key, or dub on this computer.",
        )
    if (dub_mode == "perso" or "perso" in (stt_engine, sep_engine)) and not current_value("PERSO_SPACE_SEQ"):
        # No workspace pinned: a single-workspace account resolves silently in
        # the pipeline, but several would fail AFTER minutes of separation
        # work. Catch that here, before the upload is accepted.
        key = current_value("PERSO_API_KEY")
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

    # The models this job still needs -- 409 with the dialog's exact payload
    # instead of dying minutes into the pipeline (permanent rule: the screen
    # asks, downloads, and resubmits; nothing here downloads silently).
    if dub_mode != "perso":
        need_whisper = (stt_engine or default_stt_engine() or "local") != "perso"
        missing = _missing_models(need_whisper, translate_missing_id)
        if missing:
            _raise_models_needed(missing)

    # Names the job's folder. The caller may pass a title it already knows (the
    # screen probes a link before starting, and app/source_fetch.py's fetch()
    # returns nothing, so the server never learns it otherwise). Without one,
    # fall back to the uploaded filename or the URL.
    project = safe_name(project or "")
    if not project:
        project = safe_name(
            os.path.splitext(video.filename or "")[0] if has_upload else (source_url or "")
        )
    check_space(WORKSPACE)
    work = _job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    if has_upload:
        with open(video_path, "wb") as f:
            shutil.copyfileobj(video.file, f)
        # Cut before the job starts, so everything downstream (and the running
        # screen's original) only ever sees the part the user picked. A link
        # has nothing to cut yet -- that happens after the download, below.
        if trim_start is not None:
            try:
                _cut_video(video_path, trim_start, trim_end)
            except RuntimeError as e:
                # No job record exists yet, so nothing would ever come back to
                # reap this folder -- and the next try would land in _001.
                # _job_dir always makes a fresh folder, so it is ours to drop.
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(400, str(e))

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
                      # Where input.mp4 lives. Stamped here because the running
                      # screen asks for the original while the job is still
                      # going, when there is no result to find the folder from.
                      work_dir=work,
                      # Kept so a later redub of this job can pass the same
                      # language name back into run_dub.
                      language=language,
                      # The language the user said the video is in, or None for
                      # auto-detect. Only auto-detect leaves a language behind in
                      # the result (app/stt_local.py fires on_language solely when
                      # nothing was forced), so without this the screen has no way
                      # to name the source column of a job that was told.
                      source_lang=source_language_code or None,
                      # The seconds the user kept, or None for the whole video.
                      trim=({"start": trim_start, "end": trim_end}
                            if trim_start is not None else None),
                      # An upload was cut just above, before this record existed.
                      # A link still holds the whole video and is cut in the
                      # thread below, which clears this the moment it is.
                      trim_pending=bool(source_url and trim_start is not None),
                      from_link=bool(source_url),
                      # The link itself and the speaker count: what the boot
                      # re-arm needs to rebuild this job's work should it wait
                      # out an app restart in the queue.
                      source_url=source_url,
                      num_speakers=num_speakers,
                      # What made this job: read back by the finished screen and
                      # by "Try again", which repeats these rather than today's
                      # defaults.
                      # A cloud job records its mode, not local engine choices
                      # its finished screen would then lie about.
                      **({"dub_mode": "perso"} if dub_mode == "perso" else
                         {"dub_mode": "local",
                          **_engines_used(stt_engine, translate_engine, n_takes, sep_engine)}))
    # Written now, not just at the end: a job the user quits the app in the
    # middle of still has a folder, and without a file in it that folder is
    # nameless -- Projects would have nothing to show for it.
    job_store.persist(jid, work)
    # First log line names the source -- log files are job-<id>.log, so without
    # this there is no way to tell which video a log belongs to.
    job_store.append_log(jid, f"{source_url or video.filename or 'video'}")

    def _target(log):
        if source_url:
            fetch_source(
                source_url, video_path, log=log,
                cancel_check=lambda: job_store.is_cancel_requested(jid),
            )
            if trim_start is not None:
                # Written to job.json the instant the cut lands, not at the end
                # of the job and not a statement later: quit the app in between
                # and the record still says a cut is owed over a video that has
                # already had one, and running it again would take the same
                # seconds out twice.
                def _cut_recorded():
                    job_store._update(jid, trim_pending=False)
                    job_store.persist(jid, work)

                _cut_video(video_path, trim_start, trim_end, on_cut=_cut_recorded)
        if dub_mode == "perso":
            return _run_cloud_dub(jid, video_path, out_path,
                                  source_language_code or None, language_code,
                                  num_speakers, log)
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
            sep_engine=sep_engine,
            n_takes=n_takes,
            source_language_code=source_language_code,
            cancel_check=lambda: job_store.is_cancel_requested(jid),
            on_notice=lambda n: job_store.append_notice(jid, n),
            log=log,
        )

    # A Perso cloud dub runs on Perso's servers, so it skips the local line
    # (user decision 2026-09-01): waiting here would idle both machines.
    job_store.start(jid, _target, parallel=(dub_mode == "perso"))
    # "running", or "queued" when another dub holds the air -- the screen's
    # toast says which.
    return {"job_id": jid, "status": job_store.get(jid)["status"]}


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


# A language code, not a path fragment: letters, then optionally a region after
# a hyphen or underscore ("ko", "zh-CN", "pt_BR", "es-419"). Nothing else gets
# in, because _job_dir pastes this straight into the job's folder name.
_LANGUAGE_CODE = re.compile(r"^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})?$")


def _valid_language_code(code: str) -> bool:
    return bool(_LANGUAGE_CODE.match(code or ""))


# run_dub is given the language's NAME, which it pastes into the translation
# prompt and hands to the voice sidecar -- a job whose saved record predates
# `language` needs its name worked out from the code. The table itself lives
# in app/config.py, shared with the agent's queue_dub tool.
LANGUAGE_NAMES = config.LANGUAGE_NAMES


def _language_name(code: str) -> str:
    """The language's name for a code, or the code itself for one we don't know
    (a region variant, say) -- which is no worse than what we were given."""
    return LANGUAGE_NAMES.get((code or "").lower(), code)


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
    # The language half is caller-supplied too, and went in unchecked while the
    # title half was sanitized -- so "../.." in it walked the job out of the
    # workspace and wrote input.mp4 over whatever lived there. dub_start
    # rejects a malformed code outright; this keeps every other caller safe.
    lang = safe_name(lang_code) or "out"
    name = next_free("%s_%s" % (base, lang), os.listdir(day)) if base else None
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
def dub_result_original(jid: str, download: int = 0):
    """Return this job's source video.

    Served for every job, running or finished: the running screen plays it
    blurred behind the progress card, and the finished screen puts it beside
    the dub. Read from the job's own workspace folder, which exists from the
    moment the job starts -- long before there is any result to look next to.

    ?download=1 (the "Download original" button) stays link-only: a file the
    user uploaded is already on their machine, so offering it back is noise;
    a video pulled from a link is the only original they cannot otherwise get.
    """
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if download and not j.get("from_link"):
        raise HTTPException(status_code=404,
                            detail="This job started from a file you already have")
    work_dir = _work_dir_of(j)
    original = os.path.join(work_dir, "input.mp4") if work_dir else ""
    if not original or not os.path.exists(original):
        raise HTTPException(status_code=404, detail="Original file not found")
    return FileResponse(original, media_type="video/mp4", filename="org.mp4")


@app.api_route("/api/dub/result/{jid}/srt", methods=["GET", "HEAD"])
def dub_result_srt(jid: str, download: int = 0):
    """Return the translated subtitles used for the dub, as plain text.

    HEAD as well as GET: the Export dialog only needs to know whether this job
    has subtitles at all, and asking with GET downloaded the whole file to throw
    it away. FastAPI does not add HEAD to a GET route by itself.

    run_dub()'s result dict doesn't carry the srt path, but it
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
    # edited.srt first: once the user has fixed lines, THAT is the script the
    # remade voices speak, and the one every export should carry (2026-09-01).
    for name in ("edited.srt", "translated.srt", "sub.srt"):
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


def _subtitled_sources(jid: str):
    """The finished video and the script to lay on it, or the HTTPException
    that says why not. Shared by the subtitled export and its preview."""
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out or not os.path.exists(out):
        raise HTTPException(status_code=404, detail="Result file not found")
    work = os.path.dirname(out)
    for name in ("edited.srt", "translated.srt", "sub.srt"):
        srt = os.path.join(work, name)
        if os.path.exists(srt):
            return j, out, srt, work
    raise HTTPException(status_code=404, detail="Subtitle file not found")


def _stale(built: str, *sources: str) -> bool:
    """The built file is missing, or something it was built from is newer."""
    if not os.path.exists(built):
        return True
    made = os.path.getmtime(built)
    return any(os.path.getmtime(src) > made for src in sources)


@app.get("/api/dub/result/{jid}/subtitled")
def dub_result_subtitled(jid: str, preset: Optional[str] = None, download: int = 0,
                         pos: Optional[float] = None, size: Optional[float] = None):
    """The dubbed video with its subtitles laid on, built on first ask.

    Lives in the job's own folder as subtitled-<preset>.mp4 and is served from
    there afterwards; a remade video or an edited script makes it stale and it
    is built again. The edited script wins over the original -- it is what the
    remade voices actually say.
    """
    j, out, srt, work, preset, pos, size, sources, stored = _resolved_burn_inputs(
        jid, preset, pos, size)
    built = os.path.join(work, "subtitled-%s%s.mp4" % (preset, _pos_size_suffix(pos, size)))
    if _stale(built, *sources):
        ass = _write_burn_ass(srt, preset, pos, size, work, out,
                              stored["boxWidth"], stored["widths"])
        run = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", out, "-vf", "ass=filename='%s'" % _filter_path(ass),
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", "-c:a", "copy",
             "-movflags", "+faststart", built],
            capture_output=True, text=True)
        if run.returncode != 0:
            raise HTTPException(status_code=503,
                                detail="ffmpeg could not subtitle this video (%s)."
                                       % (run.stderr or "no detail")[-120:].strip())
    filename = "dub_%s-sub-%s.mp4" % (_target_code(j), preset)
    headers = ({"Content-Disposition": 'attachment; filename="%s"' % filename}
               if download else None)
    return FileResponse(built, media_type="video/mp4", headers=headers)


_SUBTITLE_STYLE_DEFAULTS = {"enabled": True, "preset": "clean",
                            "pos": None, "size": None, "cues": {},
                            "boxWidth": None, "widths": {}}


def _subtitle_style_file(jid: str) -> str:
    j = job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    out = (j.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=404, detail="Result file not found")
    return os.path.join(os.path.dirname(out), "subtitle_style.json")


def _load_subtitle_style(work: str) -> dict:
    try:
        with open(os.path.join(work, "subtitle_style.json"), encoding="utf-8") as f:
            return {**_SUBTITLE_STYLE_DEFAULTS, **json.load(f)}
    except (OSError, ValueError):
        return dict(_SUBTITLE_STYLE_DEFAULTS)


@app.get("/api/dub/jobs/{jid}/subtitle_style")
def subtitle_style_get(jid: str):
    """How this job's subtitles should look -- one truth shared by the player
    overlay, the timeline's subtitle lane and the Export dialog."""
    return _load_subtitle_style(os.path.dirname(_subtitle_style_file(jid)))


@app.put("/api/dub/jobs/{jid}/subtitle_style")
def subtitle_style_put(jid: str, body: dict):
    path = _subtitle_style_file(jid)
    merged = {**_SUBTITLE_STYLE_DEFAULTS,
              **{k: v for k, v in (body or {}).items() if k in _SUBTITLE_STYLE_DEFAULTS}}
    merged["preset"] = _norm_preset(merged["preset"])
    _check_pos_size(merged["pos"], merged["size"])
    if merged["boxWidth"] is not None and not 10 <= merged["boxWidth"] <= 100:
        raise HTTPException(status_code=422, detail="boxWidth must be between 10 and 100")
    if not isinstance(merged["widths"], dict):
        raise HTTPException(status_code=422, detail="widths must be an object")
    for k, w in merged["widths"].items():
        try:
            w = float(w)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"width {k} must be a number")
        if not 10 <= w <= 100:
            raise HTTPException(status_code=422, detail=f"width {k} must be between 10 and 100")
    if not isinstance(merged["cues"], dict):
        raise HTTPException(status_code=422, detail="cues must be an object")
    for k, cue in merged["cues"].items():
        try:
            start, end = float(cue["start"]), float(cue["end"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"cue {k} needs start and end")
        if not 0 <= start < end:
            raise HTTPException(status_code=422, detail=f"cue {k} must start before it ends")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False)
    return merged


_SRT_TIMING = re.compile(
    r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def _fmt_srt_time(sec: float) -> str:
    ms = round(sec * 1000)
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60,
                                    ms // 1000 % 60, ms % 1000)


def _retimed_srt(srt: str, cues: dict, work: str) -> str:
    """The srt with the user's own timings on the lines they stretched or
    trimmed on the timeline (keyed 1-based, in block order). Written beside
    the original, which stays the record of what the dub said."""
    with open(srt, encoding="utf-8-sig") as f:
        blocks = f.read().split("\n\n")
    n = 0
    for i, block in enumerate(blocks):
        if not _SRT_TIMING.search(block):
            continue
        n += 1
        cue = cues.get(str(n))
        if cue:
            blocks[i] = _SRT_TIMING.sub(
                "%s --> %s" % (_fmt_srt_time(float(cue["start"])),
                               _fmt_srt_time(float(cue["end"]))), block, count=1)
    out = os.path.join(work, "subtitle_timed.srt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n\n".join(blocks))
    return out


def _resolved_burn_inputs(jid, preset, pos, size):
    """Query params when given, the stored settings where not -- plus the srt
    (retimed if lines were), and every file the built result depends on."""
    _check_pos_size(pos, size)
    j, out, srt, work = _subtitled_sources(jid)
    stored = _load_subtitle_style(work)
    preset = _norm_preset(preset or stored["preset"])
    pos = stored["pos"] if pos is None else pos
    size = stored["size"] if size is None else size
    _check_pos_size(pos, size)
    style_file = os.path.join(work, "subtitle_style.json")
    sources = [out, srt] + ([style_file] if os.path.exists(style_file) else [])
    if stored["cues"]:
        srt = _retimed_srt(srt, stored["cues"], work)
    return j, out, srt, work, preset, pos, size, sources, stored


def _first_srt_second(srt: str) -> float:
    """When the first line appears, so the preview frame has words on it."""
    with open(srt, encoding="utf-8-sig") as f:
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)", f.read())
    if not m:
        return 0.0
    h, mnt, sec, ms = (int(g) for g in m.groups())
    return h * 3600 + mnt * 60 + sec + ms / 1000.0


@app.get("/api/dub/result/{jid}/subtitle_preview")
def dub_result_subtitle_preview(jid: str, preset: Optional[str] = None,
                                pos: Optional[float] = None,
                                size: Optional[float] = None):
    """One frame of the subtitled video, for the Export dialog's style cards.

    Seeked into the first subtitle line; -copyts keeps the original clock so
    the subtitles filter still knows a line is on screen at that moment.
    """
    j, out, srt, work, preset, pos, size, sources, stored = _resolved_burn_inputs(
        jid, preset, pos, size)
    built = os.path.join(work, "subtitle-preview-%s%s.jpg" % (preset, _pos_size_suffix(pos, size)))
    if _stale(built, *sources):
        at = _first_srt_second(srt) + 0.5
        ass = _write_burn_ass(srt, preset, pos, size, work, out,
                              stored["boxWidth"], stored["widths"])
        run = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-ss", "%.3f" % at, "-copyts", "-i", out,
             "-vf", "ass=filename='%s',scale=480:-2" % _filter_path(ass),
             "-frames:v", "1", "-q:v", "5", built],
            capture_output=True, text=True)
        if run.returncode != 0:
            raise HTTPException(status_code=503,
                                detail="ffmpeg could not draw the preview (%s)."
                                       % (run.stderr or "no detail")[-120:].strip())
    return FileResponse(built, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# The script assistant: a chat panel driving whichever CLI agent the user
# already subscribes to. It reaches the script through the same five MCP tools
# a terminal agent uses -- see app/mcp_server.py. Starting or cancelling a dub
# is deliberately not among them.
# ---------------------------------------------------------------------------

AGENTS = {
    # `login` is what the user types in a terminal to sign this CLI in. It is
    # here rather than in the screen so one place names it: the failure message
    # and the strip's status line both say the same command.
    "claude": {"binary": "claude", "name": "Claude", "vendor": "Anthropic",
               "driver": claude_agent, "login": "claude"},
    "codex": {"binary": "codex", "name": "Codex", "vendor": "OpenAI",
              "driver": codex_agent, "login": "codex login"},
    # An assistant listed with "driver": None and a "reason" is offered but
    # greyed out, with the reason printed under its name. Nothing is in that
    # state today -- Gemini was, and was dropped rather than left on the list
    # as a row nobody could pick -- but the next CLI to be added can be shown
    # before it is wired up.
}

# Where the assistant's own files live. Never the user's global CLI config:
# their everyday setup has to keep working exactly as it did.
AGENT_DIR = os.path.join(PERSODUB_LOG_DIR, "agent")

# --- Which account each CLI is signed in with -------------------------------
# Asking costs a process, so the answer is kept for a minute -- and the asking
# happens on a thread of its own. /api/agent/status answers from what is known
# this instant: the picker has to open now, not when a CLI feels like replying.
AGENT_LOGIN_TTL = 60.0
_login_cache = {}          # agent id -> {"logged_in", "account", "at"}
_login_busy = set()        # ids with a check already running
_login_broken = set()      # ids whose check has already been complained about
_login_lock = threading.Lock()


def _login_refresh(key: str, binary: str) -> None:
    """Ask one CLI, and write down whatever came of it -- including nothing.

    The write and the clearing of the busy marker happen whatever the CLI does:
    a check that threw used to leave its marker behind, and that assistant then
    showed "not known" for the life of the app, with nothing on screen to say
    why and no way back but a restart.
    """
    state = {"logged_in": None, "account": ""}
    try:
        state = agent_base.login_state(key, binary)
    except Exception as e:   # noqa: BLE001 -- a CLI can fail in any way at all
        # Once per assistant per run: this is for whoever reads the log, and a
        # line every minute would bury the rest of it.
        if key not in _login_broken:
            _login_broken.add(key)
            print("PersoDub: could not check %s's login (%s)" % (key, e), file=sys.stderr)
    finally:
        with _login_lock:
            _login_cache[key] = dict(state, at=time.monotonic())
            _login_busy.discard(key)


def _login_of(key: str, binary: str, ask: bool) -> dict:
    """What is known about this CLI's login right now, refreshing behind us.

    `ask` is what allows a check to be started at all: every check is a child
    process, and the first screen -- where the assistant is not even on show --
    must not start one. The screen asks the first time the strip is visible.

    None for `logged_in` means "we cannot say yet", never "signed out" -- the
    screen shows nothing rather than an accusation it has not checked.
    """
    now = time.monotonic()
    with _login_lock:
        row = _login_cache.get(key)
        stale = row is None or now - row["at"] >= AGENT_LOGIN_TTL
        start = bool(ask and stale and binary and key not in _login_busy)
        if start:
            _login_busy.add(key)
    if start:
        threading.Thread(target=_login_refresh, args=(key, binary), daemon=True).start()
    if row is None:
        return {"logged_in": None, "account": ""}
    return {"logged_in": row["logged_in"], "account": row["account"]}


class AgentChatRequest(BaseModel):
    message: str
    agent: str = "claude"
    resume: bool = True
    # "" keeps whatever the CLI is set up to use.
    model: str = ""
    # The job the user is looking at. Every script tool needs one, and the user
    # has no way of knowing the id -- the panel reads it off the page instead.
    job_id: Optional[str] = None


def _with_job(message: str, job_id: Optional[str]) -> str:
    """Tell the assistant which job is on screen before it reads the question."""
    if not job_id:
        # The home screen has the strip too, and there no job is open. Said
        # outright, or the assistant asks for a job number the user never sees.
        return ("(No job is open on screen right now -- the user is on the "
                "home screen.)\n\n%s" % message)
    return "(The job open on screen right now: %s)\n\n%s" % (job_id, message)


@app.get("/api/agent/status")
def agent_status(login: int = 0):
    """Which assistants are installed on this machine, and which are ready.

    Only one of them is needed -- whichever the user subscribes to. The panel
    greys out the rest rather than asking anyone to install both.
    """
    out = []
    for key, meta in AGENTS.items():
        path = agent_base.find_cli(meta["binary"])
        driver = meta["driver"]
        # Only asked of a CLI we would actually run, and only when the caller
        # says the assistant is on screen (?login=1). `logged_in` is None until
        # the answer lands, and this call never waits for it.
        state = (_login_of(key, path, ask=bool(login)) if path and driver
                 else {"logged_in": None, "account": ""})
        out.append({
            "id": key,
            "name": meta["name"],
            "vendor": meta["vendor"],
            "installed": bool(path),
            "supported": driver is not None,
            # True, False, or None for "not known yet". The account is its KIND
            # ("ChatGPT", "claude.ai") -- never an address, never a token.
            "logged_in": state["logged_in"],
            "account": state["account"],
            # What to type in a terminal to sign in, said in one place.
            "login_command": meta.get("login", ""),
            # Why it is greyed out, in the picker's own words. Empty when the
            # assistant is usable, and "not installed" is the panel's line.
            "reason": "" if driver else meta.get("reason", ""),
            "models": driver.MODELS if driver else [],
        })
    return {"agents": out}


@app.post("/api/agent/stop")
def agent_stop():
    """End the turn on air, leaving the conversation there to carry on.

    The CLI is asked to go rather than shot: it writes its session down on the
    way out, and that is what the next message resumes from. `stopped` is False
    when there was no turn running -- pressing Stop twice is not an error.
    """
    return {"stopped": agent_base.stop_turn()}


@app.post("/api/agent/chat")
async def agent_chat(body: AgentChatRequest, request: Request):
    """One turn with the assistant, streamed back a line of JSON at a time.

    Streaming is the point: a turn takes seconds, and a panel that sits blank
    that whole time reads as broken. Each line is one of our five events.
    """
    meta = AGENTS.get(body.agent)
    if meta is None:
        raise HTTPException(status_code=422, detail="Unknown assistant: %s" % body.agent)
    driver = meta["driver"]
    if driver is None:
        raise HTTPException(status_code=501, detail="%s: %s"
                            % (meta["name"], meta.get("reason", "not wired up yet")))

    binary = agent_base.find_cli(meta["binary"])
    if not binary:
        raise HTTPException(status_code=503,
                            detail="%s is not installed." % meta["name"])

    api_url = str(request.base_url).rstrip("/")
    mcp_config = agent_base.write_mcp_config(AGENT_DIR, api_url)
    work_dir = os.path.dirname(mcp_config)
    # The question goes to the CLI over stdin, never argv: on Windows the CLIs
    # are npm .cmd shims, and cmd.exe cuts a shim's command line at the first
    # newline -- which this text always has between job context and question.
    prompt = driver.stdin_text(_with_job(body.message, body.job_id))
    try:
        args = driver.command(mcp_config, body.resume, body.model)
    except (OSError, ValueError, KeyError) as e:
        # Everything else on this path answers with a bubble rather than a
        # stack trace, and building the command line should not be the one
        # place that hands the user a 500.
        raise HTTPException(status_code=500,
                            detail="Could not prepare the assistant: %s" % e)

    async def stream():
        # The runner blocks -- it reads the CLI's stdout a line at a time -- so
        # it gets a thread of its own and posts what it reads here. That is what
        # leaves this side free to notice the browser going away mid-answer: a
        # closed tab used to leave the CLI running to the end, talking to
        # nobody, with the next turn queued behind it.
        events = queue.Queue()

        def pump():
            try:
                for event in agent_base.run(binary, args, driver.translate,
                                            cwd=work_dir, agent_name=meta["name"],
                                            login_command=meta.get("login", ""),
                                            input_text=prompt):
                    events.put(event)
            finally:
                events.put(None)      # whatever happened, the turn is over

        threading.Thread(target=pump, daemon=True).start()
        finished = False
        try:
            while True:
                try:
                    event = await run_in_threadpool(events.get, True, 0.25)
                except queue.Empty:
                    if await request.is_disconnected():
                        break
                    continue
                if event is None:
                    finished = True
                    break
                yield json.dumps(event, ensure_ascii=False) + "\n"
        finally:
            # Stopped, or nobody left to read it. Either way the child goes.
            if not finished:
                agent_base.stop_turn()

    return StreamingResponse(stream(), media_type="application/x-ndjson")
