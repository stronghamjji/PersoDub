"""A video brought to the New project screen: a link fetched into a holding
folder (or a file dropped there), played back from it, then saved whole or as
one stretch -- or handed to a dub by id, so the file is not fetched twice.

Lifted from the 2026-09-02 Download-tab branch and moved into app/api with
the other routers. The stretch cut re-encodes the way clips_cut does (see
app/api/clips.py for why not -c copy); media.cut_video is the other thing,
the in-place trim a dub runs on its own input.
"""
import json
import os
import re
import shutil
import time
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import media, state
from app.api._shared import dub_media, free_path, parse_ranges, ratio_errors_as_http
from app.api.clips import _clip_stamp
from app.downloads import DownloadStore, file_stem, save_folder
from app.i18n import t
from app.ratio import pad_file, pad_filter_for
from app.separate_launch import parts_of
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
    # The timeline's kept parts, [[start, end], ...], joined the way a dub
    # joins them. These or a start and an end, not both.
    ranges: Optional[List[List[float]]] = None
    audio: Optional[str] = None     # one of media.AUDIO_CODECS: the sound only
    # A canvas to save the video in (app/ratio.py); default: as it is. The
    # sound alone has no picture, so it is not read with `audio`.
    ratio: Optional[str] = None


def cut_stretch(src: str, out: str, start: float, end: float, vf: Optional[str] = None) -> None:
    """ffmpeg re-encodes [start, end) of src into a NEW file out, through the
    picture filter `vf` (the ratio's canvas) when there is one. Run the way
    the route's two other saves are (media.run_new_file): a failure is a
    RuntimeError in ffmpeg's own words without folder names, and leaves no
    half-written file in the user's folder."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-ss", "%.3f" % start, "-t", "%.3f" % (end - start), "-i", src,
           *(["-vf", vf] if vf else []),
           *media.x264_args("20", ["-c:a", "aac", "-b:a", "160k"]), out]
    media.run_new_file(cmd, end - start, t("ffmpeg could not cut this video"))


@router.post("/api/downloads")
def downloads_start(body: DownloadStartRequest):
    """Begin fetching a link. Answers at once with an id to poll."""
    try:
        validate_source_url(body.url)
    except FetchError as e:
        raise HTTPException(status_code=422, detail={"reason": e.reason, "message": e.shown})
    d = download_store.start(body.url, state.WORKSPACE, probe_source, fetch_source,
                             error_type=FetchError, measure=media.video_duration)
    return {"id": d.id}


@router.post("/api/downloads/upload")
def downloads_upload(video: UploadFile = File(...), duration_sec: Optional[float] = Form(None)):
    """A dropped file, held like a fetched link so Save clip works on it too.

    Only a video or an audio file a dubbing takes (app/api/_shared.py
    dub_media). Anything else is refused with 422 by what ffprobe finds in it
    once it is here, and then it is not kept. An audio file's record says
    `media: "audio"`."""
    if not video.filename:
        raise HTTPException(status_code=422, detail=t("No file."))
    title = os.path.splitext(os.path.basename(video.filename))[0]

    def write(dest):
        with open(dest, "wb") as f:
            shutil.copyfileobj(video.file, f)

    d = download_store.add_file(state.WORKSPACE, title, duration_sec or 0, write)
    try:
        d.media = dub_media(d.path)
    except HTTPException:
        download_store.drop(d.id)
        raise
    return d.as_dict()


@router.get("/api/downloads")
def downloads_list():
    """Every video being held right now.

    For the Dub Agent's list_videos, which shows these beside the files in the
    folder it was asked about: a link the user fetched on the screen is a real
    file on this computer, sitting where they would never think to look.
    """
    return {"downloads": [d.as_dict() for d in download_store.all()]}


@router.get("/api/downloads/{did}")
def downloads_status(did: str):
    d = download_store.get(did)
    if d is None:
        raise HTTPException(status_code=404, detail=t("Unknown download: {did}", did=did))
    return d.as_dict()


class DownloadHoldRequest(BaseModel):
    title: str = ""
    duration_sec: float = 0


_HELD_ID = re.compile(r"^[0-9a-f]{8}$")


def seconds_of(path: str) -> float:
    """A video's length in seconds, or 0 when it cannot be read: what a video
    is held with when nothing better is known."""
    try:
        return media.video_duration(path)
    except Exception:
        return 0


def held_media(path: str) -> Optional[str]:
    """What a file is when no record says: "audio" or None (a video). For a
    file held again after a restart, whose record lived in memory only, and
    for one sent straight to a separation (app/api/separate.py). It refuses
    nothing: a dubbing's own door does that (app/api/_shared.py dub_media)."""
    return "audio" if media.media_kind(path) == "audio" else None


def reopen_original(job: dict, title: str):
    """Hold the video a job was cut from again, for a new draft on it: the
    answer Add language (app/api/dub.py dub_job_again) and a separation's
    Audio tab (app/api/separate.py separate_open) open with, which carries the
    parts the job kept. The video comes back from memory, or from its folder
    after a restart (the records live in memory only); None when it is no
    longer on this computer. `title` names it when it is held again."""
    did = job.get("download_id") or ""
    held = download_store.get(did)
    if held is None and _HELD_ID.match(did):
        path = os.path.join(state.WORKSPACE, "downloads", did, "source.mp4")
        if os.path.exists(path):
            held = download_store.hold_again(did, path, title, seconds_of(path), held_media(path))
    if held is None or held.status != "ready" or not os.path.exists(held.path):
        return None
    return {"download_id": held.id, "title": held.title or title,
            "duration_sec": held.duration_sec or seconds_of(held.path),
            "ranges": parts_of(job),
            # Said only of an audio file, as on a job's record.
            **({"media": held.media} if held.media else {})}


@router.post("/api/downloads/{did}/hold")
def downloads_hold(did: str, body: DownloadHoldRequest):
    """A draft that was left before it was dubbed is opened again: its video
    is still in the holding folder, and is held once more under the same id.
    The records live in memory only, so after a restart this is what makes the
    draft's video playable. 404 when the file itself is gone."""
    d = download_store.get(did)
    if d is None and _HELD_ID.match(did):
        path = os.path.join(state.WORKSPACE, "downloads", did, "source.mp4")
        if os.path.exists(path):
            d = download_store.hold_again(did, path, body.title, body.duration_sec, held_media(path))
    if d is None or d.status != "ready" or not os.path.exists(d.path):
        raise HTTPException(status_code=404, detail=t("This video is no longer on this computer."))
    return d.as_dict()


@router.get("/api/downloads/{did}/video")
def downloads_video(did: str):
    """The fetched file, for the New project screen's player. An audio file
    is served as the sound it is: it is held under the name source.mp4, but a
    browser that is told video/mp4 and finds a WAV may refuse to play it."""
    d = download_store.get(did)
    if d is None or d.status != "ready" or not os.path.exists(d.path):
        raise HTTPException(status_code=404, detail=t("Not downloaded yet"))
    if d.media == "audio":
        return FileResponse(d.path, media_type=media.AUDIO_MIME.get(media.audio_format(d.path)))
    return FileResponse(d.path, media_type="video/mp4")


def _parts_tag(parts) -> str:
    """How a saved file says which part of the video it is."""
    if len(parts) == 1:
        return " (%s-%s)" % (_clip_stamp(parts[0][0]), _clip_stamp(parts[0][1]))
    return " (%d parts)" % len(parts)


@router.post("/api/downloads/{did}/save")
def downloads_save(did: str, body: DownloadSaveRequest):
    """Save the download as a file of its own: all of it, [start, end), or the
    timeline's kept parts joined -- as a video (inside the canvas of `ratio`
    when one is picked), or as its sound alone.

    Named after the video's title, with a "(3s-21s)" tag when it is a
    stretch and "(2 parts)" when it is several. Never writes over a file
    that is already there."""
    d = download_store.get(did)
    if d is None or d.status != "ready" or not os.path.exists(d.path):
        raise HTTPException(status_code=404, detail=t("Not downloaded yet"))
    # An audio file has no picture to save as a video; its sound is saved
    # below like any other.
    if d.media == "audio" and not body.audio:
        raise HTTPException(status_code=409, detail=t("Only for projects with a video."))
    if body.audio is not None and body.audio not in media.AUDIO_CODECS:
        raise HTTPException(status_code=422, detail=t("Audio is saved as MP3, WAV, FLAC or M4A."))
    one = body.start is not None or body.end is not None
    if one and body.ranges is not None:
        raise HTTPException(status_code=422, detail=t("Send a stretch or kept parts, not both."))
    duration = 0.0
    if one or body.ranges is not None:
        try:
            duration = media.video_duration(d.path)
        except Exception:
            duration = float(d.duration_sec or 0)
    parts = None
    if one:
        if body.start is None or body.end is None:
            raise HTTPException(status_code=422, detail=t("Give both a start and an end."))
        start, end = float(body.start), float(body.end)
        if start < 0 or end <= start:
            raise HTTPException(status_code=422, detail=t("The stretch must start before it ends."))
        if duration and start >= duration:
            raise HTTPException(status_code=422, detail=t("This video is only {seconds}s long.",
                                                            seconds=f"{duration:.0f}"))
        parts = [[start, min(end, duration) if duration else end]]
    elif body.ranges is not None:
        parts = parse_ranges(json.dumps(body.ranges))
        if duration and parts[-1][1] > duration + 0.05:
            raise HTTPException(status_code=400,
                                detail=t("The kept parts run past the end of the video ({seconds}s).",
                                         seconds=f"{duration:.1f}"))
    if body.audio and not media.has_audio(d.path):
        raise HTTPException(status_code=422, detail=t("This video has no sound."))
    # The canvas of the picked ratio, added in the same pass as the cut. Asked
    # before anything is written, so a shape the app does not know is refused
    # with no file left behind. The sound alone has no picture to put in one.
    with ratio_errors_as_http():
        vf = None if body.audio else pad_filter_for(d.path, body.ratio)

    stem = file_stem(d.title)
    folder = save_folder(body.dir or "", time.strftime("%Y-%m-%d"), stem)
    os.makedirs(folder, exist_ok=True)
    out = free_path(os.path.join(folder, stem + (_parts_tag(parts) if parts else "")),
                    "." + body.audio if body.audio else ".mp4")
    seconds = sum(b - a for a, b in parts) if parts else d.duration_sec
    try:
        if body.audio:
            media.run_new_file(media.audio_command(d.path, out, body.audio, parts),
                               seconds, t("Could not save the audio"))
        elif not parts:
            shutil.copyfile(d.path, out)
            pad_file(out, body.ratio)
        elif len(parts) == 1:
            cut_stretch(d.path, out, parts[0][0], parts[0][1], vf)
        else:
            media.run_new_file(media.cut_ranges_command(d.path, out, parts, media.has_audio(d.path), vf),
                               seconds, t("Could not join the kept parts"))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"path": out, "seconds": round(seconds, 3) if parts else seconds}
