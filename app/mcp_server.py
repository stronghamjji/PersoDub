# -*- coding: utf-8 -*-
"""A small program that hands PersoDub's script tools to a terminal AI over MCP.

Not a web server. It talks over stdin/stdout only, on this machine, and dies with
whatever started it. Nothing leaves the machine.

Run it with:
    PERSODUB_API=http://127.0.0.1:8000 python -m app.mcp_server

See docs/superpowers/specs/2026-08-20-앱내터미널-설계.md for wiring it into a
terminal tool.

What is not here cannot be reached. Changing settings and deleting files are
deliberately absent. Starting a dub (queue_dub) exists since 2026-09-01, behind
the same confirm gate as every other spending tool: nothing starts until the
user has been asked and agreed.
"""
import math
import os
from datetime import datetime
from typing import List, Optional

import httpx
from mcp.server.mcpserver import MCPServer

from app.config import LANGUAGE_NAMES
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

    This and remake_line_voice respeak only THIS job's own lines. (Starting a
    whole new dub is queue_dub's job, behind its own confirm gate; cancelling
    one and changing settings are still not reachable.)

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


@mcp.tool()
def extract_subtitles(video_path: str, engine: str = "",
                      confirm: bool = False) -> dict:
    """Pull the spoken lines out of ANY video file on this computer into a
    subtitle file (.srt).

    Not tied to a job: video_path is a file the user names (e.g. a video in
    their Downloads folder). The .srt is written next to the video with the
    same name, and an existing file is never written over.

    engine is the user's choice, never yours: "local" (free -- Whisper on
    this machine) or "perso" (paid -- Perso's cloud STT, better quality,
    about 1 credit per 5 seconds). When the user has not said which, ask
    them and call again. "local" runs at once and costs nothing. "perso"
    called without confirm=true spends nothing and returns the estimated
    cost: relay that message to the user as a question, and call again with
    confirm=true only after they clearly agree.
    """
    if engine not in ("local", "perso"):
        raise ValueError('Ask the user which engine to use first: "local" '
                         '(free, this machine) or "perso" (paid, better quality).')
    if engine == "perso" and not confirm:
        r = httpx.get("%s/api/subtitles/estimate" % API,
                      params={"video_path": video_path, "engine": "perso"},
                      timeout=60.0)
        if r.status_code in (404, 422):
            raise ValueError(r.json().get("detail", "cannot read that video"))
        r.raise_for_status()
        est = r.json()
        balance = est.get("credits_balance")
        message = ("Extracting subtitles from this video (%.0fs) will spend "
                   "about %d Perso credits%s. Proceed?"
                   % (est.get("seconds", 0), est.get("credits_estimate", 0),
                      "" if balance is None else " (balance: %s)" % balance))
        return {"needs_confirmation": True, "message": message, "estimate": est}
    r = httpx.post("%s/api/subtitles/extract" % API,
                   json={"video_path": video_path, "engine": engine},
                   timeout=3600.0)
    if r.status_code in (404, 409, 422, 503):
        raise ValueError(r.json().get("detail", "could not extract subtitles"))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def queue_dub(video_path: str, target_language: str, dub_mode: str = "local",
              source_language: str = "", num_speakers: Optional[int] = None,
              translator: str = "", confirm: bool = False) -> dict:
    """Put ONE video into PersoDub's dubbing queue.

    target_language (and optional source_language, else auto-detected) are
    codes: en ko zh fr de it ja pt ru es. dub_mode is the user's choice:
    "local" (free, dubbed on this machine, one at a time in the queue) or
    "perso" (paid -- Perso's cloud, about 1 credit per SECOND of video,
    starts at once without waiting in the local line).

    NOTHING STARTS UNASKED. Called without confirm=true it starts nothing
    and returns the video's length and, for perso, the estimated credits and
    balance: relay that to the user as a question and call again with
    confirm=true only after they clearly agree. For SEVERAL videos, gather
    every estimate first, ask the user ONCE with the total, then call each
    with confirm=true -- never ask five separate questions.

    translator picks the translation engine for a local dub when the user
    names one -- "gemma" or "hunyuan" (on this machine) or "gemini" (Google's
    API); empty keeps the app's default. If starting fails because a local
    model is not installed, say so and offer gemini.

    Returns {"job_id", "status"}; the home screen's Up next card shows the
    queue, and get_job_status follows one job.
    """
    if dub_mode not in ("local", "perso"):
        raise ValueError('dub_mode must be "local" or "perso"')
    if translator not in ("", "gemma", "hunyuan", "gemini"):
        raise ValueError('translator must be "gemma", "hunyuan", "gemini" or empty')
    code = (target_language or "").lower()
    if code not in LANGUAGE_NAMES:
        raise ValueError("target_language must be one of: %s"
                         % " ".join(sorted(LANGUAGE_NAMES)))
    path = os.path.expanduser(video_path)
    if not confirm:
        # The estimate route already measures the video and, for perso, the
        # balance. Dubbing costs ~1 credit per second (the route's own figure
        # is STT's 1-per-5s, so only seconds and balance are read from it).
        r = httpx.get("%s/api/subtitles/estimate" % API,
                      params={"video_path": video_path,
                              "engine": "perso" if dub_mode == "perso" else "local"},
                      timeout=60.0)
        if r.status_code in (404, 422):
            raise ValueError(r.json().get("detail", "cannot read that video"))
        r.raise_for_status()
        est = r.json()
        seconds = est.get("seconds", 0)
        if dub_mode == "perso":
            balance = est.get("credits_balance")
            message = ("Dubbing this video (%.0fs) on Perso will spend about "
                       "%d credits%s. Proceed?"
                       % (seconds, math.ceil(seconds),
                          "" if balance is None else " (balance: %s)" % balance))
        else:
            message = ("Dubbing this video (%.0fs) runs free on this machine "
                       "and takes a while; queued dubs run one at a time. "
                       "Proceed?" % seconds)
        return {"needs_confirmation": True, "message": message,
                "seconds": seconds}
    if not os.path.isfile(path):
        raise ValueError("No such video: %s" % video_path)
    fields = {"language": LANGUAGE_NAMES[code], "language_code": code}
    if dub_mode == "perso":
        fields["dub_mode"] = "perso"
    if source_language:
        fields["source_language_code"] = source_language.lower()
    if num_speakers:
        fields["num_speakers"] = str(num_speakers)
    if translator and dub_mode == "local":
        fields["translate_engine"] = translator
    with open(path, "rb") as f:
        r = httpx.post("%s/api/dub/start" % API, data=fields,
                       files={"video": (os.path.basename(path), f, "video/mp4")},
                       timeout=600.0)
    if r.status_code in (400, 404, 409, 422, 507):
        detail = r.json().get("detail", "could not start this dub")
        raise ValueError(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def list_videos(folder: str) -> dict:
    """List the video files in ONE folder on this computer, newest first.

    folder is a path the user names (e.g. "~/Downloads"). Only video files
    are listed (.mp4 .mov .mkv .webm .avi), nothing is opened or changed, and
    subfolders are not entered. Each entry carries name, path (hand this to
    the other tools), size_mb and modified. This plus the user's word is how
    "the second one" or "the newest one" becomes a real file path.
    """
    root = os.path.expanduser(folder)
    if not os.path.isdir(root):
        raise ValueError("No such folder: %s" % folder)
    exts = (".mp4", ".mov", ".mkv", ".webm", ".avi")
    videos = []
    for entry in os.scandir(root):
        # "._x" is macOS metadata litter, "." anything is hidden -- neither is
        # a video the user means.
        if not entry.is_file() or entry.name.startswith("."):
            continue
        if not entry.name.lower().endswith(exts):
            continue
        st = entry.stat()
        videos.append({
            "name": entry.name,
            "path": entry.path,
            "size_mb": round(st.st_size / (1024 * 1024), 1),
            # The full timestamp orders; the rounded one is what is shown.
            "_mtime": st.st_mtime,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    videos.sort(key=lambda v: v.pop("_mtime"), reverse=True)
    # A folder of thousands would drown the conversation; the newest 100 is
    # every realistic ask, and the count says when there were more.
    return {"folder": root, "total": len(videos), "videos": videos[:100]}


@mcp.tool()
def cut_clip(video_path: str, start: str, end: str) -> dict:
    """Cut one stretch of a video file into a NEW video file beside it.

    Free and local (ffmpeg on this machine) -- no Perso, no credits, no
    confirmation needed. start and end take seconds ("85") or colon timecodes
    ("1:25", "0:01:25"). The original video is never touched, and an existing
    file is never written over. Returns the new clip's path and length.
    """
    r = httpx.post("%s/api/clips/cut" % API,
                   json={"video_path": video_path, "start": start, "end": end},
                   timeout=600.0)
    if r.status_code in (404, 422, 503):
        raise ValueError(r.json().get("detail", "could not cut this video"))
    r.raise_for_status()
    return r.json()


if __name__ == "__main__":
    mcp.run(transport="stdio")


@mcp.tool()
def cancel_dub(job_id: str, confirm: bool = False) -> dict:
    """Cancel ONE dub: take a waiting job out of the line, or stop a running one.

    A WAITING (queued) job leaves the line at once and loses nothing, so the
    user's ask is confirmation enough. A RUNNING job loses the minutes it has
    already dubbed: called without confirm=true this stops nothing and returns
    the job's name for you to put to the user as a question -- call again with
    confirm=true only after they clearly agree. A job that already ended
    (done/error/cancelled) has nothing left to stop. Job ids come from
    queue_dub and get_job_status.
    """
    job = _job(job_id)
    status = job.get("status")
    if status in ("done", "error", "cancelled"):
        raise ValueError("nothing to cancel: this job is already %s" % status)
    if status != "queued" and not confirm:
        return {"needs_confirmation": True,
                "message": 'Stop the running dub "%s"? The dubbing it has '
                           "done so far is thrown away. Proceed?"
                           % (job.get("project") or job_id)}
    r = httpx.post("%s/api/dub/jobs/%s/cancel" % (API, job_id), timeout=30.0)
    if r.status_code in (404, 409):
        detail = r.json().get("detail", "cannot cancel this job")
        raise ValueError(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()
    return r.json()
