"""The timeline's film strip and sound picture of a video (app/media_preview.py).

`kind` says whose video: "job" is the original a dub was made from (its
input.mp4), "join" the video brought into a finished audio project (its
join.mp4, app/api/join.py), "download" the video a new project is holding
before it is dubbed. Plain `def` routes, so the ffmpeg run happens on
FastAPI's worker threads and never holds up the event loop.
"""
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import media_preview, state
from app.api._shared import work_dir_of
from app.api.downloads import download_store
from app.api.join import VIDEO as JOIN_VIDEO
from app.i18n import t

router = APIRouter()

# The two videos a job's folder can hold, by the kind each is asked for as.
_JOB_VIDEOS = {"job": "input.mp4", "join": JOIN_VIDEO}


def _source(kind: str, ident: str) -> str:
    path: Optional[str] = None
    if kind in _JOB_VIDEOS:
        job = state.job_store.get(ident)
        work = work_dir_of(job) if job else ""
        path = os.path.join(work, _JOB_VIDEOS[kind]) if work else None
    elif kind == "download":
        d = download_store.get(ident)
        path = d.path if d is not None and d.status == "ready" else None
    else:
        raise HTTPException(404, t("Unknown kind of video."))
    if not path or not os.path.exists(path):
        raise HTTPException(404, t("That video is not on disk."))
    return path


@router.get("/api/media/{kind}/{ident}/filmstrip")
def media_filmstrip(kind: str, ident: str):
    video = _source(kind, ident)
    try:
        path = media_preview.filmstrip(video)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return FileResponse(path, media_type="image/jpeg")


@router.get("/api/media/{kind}/{ident}/waveform")
def media_waveform(kind: str, ident: str):
    video = _source(kind, ident)
    try:
        return media_preview.waveform(video)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
