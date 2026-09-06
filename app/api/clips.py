"""Cutting a stretch of a video into its own file -- the Dub Agent's cut_clip
tool. Lifted out of app/main.py unchanged (2026-09-06).

main._cut_video stays in main on purpose: it is the trim that runs inside a
dub (start, retry, queued-job rearm), and nothing here calls it -- this route
runs its own ffmpeg because it writes a new file beside the original rather
than replacing it.
"""
import os
import subprocess
from typing import Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api._shared import free_path
from app.pipeline import _video_duration

router = APIRouter()


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


@router.post("/api/clips/cut")
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
    out = free_path("%s-clip-%s-%s" % (base, _clip_stamp(start), _clip_stamp(end)),
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
