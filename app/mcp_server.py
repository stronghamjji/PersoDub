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
import json
import math
import os
import time
from datetime import datetime
from typing import List, Optional, Union

import httpx
from mcp.server.mcpserver import MCPServer

from app import languages, media
from app.dub_script import edit_line, export_srt, load_lines

API = os.environ.get("PERSODUB_API", "http://127.0.0.1:8000")

# How long download_video waits for a link, and how often it asks. Ten minutes
# covers a long video on a slow line; past that the tool answers rather than
# holding the conversation open, and the download carries on without it.
DOWNLOAD_WAIT = 600
DOWNLOAD_POLL = 5


def _offline() -> ValueError:
    """The app itself is not answering. Every tool here talks to the local app
    over HTTP, so a refused connection means PersoDub is closed -- say so,
    instead of handing the assistant a raw connection error to guess at."""
    return ValueError("PersoDub is not running")


def _api_get(path: str, **kw):
    """GET one of the local app's routes. path starts with "/".

    Every httpx call in this file goes through here or _api_post, so the
    closed-app answer is the same wherever the assistant happens to knock
    (before 2026-09-06 only the three setup tools said it, and the other
    thirteen leaked a raw ConnectError). The url stays positional and the rest
    of the arguments pass through untouched -- the tests' fakes read it that
    way, and httpx is reached through the module attribute so monkeypatching
    mcp_server.httpx.get still bites.
    """
    try:
        return httpx.get(API + path, **kw)
    except httpx.ConnectError as e:
        raise _offline() from e


def _api_post(path: str, **kw):
    """POST one of the local app's routes. See _api_get."""
    try:
        return httpx.post(API + path, **kw)
    except httpx.ConnectError as e:
        raise _offline() from e


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
    r = _api_get("/api/dub/jobs/%s" % job_id, timeout=10.0)
    if r.status_code == 404:
        raise ValueError("no such job: %s" % job_id)
    r.raise_for_status()
    return r.json()


def _work_dir(job: dict) -> str:
    """A job's workspace folder.

    The folder name and the job id are two unrelated strings (app/api/dub.py's
    _job_dir names the folder after the title; JobStore.create makes the id),
    so the folder cannot be derived from the id -- it is read back out of the
    result path, the same way app/api/_shared.py's work_dir_of does it.
    """
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise ValueError("this job has no result yet (status: %s)" % job.get("status"))
    return os.path.dirname(out)


def _lang(job: dict) -> str:
    """The dub's target language, stamped onto the job record by app/api/dub.py
    (the language_code field it passes to launch_job)."""
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
        r = _api_get("/api/dub/jobs/%s/script" % job_id, timeout=60.0)
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
    """Where the job is now, whether it finished, and what happened along the way.

    A subtitle-erase job (erase_subtitles) also carries percent, done, the path
    of the cleaned video, and `check`: what the eraser found when it looked at
    its own work -- how many sampled frames of the finished video still hold
    writing, at what seconds, and how many it had to paint again. frames_with_text
    0 is the answer the user is after; anything else names the moments to look at.
    """
    job = _job(job_id)
    info = {
        "status": job.get("status"),
        "error": job.get("error"),
        "notices": job.get("notices") or [],
        "logs": (job.get("logs") or [])[-20:],
    }
    if job.get("kind") == "erase":
        r = _api_get("/api/erase/%s" % job_id, timeout=10.0)
        if r.status_code == 200:
            erase = r.json()
            info["percent"] = erase.get("percent")
            info["done"] = erase.get("done")
            info["result_path"] = (erase.get("result") or {}).get("out_path")
            info["check"] = erase.get("check")
    return info


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
    r = _api_post("/api/dub/jobs/%s/voices/stale" % job_id, timeout=600.0)
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
    r = _api_post("/api/dub/jobs/%s/script/%d/voice" % (job_id, line), timeout=600.0)
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
    r = _api_post("/api/dub/jobs/%s/perso/speaker" % job_id,
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
        r = _api_get("/api/subtitles/estimate",
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
    r = _api_post("/api/subtitles/extract",
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
    names one -- "hunyuan" or "gemma" (on this machine) or "gemini" (Google's
    API); empty keeps the app's default, Hunyuan. If starting fails because a
    model is not downloaded, the error names the model and its size: tell the
    user exactly that, and offer the two ways out it lists.

    Returns {"job_id", "status"}; the home screen's Up next card shows the
    queue, and get_job_status follows one job.
    """
    if dub_mode not in ("local", "perso"):
        raise ValueError('dub_mode must be "local" or "perso"')
    if translator not in ("", "gemma", "hunyuan", "gemini"):
        raise ValueError('translator must be "gemma", "hunyuan", "gemini" or empty')
    code = (target_language or "").strip()
    if languages.lookup(dub_mode, code) is None:
        known = [e["id"] for e in languages.languages_for(dub_mode)]
        raise ValueError("target_language must be one of: %s" % " ".join(sorted(known)))
    path = os.path.expanduser(video_path)
    if not confirm:
        # The estimate route already measures the video and, for perso, the
        # balance. Dubbing costs ~1 credit per second (the route's own figure
        # is STT's 1-per-5s, so only seconds and balance are read from it).
        r = _api_get("/api/subtitles/estimate",
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
    fields = {"language": languages.lookup(dub_mode, code)["name"], "language_code": code}
    if dub_mode == "perso":
        fields["dub_mode"] = "perso"
    if source_language:
        fields["source_language_code"] = source_language.lower()
    if num_speakers:
        fields["num_speakers"] = str(num_speakers)
    if translator and dub_mode == "local":
        fields["translate_engine"] = translator
    with open(path, "rb") as f:
        r = _api_post("/api/dub/start", data=fields,
                      files={"video": (os.path.basename(path), f, "video/mp4")},
                      timeout=600.0)
    if r.status_code in (400, 404, 409, 422, 507):
        detail = r.json().get("detail", "could not start this dub")
        raise ValueError(_dub_refusal_text(detail))
    r.raise_for_status()
    return r.json()


def _dub_refusal_text(detail) -> str:
    """The app's refusal, as a sentence the agent can repeat. A 409 for missing
    models arrives as {"missing": [{"name", "bytes"}, ...]}; relayed raw, the
    agent could only say "an error" (2026-09-04). Name what is missing and the
    two ways out: download it, or pick an engine this computer already has."""
    if isinstance(detail, str):
        return detail
    missing = detail.get("missing") if isinstance(detail, dict) else None
    if not missing:
        return str(detail)
    names = ", ".join("%s (%.1f GB)" % (m.get("name", m.get("id", "?")),
                                          (m.get("bytes") or 0) / 1e9) for m in missing)
    return ("Not downloaded on this computer: %s. Ask the user to download it in "
            "Settings > Models, or start with an engine that is already here "
            "(for example translator=\"hunyuan\", or dub_mode=\"perso\" with a Perso key)."
            % names)


@mcp.tool()
def get_setup() -> dict:
    """How the app is set up right now, stage by stage: which engine each
    stage uses when nobody chooses (dub_mode, separation, stt, translator,
    voice_quality), the choices each stage offers, every optional model with
    its download state (ready / downloading / paused / not_downloaded), how
    far a download has got (progress_text, e.g. "downloading 41%") and its
    size, and whether a Perso or Gemini key is saved. Read this before
    answering "what does each step use?", before changing a default, and to
    follow a download's progress.
    """
    r = _api_get("/api/setup", timeout=10.0)
    r.raise_for_status()
    data = r.json()
    for m in data.get("models", []):
        m["gb"] = round((m.get("bytes") or 0) / 1e9, 1)
        # state stays the app's own word (the same one download_model answers
        # with) -- the percentage rides alongside it, so the two tools never
        # describe the same model in two vocabularies.
        if m.get("state") == "downloading" and m.get("progress") is not None:
            m["progress_text"] = "downloading %d%%" % m["progress"]
    return data


@mcp.tool()
def set_default(stage: str, choice: str) -> dict:
    """Change what one stage uses from now on -- for every dub, from the
    screen or from here, no restart. stage is one of dub_mode (local |
    perso), separation (local | perso), stt (local | perso), translator
    (hunyuan | gemma | gemini), voice_quality (fast | high). Cloud choices
    need the matching key saved (see get_setup); a local model that is not
    downloaded is not a reason to refuse -- download_model handles that.
    Returns the defaults now in force.
    """
    r = _api_post("/api/setup", json={stage: choice}, timeout=10.0)
    if r.status_code in (422, 503):
        raise ValueError(r.json().get("detail", "could not change that setting"))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def download_model(model_id: str, confirm: bool = False) -> dict:
    """Download one optional model onto this computer (ids and sizes come
    from get_setup: whisper, qwen3-tts, gemma, hunyuan). Gigabytes, so the
    first call answers with the size and needs_confirmation=true -- put that
    to the user, and call again with confirm=true once they agree. Starts the
    download in the background and returns at once; get_setup shows the
    progress, and a dub that needs the model can be queued as soon as it
    reads ready.
    """
    r = _api_get("/api/models", timeout=10.0)
    r.raise_for_status()
    # GET /api/models answers {"models": [...]} -- the same shape the screen's
    # catalog reads. Assuming a bare list here crashed the first live call.
    rows = {m["id"]: m for m in r.json()["models"]}
    if model_id not in rows:
        raise ValueError("No such model: %s (one of %s)" % (model_id, ", ".join(rows)))
    row = rows[model_id]
    gb = round((row.get("bytes") or 0) / 1e9, 1)
    if row.get("state") == "ready":
        return {"model": row["name"], "state": "ready", "message": "%s is already downloaded." % row["name"]}
    if row.get("state") == "downloading":
        return {"model": row["name"], "state": "downloading", "progress": row.get("progress")}
    if not confirm:
        return {"needs_confirmation": True, "model": row["name"], "gb": gb,
                "message": "%s is %.1f GB. Download it now?" % (row["name"], gb)}
    r = _api_post("/api/models/%s/download" % model_id, timeout=10.0)
    if r.status_code in (404, 409):
        raise ValueError(r.json().get("detail", "could not start the download"))
    r.raise_for_status()
    return {"model": row["name"], "state": "downloading", "gb": gb,
            "message": "Downloading %s (%.1f GB). Check get_setup for progress." % (row["name"], gb)}


@mcp.tool()
def list_videos(folder: str) -> dict:
    """List the video files in ONE folder on this computer, newest first.

    folder is a path the user names (e.g. "~/Downloads"). Only video files
    are listed (.mp4 .mov .mkv .webm .avi), nothing is opened or changed, and
    subfolders are not entered. Each entry carries name, path (hand this to
    the other tools), size_mb and modified. This plus the user's word is how
    "the second one" or "the newest one" becomes a real file path.

    The videos PersoDub is holding are listed first, marked held=true: a link
    the user fetched on the New project screen is a real file on this computer,
    sitting where they would never think to look for it.
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
    held = _held_videos()
    # A folder of thousands would drown the conversation; the newest 100 is
    # every realistic ask, and the count says when there were more.
    return {"folder": root, "total": len(videos) + len(held),
            "videos": held + videos[:100]}


def _held_videos() -> List[dict]:
    """The videos the app is holding right now, in the shape of the entries
    above plus held=true.

    The app being closed is not an error here: the folder the user asked about
    is still on disk, and listing it is most of what was wanted.
    """
    try:
        r = _api_get("/api/downloads", timeout=10.0)
        r.raise_for_status()
        rows = r.json()["downloads"]
    except Exception:
        return []
    out = []
    for d in rows:
        if d.get("status") != "ready" or not d.get("path") or not os.path.exists(d["path"]):
            continue
        st = os.stat(d["path"])
        out.append({
            "name": d.get("title") or "video",
            "path": d["path"],
            "size_mb": round(st.st_size / (1024 * 1024), 1),
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "held": True,
        })
    return out


@mcp.tool()
def cut_clip(video_path: str, start: str, end: str) -> dict:
    """Cut one stretch of a video file into a NEW video file beside it.

    Free and local (ffmpeg on this machine) -- no Perso, no credits, no
    confirmation needed. start and end take seconds ("85") or colon timecodes
    ("1:25", "0:01:25"). The original video is never touched, and an existing
    file is never written over. Returns the new clip's path and length.
    """
    r = _api_post("/api/clips/cut",
                  json={"video_path": video_path, "start": start, "end": end},
                  timeout=600.0)
    if r.status_code in (404, 422, 503):
        raise ValueError(r.json().get("detail", "could not cut this video"))
    r.raise_for_status()
    return r.json()




@mcp.tool()
def download_video(url: str) -> dict:
    """Fetch ONE video from a link onto this computer and wait for it.

    Free and local (yt-dlp on this machine) -- no Perso, no credits, no
    confirmation needed. Answers when the file is really there, which can take
    a few minutes on a long video, and returns {path, title, duration_sec,
    download_id}: hand `path` to erase_subtitles, cut_clip, extract_subtitles
    or queue_dub. The video is kept in PersoDub's own workspace, not in the
    user's Downloads folder.
    """
    r = _api_post("/api/downloads", json={"url": url}, timeout=30.0)
    if r.status_code in (404, 422):
        detail = r.json().get("detail", "could not fetch that link")
        raise ValueError(detail if isinstance(detail, str)
                         else detail.get("message") or str(detail))
    r.raise_for_status()
    did = r.json()["id"]
    info = {}
    deadline = time.time() + DOWNLOAD_WAIT
    while time.time() < deadline:
        s = _api_get("/api/downloads/%s" % did, timeout=10.0)
        s.raise_for_status()
        info = s.json()
        if info.get("status") == "ready":
            return {"path": info["path"], "title": info["title"],
                    "duration_sec": info["duration_sec"], "download_id": did}
        if info.get("status") == "failed":
            raise ValueError(info.get("error") or "could not fetch that link")
        time.sleep(DOWNLOAD_POLL)
    raise ValueError("this download is still %s after %d minutes -- it is carrying on, "
                     "ask again in a while" % (info.get("status") or "running", DOWNLOAD_WAIT // 60))


def _erase_area(path: str, area):
    """The band to erase, as the route wants it, and a phrase naming it.

    "auto" asks the app where the subtitles look to be -- the same detector
    that will do the erasing, so the box offered is the box worked in.
    "bottom"/"top" are that quarter of the frame, worked out from the video's
    own size. "whole" is every pixel (slower, but it catches writing anywhere),
    and four numbers are passed through as they stand.
    """
    if isinstance(area, (list, tuple)):
        if len(area) != 4:
            raise ValueError("an area given as numbers must be [ymin, ymax, xmin, xmax]")
        return [int(v) for v in area], "the box you gave"
    word = (area or "auto").strip().lower()
    if word == "whole":
        return "whole", "the whole frame"
    if word == "auto":
        with open(path, "rb") as f:
            r = _api_post("/api/erase/suggest",
                          files={"video": (os.path.basename(path), f, "video/mp4")},
                          timeout=600.0)
        _check_eraser(r)
        found = r.json()
        return found["area"], ("where the subtitles were found" if found.get("found")
                               else "the bottom of the frame -- none were found")
    if word in ("bottom", "top"):
        w, h = media.video_size(path)
        if not (w and h):
            raise ValueError("could not read this video's size -- give the area as "
                             '[ymin, ymax, xmin, xmax], or use "whole"')
        band = [int(h * 0.75), h, 0, w] if word == "bottom" else [0, int(h * 0.25), 0, w]
        return band, "the %s quarter of the frame" % word
    raise ValueError('area must be "auto", "bottom", "top", "whole", '
                     "or [ymin, ymax, xmin, xmax]")


def _check_eraser(r) -> None:
    """Turn an erase route's refusal into a sentence. The 409 is the pack, not
    a model, so there is no size to name -- the user installs it from the
    screen, and nothing here can do it for them."""
    if r.status_code == 409:
        raise ValueError("The subtitle eraser is not installed on this computer. Ask "
                         "the user to install it from the Erase subtitles screen.")
    if r.status_code in (400, 404, 422, 503, 507):
        detail = r.json().get("detail", "could not erase this video's subtitles")
        raise ValueError(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()


@mcp.tool()
def erase_subtitles(video_path: str, area: Union[str, List[int]] = "auto",
                    start: Optional[float] = None,
                    end: Optional[float] = None) -> dict:
    """Rub out the subtitles BURNED INTO a video and keep the rest of the picture.

    Free and local (no Perso, no credits), but slow -- minutes per minute of
    video -- so it goes in the same queue a dub does and this answers at once
    with {job_id, status, area_used}. Follow it with get_job_status, which
    gives a percent, and once it says done=true call save_erased(job_id) to put
    the cleaned video in the user's Downloads folder.

    area is where to work: "auto" (the default -- the app looks for the
    subtitles first), "bottom" or "top" (that quarter of the frame), "whole"
    (every pixel: about twice as slow, but it catches writing anywhere), or
    exact numbers [ymin, ymax, xmin, xmax]. A narrow band is faster and safer;
    writing outside it is left alone.

    start and end (seconds, both or neither) cut the video down first, so one
    call does what would otherwise be two: "cut 20-30 s and erase the subtitles
    at the bottom" is erase_subtitles(path, area="bottom", start=20, end=30),
    not cut_clip followed by this.

    This is for writing baked into the picture. Subtitles the user can turn off
    are not this; a script the actors read is get_script.
    """
    path = os.path.expanduser(video_path)
    if not os.path.isfile(path):
        raise ValueError("No such video: %s" % video_path)
    if (start is None) != (end is None):
        raise ValueError("give both start and end, or neither")
    band, area_used = _erase_area(path, area)
    fields = {"area": band if band == "whole" else json.dumps(band)}
    if start is not None:
        fields["trim_start"] = str(start)
        fields["trim_end"] = str(end)
    with open(path, "rb") as f:
        r = _api_post("/api/erase", data=fields,
                      files={"video": (os.path.basename(path), f, "video/mp4")},
                      timeout=600.0)
    _check_eraser(r)
    return {**r.json(), "area_used": area_used}


@mcp.tool()
def save_erased(job_id: str, dir: str = "") -> dict:
    """Save a finished erase job's cleaned video and return where it went.

    dir is a folder the user names; left empty it goes to their Downloads
    folder, named after the project with "(no subtitles)" on the end. An
    existing file is never written over. Check get_job_status says done first.
    """
    body = {"dir": dir} if dir else {}
    r = _api_post("/api/erase/%s/save" % job_id, json=body, timeout=120.0)
    _check_eraser(r)
    return r.json()


@mcp.tool()
def cancel_dub(job_id: str) -> dict:
    """Cancel ONE dub AT ONCE: a waiting job leaves the line, a running one
    stops at its next safe point.

    Never ask the user to confirm first -- "cancel it" IS the confirmation,
    and a cancel is urgent (asking again meant the job sometimes finished
    before the user could answer). A job that already ended
    (done/error/cancelled) has nothing left to stop. Job ids come from
    queue_dub and get_job_status.
    """
    job = _job(job_id)
    status = job.get("status")
    if status in ("done", "error", "cancelled"):
        raise ValueError("nothing to cancel: this job is already %s" % status)
    r = _api_post("/api/dub/jobs/%s/cancel" % job_id, timeout=30.0)
    if r.status_code in (404, 409):
        detail = r.json().get("detail", "cannot cancel this job")
        raise ValueError(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def burn_subtitles(video_path: str, srt_path: str = "", preset: str = "clean") -> dict:
    """Lay subtitles onto a video file as a NEW video beside it.

    Free, on this machine, no confirmation needed. srt_path names the subtitle
    file; left empty, the .srt sitting next to the video with the video's own
    name is used (extract_subtitles leaves one exactly there -- if neither
    exists, offer to extract subtitles first). preset picks the look, one of
    twelve: clean (white, outlined -- the default), bold-punch (huge,
    shouted), sticker (white on a dark chip), neon-yellow (bold yellow),
    soft-card (dark on a pale card), rainbow (a colour per word), broadcast,
    streaming, lower-bar (news-style band), neon (cyan glow), black-box or
    white-box (solid grounds that cover whatever sits under them). When the
    user names no style use clean and mention the others exist. The original
    video is never touched.
    """
    r = _api_post("/api/subtitles/burn",
                  json={"video_path": video_path, "srt_path": srt_path,
                        "preset": preset},
                  timeout=1800.0)
    if r.status_code in (404, 422, 503):
        detail = r.json().get("detail", "could not subtitle this video")
        raise ValueError(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()
    return r.json()


if __name__ == "__main__":
    mcp.run(transport="stdio")
