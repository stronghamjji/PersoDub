"""Dubbing jobs: the list, one job's progress, starting one, running it again,
remaking its voices, cancelling it, and deleting its folder.

One module because they are one ritual. Every route here ends in `launch_job`
-- make the record, write job.json, hand the work to the store -- and its three
callers (start, retry, redub) share the preflights before it: the free-space
floor, the engine resolution the job is stamped with, and the missing-model
409 the screen turns into "Download N GB of AI models to dub?". The parts of
that ritual the erase and separate routers share -- launch_job, the floor, the
folder, the 409 -- are app/api/_launch.py's. The boot-time
re-arm at the bottom rebuilds that same work for a job that waited out a
restart, which is why it lives beside the routes it mirrors rather than in
app/main.py, where its target builder would drag run_dub, the trim and the
Perso path back with it.

Lifted out of app/main.py unchanged (2026-09-06). It reads nothing back off
main -- there is no `_main()` seam here, and after this move there is none
anywhere: WORKSPACE and the job store are app/state.py's, the two work-dir
helpers are app/api/_shared.py's, and the rest is imported from the module
that owns it.

What a job's work actually is -- the download, the trim, the pipeline call or
the Perso cloud call -- is app/dub_launch.py's, built from the job's record
alone, so all four doors here build it the same way. This file keeps what is
genuinely HTTP: the preflights, the folder, and the file copies.

Modules, not loose functions, for the ones the tests fake globally:
`engines_status` (a preflight the /api/engines route judges too),
`perso_client` (the cloud dub, the result downloads and the script routes all
build one), `dub_setup`/`model_store` (the same objects app/api/models.py
serves) and `launch_api` (missing_models and today, which the erase and
separate routers ask too). Patching an attribute on those module objects
reaches every importer, because there is only ever one module object. The
names only this file reads -- run_dub, fetch_source, _cut_video,
_run_cloud_dub, default_stt_engine -- are imported directly, and the tests
that fake them patch this module; app/dub_launch.py takes them as arguments
for exactly that reason.
"""
import json
import logging
import os
import re
import shutil
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app import dub_launch, engines_status, erase_launch, languages, media, room, runtime, separate_launch, state
from app import models as model_store
from app import setup as dub_setup
from app.api import _launch as launch_api
from app.api import downloads as downloads_api
from app.api._launch import check_space, goes_beside_the_line, job_dir, launch_job, require_perso_workspace
from app.api._shared import (
    check_ranges_fit,
    check_trim,
    cut_to_kept_parts,
    parse_ranges,
    script_work_dir,
    work_dir_of,
)
from app.config import QWEN_N_TAKES, default_stt_engine
from app.downloads import Download
from app.dub_script import EDITED_NAME, script_path
from app.i18n import t
from app.jobs import JobKind, JobStatus, kind_of
from app.pipeline import run_dub
from app.source_fetch import fetch as fetch_source
from app.text.naming import project_name, safe_name
from app.translate import translator_model

router = APIRouter()
logger = logging.getLogger("persodub.api.dub")

# Kept as module attributes on purpose: this file's call sites read these names
# off this module, and the tests monkeypatch them. The code itself lives in
# app/media.py and app/dub_launch.py.
_cut_video = media.cut_video
_cut_ranges = media.cut_ranges
_run_cloud_dub = dub_launch.run_cloud_dub


# ---------------------------------------------------------------------------
# The language a job is dubbed into
# ---------------------------------------------------------------------------

# A language code, not a path fragment: letters, then optionally a region after
# a hyphen or underscore ("ko", "zh-CN", "pt_BR", "es-419"). Nothing else gets
# in, because job_dir (app/api/_launch.py) pastes this straight into the job's
# folder name.
_LANGUAGE_CODE = re.compile(r"^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})?$")


def _valid_language_code(code: str, dub_mode: str = "local") -> bool:
    """A code the chosen path knows: local = config.LANGUAGE_NAMES (region
    variant allowed: "pt-BR" is still Portuguese), perso = Perso's own list
    (app/languages.py; "hi", "en-GB" yes there, not locally). The shape alone
    let "xx" start a job that only failed at translation (2026-09-08)."""
    if not _LANGUAGE_CODE.match(code or ""):
        return False
    return languages.lookup(dub_mode, code) is not None


# ---------------------------------------------------------------------------
# Which engines a job is made with, and which models that still needs
# ---------------------------------------------------------------------------

def _ollama_unavailable_message(engine_name: str, status: str) -> str:
    """422 detail for a gemma/qwen preflight failure -- distinguishes an
    unreachable Ollama server from one that's reachable but just hasn't
    pulled the model yet, so a busy-but-valid Ollama isn't misreported as
    "not running" (see engines_status.ollama_model_status)."""
    if status == "unreachable":
        if model_store.kit_dir():
            # The app starts it, and says so when that start failed or is not over.
            told = engines_status.local_engine("translation")
            if told["state"] in ("starting", "failed"):
                return told["message"]
            # A desktop user cannot "make sure Ollama is running": the app owns it.
            return t(
                "Local {engine} translation is not available right now: the "
                "translation runtime is not running. Quit and reopen PersoDub, or "
                "choose Gemini in the Translation dropdown.", engine=engine_name)
        return t(
            "Local {engine} translation is not available on this machine "
            "(Ollama is not running or not reachable). Choose Gemini in the "
            "Translation dropdown, or make sure Ollama is running.", engine=engine_name)
    # Only Qwen gets here, and it is no row in Settings > Models: a model the
    # app downloads is the download dialog instead (_ollama_preflight).
    return t("The {engine} translation model is not downloaded yet. Choose another translator.",
             engine=engine_name)


def _engines_used(stt_engine=None, translate_engine=None, n_takes=None, sep_engine=None,
                  tts_engine=None) -> dict:
    """The engine choices this job is really being made with, resolved now.

    The form may leave any of them out, in which case the app's own setting
    decides -- so what is saved on the job is the answer, never the blank. That
    is what lets the finished screen say "Whisper, Gemma, 4 takes" months later,
    and what "Try again" repeats instead of whatever the defaults are that day.
    "whisper" covers both ways of asking for the free local engine (an explicit
    "local" and no choice at all); the voice is qwen3 (this computer).
    """
    resolved_stt = (stt_engine or default_stt_engine() or "").lower()
    resolved_sep = (sep_engine or dub_setup.default_for("separation")).lower()
    translator = (translate_engine or dub_setup.default_for("translator")).lower() or None
    return {
        "stt_engine": "perso" if resolved_stt == "perso" else "whisper",
        "translator": translator,
        "translator_model": translator_model(translator),
        "tts": tts_engine or dub_setup.default_for("voice"),
        "quality": n_takes if n_takes is not None else (dub_setup.default_n_takes() or QWEN_N_TAKES),
        "separation": resolved_sep if resolved_sep in ("perso", "roformer") else "demucs",
    }


def _inherited_engines(job, keys):
    """The same engines the first run was given, not today's defaults: a Perso
    job that failed used to come back transcribed by local Whisper (or the
    other way round), with nothing on screen to say the choice had changed.
    A job saved before these were kept has none of them, so that one still
    falls back to what the app is set to now.

    `keys` is the caller's business: a redub makes voices only, so the first
    run's separation choice is none of its concern and it does not carry it.

    Takes the job dict and the engine keys to read from it. Returns a dict
    with one entry per key in `keys`, holding whatever the job recorded for
    it (None where it recorded nothing) -- unless the job has no stt_engine
    at all (saved before these fields existed), in which case it returns
    today's engine defaults instead, for every engine, not just `keys`.
    """
    engines = {k: job.get(k) for k in keys}
    if not engines.get("stt_engine"):
        engines = _engines_used()
    return engines


def _translate_model_missing_on_disk(translator):
    """The catalog id a local translator needs when its runtime is not there
    to ask: read the model's markers straight off the disk instead."""
    info = engines_status.TRANSLATORS.get(translator)
    entry = model_store.find(info.catalog_id) if info is not None and info.catalog_id else None
    if entry is None:
        return None
    return info.catalog_id if model_store.model_state(entry, model_store.kit_dir()) != "ready" else None


def _voice_engine_answers(url: str) -> bool:
    """Whether the announced voice engine is actually up: a process that died
    after announcing itself left the address behind (Windows, 2026-09-07), and
    the dub then failed minutes in at the voice stage instead of here."""
    try:
        return httpx.get(f"{url}/health", timeout=2).status_code == 200
    except Exception:
        return False


def _require_voice_engine_running() -> None:
    """The engine pack is on disk, so the preflight let a local dub through --
    but its process is not announced (its start failed) or not answering (it
    died). Without this the voice stage fails with a raw library error; with
    it the page asks the desktop app to start the engine again."""
    if not model_store.kit_dir():
        return
    url = runtime.url("tts")
    if not url or not _voice_engine_answers(url):
        # Still starting, or given up on at start: said as the page says it.
        # "voice engine is not running" stays in English: the page asks the
        # desktop app to start the engine when it reads it (ui/src/app.mjs).
        told = engines_status.local_engine("voice")["message"]
        raise HTTPException(422, told or "The voice engine is not running. Quit and reopen PersoDub.")


def _pack_ready(pack_id: str) -> bool:
    """Whether a pack (the engines venv, the Ollama runtime) is on this kit.
    Without a kit (a dev run of the backend alone) packs are not a thing:
    whatever engines the developer runs by hand are simply there."""
    kit = model_store.kit_dir()
    if not kit:
        return True
    entry = model_store.find(pack_id)
    return bool(entry) and model_store.model_state(entry, kit) == "ready"


def _translator_preflight(translator: str, has_script: bool = False):
    """The translator's own checks before a dub starts (or resumes) with it:
    422 when it cannot run here now -- Ollama unreachable, no Gemini key, no
    ChatGPT sign-in -- and none of them when a ready-made script means nothing
    is translated. Returns (need_ollama, the catalog id of a local model still
    to download or None) for the 409 the caller builds with missing_models
    (app/api/_launch.py).

    What each translator needs is app/engines_status.py's TRANSLATORS; a name
    it does not know ("vertex", or "" for a Perso dub) is checked by nothing.
    """
    info = engines_status.TRANSLATORS.get(translator)
    # A ready-made script is dubbed as it is (app/pipeline.py _stage_translate)
    # and its lines are never fitted again, so no translator is asked anything:
    # a missing key or model refused a dub that would never have used it.
    if info is None or has_script:
        return False, None
    if info.kind == "ollama":
        return _ollama_preflight(info)
    if not info.probe():
        raise HTTPException(422, info.unavailable())
    return False, None


def _ollama_preflight(info):
    """_translator_preflight for a model on the local Ollama server."""
    need_ollama = info.needs_ollama_pack
    if need_ollama and not _pack_ready("ollama-runtime"):
        # No runtime pack, nothing to probe: the reachability check below would
        # answer 422 "not running", which no dialog can fix. The 409 further
        # down names the pack (and the model, if it is not on disk either).
        return need_ollama, _translate_model_missing_on_disk(info.name)
    status = info.probe()
    # A model the app downloads is the 409 dialog when it is missing; one the
    # app does not download (Qwen) can only be refused until it is pulled.
    if status == "unreachable" or (status != "available" and not info.catalog_id):
        raise HTTPException(422, _ollama_unavailable_message(info.label, status))
    # Same rule "Try again" applies, asked with the status already in hand
    # so a start still probes Ollama exactly once.
    return need_ollama, dub_launch.translate_model_missing(info.name, status)


def require_translator(translator: str) -> None:
    """A translator about to translate a project whose separation and
    transcript are on disk (Resume with another one, Translate again):
    checked the way a start checks it -- the 422s, and the 409 download
    dialog for a local model or runtime not here yet."""
    need_ollama, translate_missing_id = _translator_preflight(translator)
    missing = launch_api.missing_models(False, translate_missing_id, need_tts=False, need_ollama=need_ollama)
    if missing:
        launch_api.raise_models_needed(missing)


# The engines a dub run again (Start over, Resume) keeps from its first run.
_RERUN_ENGINES = ("stt_engine", "translator", "tts", "quality", "separation")


def _require_local_models(engines: dict, translator) -> None:
    """A local dub about to run again: the 409 download dialog for a model or
    pack it needs and does not have, then the voice engine. `translator` is
    None when nothing is to be translated (a script was given, or the
    translation is done)."""
    info = engines_status.TRANSLATORS.get(translator)
    need_ollama = info is not None and info.needs_ollama_pack
    if need_ollama and not _pack_ready("ollama-runtime"):
        # Nothing to probe without the runtime: the model is missing from disk
        # or it is not, and either way the pack comes first.
        translate_missing_id = _translate_model_missing_on_disk(translator)
    else:
        translate_missing_id = dub_launch.translate_model_missing(translator)
    missing = launch_api.missing_models(engines.get("stt_engine") != "perso", translate_missing_id,
                                        need_engine=True, need_ollama=need_ollama,
                                        separation_local=engines.get("separation") != "perso",
                                        need_roformer=engines.get("separation") == "roformer")
    if missing:
        launch_api.raise_models_needed(missing)
    _require_voice_engine_running()


def _same_project(job) -> dict:
    """A dubbing made again from one that joined a project (Add language)
    stays in that project. One that never joined one stays on its own."""
    return {"project_id": job["project_id"]} if job.get("project_id") else {}


def _not_a_dubbing(job, what: str) -> HTTPException:
    """The refusal for a job that is not a dubbing: what it did instead, and
    `what` ("do again", "resume" or "run again") there is no dubbing to do.
    One whole sentence for each, so every language can say it its own way."""
    kind = kind_of(job)
    if kind == JobKind.ERASE:
        said = {"do again": t("This project erased subtitles, so there is no dubbing to do again."),
                "resume": t("This project erased subtitles, so there is no dubbing to resume."),
                "run again": t("This project erased subtitles, so there is no dubbing to run again.")}
    elif kind == JobKind.SEPARATE:
        said = {"do again": t("This project separated audio, so there is no dubbing to do again."),
                "resume": t("This project separated audio, so there is no dubbing to resume."),
                "run again": t("This project separated audio, so there is no dubbing to run again.")}
    else:
        said = {"do again": t("This project is not a dubbing, so there is no dubbing to do again."),
                "resume": t("This project is not a dubbing, so there is no dubbing to resume."),
                "run again": t("This project is not a dubbing, so there is no dubbing to run again.")}
    return HTTPException(409, said[what])


# ---------------------------------------------------------------------------
# The tail of every start
# ---------------------------------------------------------------------------

def _work_for(job, jid, *, voices_only=False, resume=False):
    """This job's work (app/dub_launch.py), wired to this module's seams.

    run_dub, the download, the trim and the cloud path are read off THIS module
    every time, because that is where the tests replace them; handing them over
    rather than letting dub_launch import them is what keeps those fakes
    working. The record is given the id the store just made, which is what the
    cancel button and the notice popups are addressed to.
    """
    return dub_launch.work_for(
        {**job, "id": jid},
        cancel_check=lambda: state.job_store.is_cancel_requested(jid),
        on_notice=lambda n: state.job_store.append_notice(jid, n),
        voices_only=voices_only,
        resume=resume,
        run_dub=run_dub,
        run_cloud_dub=_run_cloud_dub,
        fetch_source=fetch_source,
        cut_video=_cut_video,
        cut_ranges=_cut_ranges,
    )


# ---------------------------------------------------------------------------
# The routes
# ---------------------------------------------------------------------------

@router.get("/api/dub/jobs")
def dub_jobs():
    """Every job this app knows about, newest first -- the Projects sidebar.

    No logs: a row needs a name, a language and a status dot, and the logs of a
    few dozen jobs would be megabytes of JSON for a list nobody reads them in.
    """
    return {"jobs": state.job_store.all()}


@router.get("/api/dub/jobs/{jid}")
def dub_job(jid: str):
    """Query the progress of a dubbing job."""
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    return j


class TitleRequest(BaseModel):
    title: str = ""


# How long a shown name may be. The same 80 the folder name is cut to, so the
# two never disagree about what "too long" means.
MAX_TITLE = 80


@router.post("/api/dub/jobs/{jid}/title")
def dub_job_title(jid: str, body: TitleRequest):
    """Rename what a project is shown as, without touching its folder.

    A link brings its own title -- long enough to fill the top bar and to be
    cut off in the Projects list -- and a file brings whatever it was called.
    The folder keeps the name it was made with, because the files inside it
    are already written there; only the shown name changes, and an empty one
    puts the folder's name back (user, 2026-09-10).
    """
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    title = (body.title or "").strip()[:MAX_TITLE].strip()
    state.job_store.update(jid, title=title)
    work = j.get("work_dir")
    if work:
        state.job_store.persist(jid, work)
    return {"title": title}


@router.post("/api/dub/jobs/{jid}/redub")
def dub_job_redub(jid: str):
    """Make the voices again from this job's script, as it now stands.

    Transcription and translation are skipped: the script is handed in whole, the
    way a user-supplied subtitle file is (run_dub's srt_path). The old job is left
    untouched in its own folder so a rewrite that turns out worse can be compared
    against what came before.
    """
    job, work_dir = script_work_dir(jid)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(status_code=409, detail=t("This project's video is no longer on disk."))

    language_code = job.get("language_code") or "en"
    project = job.get("project") or os.path.basename(work_dir)
    check_space(state.WORKSPACE)
    script = script_path(work_dir)
    if not os.path.exists(script):
        # A job that finished without a script (a cloud dub, a folder carried
        # over from an old install) has nothing to re-voice from.
        raise HTTPException(409, t("No script was recorded for this project, so its voices cannot be made again."))
    work = job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    shutil.copyfile(source_video, video_path)
    # "sub.srt" because that is the name a ready-made script has in a job's
    # folder, whichever door put it there -- the work builder looks for it.
    shutil.copyfile(script, os.path.join(work, "sub.srt"))

    engines = _inherited_engines(job, ("stt_engine", "translator", "translator_model", "tts", "quality"))

    # Only the voices are made again -- no STT, no translation -- but a voice
    # model (or the engine pack) removed since must resurface as the dialog,
    # not a crash.
    missing = launch_api.missing_models(False, None,
                              need_engine=job.get("dub_mode") != "perso",
                              separation_local=False)
    if missing:
        launch_api.raise_models_needed(missing)
    if job.get("dub_mode") != "perso":
        _require_voice_engine_running()

    fields = {"language_code": language_code, "project": project,
              "day": launch_api.today(), "from_link": False, "work_dir": work, "voices_only": True,
              # Made on this computer, whatever the first run was: only a whole
              # dub goes to the cloud (dub_launch.work_for). Unsaid, the record
              # read null (Windows test H19, 2026-10-10).
              "dub_mode": "local",
              # The remake is the same video in the same two languages,
              # in the same project.
              "source_lang": job.get("source_lang"),
              **_same_project(job),
              # ...and made with the same engines, so its finished
              # screen says what the job it came from said.
              **engines}

    def _target(new_jid, log):
        # voices_only: the record above keeps the first run's transcription and
        # translation choices because the finished screen shows them, but this
        # run must not replay them -- the script is handed straight back in.
        # `language` is passed alongside because the record does not keep one,
        # and a job saved before the name was kept has only its code to give.
        return _work_for({**fields, "language": job.get("language") or language_code},
                         new_jid, voices_only=True)(log)

    edited = os.path.exists(os.path.join(work_dir, EDITED_NAME))
    new_jid = launch_job(
        work,
        fields,
        "%s (%s)" % (project, "voices remade from the edited script" if edited
                     else "from the script as it was"),
        _target,
    )
    # Stamped on the OLD job so the screen showing it can follow along when the
    # assistant, not the user, is the one who pressed go.
    state.job_store.update(jid, remade_as=new_jid)
    return {"job_id": new_jid}


# A job's id is eight hex digits (app/jobs.py create). A project_id naming
# anything else names no job of ours.
_JOB_ID = re.compile(r"^[0-9a-f]{8}$")


@router.post("/api/dub/jobs/{jid}/again")
def dub_job_again(jid: str):
    """Hold this dub's video again for a new draft: Add language opens one
    on it with the parts this dub kept, to dub it into another language
    (mockup edit-flow, user 2026-09-30; script-buttons, 2026-10-01). Nothing is started and
    the job itself is not touched.

    The original the dub was cut from comes back when the app still holds it
    (in memory, or on disk after a restart), with the kept parts, so they can
    be cut again. Otherwise the job's own copy of its video comes back whole:
    it is the kept parts already joined. A link is never fetched again.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    # A video with the user's own subtitles is dubbed from its Dubbing tab.
    if kind_of(job) not in (JobKind.DUB, JobKind.CAPTIONS):
        raise _not_a_dubbing(job, "do again")
    title = job.get("title") or job.get("project") or "video"
    original = downloads_api.reopen_original(job, title)
    if original is not None:
        return original

    source = os.path.join(work_dir_of(job), "input.mp4")
    # A link the job fetches for itself may still be coming down into input.mp4.
    if job.get("from_link") and job.get("status") in (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(409, t("Try again once this dubbing has fetched its video."))
    if not os.path.exists(source):
        raise HTTPException(409, t("This dubbing's video is no longer on disk."))
    # Cut already (the usual case): the copy is the kept parts, joined. A link
    # job that stopped before its cut still holds the whole video.
    pending = job.get("trim_pending") or job.get("ranges_pending")
    held = downloads_api.download_store.add_file(
        state.WORKSPACE, title, downloads_api.seconds_of(source), lambda dest: shutil.copyfile(source, dest))
    return {"download_id": held.id, "title": held.title, "duration_sec": held.duration_sec,
            "ranges": separate_launch.parts_of(job) if pending else None}


# A stopped job that can pick up where it left off: failed, cancelled, or cut
# off by the app closing ("interrupted" is an error with that word).
RESUMABLE = (JobStatus.ERROR, JobStatus.CANCELLED)

class ResumeRequest(BaseModel):
    # Another translator to carry on with: ChatGPT's limit or sign-in stopped
    # the dubbing at translation and the user picked one (owner, 2026-10-03).
    translator: Optional[str] = None


@router.post("/api/dub/jobs/{jid}/resume")
def dub_job_resume(jid: str, body: Optional[ResumeRequest] = None):
    """Carry on a stopped dub in its own folder, from the first stage that left
    no result behind (app/pipeline.py run_dub resume=True). Separation, the
    transcript, the translation and every finished voice line are kept, so a
    Perso stage is never paid for twice (user, 2026-09-23). Same job, same
    folder, same settings; a cloud (Perso) dub has nothing local to resume
    and is sent to Try again instead.

    `translator`, when sent, replaces the one translation stopped on: checked
    the way a start checks it (the 409 download dialog, the 422s), recorded on
    the job, and the translation is made by it -- the stage left no
    translated.srt behind, so the resumed run translates again."""
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("status") not in RESUMABLE:
        raise HTTPException(status_code=409, detail=t("Only a stopped project can be resumed."))
    if kind_of(job) != JobKind.DUB:
        raise _not_a_dubbing(job, "resume")
    if job.get("dub_mode") == "perso":
        raise HTTPException(409, t("Perso API dubbing cannot be resumed here. Use Start over."))
    work_dir = work_dir_of(job)
    if not os.path.exists(os.path.join(work_dir, "input.mp4")):
        raise HTTPException(status_code=409, detail=t("This project's video is no longer on disk."))
    translator = ((body and body.translator) or "").strip().lower() or None
    if translator:
        if translator not in dub_setup.STAGES["translator"][1] or translator == job.get("translator"):
            raise HTTPException(422, t("Cannot resume with translator: {translator}", translator=translator))
        # A finished translation would be reused, and the record would then
        # name a translator that never translated it.
        if job.get("voices_only") or os.path.exists(os.path.join(work_dir, "translated.srt")):
            raise HTTPException(409, t("This project's translation is done. Use Start over to translate again."))
        require_translator(translator)
    # The models are asked for the way Start over asks: one removed since the
    # dub stopped was resumed without, and the stage that needed it failed
    # telling the user to check the video (Windows test C16, 2026-10-10). A
    # translator handed in was checked just above, and a finished translation
    # or a given script needs none.
    translated = job.get("voices_only") or any(
        os.path.exists(os.path.join(work_dir, name)) for name in ("translated.srt", "sub.srt"))
    engines = _inherited_engines(job, _RERUN_ENGINES)
    _require_local_models(engines, None if translator or translated else engines.get("translator"))
    check_space(state.WORKSPACE)
    # Another translator takes over with its own model, which the screen names.
    switched = {"translator": translator, "translator_model": translator_model(translator)} if translator else {}
    if not state.job_store.claim(jid, RESUMABLE, status=JobStatus.QUEUED, error=None, error_shown=None,
                                 error_detail=None, cancel_requested=False, notices=[], **switched):
        raise HTTPException(status_code=409, detail=t("This project is already running again."))
    state.job_store.append_log(jid, "Resuming from where it stopped…")
    if translator:
        was = engines_status.TRANSLATOR_NAMES.get(job.get("translator"))
        state.job_store.append_log(jid, "Translating with %s%s." % (
            engines_status.TRANSLATOR_NAMES[translator], " instead of %s" % was if was else ""))
    record = {**job, "work_dir": work_dir, **switched}
    state.job_store.start(jid, lambda log: _work_for(
        record, jid, resume=True, voices_only=bool(job.get("voices_only")))(log))
    return {"job_id": jid}


@router.post("/api/dub/jobs/{jid}/retry")
def dub_job_retry(jid: str):
    """Run this job again from the top -- transcribe, translate, voices, all of it.

    "Try again" on a failed job used to mean downloading the original and
    uploading it back, which for a link job meant fetching the whole video a
    second time. The copy in the job's folder is right there, so the new job
    starts from it with the settings the old one was given.

    Not a redub: that one hands the finished script back in and only makes the
    voices again (above). A job that failed may never have had a script at all.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(status_code=409, detail=t("This project is still running."))
    if kind_of(job) != JobKind.DUB:
        # Both kinds share this list, so this button can be pressed on an
        # erase -- which would quietly start dubbing a video nobody asked to
        # have dubbed, in whatever language the blank record defaults to.
        raise _not_a_dubbing(job, "run again")
    # work_dir, not the result folder: a job that failed before it produced
    # anything is exactly the one this endpoint exists for.
    work_dir = work_dir_of(job)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(status_code=409, detail=t("This project's video is no longer on disk."))

    language_code = job.get("language_code") or "en"
    # run_dub wants the language's name. A job saved before that name was kept
    # in job.json has only its code, so work the name back out of it -- handing
    # run_dub "ko" would put "ko" in the translation prompt and in what the
    # voice sidecar is told to speak.
    language = job.get("language") or dub_launch.language_name(language_code)
    project = job.get("project") or os.path.basename(work_dir)
    check_space(state.WORKSPACE)

    # A cloud dub is made wholly on Perso's side: its record names no local
    # engines (_start_record), so none are repeated and no local model is
    # needed. Inheriting them took today's local defaults instead: their
    # models were asked for, and their names stamped on the cloud record.
    # Checked before the new folder is made: a refusal used to leave it
    # behind, holding a whole copy of the video that nothing would clear.
    engines = {}
    if job.get("dub_mode") != "perso":
        engines = _inherited_engines(job, _RERUN_ENGINES)
        # Translated again today, so with today's model of that translator.
        engines["translator_model"] = translator_model(engines.get("translator"))
        # A script the first run was given is copied in below and dubbed as it
        # is, so no translator is asked for its model or runtime -- the same
        # rule as a start (_translator_preflight).
        translator = None if os.path.exists(os.path.join(work_dir, "sub.srt")) else engines.get("translator")
        _require_local_models(engines, translator)

    work = job_dir(project, language_code)
    video_path = os.path.join(work, "input.mp4")
    shutil.copyfile(source_video, video_path)
    # The subtitles the first run was given, if it was given any. Without this
    # a job started from a subtitle file came back transcribed by Whisper --
    # a different script, with nothing on screen to say the source had changed.
    for name in ("sub.srt", "source.srt"):
        if os.path.exists(os.path.join(work_dir, name)):
            shutil.copyfile(os.path.join(work_dir, name), os.path.join(work, name))

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
            # come back to clear it. job_dir always makes a fresh one.
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))

    # The same rule for parts joined on the timeline.
    kept = job.get("ranges")
    if kept and job.get("ranges_pending"):
        try:
            _cut_ranges(video_path, kept)
        except RuntimeError as e:
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))

    fields = {"language_code": language_code, "project": project,
              "day": launch_api.today(), "work_dir": work,
              "language": language,
              # Cut just now, or copied from a video already cut: either
              # way this job owes no cut.
              "trim": trim, "trim_pending": False,
              **({"ranges": kept, "ranges_pending": False} if kept else {}),
              "source_lang": job.get("source_lang"),
              **_same_project(job),
              # The video is a local copy now, whatever the first job was
              # started from -- there is no link to download again.
              "from_link": False,
              # Where the first run was made. A cloud dub that failed must come
              # back through the cloud, not quietly switch to local engines --
              # and the record has to say so itself, because a retry that waits
              # out a restart in the queue is rebuilt from nothing but job.json
              # (rearm_queued_jobs). Jobs saved before dub_mode existed carry
              # none, and are left that way.
              **({"dub_mode": job["dub_mode"]} if job.get("dub_mode") else {}),
              # ...and with the Perso voice model it was made with.
              **({"perso_model": job["perso_model"]} if job.get("perso_model") else {}),
              **engines}

    def _target(new_jid, log):
        return _work_for(fields, new_jid)(log)

    new_jid = launch_job(
        work,
        fields,
        "%s (run again)" % project,
        _target,
        parallel=(job.get("dub_mode") == "perso"),
    )
    return {"job_id": new_jid, "status": state.job_store.get(new_jid)["status"]}


@router.post("/api/dub/jobs/{jid}/cancel")
def dub_job_cancel(jid: str):
    """Cancel a running dubbing job.

    Cooperative cancellation: run_dub polls for this request at stage
    boundaries (see app/pipeline.py's cancel_check checkpoints) rather than
    being killed mid-stage, so the job's status goes running -> cancelling ->
    cancelled, not straight to cancelled. 404 for an unknown job id, 409 if
    the job already finished (done/error) or was already cancelled -- there
    is nothing left to interrupt.
    """
    was_queued = (state.job_store.get(jid) or {}).get("status") == JobStatus.QUEUED
    status = state.job_store.request_cancel(jid)
    if status is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    # A queued job comes back "cancelled" from the call that cancelled it --
    # that is this request doing its work, not a job with nothing left to stop.
    if status in (JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELLED) and not was_queued:
        raise HTTPException(status_code=409, detail=t("Job already {status}, nothing to cancel", status=status))
    return {"job_id": jid, "status": status}


@router.delete("/api/dub/jobs/{jid}/workspace")
def dub_job_delete_workspace(jid: str):
    """Delete a job's whole folder. Irreversible, so the screen asks first.

    Automatic cleanup (app/pipeline.py's cleanup_intermediates) only drops the
    audio a finished job no longer needs; deleting the results themselves is
    always the user's own call.
    """
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    # "cancelling" counts as running: the thread only stops at the next stage
    # boundary, and until it does it is still writing into this folder.
    if j["status"] in (JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(status_code=409, detail=t("Job is still running"))
    # work_dir is stamped the moment the folder is made, so a job that failed
    # before it produced anything can be cleared out too -- Projects lists
    # those now, and a row nothing can remove is a row that never goes away.
    out = work_dir_of(j)
    if not out:
        raise HTTPException(status_code=404, detail=t("Nothing to delete"))
    work = os.path.abspath(out)
    root = os.path.abspath(state.WORKSPACE)
    # A job record is the only thing naming this path; refuse anything that
    # somehow points outside the workspace rather than trusting it.
    if os.path.commonpath([work, root]) != root or work == root:
        raise HTTPException(status_code=400, detail=t("Refusing to delete outside the workspace"))
    shutil.rmtree(work, ignore_errors=True)
    # The folder is gone, so its job.json is gone -- but the in-memory record
    # would still put the job in the list until the next restart.
    state.job_store.forget(jid)
    return {"job_id": jid, "deleted": True}


# ---------------------------------------------------------------------------
# A new dub's start, step by step: dub_start below runs these in order
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _StartPlan:
    """One POST /api/dub/start, read once: every blank filled with the saved
    default, every choice checked, the one video and the parts of it kept
    settled. The steps after the first only read it.

    On a Perso cloud dub the four per-stage engines are None: the cloud does
    every stage, so their checks (and the local-model 409) do not apply.
    """
    video: Optional[UploadFile]      # the upload as sent; has_upload says whether it counts
    held: Optional[Download]         # a video the New project screen holds (app/api/downloads.py)
    source_url: Optional[str]        # a link, or the held video's own address
    trim_start: Optional[float]
    trim_end: Optional[float]
    kept: Optional[list]             # several kept parts; a single one is the trim above
    project: Optional[str]           # the title the caller passed, if any (see title)
    project_id: Optional[str]
    language: str
    language_code: str
    source_language_code: Optional[str]
    num_speakers: Optional[int]
    dub_mode: str                    # "local" or "perso"
    stt_engine: Optional[str]
    sep_engine: Optional[str]
    translate_engine: Optional[str]  # trimmed and lowercased: None means the saved default
    tts_engine: Optional[str]
    n_takes: Optional[int]
    perso_model: Optional[str]
    stems_from: Optional[str]

    @property
    def has_upload(self) -> bool:
        return self.video is not None and bool(self.video.filename)

    @property
    def title(self) -> str:
        """What names the job's folder. The caller may pass a title it already
        knows (the screen probes a link before starting, and
        app/source_fetch.py's fetch() returns nothing, so the server never
        learns it otherwise). Without one, fall back to the uploaded filename
        or the URL; "" leaves job_dir to pick a random name."""
        return project_name(self.project or "") or safe_name(
            self.held.title if self.held else
            os.path.splitext(self.video.filename or "")[0] if self.has_upload else (self.source_url or "")
        )


def _start_plan(*, video, source_url, download_id, language, language_code, num_speakers,
                translate_engine, stt_engine, sep_engine, dub_mode, n_takes,
                source_language_code, project, trim_start, trim_end, ranges, tts_engine,
                stems_from, project_id, perso_model) -> _StartPlan:
    """dub_start's form, read and checked in the order its refusals have
    always come in: the project it joins, the parts kept, the one source,
    the engines, then the language. Nothing is saved yet."""
    project_id = (project_id or "").strip() or None
    if project_id and not _JOB_ID.match(project_id):
        raise HTTPException(422, t("Unknown project_id."))
    trim_start, trim_end, kept = _parts_to_keep(ranges, trim_start, trim_end)
    source_url, held = _one_source(video, source_url, download_id)
    # Normalized, like every engine here: without this, "Perso"
    # (capital P) skipped both the preflight and the Perso branch and silently
    # ran the free local engine -- the exact downgrade the no-fallback rule
    # forbids. Resolved here, once, so the preflights judge the engine that
    # will actually run -- a saved STT_ENGINE=perso must meet the key check too.
    stt_engine = (stt_engine or "").strip().lower() or (default_stt_engine() or "").lower() or None
    if stt_engine not in (None, "local", "perso"):
        raise HTTPException(422, t("Unknown stt_engine: {name}", name=stt_engine))
    # Same normalization for the same reason: "Perso" with a capital P must not
    # silently skip the preflight and run the free local engine instead.
    # Blanks take the app's saved defaults (app/setup.py): what the Settings
    # screen or the Dub Agent's set_default chose, in force without a restart.
    sep_engine = (sep_engine or "").strip().lower() or dub_setup.default_for("separation")
    if sep_engine not in ("local", "demucs", "roformer", "perso"):
        raise HTTPException(422, t("Unknown sep_engine: {name}", name=sep_engine))
    dub_mode = (dub_mode or "").strip().lower() or dub_setup.default_for("dub_mode")
    if dub_mode not in ("local", "perso"):
        raise HTTPException(422, t("Unknown dub_mode: {name}", name=dub_mode))
    if n_takes is None:
        n_takes = dub_setup.default_n_takes()  # None when no quality was ever saved
    tts_engine = (tts_engine or "").strip().lower() or dub_setup.default_for("voice")
    if tts_engine not in dub_setup.STAGES["voice"][1]:
        raise HTTPException(422, t("Unknown tts_engine: {name}", name=tts_engine))
    # The translator is left unresolved and unchecked (a name with no checks,
    # "vertex", starts as it always has), but trimmed: "gemini " passed the
    # Gemini key check by and was translated by the default local model.
    translate_engine = (translate_engine or "").strip().lower() or None
    if dub_mode == "perso":
        # The cloud does everything -- the per-stage engine choices (and their
        # preflights, including the local-model 409) do not apply.
        stt_engine = sep_engine = translate_engine = tts_engine = None
    if not _valid_language_code(language_code, dub_mode):
        raise HTTPException(422, t("Unknown language_code: {code}", code=language_code))
    if dub_mode == "perso":
        try:
            perso_model = languages.model_for(languages.lookup("perso", language_code), perso_model)
        except ValueError as e:
            raise HTTPException(422, str(e))
    return _StartPlan(
        video=video, held=held, source_url=source_url, trim_start=trim_start, trim_end=trim_end,
        kept=kept, project=project, project_id=project_id,
        language=language, language_code=language_code, source_language_code=source_language_code,
        num_speakers=num_speakers, dub_mode=dub_mode, stt_engine=stt_engine, sep_engine=sep_engine,
        translate_engine=translate_engine, tts_engine=tts_engine, n_takes=n_takes,
        perso_model=perso_model, stems_from=stems_from)


def _parts_to_keep(ranges, trim_start, trim_end):
    """The parts of the video a start keeps, checked: (trim_start, trim_end,
    kept). One kept part is exactly a trim, so it comes back as one."""
    kept = parse_ranges(ranges)
    if kept is not None and trim_start is not None:
        raise HTTPException(400, t("Send either the kept parts or a trim, not both."))
    if kept is not None and len(kept) == 1:
        (trim_start, trim_end), kept = kept[0], None
    check_trim(trim_start, trim_end)
    return trim_start, trim_end, kept


def _one_source(video, source_url, download_id):
    """The one video a start dubs: (source_url, held). held is a video the
    New project screen already holds; a link it came from stays the source_url."""
    # Exactly one source. Accepting both would silently pick a winner, and the
    # user would watch the wrong video get dubbed.
    source_url = (source_url or "").strip() or None
    download_id = (download_id or "").strip() or None
    has_upload = video is not None and bool(video.filename)
    held = None
    if download_id:
        held = downloads_api.download_store.get(download_id)
        if held is None or held.status != "ready" or not os.path.exists(held.path):
            raise HTTPException(404, t("That video is not downloaded yet."))
        # A held link keeps its address for the record, but the file is here
        # already: the work builder fetches only when input.mp4 is missing.
        source_url = source_url or (held.url or None)
    if (has_upload + bool(source_url and not held) + bool(held)) != 1:
        raise HTTPException(422, t("Provide either a video file, a source_url or a download_id."))
    return source_url, held


def _start_preflight(plan: _StartPlan, has_script: bool) -> Optional[str]:
    """What this computer and the user's accounts must have before anything
    is saved: the memory, the translator, the keys, the Perso workspace, then
    the models (the 409 download dialog) and the voice engine. Returns the
    "may be slow" warning, or None."""
    # Memory is asked of a dub made on this computer only (app/room.py): a
    # cloud dub runs on Perso's side, so it is never refused or warned here.
    ram = None if plan.dub_mode == "perso" else room.total_ram_bytes()
    refusal = room.ram_refusal(ram)
    if refusal:
        raise HTTPException(422, refusal)
    effective_translate_engine = "" if plan.dub_mode == "perso" else (
        plan.translate_engine or dub_setup.default_for("translator")).lower()
    warning = room.ram_warning(ram, effective_translate_engine)
    need_ollama, translate_missing_id = _translator_preflight(effective_translate_engine,
                                                              has_script=has_script)
    if plan.stt_engine == "perso" and not engines_status.perso_available():
        raise HTTPException(
            422,
            t("Perso transcription needs an API key. Open Settings and save your Perso "
              "API key, or choose Local transcription."),
        )
    if plan.sep_engine == "perso" and not engines_status.perso_available():
        raise HTTPException(
            422,
            t("Perso separation needs an API key. Open Settings and save your Perso "
              "API key, or choose Local separation."),
        )
    if plan.dub_mode == "perso" and not engines_status.perso_available():
        raise HTTPException(
            422,
            t("Perso API dubbing needs an API key. Open Settings and save your "
              "Perso API key, or use this computer for dubbing."),
        )
    if plan.dub_mode == "perso" or "perso" in (plan.stt_engine, plan.sep_engine):
        require_perso_workspace()

    # The models this job still needs -- 409 with the dialog's exact payload
    # instead of dying minutes into the pipeline (permanent rule: the screen
    # asks, downloads, and resubmits; nothing here downloads silently).
    if plan.dub_mode != "perso":
        need_whisper = plan.stt_engine != "perso"  # resolved once, in _start_plan
        # The voice is always made locally in a local dub: the engine pack is
        # needed whatever the STT and separation choices (the checks after the
        # voices run in it too).
        missing = launch_api.missing_models(need_whisper, translate_missing_id,
                                  need_engine=True, need_ollama=need_ollama,
                                  separation_local=plan.sep_engine != "perso",
                                  need_roformer=plan.sep_engine == "roformer")
        if missing:
            launch_api.raise_models_needed(missing)
        _require_voice_engine_running()
    return warning


def _start_folder(plan: _StartPlan) -> str:
    """The job's folder, with the video in it when the video is here already:
    the free-space floor, the folder, the held or uploaded file copied in and
    cut, then the whole job judged by the room left. A link is fetched, and
    cut, inside the job. Returns the folder."""
    check_space(state.WORKSPACE)
    work = job_dir(plan.title, plan.language_code)
    video_path = os.path.join(work, "input.mp4")
    if plan.held:
        shutil.copyfile(plan.held.path, video_path)
    if plan.has_upload or plan.held:
        if plan.has_upload:
            with open(video_path, "wb") as f:
                shutil.copyfileobj(plan.video.file, f)
        # Cut before the job starts, so everything downstream (and the running
        # screen's original) only ever sees the part the user picked. A link
        # has nothing to cut yet -- that happens after the download, in the job.
        # job_dir always makes a fresh folder, so a failed cut may drop it.
        cut_to_kept_parts(work, video_path, plan.trim_start, plan.trim_end, plan.kept,
                          cut_video=_cut_video, cut_ranges=_cut_ranges, check_fit=check_ranges_fit)
        # The video is here now, so its size and length are known: judge the
        # whole job by them, not just the floor. A link is judged the same way
        # once it is downloaded, before the first stage (app/pipeline.py). A
        # cloud dub is not judged: its stems and per-line takes are made on
        # Perso's side, and the floor above already covers the dub it writes.
        if plan.dub_mode != "perso":
            try:
                seconds = media.video_duration(video_path)
            except Exception:
                seconds = None
            short = room.short_of_room(work, video_path, seconds, floor=room.FLOOR, shown=True)
            if short:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(507, short)
    return work


def _reuse_stems(plan: _StartPlan, work: str):
    """The voice and the background a Separate audio job already made of this
    very cut: copied in with the note a finished separation stage leaves, so
    the run picks them up the way Resume does and separates nothing.

    Returns (the two files copied in, or None; the separation the record
    names: the one that made them, when they were copied)."""
    reused = None
    if plan.dub_mode != "perso" and plan.held and plan.stems_from:
        parts = plan.kept or ([[plan.trim_start, plan.trim_end]] if plan.trim_start is not None else None)
        reused = separate_launch.stems_for(plan.stems_from, plan.held.id, parts)
    if not reused:
        return reused, plan.sep_engine
    separate_launch.copy_stems(reused, work)
    return reused, (state.job_store.get(plan.stems_from) or {}).get("separation") or plan.sep_engine


def _save_subtitles(work: str, srt, source_srt) -> None:
    """Named, not passed along: the work builder finds a job's subtitles by
    looking in its folder, which is what lets "Try again" and the boot
    re-arm find the same two files without being told about them."""
    if srt is not None and srt.filename:
        with open(os.path.join(work, "sub.srt"), "wb") as f:
            shutil.copyfileobj(srt.file, f)
    if source_srt is not None and source_srt.filename:
        with open(os.path.join(work, "source.srt"), "wb") as f:
            shutil.copyfileobj(source_srt.file, f)


def _start_record(plan: _StartPlan, work: str, separation: Optional[str]) -> dict:
    """The new job's record. `separation` is the engine it names for that
    stage: the one that made reused stems (_reuse_stems), else the plan's.

    The download filenames are built from this; the job record is the only
    place the result endpoints can read the user's choice back from.
    project/day/from_link are read back by the download endpoints and by the
    desktop shell, which builds the save folder from them. `day` is stamped
    here rather than recomputed later: a job started at 23:59 must not land in
    tomorrow's folder when it finishes.
    """
    return {
        "language_code": plan.language_code,
        "project": plan.title or os.path.basename(work),
        "day": launch_api.today(),
        # Where input.mp4 lives. Stamped here because the running
        # screen asks for the original while the job is still
        # going, when there is no result to find the folder from.
        "work_dir": work,
        # Kept so a later redub of this job can pass the same
        # language name back into run_dub.
        "language": plan.language,
        # The language the user said the video is in, or None for
        # auto-detect. Only auto-detect leaves a language behind in
        # the result (app/stt_local.py fires on_language solely when
        # nothing was forced), so without this the screen has no way
        # to name the source column of a job that was told.
        "source_lang": plan.source_language_code or None,
        # The seconds the user kept, or None for the whole video.
        "trim": ({"start": plan.trim_start, "end": plan.trim_end}
                 if plan.trim_start is not None else None),
        # An upload was cut further up, before this record existed.
        # A link still holds the whole video and is cut inside the
        # job, which clears this the moment it is.
        "trim_pending": bool(plan.source_url and not plan.held and plan.trim_start is not None),
        # The parts kept on the timeline, when there were several: the
        # finished screen says "Trimmed", and a link joins them only once it
        # is downloaded (inside the job, which clears ranges_pending).
        **({"ranges": plan.kept, "ranges_pending": bool(plan.source_url and not plan.held)}
           if plan.kept is not None else {}),
        "from_link": bool(plan.source_url),
        # The held video this dub was cut from, which Add language opens a new
        # draft on (dub_job_again) rather than the cut copy in its folder.
        **({"download_id": plan.held.id} if plan.held else {}),
        **({"project_id": plan.project_id} if plan.project_id else {}),
        # The link itself and the speaker count: what the boot
        # re-arm needs to rebuild this job's work should it wait
        # out an app restart in the queue.
        "source_url": plan.source_url,
        "num_speakers": plan.num_speakers,
        # What made this job: read back by the finished screen and
        # by "Try again", which repeats these rather than today's
        # defaults.
        # A cloud job records its mode, not local engine choices
        # its finished screen would then lie about.
        **({"dub_mode": "perso", "perso_model": plan.perso_model} if plan.dub_mode == "perso" else
           {"dub_mode": "local",
            **_engines_used(plan.stt_engine, plan.translate_engine, plan.n_takes, separation,
                            plan.tts_engine)}),
    }


def _start_launch(plan: _StartPlan, work: str, fields: dict, reused, warning: Optional[str]) -> dict:
    """Register the job and set it going (launch_job), then answer the screen."""
    def _target(jid, log):
        # Built from the record this start is about to write, so a job that
        # starts now and one the queue picks up after a restart run the very
        # same work. The one thing that reads differently is the download: the
        # builder fetches only when input.mp4 is missing, where this used to
        # fetch on sight of a link -- for a fresh start the file cannot exist
        # yet, so the two rules agree.
        #
        # `quality` is the exception the record cannot express: it resolves a
        # blank take count to a number so the finished screen has one to show,
        # while the run itself passes nothing and lets the voice engine apply
        # that same number. Same takes either way -- this keeps the run saying
        # what it has always said.
        return _work_for({**fields, "quality": plan.n_takes}, jid, resume=bool(reused))(log)

    # A Perso cloud dub runs on Perso's servers, so it skips the local line
    # (user decision 2026-09-01): waiting here would idle both machines.
    jid = launch_job(
        work,
        fields,
        # First log line names the source -- log files are job-<id>.log, so
        # without this there is no way to tell which video a log belongs to.
        f"{plan.source_url or (plan.held.title if plan.held else None) or plan.video.filename or 'video'}",
        _target,
        parallel=(plan.dub_mode == "perso"),
    )
    if warning:
        state.job_store.append_log(jid, warning)
    # "running", or "queued" when another dub holds the air -- the screen's
    # toast says which.
    return {"job_id": jid, "status": state.job_store.get(jid)["status"],
            **({"warning": warning} if warning else {})}


@router.post("/api/dub/start")
def dub_start(
    video: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    download_id: Optional[str] = Form(None),
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
    ranges: Optional[str] = Form(None),
    tts_engine: Optional[str] = Form(None),
    stems_from: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    perso_model: Optional[str] = Form(None),
):
    """Start dubbing by uploading a video (+ optional subtitles) from the screen.

    srt = translated subtitles (used as is) / source_srt = source subtitles (translate
    this instead of transcribing — with a script, transcription errors & omissions vanish).
    n_takes = how many candidate takes per line the best-of-N selection
    scores before picking a winner; omitted uses the saved voice quality
    (app/setup.py default_n_takes: Fast is 1).
    tts_engine = "qwen3" (this computer); omitted uses the saved default
    (app/setup.py "voice").
    stt_engine = "perso" for cloud STT+diarization (best quality); if omitted, the
    server default applies (see app.config.default_stt_engine) — the saved
    STT_ENGINE, else local Whisper, key or no key. A Perso failure FAILS the
    job with an actionable message (no silent local substitute — the engine was
    chosen for a reason); pick Whisper explicitly for the free offline path.
    trim_start/trim_end = dub only these seconds of the video. Both or neither:
    the video is cut down to that part and the cut IS this job's original.
    download_id = a video the New project screen already fetched or was given
    (app/api/downloads.py): its file is copied in as the original, so a link
    is not downloaded a second time and a dropped file is not uploaded twice.
    ranges = the parts kept on the timeline, JSON [[start, end], ...]. One
    part is exactly a trim; several are cut out and joined into one video
    before the job starts, and that joined video is this job's original.
    stems_from = a finished "Separate audio" job of the same held video and
    the same kept parts: its voice and background are copied in and the
    separation stage is not run again (app/separate_launch.py stems_for).
    project_id = the first dubbing of the project this one joins (Add
    language): one video's languages are one project on Home.
    perso_model = the Perso voice model of a Perso cloud dubbing, any one Perso's
    language list names ("ORIOLE", "LINNET_4", "FINCH", ...), which the target
    language must have; omitted, LINNET_4
    when the language has it, else ORIOLE, else the first it has (app/languages.py model_for).
    """
    try:
        plan = _start_plan(
            video=video, source_url=source_url, download_id=download_id, language=language,
            language_code=language_code, num_speakers=num_speakers, translate_engine=translate_engine,
            stt_engine=stt_engine, sep_engine=sep_engine, dub_mode=dub_mode, n_takes=n_takes,
            source_language_code=source_language_code, project=project, trim_start=trim_start,
            trim_end=trim_end, ranges=ranges, tts_engine=tts_engine, stems_from=stems_from,
            project_id=project_id, perso_model=perso_model)
        warning = _start_preflight(plan, has_script=srt is not None)
        work = _start_folder(plan)
    except HTTPException as e:
        # What the screen sent, under the names a job's Inputs line uses
        # (app/jobs.py): settings only -- no title, file name, path or link.
        _log_refused(e.detail, {
            "language": language, "language_code": language_code, "source_lang": source_language_code,
            "from_link": bool(source_url),
            "trim": None if trim_start is None and trim_end is None else {"start": trim_start, "end": trim_end},
            "stt_engine": stt_engine, "translator": translate_engine, "tts": tts_engine, "quality": n_takes,
            "separation": sep_engine, "dub_mode": dub_mode, "perso_model": perso_model,
            "num_speakers": num_speakers, "download_id": download_id, "ranges": ranges, "project_id": project_id})
        raise
    reused, separation = _reuse_stems(plan, work)
    _save_subtitles(work, srt, source_srt)
    fields = _start_record(plan, work, separation)
    return _start_launch(plan, work, fields, reused, warning)


def _log_refused(detail, settings: dict) -> None:
    """One line in the app log for a start refused before any job existed:
    there is no job to keep a log, and the screen's sentence was all that was
    left of it (Windows, 2026-10-16). The 409 that asks for downloads names
    the models it is missing."""
    if isinstance(detail, dict) and "missing" in detail:
        said = "models needed: " + ", ".join(str(m.get("id")) for m in detail["missing"])
    else:
        said = " ".join(str(detail).split())
    logger.warning("JOB REFUSED (dub): %s | %s", said, json.dumps(settings, ensure_ascii=False, default=str))


# ---------------------------------------------------------------------------
# Jobs that waited out a restart. app/main.py's lifespan calls this once the
# store has been restored; it lives here because the work it rebuilds is the
# work the routes above start.
# ---------------------------------------------------------------------------

def _dub_target_for(job: dict):
    """Rebuild a queued job's work from nothing but its saved record.

    A job that starts straight away runs a closure built by dub_start
    (_start_launch), with the request still in hand. A job that waited out an app restart has only
    its job.json and its folder -- and since every door now builds its work
    from exactly that (app/dub_launch.py), the queue can start it as if the
    app had never closed.

    Resume is always on, and that is safe: a queued job has not run since its
    door queued it, so its folder holds only what that door left there (the
    stems a start copied in, the stages a stopped job finished before
    Resume), and each door meant those to be used. voices_only comes off the
    record, which a redub stamps, so a redub stays voices-only.
    """
    return _work_for(job, job["id"], resume=True, voices_only=bool(job.get("voices_only")))


def _erase_target_for(job: dict):
    """The same for a job that erases a video's subtitles (app/erase_launch.py).

    One stage, so one call -- but it is rebuilt here, beside the dub's, because
    this is where a queued job of either kind comes back to life.
    """
    jid = job["id"]
    return erase_launch.work_for(
        job, cancel_check=lambda: state.job_store.is_cancel_requested(jid))


def _separate_target_for(job: dict):
    """And for a job that separates a video's voice from its background
    (app/separate_launch.py)."""
    jid = job["id"]
    return separate_launch.work_for(
        job, cancel_check=lambda: state.job_store.is_cancel_requested(jid),
        on_notice=lambda n: state.job_store.append_notice(jid, n))


_TARGETS = {JobKind.ERASE: _erase_target_for, JobKind.SEPARATE: _separate_target_for}


def rearm_queued_jobs() -> None:
    """Put restored queued jobs back in line, oldest first.

    Their threads never existed, so a restart cost them nothing -- but the
    functions they were queued with died with the process. Best-effort per
    job: one whose folder has gone missing becomes an error, not a crash."""
    waiting = sorted((j for j in (state.job_store.get(j["id"]) for j in state.job_store.all())
                      if j and j.get("status") == JobStatus.QUEUED),
                     key=lambda j: j.get("created") or "")
    for job in waiting:
        try:
            if not job.get("work_dir"):
                raise RuntimeError("no folder on record")
            target = _TARGETS.get(kind_of(job), _dub_target_for)(job)
            state.job_store.start(job["id"], target, parallel=goes_beside_the_line(job))
        except Exception as e:
            state.job_store.update(job["id"], status=JobStatus.ERROR, error=str(e))
