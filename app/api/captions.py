"""The Subtitle style tab on its own: a video and a subtitle file the user
already has, and the twelve looks laid on it, with no dubbing.

One route. It copies the held video into a job folder and writes the
subtitles beside it under the name a dubbing's script has (translated.srt),
then makes a record that is finished the moment it exists, kind "captions".
From there the finished-dub routes serve it as they serve a dub: the video
(/api/dub/result/{jid}), its lines (/api/dub/jobs/{jid}/script), the look
(/subtitle_style), the subtitled video (/subtitled) and the .srt (/srt). The
video is the one file of the job, so it is both the "original" and the result.
"""
import json
import os
import shutil
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app import media, state
from app.api import _launch as launch_api
from app.api._launch import check_space, job_dir
from app.api.erase import _source
from app.dub_script import DUB_NAME
from app.i18n import t
from app.jobs import JobKind, JobStatus
from app.text.naming import project_name
from app.text.srt import build_srt, clamp_cues, parse_srt

router = APIRouter()


@router.post("/api/captions/import")
def captions_import(download_id: str = Form(...), srt: UploadFile = File(...),
                    project: Optional[str] = Form(None)):
    """A held video and its .srt, as a finished project to style and download.

    The subtitles are read before anything is copied: a file with no line
    the app can read is refused with 422, a video that is not held with 404.
    Lines past the end of the video are cut there (clamp_cues).
    """
    try:
        cues = parse_srt((srt.file.read() or b"").decode("utf-8-sig"))
    except UnicodeDecodeError:
        cues = []
    cues = [c for c in cues if c["text"] and c["end"] > c["start"]]
    if not cues:
        raise HTTPException(422, t("This subtitle file has no lines PersoDub can read."))
    title, _path, copy_into = _source(None, download_id)

    project = project_name(project or "") or project_name(title or "")
    check_space(state.WORKSPACE)
    work = job_dir(project, "captions")
    video = os.path.join(work, "input.mp4")
    copy_into(video)
    try:
        seconds = media.video_duration(video)
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(422, t("That file does not look like a video."))
    cues = clamp_cues(cues, seconds)
    if not cues:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(422, t("Every line of this subtitle file starts after the video ends."))
    with open(os.path.join(work, DUB_NAME), "w", encoding="utf-8") as f:
        f.write(build_srt(cues))
    # A dub's subtitles start off; these are the project, so they start on.
    with open(os.path.join(work, "subtitle_style.json"), "w", encoding="utf-8") as f:
        json.dump({"enabled": True}, f)

    jid = state.job_store.create()
    state.job_store.update(
        jid, kind=JobKind.CAPTIONS, status=JobStatus.DONE, project=project or os.path.basename(work),
        title=title or project, day=launch_api.today(), work_dir=work, from_link=False,
        duration=seconds, srt_name=os.path.basename(srt.filename or ""), download_id=download_id,
        result={"out_path": video})
    state.job_store.persist(jid, work)
    state.job_store.append_log(jid, "%s (subtitle style)" % (project or "video"))
    return {"job_id": jid, "lines": len(cues)}
