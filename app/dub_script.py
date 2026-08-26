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
  speakers.json   who speaks when, as [{start, end, speaker}], written beside
                  original.srt. Absent on jobs made before 2026-08-26.
"""
import json
import os
import wave
from typing import List, Optional

from app.text.cues import match_cue_index
from app.text.length_fit import in_window
from app.text.srt import Cue, build_srt, estimate_seconds, parse_srt

ORIGINAL_NAME = "original.srt"
DUB_NAME = "translated.srt"
EDITED_NAME = "edited.srt"
SPEAKERS_NAME = "speakers.json"


def _read_cues(path: str) -> List[Cue]:
    """Parse an SRT file, or return nothing at all if it is not there."""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return parse_srt(f.read())


def _read_speakers(work_dir: str) -> List[dict]:
    """The speaker spans, or nothing at all if this job never recorded them."""
    path = os.path.join(work_dir, SPEAKERS_NAME)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def line_wav_path(work_dir: str, line: int) -> str:
    """Where the voice made for script line `line` (1-based) lives.

    Script lines are numbered from 1 and the synthesizer writes them from 0
    (app/qwen_pipeline.py: qwen_line_<i>.wav), so line N is file N-1. One place
    says so, because two copies of an off-by-one rule drift apart.
    """
    return os.path.join(work_dir, "qwen_line_%d.wav" % (line - 1))


def _audio_seconds(path: str) -> Optional[float]:
    """How long a voice wav runs, or None if it is missing or unreadable.

    A wav that is still being written back (a line being remade) has no
    readable length yet.
    """
    if not os.path.exists(path):
        return None
    try:
        with wave.open(path, "rb") as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except (wave.Error, EOFError):
        return None


def _voice_is_older_than(wav_path: str, script: str) -> bool:
    """True when this line's voice was made before the script was last written.

    The script file is rewritten whole on every edit, so this answers "has
    anything been rewritten since this voice was made" -- it is the caller's job
    to ask it only about lines whose words actually changed. Neither file there
    means there is nothing to compare, which counts as not stale.
    """
    if not os.path.exists(wav_path) or not os.path.exists(script):
        return False
    return os.path.getmtime(wav_path) < os.path.getmtime(script)


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

    voice_stale compares file times, and the script file is rewritten whole on
    every edit -- so it says "made before the last edit of anything", and only
    means "this line's voice is out of date" for a line whose words changed.
    """
    path = script_path(work_dir)
    if not os.path.exists(path):
        raise FileNotFoundError("this job has no script: %s" % path)

    cues = _read_cues(path)
    originals = _read_cues(os.path.join(work_dir, ORIGINAL_NAME))
    speakers = _read_speakers(work_dir)

    lines = []
    for n, c in enumerate(cues, start=1):
        slot = round(c["end"] - c["start"], 2)
        estimated = round(estimate_seconds(c["text"], lang), 2)
        k = match_cue_index(c, originals) if originals else None
        # The speaker spans carry the same timings as the source lines, so they
        # are paired the same way -- by midpoint, not by line number.
        s = match_cue_index(c, speakers) if speakers else None
        wav = line_wav_path(work_dir, n)
        lines.append({
            "line": n,
            "start": round(c["start"], 2),
            "end": round(c["end"], 2),
            "slot": slot,
            "source": originals[k]["text"] if k is not None else None,
            "text": c["text"],
            "estimated": estimated,
            "fits": in_window(estimated, slot),
            "speaker": speakers[s]["speaker"] if s is not None else None,
            "audio_sec": _audio_seconds(wav),
            "voice_stale": _voice_is_older_than(wav, path),
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


def _inside_job(work_dir: str, out_path: str) -> str:
    """out_path as an absolute path, refused if it lands outside the job folder.

    This is the one tool the assistant has that names its own destination, and
    an assistant reaches it through MCP -- a separate process, so nothing the
    CLI's own sandbox does can see this write. A relative name is taken as
    relative to the job; an absolute one is allowed only if it is still in
    there. "../../.zshrc" and "/etc/hosts" are not.
    """
    base = os.path.realpath(work_dir)
    # join leaves an absolute out_path alone, which is what makes the check
    # cover both spellings.
    full = os.path.realpath(os.path.join(base, out_path))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError(
            "a script can only be written inside its own job folder, and %s is "
            "outside it -- give a plain file name instead" % out_path
        )
    return full


def export_srt(work_dir: str, out_path: str) -> str:
    """Copy the script that currently counts to out_path, and return that path.

    Feeding this file back in as a ready-made translated SRT (app/main.py:303) skips
    transcription and translation, so only the voices are made again.
    """
    out_path = _inside_job(work_dir, out_path)
    src = script_path(work_dir)
    if not os.path.exists(src):
        raise FileNotFoundError("this job has no script: %s" % work_dir)
    with open(src, encoding="utf-8-sig") as f:
        body = f.read()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(body)
    return out_path
