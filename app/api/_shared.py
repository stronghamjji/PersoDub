"""The one helper both api routers need.

app/api/results.py names an .srt and a subtitled .mp4 with it, app/api/clips.py
names a clip with it. Here rather than in either of them so neither router has
to import the other.
"""
import os


def free_path(base: str, ext: str) -> str:
    """base+ext, or base-1+ext.. when that name is taken. Never writes over."""
    cand = base + ext
    n = 0
    while os.path.exists(cand):
        n += 1
        cand = "%s-%d%s" % (base, n, ext)
    return cand
