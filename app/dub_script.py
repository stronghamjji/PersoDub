# -*- coding: utf-8 -*-
"""Reading, measuring and editing one job's dubbing script.

Knows nothing about MCP or HTTP -- app/mcp_server.py only calls these functions.
That keeps the tests pure logic over files, with no external service running
(docs/development.md).

The files this works with, all inside one job's work dir:
  original.srt    the source script, kept by app/pipeline.py just before the
                  translation overwrites it in place
  translated.srt  the script the dub actually read. Never edited.
  edited.srt      the edited script. Absent until something is edited.
"""
import os
from typing import List, Optional

from app.text.cues import match_cue_index
from app.text.length_fit import in_window
from app.text.srt import Cue, estimate_seconds, parse_srt

ORIGINAL_NAME = "original.srt"
DUB_NAME = "translated.srt"
EDITED_NAME = "edited.srt"


def _read_cues(path: str) -> List[Cue]:
    """Parse an SRT file, or return nothing at all if it is not there."""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return parse_srt(f.read())


def script_path(work_dir: str) -> str:
    """The script that currently counts: the edited one if it exists, else the dubbed one."""
    edited = os.path.join(work_dir, EDITED_NAME)
    if os.path.exists(edited):
        return edited
    return os.path.join(work_dir, DUB_NAME)


def load_lines(work_dir: str, lang: str) -> List[dict]:
    """One entry per script line, each carrying the source line that overlaps it in time.

    Pairing is by time, not by line number: sentence splitting and time borrowing run
    after translation (app/pipeline.py:235-237), so the two files can have different
    line counts. app.text.cues.match_cue_index finds the source line a given line's
    midpoint falls inside -- one source split into two translated lines leaves both
    halves pointing at the same source.
    """
    path = script_path(work_dir)
    if not os.path.exists(path):
        raise FileNotFoundError("this job has no script: %s" % path)

    cues = _read_cues(path)
    originals = _read_cues(os.path.join(work_dir, ORIGINAL_NAME))

    lines = []
    for n, c in enumerate(cues, start=1):
        slot = round(c["end"] - c["start"], 2)
        estimated = round(estimate_seconds(c["text"], lang), 2)
        k = match_cue_index(c, originals) if originals else None
        lines.append({
            "line": n,
            "start": round(c["start"], 2),
            "end": round(c["end"], 2),
            "slot": slot,
            "source": originals[k]["text"] if k is not None else None,
            "text": c["text"],
            "estimated": estimated,
            "fits": in_window(estimated, slot),
        })
    return lines
