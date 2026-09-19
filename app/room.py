"""Can this computer finish the dub? Room on disk and memory, asked when a dub
starts and again before each of its stages.

A dub that cannot finish should say so up front, with numbers, instead of
failing deep inside a stage with a half-written folder (owner, 2026-09-19).
Read by app/api/dub.py's start and by app/pipeline.py between stages -- one
place, so the two cannot disagree about what a job needs.

A reading the computer will not give (a disk or a memory size) is never a
reason to refuse: every check below lets the job go when it cannot tell.
"""
import os
import sys

from app import models as model_store

GB = 1024 ** 3

# A dub keeps its per-line voices (app/pipeline.py), which is what makes
# redoing a single line possible -- and what makes a job need room. Measured on
# a real job 2026-08-21: the intermediates were about 61% of the folder. The
# floor every job gets, whatever its size, and all a link that is not
# downloaded yet can be judged by.
FLOOR = 3 * GB
# Per minute of video: vocals.wav and background.wav are 11.5 MB each (48k
# 16-bit stereo), the dub bed 11.7, the takes and the rest about 15 -- 0.05 GB,
# rounded up for what was not counted.
PER_MINUTE = 0.08 * GB
MARGIN = 1 * GB

# Total memory, never free: free memory reads 0.09 GB on a healthy 24 GB Mac in
# the middle of a dub, because the system keeps whatever is idle in use.
MIN_RAM = 7 * GB          # an "8 GB" computer reports a little under 8
SLOW_RAM = 12 * GB
SLOW_RAM_GEMMA = 16 * GB  # Gemma translates on this computer, beside the voice


def dub_need(video_bytes, seconds):
    """Bytes a whole dub of this video needs: the video, the finished dub about
    its size again, the audio made along the way, and a margin."""
    return int(2 * video_bytes + PER_MINUTE * (seconds or 0) / 60 + MARGIN)


def space_message(need, free):
    return "Not enough space. Needs %.1f GB, %.1f GB free." % (need / GB, free / GB)


def _folder_bytes(folder):
    total = 0
    for entry in os.scandir(folder):
        if entry.is_file():
            total += entry.stat().st_size
    return total


def short_of_room(work_dir, video_path, seconds, floor=0):
    """The sentence to stop with when the rest of this job will not fit, or None.

    What the whole job needs, less what its folder already holds: the video is
    in there already, and between stages so is everything made so far.
    Counting those again would stop a long dub halfway that would have fit.
    The floor is for a start only: between stages it would stop a short dub
    that needs a few hundred MB more because the disk is under 3 GB.
    """
    free = model_store.free_bytes_at(work_dir)
    if free is None:
        return None
    try:
        need = max(floor, dub_need(os.path.getsize(video_path), seconds)) - _folder_bytes(work_dir)
    except OSError:
        return None
    return space_message(need, free) if free < need else None


def total_ram_bytes():
    """This computer's memory in bytes, or None when it will not say."""
    try:
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                # DWORD is 32 bits on Windows, which c_ulong is there.
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return int(status.ullTotalPhys)
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except Exception:
        return None


def ram_refusal(total):
    """The sentence to refuse a dub on this computer with, or None."""
    if total is not None and total < MIN_RAM:
        return "This computer needs 8 GB of memory to dub."
    return None


def ram_warning(total, translator):
    """A note that the dub will run but slowly, or None. Never a refusal."""
    if total is None:
        return None
    if total < SLOW_RAM or (translator == "gemma" and total < SLOW_RAM_GEMMA):
        return "This may be slow on this computer."
    return None
