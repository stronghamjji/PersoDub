"""Erasing the subtitles burned into a video: guessing where they sit, running
the erase as a job, playing the result back, saving it, and handing it on to a
dub.

The ritual is the dub's (app/api/dub.py), reused rather than rewritten: the
free-space floor, a folder named the same way, input.mp4 copied into it, and
launch_job to make the record and set the work going. What differs is the work
itself -- app/erase_launch.py, one stage and no engine choices -- and the
`kind="erase"` stamped on the record, which is what tells the two apart in the
Projects list, in the boot re-arm and in the routes below.

A video arrives the two ways a dub's does: uploaded, or by the id of a file the
New project screen is already holding (app/api/downloads.py). The last route
hands the erased video back to that same holding area, so "now dub it" opens a
new project on the cleaned file instead of the one with subtitles on it.

The eraser pack is not part of the base install, so every route that would use
it checks first and answers 409 {"reason": "pack_missing"} -- the screen offers
the download; nothing here downloads anything by itself.
"""
import json
import math
import os
import re
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import engines_status, erase_launch, eraser, media, state
from app.api import downloads as downloads_api
from app.api._shared import free_path, work_dir_of
from app.api.dub import _job_dir, _today, check_space, launch_job
from app.downloads import save_folder
from app.jobs import kind_of
from app.text.naming import project_name

router = APIRouter()

# Read off this module, the way app/api/dub.py keeps _cut_video: this is where
# the tests replace the trim.
_cut_video = media.cut_video

# The percentage the screen shows comes out of the job's own log, which is the
# only place app/eraser.py's progress lines are kept.
_PROGRESS = re.compile(r"^progress (\d+)%")


class SaveRequest(BaseModel):
    dir: Optional[str] = None       # default: the user's Downloads folder


def _pack_missing() -> HTTPException:
    """The eraser is not installed. Its own shape, not the dub's missing-model
    409: this pack is not in the model catalog the dialog is built from, so
    there is nothing to name a size for -- the screen asks for the one pack."""
    return HTTPException(409, {"reason": "pack_missing", "pack": "subtitle-eraser"})


def _require_eraser() -> None:
    """Refuse before anything is copied, not minutes into a job."""
    if not engines_status.eraser_available():
        raise _pack_missing()


def _source(video, download_id):
    """Where this request's video is and what it is called.

    Returns (title, path, copy_into): `path` is the file itself when the New
    project screen is already holding it -- a suggestion can read that one
    where it lies -- and None for an upload, which has to be written down
    first. Exactly one source, the rule dub_start follows: accepting both
    would silently pick a winner and the user would watch the wrong video get
    cleaned.
    """
    download_id = (download_id or "").strip() or None
    has_upload = video is not None and bool(video.filename)
    if has_upload == bool(download_id):
        raise HTTPException(422, "Provide either a video file or a download_id.")
    if download_id:
        held = downloads_api.download_store.get(download_id)
        if held is None or held.status != "ready" or not os.path.exists(held.path):
            raise HTTPException(404, "That video is not downloaded yet.")
        return held.title, held.path, lambda dest: shutil.copyfile(held.path, dest)

    def _write(dest):
        with open(dest, "wb") as f:
            shutil.copyfileobj(video.file, f)

    return os.path.splitext(os.path.basename(video.filename))[0], None, _write


def _parse_area(raw: str):
    """The band to erase: "whole", or [ymin, ymax, xmin, xmax] as JSON.

    Rows first, not the usual (x, y) -- that is the order the eraser itself
    takes (app/scripts/erase_subtitles.py). A box with no height or no width
    would erase nothing and take the same minutes doing it.
    """
    if (raw or "").strip().lower() == "whole":
        return "whole"
    try:
        band = json.loads(raw or "")
    except ValueError:
        band = None
    if (not isinstance(band, list) or len(band) != 4
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in band)):
        raise HTTPException(422, 'area must be "whole" or [ymin, ymax, xmin, xmax].')
    ymin, ymax, xmin, xmax = (int(v) for v in band)
    if ymin < 0 or xmin < 0 or ymax <= ymin or xmax <= xmin:
        raise HTTPException(422, "The subtitle area has to be a box with height and width.")
    return [ymin, ymax, xmin, xmax]


def _check_trim(trim_start, trim_end) -> None:
    """The same rule dub_start applies: both or neither, and long enough to be
    a video at all."""
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


def _erase_job(jid: str) -> dict:
    """This erase job, or 404 -- including for a job id that is a dub's. The
    two live in one store, and a dub answered here would have no erased video
    to give."""
    job = state.job_store.get(jid)
    if job is None or kind_of(job) != "erase":
        raise HTTPException(404, f"Unknown job: {jid}")
    return job


def _percent(job: dict) -> int:
    """How far along, from the last progress line in the job's log."""
    for line in reversed(job.get("logs") or []):
        m = _PROGRESS.match(line)
        if m:
            return int(m.group(1))
    return 0


def _erased_path(job: dict) -> str:
    return os.path.join(work_dir_of(job), "erased.mp4")


@router.post("/api/erase/suggest")
def erase_suggest(video: Optional[UploadFile] = File(None),
                  download_id: Optional[str] = Form(None)):
    """Where this video's subtitles look to be, as the screen's opening box.

    A guess, not a decision: the user drags the box afterwards. An uploaded
    file is written into a scratch folder because the detector needs a real
    file to read, and that folder goes again as soon as the answer is out --
    the erase itself uploads once more, into a job folder of its own.
    """
    _require_eraser()
    _title, path, copy_into = _source(video, download_id)
    probe = os.path.join(state.WORKSPACE, "erase-probe", uuid.uuid4().hex[:8])
    try:
        if path is None:
            os.makedirs(probe, exist_ok=True)
            path = os.path.join(probe, "input.mp4")
            copy_into(path)
        try:
            found = eraser.suggest_area(path)
        except eraser.EraserMissing:
            raise _pack_missing()
        except RuntimeError as e:
            raise HTTPException(503, str(e))
    finally:
        shutil.rmtree(probe, ignore_errors=True)
    return {"area": found.get("area"), "width": found.get("width"),
            "height": found.get("height"), "found": bool(found.get("found"))}


@router.post("/api/erase")
def erase_start(
    video: Optional[UploadFile] = File(None),
    download_id: Optional[str] = Form(None),
    area: str = Form("whole"),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
    project: Optional[str] = Form(None),
):
    """Queue an erase: take the subtitles out of this video and keep the rest.

    area is the band to work in ([ymin, ymax, xmin, xmax], the box the screen
    offered or the one the user dragged) or "whole" for the entire frame --
    slower, but it catches writing anywhere. trim_start/trim_end cut the video
    down first, and the cut IS what this job is about, exactly as it is for a
    dub.

    Answers as soon as the job is on the queue: an erase runs for minutes, and
    GET /api/erase/{job_id} is what follows it.
    """
    _require_eraser()
    band = _parse_area(area)
    _check_trim(trim_start, trim_end)
    title, _path, copy_into = _source(video, download_id)

    project = project_name(project or "") or project_name(title or "")
    check_space(state.WORKSPACE)
    work = _job_dir(project, "erase")
    video_path = os.path.join(work, "input.mp4")
    copy_into(video_path)
    if trim_start is not None:
        try:
            _cut_video(video_path, trim_start, trim_end)
        except RuntimeError as e:
            # No record points at this folder yet, so nothing would ever come
            # back to clear it, and the next try would land in _001.
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))

    fields = {
        # What this job is. Everything else here means the same as it does on a
        # dub's record, which is what lets Projects, the cancel button and the
        # delete route treat the two alike.
        "kind": "erase",
        "project": project or os.path.basename(work),
        "day": _today(),
        "work_dir": work,
        "area": band,
        "from_link": False,
        "trim": ({"start": trim_start, "end": trim_end} if trim_start is not None else None),
    }

    def _target(jid, log):
        return erase_launch.work_for(
            {**fields, "id": jid},
            cancel_check=lambda: state.job_store.is_cancel_requested(jid))(log)

    jid = launch_job(work, fields, "%s (erasing subtitles)" % (project or "video"), _target)
    return {"job_id": jid, "status": state.job_store.get(jid)["status"]}


@router.post("/api/erase/{jid}/retry")
def erase_retry(jid: str):
    """Run this erase again from the top, on the video already in its folder.

    The dub's own Try again (app/api/dub.py's dub_job_retry), which this
    mirrors: the failure card had no way forward at all, so the only way to
    have another go was to find the video and drop it in again -- and a job
    opened out of the Projects list has no held video behind it, so there was
    nothing on screen to drop (user, 2026-09-11).

    input.mp4 is the video as the first run worked on it, trim and all, so
    nothing is cut a second time. The band travels with it: the user drew that
    box once, and a failure is not a reason to make them draw it again.
    """
    job = _erase_job(jid)
    if job.get("status") in ("running", "cancelling"):
        raise HTTPException(409, "This job is still running.")
    work_dir = work_dir_of(job)
    source_video = os.path.join(work_dir, "input.mp4")
    if not os.path.exists(source_video):
        raise HTTPException(409, "This job's video is no longer on disk.")
    _require_eraser()

    project = job.get("project") or os.path.basename(work_dir)
    check_space(state.WORKSPACE)
    work = _job_dir(project, "erase")
    shutil.copyfile(source_video, os.path.join(work, "input.mp4"))

    fields = {
        "kind": "erase",
        "project": project,
        "day": _today(),
        "work_dir": work,
        "area": job.get("area"),
        "from_link": False,
        # Already cut into the copy above. Kept on the record so the screen can
        # still say which part of the original this is.
        "trim": job.get("trim"),
    }

    def _target(new_jid, log):
        return erase_launch.work_for(
            {**fields, "id": new_jid},
            cancel_check=lambda: state.job_store.is_cancel_requested(new_jid))(log)

    new_jid = launch_job(work, fields, "%s (erasing subtitles)" % project, _target)
    return {"job_id": new_jid, "status": state.job_store.get(new_jid)["status"]}


@router.get("/api/erase/{jid}")
def erase_job(jid: str):
    """One erase job: its record, how far along it is, and whether the cleaned
    video is there to play."""
    job = _erase_job(jid)
    return {**job, "percent": _percent(job), "done": os.path.exists(_erased_path(job))}


@router.get("/api/erase/{jid}/video")
def erase_video(jid: str):
    """The cleaned video."""
    out = _erased_path(_erase_job(jid))
    if not os.path.exists(out):
        raise HTTPException(404, "This video is not erased yet.")
    return FileResponse(out, media_type="video/mp4")


@router.get("/api/erase/{jid}/original")
def erase_original(jid: str):
    """The video as it came in -- what the screen shows beside the result."""
    src = os.path.join(work_dir_of(_erase_job(jid)), "input.mp4")
    if not os.path.exists(src):
        raise HTTPException(404, "This job's video is no longer on disk.")
    return FileResponse(src, media_type="video/mp4")


@router.post("/api/erase/{jid}/save")
def erase_save(jid: str, body: SaveRequest):
    """Save the cleaned video where the user keeps their files.

    Named after the project so the file says what it is, and never written
    over an existing one -- the same promise every other save in the app makes.
    """
    job = _erase_job(jid)
    out = _erased_path(job)
    if not os.path.exists(out):
        raise HTTPException(404, "This video is not erased yet.")
    project = job.get("project") or "video"
    folder = save_folder(body.dir or "", job.get("day") or _today(), project)
    os.makedirs(folder, exist_ok=True)
    dest = free_path(os.path.join(folder, "%s (no subtitles)" % project), ".mp4")
    shutil.copyfile(out, dest)
    return {"path": dest}


@router.post("/api/erase/{jid}/dub")
def erase_to_dub(jid: str):
    """Hand the cleaned video to the New project screen.

    It goes into the same holding area a fetched link lands in
    (app/api/downloads.py), so the screen opens a new project on the id this
    returns and the dub starts from the video without subtitles. No dub is
    started here: which language, which engines and whether to trim are all
    still the user's to choose.
    """
    job = _erase_job(jid)
    out = _erased_path(job)
    if not os.path.exists(out):
        raise HTTPException(404, "This video is not erased yet.")
    try:
        duration = media.video_duration(out)
    except Exception:
        duration = 0
    held = downloads_api.download_store.add_file(
        state.WORKSPACE, job.get("project") or "video", duration,
        lambda dest: shutil.copyfile(out, dest))
    return {"download_id": held.id, "title": held.title, "duration_sec": held.duration_sec}
