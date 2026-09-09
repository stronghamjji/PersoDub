"""ffmpeg helpers: probe durations, mux, pad/trim to length, cut a clip.

Lowest layer -- imports nothing from app/ except config/logging.
"""
import os
import re
import subprocess
from typing import Callable


def stream_duration(path: str, stream: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", "stream=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    # ffmpeg 7.x appends a trailing comma to csv output -> strip it and convert to number
    return float(out.stdout.strip().splitlines()[0].rstrip(","))


def video_duration(path: str) -> float:
    return stream_duration(path, "v:0")


def video_size(path: str):
    """The video's pixel width and height, or (0, 0) when ffprobe will not say.

    For work described in the frame's own coordinates -- the band the subtitle
    eraser is pointed at, which app/mcp_server.py works out from words like
    "bottom". Zeros rather than a guessed size: a band measured against the
    wrong frame would clean the wrong part of the picture, so the caller has
    to be told instead.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    try:
        w, h = (int(x) for x in out.stdout.strip().split(",")[:2])
    except ValueError:
        return 0, 0
    return w, h


def mux(video: str, audio: str, out: str, dur: float) -> subprocess.CompletedProcess:
    """Re-mux a video track with an audio track, padding the audio to `dur` seconds.

    The video stream is copied untouched (-c:v copy); only the audio is (re)encoded.
    """
    return subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio,
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
         "-b:a", "256k", "-af", "apad", "-t", f"{dur:.3f}", out],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def ensure_video_length(original_video: str, out_path: str, log: Callable[[str], None]) -> None:
    """🔒 Absolute guarantee: if the output video length differs from the original, rebuild using the original video untouched.

    The Qwen dub export can come out shorter than the video (audio ends first). In that
    case, re-mux the original video track + dubbed audio (silence-padded at the end)
    into a finished file where not a single video frame has been touched.
    """
    try:
        d_orig = video_duration(original_video)
        d_out = video_duration(out_path)
    except Exception as e:
        log(f"   Warning: Length check failed ({str(e)[:60]}) — using the export result as is")
        return
    if abs(d_orig - d_out) <= 0.02:
        return
    log(f"   Video length correction: {d_out:.3f}s → {d_orig:.3f}s (lossless rebuild from original video)")
    tmp = out_path + ".fix.mp4"
    r = mux(original_video, out_path, tmp, d_orig)
    if r.returncode == 0 and os.path.exists(tmp):
        os.replace(tmp, out_path)
    else:
        log(f"   Warning: Length correction failed — keeping the export result ({r.stderr[-80:]})")


def cut_video(path: str, start: float, end: float, on_cut=None) -> None:
    """Keep only [start, end] of the video, in place. Re-encodes so the cut is
    exact (a copy-cut lands on the nearest keyframe, seconds away).

    `on_cut` runs the instant the cut file takes the original's place, before
    anything else can happen. That is where a caller records "this video is cut
    now": recording it a statement later leaves a window where a force-quit
    saves a record that still owes a cut over a video that has already had one,
    and the next run would take the same seconds out twice.
    """
    tmp = path + ".cut.mp4"
    try:
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                            "-i", path, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", tmp],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            # Only ffmpeg's last line, which is the complaint itself. The lines
            # before it name the input file, so a tail of the whole thing put the
            # user's folders on screen (and into a bug report) for nothing.
            last = ([ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip()] or [""])[-1]
            # ffmpeg names files by their full path even in that last line, so
            # each one is cut back to its own name: the user learns which file
            # upset it without their folders ending up on screen.
            last = re.sub(r"\S*/(\S+)", r"\1", last)
            raise RuntimeError(("Could not trim the video: " + last) if last
                               else "Could not trim the video.")
        os.replace(tmp, path)
        if on_cut is not None:
            on_cut()
    finally:
        # A cut that died with the output already open (out of disk, a killed
        # encoder) would otherwise leave a half-written .cut.mp4 beside a good
        # input.mp4, in a folder the pipeline later walks.
        if os.path.exists(tmp):
            os.remove(tmp)
