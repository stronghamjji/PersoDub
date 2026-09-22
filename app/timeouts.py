"""One shared formula for "this subprocess's timeout should scale with the
video it's processing" -- used by app/separate.py, app/stt_local.py,
app/diar_campplus_client.py and app/nonverbal.py.

Each of those runs a heavy subprocess (Demucs, Whisper, CAM++, a whisper
veto) against a fixed ceiling that ignores how long the source video is --
the most frequent failure in the public issue tracker (21 occurrences): a
short clip and a feature-length video got the same wall.

Budget: separating a 31s clip measured 10s on an M4 Mac (0.32x realtime). A
CPU-only Windows laptop can run roughly 10x slower (~3.2x realtime worst
case); doubled again for headroom (older/busier machines, disk contention)
gives the ~6x realtime default below. Only separation has been measured --
the other three stages reuse the same number for lack of a better one.
"""
import os
from typing import Optional

# Env-overridable the way PERSODUB_DIAR_TIMEOUT already is.
try:
    PERSODUB_TIMEOUT_PER_SEC = float(os.environ.get("PERSODUB_TIMEOUT_PER_SEC", "6"))
except (TypeError, ValueError):
    PERSODUB_TIMEOUT_PER_SEC = 6.0
# Upper cap so a genuinely stuck subprocess still gets killed instead of
# hanging for a day.
try:
    PERSODUB_TIMEOUT_CAP = float(os.environ.get("PERSODUB_TIMEOUT_CAP", "10800"))
except (TypeError, ValueError):
    PERSODUB_TIMEOUT_CAP = 10800.0


def scaled_timeout(video_duration: Optional[float], floor: float) -> float:
    """The subprocess ceiling for a video this long.

    `floor` (the caller's own fixed default) when the duration is unknown or
    non-positive, so a failed ffprobe or a short video behaves exactly as
    before. Otherwise the length-scaled budget, never below `floor` and
    never above PERSODUB_TIMEOUT_CAP.
    """
    if not video_duration or video_duration <= 0:
        return floor
    return min(max(floor, video_duration * PERSODUB_TIMEOUT_PER_SEC), PERSODUB_TIMEOUT_CAP)
