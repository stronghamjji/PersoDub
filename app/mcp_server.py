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
    translation), estimated (how long the translation takes to say), and fits (true
    when estimated lands inside the slot).
    """
    job = _job(job_id)
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

    Feeding that file back into PersoDub as a ready-made translated subtitle skips
    transcription and translation, and makes the voices again from this script.
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
