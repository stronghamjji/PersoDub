import json
import math
import os
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import config, media
from app import models as model_store
from app import setup as dub_setup
from app.api import agent as agent_api
from app.api import clips as clips_api
from app.api import models as models_api
from app.api import results as results_api
from app.api import script as script_api
from app.api import settings as settings_api
from app.config import (
    OLLAMA_GEMMA_MODEL,
    OLLAMA_HUNYUAN_MODEL,
    OLLAMA_QWEN_MODEL,
    QWEN_N_TAKES,
    default_stt_engine,
)
from app.dub_script import EDITED_NAME, script_path
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
from app.perso_client import (
    APP_VERSION,
    PersoClient,
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoUnavailableError,
    list_dubbing_spaces,
)
from app.pipeline import run_dub

# Kept on this module although nothing here calls it any more: the settings
# routes moved to app/api/settings.py, and tests still redirect main.read_value.
from app.settings_env import (
    current_value,
    read_value,  # noqa: F401
)
from app.source_fetch import FetchError
from app.source_fetch import fetch as fetch_source
from app.source_fetch import probe as probe_source
from app.text.naming import next_free, safe_name
from app.translate import get_translator

# Kept as a module attribute on purpose: main's own call sites read this name
# off this module, and the tests monkeypatch main._cut_video. The code itself
# lives in app/media.py.
_cut_video = media.cut_video


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
                job_store.update(jid, trim_pending=False)
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
            job_store.update(job["id"], status="error", error=str(e))


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


# Settings, the Perso workspace picker and the reveal-output button live in
# app/api/settings.py; the URLs are unchanged.
app.include_router(agent_api.router)
app.include_router(clips_api.router)
app.include_router(models_api.router)
app.include_router(results_api.router)
app.include_router(script_api.router)
app.include_router(settings_api.router)

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


def _script_work_dir(jid: str) -> tuple:
    """The job and its folder, or the right HTTP error.

    Shared: redub below starts from it, and every route in app/api/script.py
    reads it back off this module (script._main()._script_work_dir).
    """
    job = job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail="This job has no finished script yet.")
    return job, os.path.dirname(out)


def _inherited_engines(job, keys):
    """The same engines the first run was given, not today's defaults: a Perso
    job that failed used to come back transcribed by local Whisper (or the
    other way round), with nothing on screen to say the choice had changed.
    A job saved before these were kept has none of them, so that one still
    falls back to what the app is set to now.

    `keys` is the caller's business: a redub makes voices only, so the first
    run's separation choice is none of its concern and it does not carry it.
    """
    engines = {k: job.get(k) for k in keys}
    if not engines.get("stt_engine"):
        engines = _engines_used()
    return engines


def launch_job(work, fields, log_line, target, parallel=False):
    """Register a new job and set it running. Returns the new job's id.

    The tail of the start ritual, the same one for a new dub, a redub and a
    "Try again": make the record, stamp `fields` on it, write job.json into
    the job's folder, log the first line, and hand the work to the store.

    The file is written now, not just at the end: a job the user quits the app
    in the middle of still has a folder, and without a file in it that folder
    is nameless -- Projects would have nothing to show for it.

    `target` is called as target(jid, log). The id only exists once the record
    is made here, and the work needs it for its cancel_check and on_notice.
    """
    jid = job_store.create()
    job_store.update(jid, **fields)
    job_store.persist(jid, work)
    job_store.append_log(jid, log_line)
    job_store.start(jid, lambda log: target(jid, log), parallel=parallel)
    return jid


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

    engines = _inherited_engines(job, ("stt_engine", "translator", "tts", "quality"))

    # Only the voices are made again -- no STT, no translation -- but a voice
    # model removed in the catalog must resurface as the dialog, not a crash.
    missing = _missing_models(False, None)
    if missing:
        _raise_models_needed(missing)

    def _target(new_jid, log):
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

    edited = os.path.exists(os.path.join(work_dir, EDITED_NAME))
    new_jid = launch_job(
        work,
        {"language_code": language_code, "project": project,
         "day": _today(), "from_link": False, "work_dir": work,
         # The remake is the same video in the same two languages.
         "source_lang": job.get("source_lang"),
         # ...and made with the same engines, so its finished
         # screen says what the job it came from said.
         **engines},
        "%s (%s)" % (project, "voices remade from the edited script" if edited
                     else "from the script as it was"),
        _target,
    )
    # Stamped on the OLD job so the screen showing it can follow along when the
    # assistant, not the user, is the one who pressed go.
    job_store.update(jid, remade_as=new_jid)
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

    engines = _inherited_engines(
        job, ("stt_engine", "translator", "tts", "quality", "separation"))

    translate_missing_id = None
    if engines.get("translator") in ("gemma", "hunyuan"):
        status = gemma_status() if engines["translator"] == "gemma" else hunyuan_status()
        if status == "model_missing":
            translate_missing_id = engines["translator"]
    missing = _missing_models(engines.get("stt_engine") != "perso", translate_missing_id)
    if missing:
        _raise_models_needed(missing)

    def _target(new_jid, log):
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

    new_jid = launch_job(
        work,
        {"language_code": language_code, "project": project,
         "day": _today(), "work_dir": work,
         "language": language,
         # Cut just now, or copied from a video already cut: either
         # way this job owes no cut.
         "trim": trim, "trim_pending": False,
         "source_lang": job.get("source_lang"),
         # The video is a local copy now, whatever the first job was
         # started from -- there is no link to download again.
         "from_link": False,
         **engines},
        "%s (run again)" % project,
        _target,
        parallel=(job.get("dub_mode") == "perso"),
    )
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
            job_store.update(jid, perso_project_seq=seq)
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
        and trim_start >= 0 and trim_end - trim_start >= 0.5
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
    # Resolved here, once, so the preflights below judge the engine that will
    # actually run -- a saved STT_ENGINE=perso must meet the key check too.
    stt_engine = (stt_engine or "").strip().lower() or (default_stt_engine() or "").lower() or None
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
        need_whisper = stt_engine != "perso"  # resolved above, once
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

    def _target(jid, log):
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
                    job_store.update(jid, trim_pending=False)
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
            # The engine the preflight judged, not the raw form value: a blank
            # form field means the saved default (kit.env), and run_dub's own
            # fallback is the process env, frozen at launch.
            translate_engine=effective_translate_engine or None,
            stt_engine=stt_engine,
            sep_engine=sep_engine,
            n_takes=n_takes,
            source_language_code=source_language_code,
            cancel_check=lambda: job_store.is_cancel_requested(jid),
            on_notice=lambda n: job_store.append_notice(jid, n),
            log=log,
        )

    # The download filenames are built from this; the job record is the only
    # place the result endpoints can read the user's choice back from.
    # project/day/from_link are read back by the download endpoints and by the
    # desktop shell, which builds the save folder from them. `day` is stamped
    # here rather than recomputed later: a job started at 23:59 must not land in
    # tomorrow's folder when it finishes.
    #
    # A Perso cloud dub runs on Perso's servers, so it skips the local line
    # (user decision 2026-09-01): waiting here would idle both machines.
    jid = launch_job(
        work,
        {"language_code": language_code,
         "project": project or os.path.basename(work),
         "day": _today(),
         # Where input.mp4 lives. Stamped here because the running
         # screen asks for the original while the job is still
         # going, when there is no result to find the folder from.
         "work_dir": work,
         # Kept so a later redub of this job can pass the same
         # language name back into run_dub.
         "language": language,
         # The language the user said the video is in, or None for
         # auto-detect. Only auto-detect leaves a language behind in
         # the result (app/stt_local.py fires on_language solely when
         # nothing was forced), so without this the screen has no way
         # to name the source column of a job that was told.
         "source_lang": source_language_code or None,
         # The seconds the user kept, or None for the whole video.
         "trim": ({"start": trim_start, "end": trim_end}
                  if trim_start is not None else None),
         # An upload was cut further up, before this record existed.
         # A link still holds the whole video and is cut in the
         # thread above, which clears this the moment it is.
         "trim_pending": bool(source_url and trim_start is not None),
         "from_link": bool(source_url),
         # The link itself and the speaker count: what the boot
         # re-arm needs to rebuild this job's work should it wait
         # out an app restart in the queue.
         "source_url": source_url,
         "num_speakers": num_speakers,
         # What made this job: read back by the finished screen and
         # by "Try again", which repeats these rather than today's
         # defaults.
         # A cloud job records its mode, not local engine choices
         # its finished screen would then lie about.
         **({"dub_mode": "perso"} if dub_mode == "perso" else
            {"dub_mode": "local",
             **_engines_used(stt_engine, translate_engine, n_takes, sep_engine)})},
        # First log line names the source -- log files are job-<id>.log, so
        # without this there is no way to tell which video a log belongs to.
        f"{source_url or video.filename or 'video'}",
        _target,
        parallel=(dub_mode == "perso"),
    )
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
