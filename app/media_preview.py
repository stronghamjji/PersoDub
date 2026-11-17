"""The timeline's pictures of a video: a film strip of small frames and the
loudness of its sound, each made once with ffmpeg and kept beside the video.

Two files, named after the video they describe:
  <video>.filmstrip.jpg  N frames of FRAME_W x FRAME_H side by side, evenly
                         spaced over the video (the screen reads N off the
                         image's width)
  <video>.waveform.json  {"rate": values per second, "duration": seconds,
                         "peaks": RMS loudness 0..1}

A kept file is used again only while it is newer than its video, so a video
cut in place (a link job's trim) is described afresh. Written under a
temporary name and renamed, so a reader never sees half a file, and every
ffmpeg run has a time limit scaled to the video.
"""
import json
import math
import os
import subprocess
import threading
from array import array
from operator import mul

from app import media
from app.i18n import t
from app.timeouts import scaled_timeout

FRAME_W, FRAME_H = 69, 39
MAX_FRAMES = 60
PX_PER_SEC = 77          # the timeline's scale at zoom 1
PEAKS_PER_SEC = 25
MAX_PEAKS = 6000         # an hour of video still answers in a few kilobytes
SAMPLE_RATE = 4000       # enough to see speech by, small enough to add up fast
# Past this, frames are taken from keyframes only: decoding every frame of a
# long video to keep sixty of them would take minutes.
KEYFRAMES_AFTER_SEC = 120

_locks = {}
_locks_guard = threading.Lock()


def _lock_for(path: str) -> threading.Lock:
    """One maker per file: two requests for the same strip wait for one run."""
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


def _fresh(cache: str, video: str) -> bool:
    return os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(video)


def _duration(video: str) -> float:
    try:
        return media.video_duration(video)
    except Exception:
        return 0.0


def frame_count(duration: float) -> int:
    """One frame per strip-width of timeline at zoom 1, at most MAX_FRAMES."""
    if duration <= 0:
        return 1
    return max(1, min(MAX_FRAMES, math.ceil(duration * PX_PER_SEC / FRAME_W)))


def filmstrip_command(video: str, out: str, duration: float) -> list:
    n = frame_count(duration)
    rate = n / duration if duration > 0 else 1
    # yuvj444p before the crop: in 4:2:0 a frame must be an even number of
    # pixels wide, and 69 would come out as 68.
    vf = (f"fps={rate:.6f},format=yuvj444p,"
          f"scale={FRAME_W}:{FRAME_H}:force_original_aspect_ratio=increase,"
          f"crop={FRAME_W}:{FRAME_H},tile={n}x1")
    skip = ["-skip_frame", "nokey"] if duration > KEYFRAMES_AFTER_SEC else []
    return ["ffmpeg", "-y", "-v", "error", *skip, "-i", video, "-an", "-vf", vf,
            "-frames:v", "1", "-q:v", "5", "-f", "image2", out]


def waveform_command(video: str) -> list:
    return ["ffmpeg", "-v", "error", "-i", video, "-vn", "-ac", "1",
            "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]


def peaks_from_pcm(pcm: bytes, duration: float) -> dict:
    """RMS per 1/25 s of 16-bit mono samples, scaled so the loudest is 1.

    A long video's values are merged (the loudest of each group) until there
    are at most MAX_PEAKS of them; `rate` says how many stand for a second.
    """
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    step = SAMPLE_RATE // PEAKS_PER_SEC
    rms = []
    for i in range(0, len(samples), step):
        w = samples[i:i + step]
        rms.append(math.sqrt(sum(map(mul, w, w)) / len(w)))
    group = max(1, math.ceil(len(rms) / MAX_PEAKS))
    if group > 1:
        rms = [max(rms[i:i + group]) for i in range(0, len(rms), group)]
    top = max(rms, default=0) or 1
    seconds = duration or len(samples) / SAMPLE_RATE
    return {"rate": round(len(rms) / seconds, 4) if seconds else PEAKS_PER_SEC,
            "duration": round(seconds, 3),
            "peaks": [round(v / top, 3) for v in rms]}


def _write_atomic(path: str, data: bytes) -> None:
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def filmstrip(video: str) -> str:
    """The film strip's path, made first when there is none (or an old one).
    An audio file has none, said the way an unreadable video is: ffmpeg would
    otherwise tile an album cover into one."""
    out = video + ".filmstrip.jpg"
    with _lock_for(out):
        if _fresh(out, video):
            return out
        if media.media_kind(video) == "audio":
            raise RuntimeError(t("Could not read frames from this video."))
        duration = _duration(video)
        tmp = f"{out}.{os.getpid()}.tmp.jpg"
        try:
            r = subprocess.run(filmstrip_command(video, tmp, duration),
                               capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=scaled_timeout(duration, 60))
            if r.returncode != 0 or not os.path.exists(tmp):
                raise RuntimeError(t("Could not read frames from this video."))
            os.replace(tmp, out)
        except subprocess.TimeoutExpired:
            raise RuntimeError(t("Reading frames from this video took too long."))
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        return out


def waveform(video: str) -> dict:
    """The sound's loudness, made first when there is none (or an old one).
    A video with no sound answers an empty list."""
    out = video + ".waveform.json"
    with _lock_for(out):
        if _fresh(out, video):
            with open(out, encoding="utf-8") as f:
                return json.load(f)
        duration = _duration(video)
        try:
            r = subprocess.run(waveform_command(video), capture_output=True,
                               timeout=scaled_timeout(duration, 60))
        except subprocess.TimeoutExpired:
            raise RuntimeError(t("Reading the sound of this video took too long."))
        # No audio stream: ffmpeg says "does not contain any stream" and exits 1.
        pcm = r.stdout if r.returncode == 0 else b""
        data = peaks_from_pcm(pcm, duration) if pcm else {
            "rate": PEAKS_PER_SEC, "duration": round(duration, 3), "peaks": []}
        _write_atomic(out, json.dumps(data, separators=(",", ":")).encode("utf-8"))
        return data

