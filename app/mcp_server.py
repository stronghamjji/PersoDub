# -*- coding: utf-8 -*-
"""A small program that hands PersoDub's script tools to a terminal AI over MCP.

Not a web server. It talks over stdin/stdout only, on this machine, and dies with
whatever started it. Nothing leaves the machine.

Run it with:
    PERSODUB_API=http://127.0.0.1:8000 python -m app.mcp_server

See docs/superpowers/specs/2026-08-20-앱내터미널-설계.md for wiring it into a
terminal tool.

What is not here cannot be reached. Starting or cancelling a dub, changing settings
and deleting files are deliberately absent -- anything that spends the GPU and a lot
of time stays behind a button a person presses.
"""
import os
from typing import List, Optional

import httpx
from mcp.server.mcpserver import MCPServer

from app.dub_script import edit_line, export_srt, load_lines

API = os.environ.get("PERSODUB_API", "http://127.0.0.1:8000")

mcp = MCPServer(
    name="persodub",
    instructions=(
        "Tools for reading and rewriting a PersoDub dubbing script. In PersoDub a "
        "script is not on-screen subtitles -- it is what a voice actor reads, so "
        "changing the words changes the audio. Every line has a fixed slot of time, "
        "and a line too long to be spoken inside it has fits=false."
    ),
)


def _job(job_id: str) -> dict:
    """Ask the app server about a job."""
    r = httpx.get("%s/api/dub/jobs/%s" % (API, job_id), timeout=10.0)
    if r.status_code == 404:
        raise ValueError("no such job: %s" % job_id)
    r.raise_for_status()
    return r.json()


def _work_dir(job: dict) -> str:
    """A job's workspace folder.

    The folder name and the job id are two unrelated random strings (app/main.py:374
    and :379), so the folder cannot be derived from the id -- it is read back out of
    the result path, the same way app/main.py:516 does it.
    """
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise ValueError("this job has no result yet (status: %s)" % job.get("status"))
    return os.path.dirname(out)


def _lang(job: dict) -> str:
    """The dub's target language, stamped onto the job by app/main.py:396."""
    return job.get("language_code") or "en"


@mcp.tool()
def get_script(job_id: str) -> List[dict]:
    """Return the dubbing script line by line.

    Each line carries: line (its number), start/end (seconds), slot (the time this
    line has to be spoken in), source (the original-language line), text (the current
    translation), estimated (how long the translation takes to say), fits (true
    when estimated lands inside the slot), speaker (who says it, or null when this
    job recorded no speakers), audio_sec (how long the voice made for it actually
    runs, or null when that file is gone), and voice_stale (true when that voice
    was made before the script was last written -- so a line whose words you
    changed still sounds like the old ones until remake_line_voice runs).
    """
    job = _job(job_id)
    if job.get("dub_mode") == "perso":
        # A Perso dub's lines live on Perso's side; the app's own script
        # endpoint mirrors them (read-only for now -- see change_speaker).
        r = httpx.get("%s/api/dub/jobs/%s/script" % (API, job_id), timeout=60.0)
        if r.status_code in (404, 503):
            raise ValueError(r.json().get("detail", "no script for this job"))
        r.raise_for_status()
        return r.json()["lines"]
    return load_lines(_work_dir(job), _lang(job))


@mcp.tool()
def edit_script_line(job_id: str, line: int, text: str) -> dict:
    """Replace one line's words. Timing is left alone.

    What the dub actually read (translated.srt) is never touched -- edits are kept
    separately. Returns the edited line, so its fits tells you at once whether the
    new wording is short enough.
    """
    job = _job(job_id)
    return edit_line(_work_dir(job), line, text, _lang(job))


@mcp.tool()
def check_fit(job_id: str, line: Optional[int] = None) -> List[dict]:
    """Measure whether lines can be spoken inside the time they have.

    With a line number, reports just that line; without one, reports every line that
    does not fit.
    """
    job = _job(job_id)
    lines = load_lines(_work_dir(job), _lang(job))
    if line is not None:
        if not 1 <= line <= len(lines):
            raise ValueError(
                "there is no line %d -- this script runs from line 1 to %d" % (line, len(lines))
            )
        return [lines[line - 1]]
    return [ln for ln in lines if not ln["fits"]]


@mcp.tool()
def export_script(job_id: str, out_path: str) -> str:
    """Write the current script out to a file and return that path.

    out_path is a file name inside this job's own folder (e.g. "script.srt");
    paths outside the job folder, and the folder itself, are refused with a
    ValueError. Feeding that file back into PersoDub as a ready-made translated
    subtitle skips transcription and translation, and makes the voices again
    from this script.
    """
    job = _job(job_id)
    return export_srt(_work_dir(job), out_path)


@mcp.tool()
def get_job_status(job_id: str) -> dict:
    """Where the job is now, whether it finished, and what happened along the way."""
    job = _job(job_id)
    return {
        "status": job.get("status"),
        "error": job.get("error"),
        "notices": job.get("notices") or [],
        "logs": (job.get("logs") or [])[-20:],
    }


@mcp.tool()
def remake_voices(job_id: str) -> dict:
    """Remake the voices of the lines whose words changed, and nothing else.

    Only lines whose text was rewritten since their voice was made are spoken
    again. Every other line keeps the voice it already has, the timings, the
    script and the job itself are untouched, and the finished video is rebuilt
    in place -- no new job and no second copy of the job's folder.

    Returns {"remade": [line numbers], "skipped": how many lines were left
    alone}; remade is empty when every voice is already up to date. The work is
    done by the time this answers -- seconds per changed line -- so there is
    nothing to poll afterwards.

    This is the whole-script version. To remake one particular line, changed or
    not, call remake_line_voice(job_id, line) instead.

    This and remake_line_voice are the only things here that spend real GPU
    time, and both are deliberately narrow: they can only respeak THIS job's own
    lines. Starting a new dub, cancelling one, or changing any setting is still
    not reachable.

    Added 2026-08-24, reversing the 2026-08-20 rule that every GPU-spending
    action stays behind a button. A user put it plainly: an assistant that
    rewrites a line and then asks the user to go press a button themselves is
    doing nothing they could not do alone.
    """
    r = httpx.post("%s/api/dub/jobs/%s/voices/stale" % (API, job_id), timeout=600.0)
    if r.status_code == 404:
        raise ValueError("no such job: %s" % job_id)
    if r.status_code in (409, 422):
        raise ValueError(r.json().get("detail", "this job's voices cannot be remade"))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def remake_line_voice(job_id: str, line: int) -> dict:
    """Speak ONE line again, in the same voice, and rebuild the dub around it.

    Use this for one named line -- including a line nobody edited, when its
    voice simply came out wrong. remake_voices does the same thing to every
    line whose words changed, which is the usual way to catch up after a batch
    of rewrites.
    """
    r = httpx.post("%s/api/dub/jobs/%s/script/%d/voice" % (API, job_id, line), timeout=600.0)
    if r.status_code in (404, 409, 422):
        raise ValueError(r.json().get("detail", "cannot remake line %d" % line))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def change_speaker(job_id: str, line: int, confirm: bool = False) -> dict:
    """Give ONE line of a Perso dub a NEW speaker (a fresh voice), on Perso's side.

    Perso dubs only. THIS MAY SPEND PERSO CREDITS. Called without confirm=true
    it does nothing but return the confirmation question: relay that message to
    the user, and call again with confirm=true only after they clearly agree.
    """
    if not confirm:
        return {
            "needs_confirmation": True,
            "message": ("Changing this line's speaker runs on Perso's side and "
                        "may spend Perso credits. Proceed?"),
        }
    r = httpx.post("%s/api/dub/jobs/%s/perso/speaker" % (API, job_id),
                   json={"line": line}, timeout=600.0)
    if r.status_code in (404, 409, 422):
        raise ValueError(r.json().get("detail", "cannot change line %d's speaker" % line))
    r.raise_for_status()
    return r.json()


if __name__ == "__main__":
    mcp.run(transport="stdio")
