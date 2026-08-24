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
from app.text.srt import Cue, build_srt, estimate_seconds, parse_srt

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


def edit_line(work_dir: str, line: int, text: str, lang: str) -> dict:
    """Rewrite line number `line` (1-based) as `text`, and report that line back.

    Always writes to edited.srt. translated.srt is the record of what the dub actually
    read -- overwrite it and there is nothing left to compare an edit against.
    Timing is never touched: shifting a line pulls the voice out of sync with the mouth.
    """
    cues = _read_cues(script_path(work_dir))
    if not cues:
        raise FileNotFoundError("this job has no script: %s" % work_dir)
    if not 1 <= line <= len(cues):
        raise ValueError(
            "there is no line %d -- this script runs from line 1 to %d" % (line, len(cues))
        )

    cues[line - 1]["text"] = text
    with open(os.path.join(work_dir, EDITED_NAME), "w", encoding="utf-8") as f:
        f.write(build_srt(cues))

    return load_lines(work_dir, lang)[line - 1]


def export_srt(work_dir: str, out_path: str) -> str:
    """Copy the script that currently counts to out_path, and return that path.

    Feeding this file back in as a ready-made translated SRT (app/main.py:303) skips
    transcription and translation, so only the voices are made again.
    """
    src = script_path(work_dir)
    if not os.path.exists(src):
        raise FileNotFoundError("this job has no script: %s" % work_dir)
    with open(src, encoding="utf-8-sig") as f:
        body = f.read()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(body)
    return out_path
