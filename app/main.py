import json
import math
import os
import re
import shutil
import subprocess
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.agents import base as agent_base
from app.agents import claude as claude_agent
from app.config import (OLLAMA_GEMMA_MODEL, OLLAMA_QWEN_MODEL, PERSODUB_LOG_DIR,
                        TRANSLATE_ENGINE, default_stt_engine)
from app.dub_script import (
    DUB_NAME, EDITED_NAME, edit_line, line_wav_path, load_lines, script_path,
)
from app.text.srt import parse_srt
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
from app.qwen_pipeline import rebuild_dub, resynth_one_line
from app.text.naming import next_free, safe_name
from app.settings_env import (read_analytics_off, read_key_status, read_value,
                              write_analytics_off, write_keys)
from app.source_fetch import FetchError, fetch as fetch_source, probe as probe_source
from app.translate import get_translator


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
        detail=("저장 공간이 부족합니다 (남은 공간 %.1f GB). "
                "지난 작업 폴더를 지우면 공간이 생깁니다 — "
                "왼쪽 작업 목록에서 오래된 작업을 지워주세요."
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
            detail=("이 작업에는 줄별 음성이 없습니다. "
                    "줄별 음성을 남기기 시작한 것은 2026-08-24부터라, "
                    "그 전에 만든 작업은 다시 더빙해야 들을 수 있습니다."))
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/dub/jobs/{jid}/script/{line}/voice")
def dub_job_line_voice(jid: str, line: int):
    """Speak ONE line again and rebuild the dub around it.

    Everything else is reused: the other lines' audio, the background bed and
    the speaker's cloned voice all stay on disk after a job (app/pipeline.py).
    Rewriting two lines of ten should not cost a whole synthesis pass.
    """
    job, work_dir = _script_work_dir(jid)
    manifest = os.path.join(work_dir, "lines.json")
    if not os.path.exists(manifest):
        raise HTTPException(status_code=409, detail=(
            "이 작업은 줄별로 다시 만들 수 없습니다. 2026-08-24 이전에 만든 작업이라 "
            "줄 정보가 없습니다 — 통째로 다시 만들어 주세요."))
    with open(manifest, encoding="utf-8") as f:
        data = json.load(f)
    lines = data.get("lines") or []
    if not 1 <= line <= len(lines):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")

    entry = lines[line - 1]
    text = load_lines(work_dir, job.get("language_code") or "en")[line - 1]["text"]
    try:
        new_path = resynth_one_line(work_dir, entry, text, data.get("language") or "English")
    except FileNotFoundError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if new_path is None:
        raise HTTPException(status_code=502, detail="목소리를 만들지 못했습니다.")

    rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"),
                (job.get("result") or {}).get("out_path"))
    return {"line": line, "ok": True}


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

    new_jid = job_store.create()
    job_store._update(new_jid, language_code=language_code, project=project,
                      day=_today(), from_link=False, work_dir=work,
                      # The remake is the same video in the same two languages.
                      source_lang=job.get("source_lang"))
    # Same reason as in dub_start: quit the app mid-remake and this folder is
    # nameless without a file in it, so Projects could never show or clear it.
    job_store.persist(new_jid, work)
    edited = os.path.exists(os.path.join(work_dir, EDITED_NAME))
    job_store.append_log(new_jid, "🎬 %s (대본 %s으로 다시 만들기)"
                         % (project, "고친 것" if edited else "그대로"))

    def _target(log):
        return run_dub(
            video_path=video_path,
            srt_path=srt_path,
            out_path=out_path,
            language=job.get("language") or language_code,
            language_code=language_code,
            cancel_check=lambda: job_store.is_cancel_requested(new_jid),
            on_notice=lambda n: job_store.append_notice(new_jid, n),
            log=log,
        )

    job_store.start(new_jid, _target)
    # Stamped on the OLD job so the screen showing it can follow along when the
    # assistant, not the user, is the one who pressed go.
    job_store._update(jid, remade_as=new_jid)
    return {"job_id": new_jid}


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
    if j["status"] == "running":
        raise HTTPException(status_code=409, detail="Job is still running")
    # work_dir is stamped the moment the folder is made, so a job that failed
    # before it produced anything can be cleared out too -- Projects lists
    # those now, and a row nothing can remove is a row that never goes away.
    out = j.get("work_dir") or os.path.dirname((j.get("result") or {}).get("out_path") or "")
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


def _cut_video(path: str, start: float, end: float) -> None:
    """Keep only [start, end] of the video, in place. Re-encodes so the cut is
    exact (a copy-cut lands on the nearest keyframe, seconds away)."""
    tmp = path + ".cut.mp4"
    try:
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                            "-i", path, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("Could not trim the video: " + r.stderr[-200:])
        os.replace(tmp, path)
    finally:
        # A cut that died with the output already open (out of disk, a killed
        # encoder) would otherwise leave a half-written .cut.mp4 beside a good
        # input.mp4, in a folder the pipeline later walks.
        if os.path.exists(tmp):
            os.remove(tmp)


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
    if not _valid_language_code(language_code):
        raise HTTPException(422, f"Unknown language_code: {language_code}")
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
                      from_link=bool(source_url))
    # Written now, not just at the end: a job the user quits the app in the
    # middle of still has a folder, and without a file in it that folder is
    # nameless -- Projects would have nothing to show for it.
    job_store.persist(jid, work)
    # First log line names the source -- log files are job-<id>.log, so without
    # this there is no way to tell which video a log belongs to.
    job_store.append_log(jid, f"🎬 {source_url or video.filename or 'video'}")

    def _target(log):
        if source_url:
            fetch_source(
                source_url, video_path, log=log,
                cancel_check=lambda: job_store.is_cancel_requested(jid),
            )
            if trim_start is not None:
                _cut_video(video_path, trim_start, trim_end)
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


# A language code, not a path fragment: letters, then optionally a region after
# a hyphen or underscore ("ko", "zh-CN", "pt_BR", "es-419"). Nothing else gets
# in, because _job_dir pastes this straight into the job's folder name.
_LANGUAGE_CODE = re.compile(r"^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})?$")


def _valid_language_code(code: str) -> bool:
    return bool(_LANGUAGE_CODE.match(code or ""))


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
    work_dir = j.get("work_dir") or os.path.dirname((j.get("result") or {}).get("out_path") or "")
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


# ---------------------------------------------------------------------------
# The script assistant: a chat panel driving whichever CLI agent the user
# already subscribes to. It reaches the script through the same five MCP tools
# a terminal agent uses -- see app/mcp_server.py. Starting or cancelling a dub
# is deliberately not among them.
# ---------------------------------------------------------------------------

AGENTS = {
    "claude": {"binary": "claude", "name": "Claude", "vendor": "Anthropic"},
    "codex": {"binary": "codex", "name": "Codex", "vendor": "OpenAI"},
    "gemini": {"binary": "gemini", "name": "Gemini", "vendor": "Google"},
}

# Where the assistant's own files live. Never the user's global CLI config:
# their everyday setup has to keep working exactly as it did.
AGENT_DIR = os.path.join(PERSODUB_LOG_DIR, "agent")


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
        return message
    return "(지금 화면에 열려 있는 작업 번호: %s)\n\n%s" % (job_id, message)


@app.get("/api/agent/status")
def agent_status():
    """Which assistants are installed on this machine, and which are ready.

    Only one of them is needed -- whichever the user subscribes to. The panel
    greys out the rest rather than asking anyone to install all three.
    """
    out = []
    for key, meta in AGENTS.items():
        path = agent_base.find_cli(meta["binary"])
        out.append({
            "id": key,
            "name": meta["name"],
            "vendor": meta["vendor"],
            "installed": bool(path),
            "supported": key == "claude",  # the other two translators come next
            "models": claude_agent.MODELS if key == "claude" else [],
        })
    return {"agents": out}


@app.post("/api/agent/chat")
def agent_chat(body: AgentChatRequest, request: Request):
    """One turn with the assistant, streamed back a line of JSON at a time.

    Streaming is the point: a turn takes seconds, and a panel that sits blank
    that whole time reads as broken. Each line is one of our five events.
    """
    meta = AGENTS.get(body.agent)
    if meta is None:
        raise HTTPException(status_code=422, detail="Unknown assistant: %s" % body.agent)
    if body.agent != "claude":
        raise HTTPException(status_code=501,
                            detail="%s is not wired up yet." % meta["name"])

    binary = agent_base.find_cli(meta["binary"])
    if not binary:
        raise HTTPException(status_code=503,
                            detail="%s is not installed." % meta["name"])

    api_url = str(request.base_url).rstrip("/")
    mcp_config = agent_base.write_mcp_config(AGENT_DIR, api_url)
    work_dir = os.path.dirname(mcp_config)
    args = claude_agent.command(_with_job(body.message, body.job_id),
                                mcp_config, body.resume, body.model)

    def stream():
        for event in agent_base.run(binary, args, claude_agent.translate,
                                    cwd=work_dir):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
