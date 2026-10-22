"""Separate audio: the voice and the background of a video, apart, as a job of
its own -- starting one, following it, drawing its two sounds, and opening it
again.

The ritual is the erase's (app/api/erase.py), which is the dub's: the
free-space floor, a folder named the same way, input.mp4 copied into it and
cut to the kept parts, and launch_job to make the record and set the work
going. What differs is the work -- app/separate_launch.py, the dubbing
pipeline's first stage and nothing after it -- and the `kind="separate"`
stamped on the record.

The two files are handed out by the routes a dubbing's stems already use
(app/api/results.py: /api/dub/result/{jid}/stems and /stem/{which}), so
playing them and exporting them as mp3 or wav is one code path for both.

On this computer the separation needs the engine pack; a start without it
answers 409 with the same payload a dubbing's start does, and the screen
offers the download. Through Perso it needs the key and spends credits.
"""
import os
import shutil
import time
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app import engines_status, media, media_preview, separate_launch, state
from app.api import _launch as launch_api
from app.api import downloads as downloads_api
from app.api._launch import check_space, goes_beside_the_line, job_dir, launch_job, require_perso_workspace
from app.api._shared import check_ranges_fit, check_trim, parse_ranges, work_dir_of
from app.api.erase import _source
from app.i18n import t
from app.jobs import JobKind, JobStatus, kind_of
from app.text.naming import project_name

router = APIRouter()

# Read off this module, the way app/api/erase.py keeps its own: this is where
# the tests replace the trim.
_cut_video = media.cut_video
_cut_ranges = media.cut_ranges

ENGINES = {"local": "demucs", "demucs": "demucs", "perso": "perso"}


def _separate_job(jid: str) -> dict:
    """This separation job, or 404 -- including for an id that is a dubbing's
    or an erase's: they live in one store, and neither has this to give."""
    job = state.job_store.get(jid)
    if job is None or kind_of(job) != JobKind.SEPARATE:
        raise HTTPException(404, t("Unknown job: {jid}", jid=jid))
    return job


def _require_engine(engine: str) -> None:
    """Refuse before anything is copied, not minutes into a job."""
    if engine == "perso":
        if not engines_status.perso_available():
            # In English on purpose: the page opens the key window when a
            # refused start says "needs an API key" (ui/src/app.mjs onStartRefused).
            raise HTTPException(
                422, "Perso separation needs an API key. Open Settings and save your "
                     "Perso API key, or choose Local model.")
        require_perso_workspace()
        return
    # The engine pack and nothing else: no transcription, no voices.
    missing = launch_api.missing_models(False, None, need_tts=False, need_engine=True)
    if missing:
        try:
            launch_api.raise_models_needed(missing)
        except HTTPException as e:
            # The same notice a dubbing's start gets, saying what it is for here.
            # A word for the page, not a sentence: the page picks its own
            # sentence by it (ui/src/modelsUi.mjs), so it stays in English.
            raise HTTPException(409, {**e.detail, "purpose": "separating audio"})


def _launch(work, fields, project):
    def _target(jid, log):
        return separate_launch.work_for(
            {**fields, "id": jid},
            cancel_check=lambda: state.job_store.is_cancel_requested(jid),
            on_notice=lambda n: state.job_store.append_notice(jid, n))(log)

    jid = launch_job(work, fields, "%s (separating audio)" % (project or "video"), _target,
                     parallel=goes_beside_the_line(fields))
    return {"job_id": jid, "status": state.job_store.get(jid)["status"]}


@router.post("/api/separate")
def separate_start(
    video: Optional[UploadFile] = File(None),
    download_id: Optional[str] = Form(None),
    engine: str = Form("local"),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
    ranges: Optional[str] = Form(None),
    project: Optional[str] = Form(None),
):
    """Queue a separation: this video's voice and its background, apart.

    engine is "local" (this computer) or "perso" (Perso's API, which spends
    credits). trim_start/trim_end or ranges cut the video down first, exactly
    as they do for a dubbing and an erase; a trim or kept parts, not both.

    Answers as soon as the job is on the queue; GET /api/separate/{job_id} is
    what follows it.
    """
    engine = ENGINES.get((engine or "").strip().lower())
    if engine is None:
        raise HTTPException(422, t("engine must be local or perso."))
    check_trim(trim_start, trim_end)
    kept = parse_ranges(ranges)
    if kept is not None and trim_start is not None:
        raise HTTPException(400, t("Send a trim or kept parts, not both."))
    if kept is not None and len(kept) == 1:
        (trim_start, trim_end), kept = kept[0], None
    _require_engine(engine)
    title, _path, copy_into = _source(video, download_id)

    project = project_name(project or "") or project_name(title or "")
    check_space(state.WORKSPACE)
    work = job_dir(project, "audio")
    video_path = os.path.join(work, "input.mp4")
    copy_into(video_path)
    try:
        if trim_start is not None:
            _cut_video(video_path, trim_start, trim_end)
        if kept is not None:
            check_ranges_fit(kept, video_path)
            _cut_ranges(video_path, kept)
        if not media.has_audio(video_path):
            raise HTTPException(422, t("This video has no sound."))
    except HTTPException:
        # No record points at this folder yet, so nothing would ever come
        # back to clear it.
        shutil.rmtree(work, ignore_errors=True)
        raise
    except RuntimeError as e:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(400, str(e))

    fields = {
        "kind": JobKind.SEPARATE,
        "project": project or os.path.basename(work),
        "day": launch_api.today(),
        "work_dir": work,
        "separation": engine,
        "from_link": False,
        "trim": ({"start": trim_start, "end": trim_end} if trim_start is not None else None),
        "ranges": kept,
        # The held video this was cut from: a dubbing of the same video and
        # the same parts takes these two files instead of separating again.
        **({"download_id": (download_id or "").strip()} if (download_id or "").strip() else {}),
    }
    return _launch(work, fields, project)


@router.post("/api/separate/{jid}/retry")
def separate_retry(jid: str):
    """Run this separation again from the top, on the video already in its
    folder (cut as the first run cut it), the same way."""
    job = _separate_job(jid)
    if job.get("status") in (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(409, t("This project is still running."))
    work_dir = work_dir_of(job)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(409, t("This project's video is no longer on disk."))
    engine = ENGINES.get(job.get("separation") or "", "demucs")
    _require_engine(engine)

    project = job.get("project") or os.path.basename(work_dir)
    check_space(state.WORKSPACE)
    work = job_dir(project, "audio")
    shutil.copyfile(source_video, os.path.join(work, "input.mp4"))
    fields = {
        "kind": JobKind.SEPARATE, "project": project, "day": launch_api.today(), "work_dir": work,
        "separation": engine, "from_link": False,
        "trim": job.get("trim"), "ranges": job.get("ranges"),
        **({"download_id": job["download_id"]} if job.get("download_id") else {}),
    }
    return _launch(work, fields, project)


def _stems_there(job: dict) -> bool:
    work = work_dir_of(job)
    return bool(work) and all(os.path.isfile(os.path.join(work, name))
                              for name in separate_launch.STEMS.values())


@router.get("/api/separate/{jid}")
def separate_job(jid: str):
    """One separation job: its record, how long it has been separating (the
    engines report no percentage, so the screen counts from this), and
    whether the two sounds are there to play."""
    job = _separate_job(jid)
    started = job.get("started")
    running = job.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING) and started
    return {**job,
            "elapsed": round(max(0.0, time.time() - started), 1) if running else 0,
            "done": job.get("status") == JobStatus.DONE and _stems_there(job)}


@router.get("/api/separate/{jid}/waveform/{which}")
def separate_waveform(jid: str, which: str):
    """The loudness of one of the two sounds, in the shape the timeline's own
    sound picture has (app/media_preview.py)."""
    job = _separate_job(jid)
    if which not in separate_launch.STEMS:
        raise HTTPException(404, t("No such audio."))
    path = os.path.join(work_dir_of(job), separate_launch.STEMS[which])
    if job.get("status") != JobStatus.DONE or not os.path.isfile(path):
        raise HTTPException(404, t("This audio is not separated yet."))
    try:
        return media_preview.waveform(path)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/api/separate/{jid}/open")
def separate_open(jid: str):
    """Hold this job's video again, for the draft its Audio tab is shown on.

    The video it was cut from comes back when the app still holds it, with
    the parts this job kept. Otherwise the job's own copy comes back whole:
    it is the kept parts already joined, and the record notes the id it went
    out under so a dubbing of it still finds these two sounds.
    """
    job = _separate_job(jid)
    title = job.get("title") or job.get("project") or "video"
    original = downloads_api.reopen_original(job, title)
    if original is not None:
        return original

    # The job's own copy, if one was held before: back from memory, or from
    # its holding folder after a restart, and whole (no kept parts). Copying
    # input.mp4 again would put another full video in the workspace each time.
    held = downloads_api.reopen_original({"download_id": job.get("held_again")}, title)
    if held is not None:
        return held
    source = os.path.join(work_dir_of(job), "input.mp4")
    if not os.path.exists(source):
        raise HTTPException(409, t("This project's video is no longer on disk."))
    again = downloads_api.download_store.add_file(
        state.WORKSPACE, title, downloads_api.seconds_of(source),
        lambda dest: shutil.copyfile(source, dest))
    state.job_store.update(jid, held_again=again.id)
    # Into job.json at once: a finished job's file is not written again, so a
    # restart would forget the copy and the next reopen would make another.
    state.job_store.persist(jid, work_dir_of(job))
    return {"download_id": again.id, "title": again.title, "duration_sec": again.duration_sec,
            "ranges": None}
