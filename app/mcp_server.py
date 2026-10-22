# -*- coding: utf-8 -*-
"""A small program that hands PersoDub's script tools to a terminal AI over MCP.

Not a web server. It talks over stdin/stdout only, on this machine, and dies with
whatever started it. Nothing leaves the machine.

Run it with:
    PERSODUB_API=http://127.0.0.1:8000 python -m app.mcp_server

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
from mcp.server.mcpserver.exceptions import ToolError

from app import languages, media
from app.dub_script import DUB_NAME, edit_line, export_srt, load_lines
from app.engines_status import TRANSLATORS
from app.jobs import JobKind, JobStatus
from app.perso_edit import LOCAL_VOICE
from app.setup import STAGES, checked_choice
from app.stages import progress_of

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


class Refusal(ToolError, ValueError):
    """A tool saying no, with the reason attached.

    mcp >= 2.2 hands the agent "Error executing tool X" and nothing more for
    any exception that is not a ToolError. The kit shipped 2.2.0 while the
    dev venv still had 2.0.0, and eleven refused dubs in the 0.6.2 full test
    reached the agent as an error with no reason (2026-09-16). Still a
    ValueError, so nothing that caught one before changes.
    """


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
        raise Refusal("no such job: %s" % job_id)
    r.raise_for_status()
    return r.json()


def _work_dir(job: dict) -> str:
    """A job's workspace folder.

    The folder name and the job id are two unrelated strings (app/api/_launch.py's
    job_dir names the folder after the title; JobStore.create makes the id),
    so the folder cannot be derived from the id -- it is read back out of the
    result path, the same way app/api/_shared.py's work_dir_of does it.
    """
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise Refusal("this job has no result yet (status: %s)" % job.get("status"))
    return os.path.dirname(out)


def _lang(job: dict) -> str:
    """The dub's target language, stamped onto the job record by app/api/dub.py
    (the language_code field it passes to launch_job)."""
    return job.get("language_code") or "en"


# What the routes that reach Perso answer with when they refuse
# (app/api/script.py _perso_says), each with its reason in `detail`.
PERSO_REFUSALS = (402, 404, 409, 422, 500, 502, 503, 504, 507)


def _perso_edit(job_id: str, job: dict) -> Optional[dict]:
    """How this job's voices are to be remade: None for "on this computer",
    else what Perso says about the project (app/perso_edit.py live_state).

    On this computer means a job Perso never dubbed, or one a voice was
    already made in here -- the rule at the top of app/perso_edit.py. Any
    other reason Perso editing is off is a reason to stop, not to fall back:
    a local voice on a Perso dub is the one thing the user must choose.
    """
    if job.get("dub_mode") != "perso":
        return None
    r = _api_get("/api/dub/jobs/%s/perso/edit" % job_id, timeout=60.0)
    if r.status_code in PERSO_REFUSALS:
        raise Refusal(r.json().get("detail", "cannot ask Perso about this job"))
    r.raise_for_status()
    edit = r.json()
    if edit.get("reason") == LOCAL_VOICE:
        return None
    if not edit.get("available"):
        raise Refusal(edit.get("reason") or "this job cannot be edited through Perso")
    return edit


# The tools that put a question to the user in this reply, with the plan each
# put. The CLI starts this server afresh for every message (app/api/agent.py),
# so a name here means the user has not answered yet, and a confirm=true now
# would be the agent saying yes for them: Claude asked "Proceed?" and started
# the dubbing in the same reply (night test 2026-10-01).
#
# One exception, kept on disk because it spans two of these processes: the
# agent put the plan in one reply, the user said yes, and in the next reply it
# put the same plan once more before confirming. That ask is the user's own
# question read back, not a new one, so the confirm goes through (Windows F41,
# 2026-10-07: every consent had to be given twice).
_asked = {}
_ASK_FILE = os.path.join(os.getcwd(), ".persodub-asked.json")


def _asks_on_file() -> dict:
    try:
        with open(_ASK_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _write_asks(asks: dict) -> None:
    try:
        with open(_ASK_FILE, "w", encoding="utf-8") as f:
            json.dump(asks, f, ensure_ascii=False)
    except Exception:
        pass   # a folder that cannot be written only costs the exception above


def _ask_entries(value) -> list:
    """A tool's asks on file, one {"plan", "pid"} each (a single dict before
    2026-10-12)."""
    if isinstance(value, dict):
        return [value]
    return [e for e in value if isinstance(e, dict)] if isinstance(value, list) else []


def _ask(tool: str, answer: dict, plan: str) -> dict:
    """Put a plan to the user. `plan` names what the call would do (file,
    language, engines), not the sentence shown: the sentence carries the
    balance, which moves between two replies.

    Every plan put in one reply stays on file, so "Shall I start all three?"
    can be confirmed three times in the next: only the last was kept, and a
    batch that spends credits started one video per answer (final review,
    2026-10-12). The first question of a reply replaces the reply before's."""
    first = tool not in _asked
    _asked[tool] = plan
    asks = _asks_on_file()
    entries = _ask_entries(asks.get(tool))
    if first:
        # The same plan put in an earlier reply stays on file as that earlier ask.
        entries = [e for e in entries if e.get("pid") != os.getpid() and e.get("plan") == plan]
    if not any(e.get("plan") == plan for e in entries):
        entries.append({"plan": plan, "pid": os.getpid()})
    asks[tool] = entries
    _write_asks(asks)
    return answer


def _answered(tool: str, plan: str, paid: bool = False) -> None:
    """confirm=true has arrived. It goes through when the user has had the
    plan since an earlier reply (its ask is on file from another process), or,
    for work that costs nothing, when the user's own message said to go and
    nothing was asked in this reply. Work that spends credits is never started
    on that word alone: the plan with its cost goes to the user first (the
    agent started a dub whose transcription ran on Perso without a quote,
    Mac F10, 2026-10-08)."""
    same = any(e.get("pid") != os.getpid() and e.get("plan") in ("*", plan)
               for e in _ask_entries(_asks_on_file().get(tool)))
    if tool in _asked:
        if same:
            _forget_ask(tool, plan)
            return
        raise Refusal("The user has not answered yet. Put the plan to them and end "
                      "your reply. Call with confirm=true only after they say yes.")
    if same:
        _forget_ask(tool, plan)
        return
    if paid:
        raise Refusal("This spends credits, so it is not started on the user's word alone: "
                      "call without confirm first, put the plan with its cost to the user, "
                      "end your reply, and call with confirm=true after they say yes.")


def _forget_ask(tool: str, plan: str) -> None:
    """A yes is used once: the plan it answered, or the "*" that stood for it."""
    asks = _asks_on_file()
    entries = _ask_entries(asks.get(tool))
    kept = [e for e in entries if e.get("plan") != plan]
    if len(kept) == len(entries):
        kept = [e for e in entries if e.get("plan") != "*"]
    if kept:
        asks[tool] = kept
    else:
        asks.pop(tool, None)
    _write_asks(asks)


def _perso_post(path: str, refusal: str, changed_only: bool = False, **kw) -> dict:
    body = {"confirm": True, "changed_only": True} if changed_only else {"confirm": True}
    r = _api_post(path, json=body, **kw)
    if r.status_code in PERSO_REFUSALS:
        raise Refusal(r.json().get("detail", refusal))
    r.raise_for_status()
    return r.json()


NIGHTINGALE_LINES = ("This dubbing's Perso voice cannot remake one line at a time. "
                     "proofread_dub (All at once on screen) remakes every line.")


@mcp.tool()
def get_script(job_id: str) -> List[dict]:
    """Return the dubbing script line by line.

    Each line carries: line (its number), start/end (seconds), slot (the time this
    line has to be spoken in), source (the original-language line), source_line (that
    line's number: lines sharing one are a sentence the dub split), text (the current
    translation), estimated (how long the translation takes to say), fits (true
    when the line can be spoken inside its slot -- judged by the voice made for
    it once there is one, else by the estimate), over (how many seconds the
    line runs past its slot, 0 when it does not: the screen's "+0.9s"; quote
    this rather than working it out from estimated), speaker (who says it, or null when this
    job recorded no speakers), audio_sec (how long the voice made for it actually
    runs, or null when that file is gone), voice_stale (true when the line's
    words changed and its voice has not been made from them yet -- so it
    still sounds like the old ones until remake_line_voice runs), and
    untranslated (true when the translator could not translate this line: it
    has no words and is silent in the dub; write it from source with
    edit_script_line, then remake_line_voice). On a Perso dub a line can also
    carry reworded: the words the user wrote, which Perso replaced with its
    own (text) when it made the voice.
    """
    job = _job(job_id)
    if job.get("dub_mode") == "perso":
        # A Perso dub's lines live on Perso's side; the app's own script
        # endpoint mirrors them (read-only for now -- see change_speaker).
        r = _api_get("/api/dub/jobs/%s/script" % job_id, timeout=60.0)
        if r.status_code in (404, 503):
            raise Refusal(r.json().get("detail", "no script for this job"))
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
    work_dir = _work_dir(job)
    if job.get("dub_mode") == "perso" and not os.path.exists(os.path.join(work_dir, DUB_NAME)):
        # A Perso dub nobody has opened for editing yet: its parts are
        # fetched first (downloads only, no credits).
        r = _api_post("/api/dub/jobs/%s/perso/materialize" % job_id, timeout=600.0)
        if r.status_code in PERSO_REFUSALS:
            raise Refusal(r.json().get("detail", "could not fetch this dubbing from Perso"))
        r.raise_for_status()
    return edit_line(work_dir, line, text, _lang(job))


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
            raise Refusal(
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
    if job.get("dub_mode") == "perso" and job.get("status") == JobStatus.DONE:
        # Whether Perso is working on it (a proofread) and how that ended.
        r = _api_get("/api/dub/jobs/%s/perso/edit" % job_id, timeout=60.0)
        if r.status_code == 200:
            info["perso_edit"] = r.json()
    if (job.get("kind") not in (JobKind.ERASE, JobKind.SEPARATE)
            and job.get("status") in (JobStatus.RUNNING, JobStatus.QUEUED, JobStatus.CANCELLING)):
        # The same percent the home card shows (app/stages.py progress_of):
        # the agent used to answer "no percent given" (Windows F6, 2026-10-07).
        info.update(progress_of(job.get("logs") or []))
    if job.get("kind") == JobKind.ERASE:
        r = _api_get("/api/erase/%s" % job_id, timeout=10.0)
        if r.status_code == 200:
            erase = r.json()
            info["percent"] = erase.get("percent")
            info["done"] = erase.get("done")
            info["result_path"] = (erase.get("result") or {}).get("out_path")
            info["check"] = erase.get("check")
    return info


@mcp.tool()
def remake_voices(job_id: str, confirm: bool = False, every_line: bool = False) -> dict:
    """Remake the voices of the lines whose words changed, and nothing else --
    or, with every_line=true, of every line ("read it all again").

    every_line=true speaks every line that has words again, changed or not, and
    rebuilds the video once. It takes a while, so without confirm=true it only
    returns the question with the number of lines; call again with confirm=true
    after the user says yes. On a Perso dub, Perso redoes every line through
    proofread_dub instead.

    Without every_line: on a Perso dub the voices are made BY PERSO, in the
    voice it dubbed with, and THAT SPENDS PERSO CREDITS: without confirm=true
    this only returns the confirmation question. Without every_line, confirm
    means nothing on any other job. Perso may put its own words in place of the
    user's to fit the time: each such line comes back under reworded, with
    you_wrote and perso_said. Always tell the user, quoting both.

    Without every_line, only lines whose text was rewritten since their voice
    was made are spoken again. Every other line keeps the voice it already has,
    the timings, the script and the job itself are untouched, and the finished
    video is rebuilt in place -- no new job and no second copy of the job's
    folder.

    Returns {"remade": [line numbers], "skipped": how many lines were left
    alone}; remade is empty when every voice is already up to date. The work is
    done by the time this answers -- seconds per remade line -- so there is
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
    job = _job(job_id)
    if every_line:
        return _remake_every_voice(job_id, job, confirm)
    if _perso_edit(job_id, job):
        return _perso_remake_stale(job_id, confirm)
    return _voices_post(job_id, "stale", 600.0)


def _remake_every_voice(job_id: str, job: dict, confirm: bool) -> dict:
    """remake_voices(every_line=True): asked first, with the number of lines.
    Only the changed lines could be remade before, so with none changed "read
    it all again" did nothing (Windows test F18, 2026-10-11)."""
    # A Perso dub whose voices are made here now is read again here, the way
    # its changed lines are (_perso_edit answers None for it).
    if _perso_edit(job_id, job):
        raise Refusal("On a Perso dub, Perso redoes every line: that is proofread_dub.")
    count = sum(1 for line in load_lines(_work_dir(job), _lang(job)) if line["text"].strip())
    plan = "every_line:%s" % job_id
    if not confirm:
        return _ask("remake_voices", {"needs_confirmation": True, "message": (
            "Remaking every voice speaks all %d lines of this dubbing again on this computer, "
            "one after another, and rebuilds the video once at the end. It takes a while. "
            "Proceed?" % count)}, plan=plan)
    _answered("remake_voices", plan)
    # Seconds a line, and the rebuild: a long script can run past the usual ten minutes.
    return _voices_post(job_id, "all", max(600.0, 30.0 * count))


def _voices_post(job_id: str, which: str, timeout: float) -> dict:
    r = _api_post("/api/dub/jobs/%s/voices/%s" % (job_id, which), timeout=timeout)
    if r.status_code == 404:
        raise Refusal("no such job: %s" % job_id)
    # 502 and 503 carry the voice engine's own sentence (busy, not running).
    if r.status_code in (409, 422, 502, 503, 507):
        raise Refusal(r.json().get("detail", "this job's voices cannot be remade"))
    r.raise_for_status()
    return r.json()


def _perso_remake_stale(job_id: str, confirm: bool) -> dict:
    """remake_voices on a Perso dub: each changed line goes to Perso in turn."""
    r = _api_get("/api/dub/jobs/%s/script" % job_id, timeout=60.0)
    if r.status_code in PERSO_REFUSALS:
        raise Refusal(r.json().get("detail", "no script for this job"))
    r.raise_for_status()
    lines = r.json()["lines"]
    stale = [l["line"] for l in lines if l.get("voice_stale")]
    if not stale:
        return {"remade": [], "skipped": len(lines)}
    if not confirm:
        return _ask("remake_voices", {
            "needs_confirmation": True,
            "message": ("Perso will make %d voice%s again, in the voice it dubbed "
                        "with. That spends Perso credits. Proceed?"
                        % (len(stale), "" if len(stale) == 1 else "s")),
        }, plan=job_id)
    _answered("remake_voices", job_id, paid=True)
    remade, reworded, credits = [], [], 0
    for line in stale:
        done = _perso_post("/api/dub/jobs/%s/perso/script/%d/voice" % (job_id, line),
                           "cannot remake line %d" % line, changed_only=True, timeout=900.0)
        if done.get("unchanged"):
            continue
        remade.append(line)
        if done.get("reworded"):
            reworded.append({"line": line, "you_wrote": done.get("you_wrote"),
                             "perso_said": done.get("perso_said")})
        credits += done.get("credits") or 0
    return {"remade": remade, "skipped": len(lines) - len(remade), "credits": credits,
            **({"reworded": reworded} if reworded else {})}


@mcp.tool()
def remake_line_voice(job_id: str, line: int, confirm: bool = False) -> dict:
    """Speak ONE line again, in the same voice, and rebuild the dub around it.

    Use this for one named line -- including a line nobody edited, when its
    voice simply came out wrong. remake_voices does the same thing to every
    line whose words changed, which is the usual way to catch up after a batch
    of rewrites.

    On a Perso dub the voice is made BY PERSO, in the voice it dubbed with,
    and THAT SPENDS PERSO CREDITS: without confirm=true this only returns the
    confirmation question. confirm means nothing on any other job. Perso may
    put its own words in place of the user's to fit the time: reworded=true,
    with you_wrote and perso_said. Always tell the user, quoting both.
    """
    edit = _perso_edit(job_id, _job(job_id))
    if edit:
        if edit.get("nightingale"):
            raise Refusal(NIGHTINGALE_LINES)
        if not confirm:
            return _ask("remake_line_voice", {
                "needs_confirmation": True,
                "message": ("Perso will make line %d's voice again, in the voice it "
                            "dubbed with. That spends Perso credits. Proceed?" % line),
            }, plan="%s:%d" % (job_id, line))
        _answered("remake_line_voice", "%s:%d" % (job_id, line), paid=True)
        return _perso_post("/api/dub/jobs/%s/perso/script/%d/voice" % (job_id, line),
                           "cannot remake line %d" % line, timeout=900.0)
    r = _api_post("/api/dub/jobs/%s/script/%d/voice" % (job_id, line), timeout=600.0)
    if r.status_code in (404, 409, 422, 507):
        raise Refusal(r.json().get("detail", "cannot remake line %d" % line))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def proofread_dub(job_id: str, confirm: bool = False) -> dict:
    """Have PERSO go over a whole Perso dub again: every line is voiced again
    with its quality pass (a line the user edited keeps its words), and the
    script, the voices and the video here are replaced with the result.

    Perso dubs only. THIS MAY SPEND PERSO CREDITS -- up to what the dub itself
    cost (a run measured 2026-09-29 spent none, Perso's price list says
    otherwise). Called without confirm=true it does nothing but return the
    confirmation question: relay that message to the user, and call again
    with confirm=true only after they clearly agree.

    It takes minutes and this answers at once with {"started": true}.
    get_job_status says when it is over: perso_edit.working is "proofread"
    until then, and perso_edit.error carries the reason if it failed.
    """
    job = _job(job_id)
    if job.get("dub_mode") != "perso":
        raise Refusal("All at once works on Perso dubbing only. "
                      "This job was dubbed on this computer.")
    r = _api_get("/api/dub/jobs/%s/perso/edit" % job_id, timeout=60.0)
    if r.status_code in PERSO_REFUSALS:
        raise Refusal(r.json().get("detail", "cannot ask Perso about this job"))
    r.raise_for_status()
    edit = r.json()
    if edit.get("working"):
        raise Refusal("Perso is already working on this job. Wait for it to finish.")
    if not edit.get("unfetched"):
        if not edit.get("available"):
            raise Refusal(edit.get("reason") or "Perso cannot redo this job")
        # A NIGHTINGALE dub's new words go with the proofread, so whether
        # Perso takes it is only known once it is asked.
        if not edit.get("retranslate_available") and not edit.get("nightingale"):
            raise Refusal("Perso has nothing to redo in this project yet.")
        if not confirm:
            return _ask("proofread_dub", {
                "needs_confirmation": True,
                "message": ("All at once sends the whole dubbing through Perso again and "
                            "may spend Perso credits, up to what the dubbing itself cost%s. "
                            "Every voice here is made again by Perso. Proceed?"
                            % (" (the first time on this dubbing is free)"
                               if edit.get("nightingale") else "")),
            }, plan=job_id)
        _answered("proofread_dub", job_id, paid=True)
    return _perso_post("/api/dub/jobs/%s/perso/proofread" % job_id,
                       "Perso cannot redo this job", timeout=120.0)


@mcp.tool()
def retranslate_lines(job_id: str, lines: Optional[List[int]] = None) -> dict:
    """Translate the given lines again. WORDS ONLY: no voice is remade.

    Use this when the user asks for lines to be translated again. `lines` is a
    list of line numbers; leave it out for every line. A Perso dub is
    translated by Perso, every other by the translator it was dubbed with,
    fitted to each line's time slot, and the new words are written to the script.

    Returns {"changed": [{"line", "was", "text"}]}: show the user each line's
    old and new words. The voices still say the old words until remake_voices
    is called. To rewrite a line in your own words instead, use
    edit_script_line.
    """
    r = _api_post("/api/dub/jobs/%s/retranslate" % job_id,
                  json={"lines": lines}, timeout=1800.0)
    if r.status_code in (404, 409, 422, 429, 502, 507):
        raise Refusal(_dub_refusal_text(r.json().get("detail", "these lines cannot be translated again")))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def change_speaker(job_id: str, line: int, confirm: bool = False) -> dict:
    """Give ONE line of a Perso dub a NEW speaker (a fresh voice), on Perso's side.

    Perso dubs only. THIS MAY SPEND PERSO CREDITS. Called without confirm=true
    it does nothing but return the confirmation question: relay that message to
    the user, and call again with confirm=true only after they clearly agree.
    """
    # Which kind of dub first: a local one got asked about Perso credits for a
    # change that cannot happen there (Windows, 2026-09-26).
    if _job(job_id).get("dub_mode") != "perso":
        raise Refusal("Changing a line's speaker works on Perso dubbing only. "
                      "This job was dubbed on this computer.")
    if not confirm:
        return _ask("change_speaker", {
            "needs_confirmation": True,
            "message": ("Changing this line's speaker runs on Perso's side and "
                        "may spend Perso credits. Proceed?"),
        }, plan="%s:%d" % (job_id, line))
    _answered("change_speaker", "%s:%d" % (job_id, line), paid=True)
    r = _api_post("/api/dub/jobs/%s/perso/speaker" % job_id,
                  json={"line": line}, timeout=600.0)
    if r.status_code in (404, 409, 422):
        raise Refusal(r.json().get("detail", "cannot change line %d's speaker" % line))
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
        raise Refusal('Ask the user which engine to use first: "local" '
                         '(free, this machine) or "perso" (paid, better quality).')
    if engine == "perso" and not confirm:
        r = _api_get("/api/subtitles/estimate",
                     params={"video_path": video_path, "engine": "perso"},
                     timeout=60.0)
        if r.status_code in (404, 422):
            raise Refusal(r.json().get("detail", "cannot read that video"))
        r.raise_for_status()
        est = r.json()
        balance = est.get("credits_balance")
        message = ("Extracting subtitles from this video (%.0fs) will spend "
                   "about %d Perso credits%s. Proceed?"
                   % (est.get("seconds", 0), est.get("credits_estimate", 0),
                      "" if balance is None else " (balance: %s)" % balance))
        return _ask("extract_subtitles",
                    {"needs_confirmation": True, "message": message, "estimate": est},
                    plan=os.path.basename(video_path))
    if engine == "perso":
        _answered("extract_subtitles", os.path.basename(video_path), paid=True)
    r = _api_post("/api/subtitles/extract",
                  json={"video_path": video_path, "engine": engine},
                  timeout=3600.0)
    if r.status_code in (404, 409, 422, 503):
        raise Refusal(r.json().get("detail", "could not extract subtitles"))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def queue_dub(video_path: str, target_language: str, dub_mode: str = "local",
              source_language: str = "", num_speakers: Optional[int] = None,
              translator: str = "", confirm: bool = False,
              stt: str = "", separation: str = "", voice: str = "",
              perso_model: str = "") -> dict:
    """Put ONE video into PersoDub's dubbing queue.

    target_language (and optional source_language, else auto-detected) are
    codes: en ko zh fr de it ja pt ru es. dub_mode is the user's choice:
    "local" (free, dubbed on this machine, one at a time in the queue) or
    "perso" (paid -- Perso's cloud, about 1 credit per SECOND of video,
    starts at once without waiting in the local line).

    NOTHING STARTS UNASKED, free or paid. Called without confirm=true it
    starts nothing and returns the plan: the file, the language, the video's
    length and, for perso, the estimated credits and balance. Relay that to
    the user as a question and end your reply; confirm=true is refused in the
    same reply, and goes in once they say yes. "You decide" does NOT let you
    pick the mode: the mode is the user's money, so put both to them in one
    question -- this machine (free, slower) or Perso (credits, the estimate)
    -- and wait (the agent once chose for them, Windows F36, 2026-10-07).
    Only when the user's own message already names the
    file, the language and the mode and says to go, call with confirm=true
    straight away, without asking (on perso they must also have seen the
    credits). For SEVERAL videos, gather every estimate first, ask the user
    ONCE with the total, then call each with confirm=true -- never ask five
    separate questions.

    translator picks the translation engine for a local dub when the user
    names one -- "chatgpt" (the user's own ChatGPT account, the default),
    "hunyuan" or "gemma" (on this machine) or "gemini" (Google's API); empty
    keeps the app's default, ChatGPT. If starting fails because a
    model is not downloaded, the error names the model and its size: tell the
    user exactly that, and offer the two ways out it lists.

    stt and separation pick, FOR THIS DUB ONLY, where a local dub's
    transcription and background separation run: "local" (free, this machine)
    or "perso" (paid); separation also takes "roformer" (free, this machine,
    a cleaner background, slower, its own download); empty keeps the app's
    default. Use these when the user
    wants one dub done differently -- never set_default, which changes every
    dub from then on.

    voice picks, FOR THIS DUB ONLY, the engine that speaks a local dub:
    "qwen3" (free, this machine); empty keeps the app's default.

    perso_model picks the voice model of a perso dub when the user names one
    -- any model Perso lists for the language, such as "linnet_4" (the default,
    or "oriole" where the language lacks it), "linnet_3", "wren", "finch" or "nightingale" (finch and
    nightingale need a Perso Pro plan); empty lets the app choose. Not every language has every model: a refusal names the ones the
    language has, so tell the user exactly that.

    Returns {"job_id", "status"}; the home screen's Up next card shows the
    queue, and get_job_status follows one job.
    """
    code = _check_dub_choices(target_language, dub_mode, translator, stt, separation, voice,
                              perso_model)
    path = os.path.expanduser(video_path)
    cloud_stages, spends = _paid_choices(dub_mode, stt, separation, translator)
    plan = "%s|%s|%s|%s%s" % (os.path.basename(path), code, dub_mode, ",".join(cloud_stages),
                              "|quota" if spends else "")
    if not confirm:
        return _ask("queue_dub", _dub_question(video_path, path, code, dub_mode, cloud_stages, spends),
                    plan=plan)
    _answered("queue_dub", plan, paid=dub_mode == "perso" or bool(cloud_stages) or bool(spends))
    if not os.path.isfile(path):
        raise Refusal("No such video: %s" % video_path)
    fields = _dub_start_fields(code, dub_mode, source_language, num_speakers, translator, stt,
                               separation, voice, perso_model)
    with open(path, "rb") as f:
        r = _api_post("/api/dub/start", data=fields,
                      files={"video": (os.path.basename(path), f, "video/mp4")},
                      timeout=600.0)
    if r.status_code in (400, 404, 409, 422, 507):
        detail = r.json().get("detail", "could not start dubbing")
        raise Refusal(_dub_refusal_text(detail))
    r.raise_for_status()
    return r.json()


def _check_dub_choices(target_language, dub_mode, translator, stt, separation, voice,
                       perso_model) -> str:
    """queue_dub's choices, checked before anything is asked or started: each
    engine against the choices its stage offers (app/setup.py STAGES, the
    table set_default and the Settings screen read too; "" keeps the app's
    default), then the language against the chosen path's list. Returns the
    language's code."""
    if dub_mode not in STAGES["dub_mode"][1]:
        raise Refusal('dub_mode must be "local" or "perso"')
    if translator not in ("", *STAGES["translator"][1]):
        raise Refusal('translator must be "chatgpt", "gemma", "hunyuan", "gemini" or empty')
    for name, value in (("stt", stt), ("separation", separation)):
        if value not in ("", *STAGES[name][1]):
            raise Refusal('%s must be %s or empty' % (name, ", ".join('"%s"' % c for c in STAGES[name][1])))
    if voice not in ("", *STAGES["voice"][1]):
        raise Refusal('voice must be "qwen3" or empty')
    code = (target_language or "").strip()
    if languages.lookup(dub_mode, code) is None:
        known = [e["id"] for e in languages.languages_for(dub_mode)]
        raise Refusal("target_language must be one of: %s" % " ".join(sorted(known)))
    if dub_mode == "perso":
        try:
            languages.model_for(languages.lookup(dub_mode, code), perso_model)
        except ValueError as e:
            raise Refusal(str(e))
    return code


def _paid_choices(dub_mode, stt, separation, translator):
    """What a local dub pays for: (the stages it sends through Perso, what its
    translator spends -- its TRANSLATORS entry, "Gemini API quota", or ""),
    from the engines named for it or else the saved defaults. A Perso dub pays
    for the whole, and its question says so.

    A "local" dub still goes through Perso for whichever stages the saved
    defaults send there. The agent called such a dub free and never named the
    balance (0.6.2 full test, 2026-09-16).
    """
    if dub_mode != "local":
        return [], ""
    defaults = _api_get("/api/setup", timeout=10.0).json().get("defaults", {})
    # What this dub will really use: the engine named for it, else the default.
    chosen = {"stt": stt or defaults.get("stt"),
              "separation": separation or defaults.get("separation")}
    # The same word set_default asks about before Gemini becomes the default:
    # a Gemini dub was called free and started on the user's word alone.
    info = TRANSLATORS.get(translator or defaults.get("translator") or "")
    return ([s for s in ("stt", "separation") if chosen[s] == "perso"],
            info.spends if info else "")


def _dub_question(video_path, path, code, dub_mode, cloud_stages, spends="") -> dict:
    """The plan queue_dub puts to the user before anything starts: the file,
    the language, the video's length and what the dub will spend."""
    # The estimate route already measures the video and, for perso, the
    # balance. Dubbing costs ~1 credit per second (the route's own figure
    # is STT's 1-per-5s, so only seconds and balance are read from it).
    r = _api_get("/api/subtitles/estimate",
                 params={"video_path": video_path,
                         "engine": "perso" if dub_mode == "perso" or cloud_stages else "local"},
                 timeout=60.0)
    if r.status_code in (404, 422):
        raise Refusal(r.json().get("detail", "cannot read that video"))
    r.raise_for_status()
    est = r.json()
    seconds = est.get("seconds", 0)
    balance = est.get("credits_balance")
    balance_text = "" if balance is None else " (balance: %s)" % balance
    if dub_mode == "perso":
        message = ("Dubbing this video (%.0fs) on Perso will spend about %d credits%s."
                   % (seconds, math.ceil(seconds), balance_text))
    elif cloud_stages:
        # Measured 2026-09-16: transcription 2 credits and separation 5
        # credits for a 10-second clip.
        credits = (math.ceil(seconds / 5.0) if "stt" in cloud_stages else 0) \
            + (math.ceil(seconds / 2.0) if "separation" in cloud_stages else 0)
        what = " and ".join({"stt": "transcription", "separation": "separation"}[s]
                            for s in cloud_stages)
        message = ("Dubbing this video (%.0fs) runs on this machine, but its "
                   "%s goes through Perso: about %d credits%s."
                   % (seconds, what, credits, balance_text))
    else:
        message = ("Dubbing this video (%.0fs) runs %son this machine and takes a "
                   "while; queued videos run one at a time." % (seconds, "" if spends else "free "))
    if spends:
        message += " Its translation uses the user's %s." % spends
    # The plan says which file and which language: "Proceed?" alone let
    # "2 dubbing, 1 erase" start without the user seeing which was which.
    message = "%s into %s. %s Proceed?" % (os.path.basename(path),
                                           languages.lookup(dub_mode, code)["name"], message)
    return {"needs_confirmation": True, "message": message, "seconds": seconds}


def _dub_start_fields(code, dub_mode, source_language, num_speakers, translator, stt, separation,
                      voice, perso_model) -> dict:
    """The form queue_dub posts to POST /api/dub/start, in dub_start's own
    field names (tests/test_mcp_dub_contract.py holds the two sides together)."""
    # Always said, local included: the server's own default is Perso in the
    # production edition (app/setup.py), and a local dub that left it unsaid went to
    # Perso and spent credits the agent had promised were not needed (Windows F10, 2026-10-07).
    fields = {"language": languages.lookup(dub_mode, code)["name"], "language_code": code,
              "dub_mode": dub_mode}
    if dub_mode == "perso" and perso_model:
        fields["perso_model"] = perso_model.upper()
    if source_language:
        fields["source_language_code"] = source_language.lower()
    if num_speakers:
        fields["num_speakers"] = str(num_speakers)
    if dub_mode == "local":
        # The engines named for this dub only; the rest keep the app's defaults.
        for field, value in (("translate_engine", translator), ("stt_engine", stt),
                             ("sep_engine", separation), ("tts_engine", voice)):
            if value:
                fields[field] = value
    return fields


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
    voice_quality, voice), the choices each stage offers, every optional model with
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
def set_default(stage: str, choice: str, confirm: bool = False) -> dict:
    """Change what one stage uses from now on -- for every dub, from the
    screen or from here, no restart. NOT for one dub: queue_dub takes stt,
    separation, translator and voice for that. A choice that spends money (perso for
    any stage, gemini for translation) answers needs_confirmation=true first:
    put its message to the user and call again with confirm=true only after
    they clearly agree -- the assistant once switched transcription to Perso
    before asking, the user declined the dub, and the paid default stayed. stage is one of dub_mode (local |
    perso), separation (local | roformer | perso), stt (local | perso), translator
    (chatgpt | hunyuan | gemma | gemini), voice_quality (fast | high),
    voice (qwen3). Cloud choices
    need the matching key saved (see get_setup); a local model that is not
    downloaded is not a reason to refuse -- download_model handles that.
    Returns the defaults now in force.
    """
    # Read the way the app saves it (trimmed, lowercased, one the stage offers),
    # so the choice judged paid or free below is the one that is saved.
    try:
        choice = checked_choice(stage, choice)
    except ValueError as e:
        raise Refusal(str(e))
    # A translator that spends the user's money says so in its TRANSLATORS entry.
    info = TRANSLATORS.get(choice) if stage == "translator" else None
    paid = choice == "perso" or bool(info and info.spends)
    plan = "%s:%s" % (stage, choice)
    if paid and not confirm:
        spend = "Perso credits" if choice == "perso" else info.spends
        return _ask("set_default", {"needs_confirmation": True, "message": (
            "This makes %s the default %s for every dubbing from now on, and each of "
            "them will spend %s. To do it for one dubbing only, queue that one with "
            "the engine named instead. Change the default?"
            % (choice, stage, spend))}, plan=plan)
    if paid:
        _answered("set_default", plan, paid=True)
    r = _api_post("/api/setup", json={stage: choice}, timeout=10.0)
    if r.status_code in (422, 503):
        raise Refusal(r.json().get("detail", "could not change that setting"))
    r.raise_for_status()
    return r.json()


@mcp.tool()
def download_model(model_id: str) -> dict:
    """Offer one optional model for download (ids and sizes come from
    get_setup: whisper, qwen3-tts, gemma, hunyuan). This never downloads
    anything: it puts a Download button with the size in the chat, and the
    download starts only when the user presses it. Tell them that, with the
    size -- never say a download has started. get_setup shows it once they
    have pressed the button.
    """
    r = _api_get("/api/models", timeout=10.0)
    r.raise_for_status()
    # GET /api/models answers {"models": [...]} -- the same shape the screen's
    # catalog reads. Assuming a bare list here crashed the first live call.
    rows = {m["id"]: m for m in r.json()["models"]}
    if model_id not in rows:
        raise Refusal("No such model: %s (one of %s)" % (model_id, ", ".join(rows)))
    row = rows[model_id]
    gb = round((row.get("bytes") or 0) / 1e9, 1)
    if row.get("state") == "ready":
        return {"model": row["name"], "state": "ready", "message": "%s is already downloaded." % row["name"]}
    if row.get("state") == "downloading":
        return {"model": row["name"], "state": "downloading", "progress": row.get("progress")}
    # Only a person's press starts gigabytes: the old confirm=true could be
    # sent by the agent itself, and Codex did, 7.6 GB before asking (Windows
    # full test, 2026-09-25). The page shows the button when this call returns.
    return {"model": row["name"], "id": model_id, "gb": gb, "state": row.get("state"),
            "button_shown": True,
            "message": ("A Download button for %s (%.1f GB) is now in the chat. Nothing is "
                        "downloading yet: it starts only when the user presses it."
                        % (row["name"], gb))}


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
        raise Refusal("No such folder: %s" % folder)
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
        raise Refusal(r.json().get("detail", "could not cut this video"))
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
        raise Refusal(detail if isinstance(detail, str)
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
            raise Refusal(info.get("error") or "could not fetch that link")
        time.sleep(DOWNLOAD_POLL)
    raise Refusal("this download is still %s after %d minutes -- it is carrying on, "
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
            raise Refusal("an area given as numbers must be [ymin, ymax, xmin, xmax]")
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
            raise Refusal("could not read this video's size -- give the area as "
                             '[ymin, ymax, xmin, xmax], or use "whole"')
        band = [int(h * 0.75), h, 0, w] if word == "bottom" else [0, int(h * 0.25), 0, w]
        return band, "the %s quarter of the frame" % word
    raise Refusal('area must be "auto", "bottom", "top", "whole", '
                     "or [ymin, ymax, xmin, xmax]")


def _check_eraser(r) -> None:
    """Turn an erase route's refusal into a sentence. The 409 is the pack, not
    a model, so there is no size to name -- the user installs it from the
    screen, and nothing here can do it for them."""
    if r.status_code == 409:
        raise Refusal("The subtitle eraser is not installed on this computer. Ask "
                         "the user to install it from the Erase subtitles screen.")
    if r.status_code in (400, 404, 422, 503, 507):
        detail = r.json().get("detail", "could not erase this video's subtitles")
        raise Refusal(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()


@mcp.tool()
def erase_subtitles(video_path: str, area: Union[str, List[int]] = "auto",
                    start: Optional[float] = None,
                    end: Optional[float] = None, confirm: bool = False) -> dict:
    """Rub out the subtitles BURNED INTO a video and keep the rest of the picture.

    Free and local (no Perso, no credits), but slow -- minutes per minute of
    video -- so NOTHING STARTS UNASKED: called without confirm=true it starts
    nothing and returns the plan (which file, which part of the frame). Relay
    it to the user as a question and end your reply; confirm=true is refused
    in the same reply. Only when the user's own message already names the
    file and says to go, call with confirm=true straight away. With several
    videos, put the whole plan (which file is erased, which is dubbed) to the
    user in one question.

    It goes in the same queue a dub does and, with confirm=true, answers at
    once with {job_id, status, area_used}. Follow it with get_job_status, which
    gives a percent, and once it says done=true call save_erased(job_id) to put
    the cleaned video under the user's Downloads folder (Downloads/<day>/<project>).

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
        raise Refusal("No such video: %s" % video_path)
    if (start is None) != (end is None):
        raise Refusal("give both start and end, or neither")
    if not confirm:
        where = {"auto": "where the app finds them", "whole": "anywhere in the frame",
                 "bottom": "in the bottom quarter", "top": "in the top quarter"}
        said = (where.get(area.strip().lower(), "in the area given")
                if isinstance(area, str) else "in the box you gave")
        part = "" if start is None else " from %gs to %gs" % (start, end)
        return _ask("erase_subtitles", {"needs_confirmation": True, "message": (
            "Erase the subtitles in %s%s, %s. Free on this machine, but it takes "
            "minutes per minute of video. Proceed?" % (os.path.basename(path), part, said))},
            plan="%s|%s|%s|%s" % (os.path.basename(path), area, start, end))
    _answered("erase_subtitles", "%s|%s|%s|%s" % (os.path.basename(path), area, start, end))
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

    dir is a folder the user names; left empty it goes to Downloads/<day>/
    <project>, the folder the dub's exports use, named after the project with
    "(no subtitles)" on the end. An
    existing file is never written over. Check get_job_status says done first.
    """
    body = {"dir": dir} if dir else {}
    r = _api_post("/api/erase/%s/save" % job_id, json=body, timeout=120.0)
    _check_eraser(r)
    return r.json()


@mcp.tool()
def list_jobs(active_only: bool = True) -> List[dict]:
    """What PersoDub is working on right now, newest first.

    Each entry carries id, kind ("dub" or "erase"), title, status, the
    target language_code and project_id: the dubbings of one video into
    several languages share one project_id (the first one's id). This is
    how "stop it", "how far along is it?" or "what is it doing?" becomes a job
    id: work the user started on the screen has an id they have never seen and
    cannot be asked for. Follow it with get_job_status for the percentage, or
    cancel_dub to stop one.

    active_only lists only what is queued, running or stopping. False lists
    the finished ones too, newest first.
    """
    r = _api_get("/api/dub/jobs", timeout=10.0)
    r.raise_for_status()
    body = r.json()
    jobs = body.get("jobs", body) if isinstance(body, dict) else body
    live = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING)
    out = []
    for j in jobs:
        status = j.get("status") or ""
        if active_only and status not in live:
            continue
        out.append({"id": j.get("id"), "kind": j.get("kind") or "dub",
                    "title": j.get("project") or "", "status": status,
                    "language_code": j.get("language_code"),
                    "project_id": j.get("project_id") or j.get("id")})
    return out


@mcp.tool()
def cancel_dub(job_id: str) -> dict:
    """Cancel ONE job AT ONCE -- a dub or a subtitle erase: a waiting job
    leaves the line, a running one stops at its next safe point.

    Never ask the user to confirm first -- "cancel it" IS the confirmation,
    and a cancel is urgent (asking again meant the job sometimes finished
    before the user could answer). A job that already ended
    (done/error/cancelled) has nothing left to stop. Job ids come from
    queue_dub, erase_subtitles and list_jobs -- and list_jobs is the one to
    use when the user says "stop it" about work they started on the screen,
    whose id they have never seen.
    """
    job = _job(job_id)
    status = job.get("status")
    if status in (JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELLED):
        raise Refusal("nothing to cancel: this job is already %s" % status)
    r = _api_post("/api/dub/jobs/%s/cancel" % job_id, timeout=30.0)
    if r.status_code in (404, 409):
        detail = r.json().get("detail", "cannot cancel this job")
        raise Refusal(detail if isinstance(detail, str) else str(detail))
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
        raise Refusal(detail if isinstance(detail, str) else str(detail))
    r.raise_for_status()
    return r.json()


if __name__ == "__main__":
    mcp.run(transport="stdio")
