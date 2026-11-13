"""The helpers more than one router needs.

app/api/results.py names an .srt and a subtitled .mp4 with free_path,
app/api/clips.py names a clip with it. The two "where is this job's folder"
answers below are shared the same way: dub.py, results.py and script.py all
ask them. So are the rules for the part of a video a new job keeps
(check_trim, parse_ranges, check_ranges_fit, and cut_to_kept_parts for a dub
and an erase): a dub, an erase and a separation follow the same ones, and the held video's own save
(app/api/downloads.py) reads its kept parts with parse_ranges too. Here
rather than in any one router so no router has to import another.

Both work-dir helpers were app/main.py's until 2026-09-06, read back off it by
the routers' `_main()` seams. Unchanged apart from losing their leading
underscore, now that they are a module's exports rather than one file's
privates.
"""
import json
import math
import os
import shutil
from contextlib import contextmanager
from typing import Optional

from fastapi import HTTPException

from app import media, ratio, state
from app.i18n import t


def work_dir_of(job: dict) -> str:
    """Where this job's folder is -- the one answer, in one place.

    work_dir is stamped the moment the folder is made, so it is there even for a
    job that failed before it produced anything. dirname(out_path) is the older
    way of asking the same question, kept as the fallback so a record written
    before work_dir existed (or hand-built in a test) still resolves.

    Not for the script and subtitle routes: those ask out_path directly (see
    script_work_dir), because they say 409 when there is no result at all. In
    the product the two answers are the same folder -- run_dub always writes the
    result inside work_dir -- so what really pins those routes is two tests
    whose fake run writes the result somewhere else (tests/test_dub_api.py,
    fake_run_dub).
    """
    return job.get("work_dir") or os.path.dirname((job.get("result") or {}).get("out_path") or "")


def script_work_dir(jid: str) -> tuple:
    """The job and its folder, or the right HTTP error.

    Shared: redub in app/api/dub.py starts from it, and every route in
    app/api/script.py does too.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail=t("This project has no finished script yet."))
    return job, os.path.dirname(out)


def free_path(base: str, ext: str) -> str:
    """base+ext, or base-1+ext.. when that name is taken. Never writes over."""
    cand = base + ext
    n = 0
    while os.path.exists(cand):
        n += 1
        cand = "%s-%d%s" % (base, n, ext)
    return cand


@contextmanager
def ratio_errors_as_http():
    """app/ratio.py's plain errors as the answers the routes have always given:
    a shape the Ratio menu does not offer is a 422, a video that could not be
    measured or put in its canvas a 503, each in the error's own words."""
    try:
        yield
    except ratio.UnknownRatioError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ratio.CanvasError as e:
        raise HTTPException(status_code=503, detail=str(e))


def dub_media(path: str) -> Optional[str]:
    """What a file that has just come in for dubbing is, as the held record
    and the job's record say it: "audio" for sound with no picture, None for a
    video.

    The file itself decides, here and nowhere else; its name is not read. Any
    file with a picture is a video, as it always was: the Dub Agent sends
    .mkv, .webm and .avi too (app/mcp_server.py list_videos). Sound with no
    picture has to be in one of the four containers a dubbing takes (WAV,
    FLAC, MP3, M4A: media.audio_format). Anything else, an .ogg or made-up
    bytes, is refused with 422 and one sentence.
    """
    kind = media.media_kind(path)
    if kind is None or (kind == "audio" and media.audio_format(path) is None):
        raise HTTPException(422, t("Only MP4 or MOV video and WAV, FLAC, MP3 or M4A audio can be used."))
    return "audio" if kind == "audio" else None


def same_media(job: dict) -> dict:
    """A job made again from an audio project is an audio project, and so is
    the draft opened on it again: its input.mp4 is copied as it is, and what
    that file is was settled when it first came in. A video's record says
    nothing, and neither does its copy."""
    return {"media": job["media"]} if job.get("media") else {}


def require_video(path: str) -> None:
    """Refuse a file that has no picture. For the tools that work on one:
    Erase subtitles, Captions and cutting a clip, which a dubbing's audio
    files must not reach. The caller clears whatever it copied first."""
    if media.media_kind(path) != "video":
        raise HTTPException(422, t("This tool takes video files only."))


def check_trim(trim_start, trim_end) -> None:
    """A trim is both ends or neither, and long enough to be a video at all.

    Half a range means nothing, and a backwards one would produce an empty
    video minutes later -- both are caught here, before anything is saved.
    isfinite keeps out inf and nan, which would otherwise reach ffmpeg as
    "-to inf"; the half-second floor is the same one the screen's handles
    enforce, so both sides agree on what counts as a trim.
    """
    if (trim_start is None) != (trim_end is None):
        raise HTTPException(400, t("Send both trim_start and trim_end, or neither."))
    if trim_start is not None and not (
        math.isfinite(trim_start) and math.isfinite(trim_end)
        and trim_start >= 0 and trim_end - trim_start >= 0.5
    ):
        raise HTTPException(
            400,
            t("The trim must start at 0 seconds or later and keep at least half a second of video."),
        )


def parse_ranges(raw: Optional[str]):
    """The kept parts of a video cut on the timeline, checked: a JSON list of
    [start, end] pairs in seconds, in order, not overlapping, each at least a
    tenth of a second and half a second between them. None when none was sent.
    """
    if raw is None or not raw.strip():
        return None
    bad = HTTPException(400, t("The kept parts must be pairs of seconds, in order, "
                               "each at least 0.1s and at least 0.5s in all."))
    try:
        ranges = [[float(a), float(b)] for a, b in json.loads(raw)]
    except (ValueError, TypeError):
        raise bad
    prev_end = 0.0
    for a, b in ranges:
        if not (math.isfinite(a) and math.isfinite(b)) or a < prev_end or b - a < 0.1:
            raise bad
        prev_end = b
    if not ranges or sum(b - a for a, b in ranges) < 0.5:
        raise bad
    return ranges


def check_ranges_fit(ranges, video_path: str) -> None:
    """The last kept part must end inside the video (a hair of rounding allowed)."""
    try:
        seconds = media.video_duration(video_path)
    except Exception:
        return   # ffmpeg itself will say what is wrong with the file
    if ranges[-1][1] > seconds + 0.05:
        raise HTTPException(400, t("The kept parts run past the end of the video ({seconds}s).",
                                  seconds=f"{seconds:.1f}"))


def cut_to_kept_parts(work, video_path, trim_start, trim_end, kept, *, cut_video, cut_ranges,
                      check_fit) -> None:
    """Cut a new job's own copy of its video (video_path, in folder `work`)
    down to the part kept: a trim, or several parts (`kept`) joined into one.
    The held or uploaded file itself is never touched.

    A cut that fails drops the folder and answers 400 with the reason, as
    does a kept part past the end of the video (check_fit's own 400): no job
    record points at that folder yet, so nothing would ever come back to
    clear it, and the next try would land in _001. The router hands in its
    own cut_video, cut_ranges and check_fit, the names its tests replace.
    """
    if trim_start is not None:
        try:
            cut_video(video_path, trim_start, trim_end)
        except RuntimeError as e:
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))
    if kept is not None:
        try:
            check_fit(kept, video_path)
            cut_ranges(video_path, kept)
        except HTTPException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        except RuntimeError as e:
            shutil.rmtree(work, ignore_errors=True)
            raise HTTPException(400, str(e))
