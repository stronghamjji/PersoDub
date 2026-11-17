"""The Home screen's project-card picture: one small JPEG made from a job's
own video, so a card does not have to fall back to a plain dark tile.

Built once with the kit's own ffmpeg (the calling style app/media.py and
app/api/results.py already use) and cached beside the job as thumb.jpg;
rebuilt only when input.mp4 is newer than the cached file.

An audio project has no frame to show, so its picture is the shape of its
sound: the same small JPEG under the same name.
"""
import logging
import os
import subprocess

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import media, state
from app.api._shared import work_dir_of
from app.i18n import t

logger = logging.getLogger("persodub.api.thumbs")

router = APIRouter()

# A card that never draws is worse than the plain dark tile the page falls
# back to -- so this gives up rather than let one bad video hang the request.
_TIMEOUT = 20

# An audio project's picture: the waveform of its first minute, as wide as a
# video's thumbnail and square like the card it fills, in the colours of the
# tile it sits on (--thumb-bg and --waveform in static/css/app.css). A minute
# and not the whole file, as a video's frame comes from its first seconds: a
# long recording must not run into the time limit above. The sound is mixed to
# one channel so it is drawn once in one colour, each column is the loudest
# moment it covers (filter=peak), and the square-root scale keeps a quiet
# recording from being a flat line. A JPEG has no see-through, so the ground
# is painted first.
_WAVEFORM = ("color=c=0x111111:s=248x248[ground];"
             "[0:a]aformat=channel_layouts=mono,"
             "showwavespic=s=248x248:colors=0x5682bb:scale=sqrt:filter=peak[wave];"
             "[ground][wave]overlay")


def _stale(built: str, source: str) -> bool:
    return not os.path.exists(built) or os.path.getmtime(source) > os.path.getmtime(built)


@router.get("/api/dub/jobs/{jid}/thumb")
def job_thumb(jid: str):
    """A small JPEG of the job's source video.

    ffmpeg's own `thumbnail` filter picks the most representative frame out
    of the first few seconds, rather than one at a fixed timestamp that could
    land on a black intro or a title card. An audio project's is a picture of
    its waveform (_WAVEFORM).
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    work_dir = work_dir_of(job)
    video = os.path.join(work_dir, "input.mp4") if work_dir else ""
    if not video or not os.path.exists(video):
        raise HTTPException(status_code=404, detail=t("No video for this project yet"))
    out = os.path.join(work_dir, "thumb.jpg")
    if _stale(out, video):
        tmp = out + ".tmp"
        picture = (["-t", "60", "-i", video, "-filter_complex", _WAVEFORM]
                   if job.get("media") == "audio"
                   else ["-t", "8", "-i", video, "-vf", "thumbnail=90,scale=248:-2"])
        try:
            run = subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *picture,
                 "-frames:v", "1", "-q:v", "4", "-f", "mjpeg", tmp],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=_TIMEOUT)
        except subprocess.TimeoutExpired:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise HTTPException(status_code=503, detail=t("Making the thumbnail took too long"))
        if run.returncode != 0 or not os.path.exists(tmp):
            if os.path.exists(tmp):
                os.remove(tmp)
            raise HTTPException(status_code=503,
                                detail=media._failure(t("ffmpeg could not draw a thumbnail"), run.stderr,
                                                      (video, tmp)))
        os.replace(tmp, out)  # atomic: a half-written file is never served
    return FileResponse(out, media_type="image/jpeg")
