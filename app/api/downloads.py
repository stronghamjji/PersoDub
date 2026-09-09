"""A video brought to the New project screen: a link fetched into a holding
folder (or a file dropped there), played back from it, then saved whole or as
one stretch -- or handed to a dub by id, so the file is not fetched twice.

Lifted from the 2026-09-02 Download-tab branch and moved into app/api with
the other routers. The stretch cut re-encodes the way clips_cut does (see
app/api/clips.py for why not -c copy); media.cut_video is the other thing,
the in-place trim a dub runs on its own input.
"""
import os
import shutil
import subprocess
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import media, state
from app.api._shared import free_path
from app.api.clips import _clip_stamp
from app.downloads import DownloadStore, file_stem
from app.source_fetch import FetchError
from app.source_fetch import fetch as fetch_source
from app.source_fetch import probe as probe_source
from app.source_fetch import validate_url as validate_source_url

router = APIRouter()

download_store = DownloadStore()


class DownloadStartRequest(BaseModel):
    url: str


class DownloadSaveRequest(BaseModel):
    dir: Optional[str] = None       # default: the user's Downloads folder
    start: Optional[float] = None   # seconds; both or neither
    end: Optional[float] = None


def cut_stretch(src: str, out: str, start: float, end: float) -> None:
    """ffmpeg re-encodes [start, end) of src into a NEW file out."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-ss", "%.3f" % start, "-t", "%.3f" % (end - start), "-i", src,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
           "-movflags", "+faststart", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(status_code=503,
                            detail="ffmpeg could not cut this video (%s)."
                            % (r.stderr or "").strip().splitlines()[-1:] or "unknown error")


@router.post("/api/downloads")
def downloads_start(body: DownloadStartRequest):
    """Begin fetching a link. Answers at once with an id to poll."""
    try:
        validate_source_url(body.url)
    except FetchError as e:
        raise HTTPException(status_code=422, detail={"reason": e.reason, "message": e.message})
    d = download_store.start(body.url, state.WORKSPACE, probe_source, fetch_source,
                             error_type=FetchError)
    return {"id": d.id}


@router.post("/api/downloads/upload")
def downloads_upload(video: UploadFile = File(...), duration_sec: Optional[float] = Form(None)):
    """A dropped file, held like a fetched link so Save clip works on it too."""
    if not video.filename:
        raise HTTPException(status_code=422, detail="No file.")
    title = os.path.splitext(os.path.basename(video.filename))[0]

    def write(dest):
        with open(dest, "wb") as f:
            shutil.copyfileobj(video.file, f)

    d = download_store.add_file(state.WORKSPACE, title, duration_sec or 0, write)
    return d.as_dict()


@router.get("/api/downloads/{did}")
def downloads_status(did: str):
    d = download_store.get(did)
    if d is None:
        raise HTTPException(status_code=404, detail=f"Unknown download: {did}")
    return d.as_dict()


@router.get("/api/downloads/{did}/video")
def downloads_video(did: str):
    """The fetched file, for the New project screen's player."""
    d = download_store.get(did)
    if d is None or d.status != "ready" or not os.path.exists(d.path):
        raise HTTPException(status_code=404, detail="Not downloaded yet")
    return FileResponse(d.path, media_type="video/mp4")


@router.post("/api/downloads/{did}/save")
def downloads_save(did: str, body: DownloadSaveRequest):
    """Save the download as a file of its own: all of it, or [start, end).

    Named after the video's title, with a "(3s-21s)" tag when it is a
    stretch. Never writes over a file that is already there."""
    d = download_store.get(did)
    if d is None or d.status != "ready" or not os.path.exists(d.path):
        raise HTTPException(status_code=404, detail="Not downloaded yet")
    folder = os.path.expanduser(body.dir or "~/Downloads")
    os.makedirs(folder, exist_ok=True)
    stem = file_stem(d.title)
    if body.start is None and body.end is None:
        out = free_path(os.path.join(folder, stem), ".mp4")
        shutil.copyfile(d.path, out)
        return {"path": out, "seconds": d.duration_sec}
    if body.start is None or body.end is None:
        raise HTTPException(status_code=422, detail="Give both a start and an end.")
    start, end = float(body.start), float(body.end)
    if start < 0 or end <= start:
        raise HTTPException(status_code=422, detail="The stretch must start before it ends.")
    try:
        duration = media.video_duration(d.path)
    except Exception:
        duration = float(d.duration_sec or 0)
    if duration and start >= duration:
        raise HTTPException(status_code=422, detail=f"This video is only {duration:.0f}s long.")
    if duration:
        end = min(end, duration)
    out = free_path(os.path.join(folder, "%s (%s-%s)" % (stem, _clip_stamp(start), _clip_stamp(end))),
                    ".mp4")
    cut_stretch(d.path, out, start, end)
    return {"path": out, "seconds": round(end - start, 3)}
