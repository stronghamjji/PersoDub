"""Simple background job management.

Dubbing takes time, so when a request comes in it runs on a separate thread
and its progress status (running/done/error/cancelling/cancelled) can be
queried.
"""
import contextlib
import glob
import hashlib
import json
import logging
import os
import subprocess
import threading
import time
import traceback
import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any, Callable, Dict, List, Optional

from app.config import PERSODUB_LOG_DIR
from app.memline import mem_line
from app.netlog import CUT as _CUT
from app.netlog import described as _described
from app.netlog import no_query as _no_query

logger = logging.getLogger("persodub.jobs")

# What a job.json holds. Deliberately not the whole record: `logs` runs to
# thousands of lines, and `notices`/`cancel_requested` only mean anything while
# the job is still running. `result` is added separately -- only its out_path
# and the language it detected, because the rest of run_dub's return value is of
# no use once the job is over.
# `language` is the target language's NAME ("Korean"), which is what run_dub
# takes -- without it a job restored from a file could only be run again on its
# code. `trim_pending` says the cut has NOT been made in input.mp4 yet, which is
# only ever true of a link job between its download and its cut; written that way
# round so that a job.json from before it existed (no key, so false) is read as
# "already cut", which is what every job saved until now was.
# The engine choices a job was started with (stt_engine "whisper"/"perso",
# translator "gemma"/"gemini"/..., tts "qwen3", quality = how many takes per line,
# separation "demucs"/"roformer"/"perso") are saved too, so a finished job can say what made it and "Try again" can
# repeat the same choices instead of falling back to today's defaults. A job.json
# written before they existed simply has no such keys -- every reader treats them
# as unknown and shows nothing.
# `kind` says what work a job is: a dub, or erasing the subtitles burned into
# a video ("erase" -- app/erase_launch.py). It is saved because the boot re-arm
# has nothing but job.json to tell the two apart, and it is read through
# kind_of below, so a record written before erasing existed still reads as the
# dub it was. `area` is the band of the frame an erase worked in ("whole" for
# all of it), for the same reason: a job that waits out a restart must come
# back to the part of the video its user picked. `check` is what the eraser
# found when it looked at its own finished video (how many sampled frames still
# held writing) -- the answer to "is it really gone?", which the screen and the
# agent both show, so it has to outlive the run that measured it.
SAVED_FIELDS = ("id", "status", "kind", "language", "language_code", "source_lang",
                # "project" names the folder and never moves; "title" is what
                # the screens show, and is the user's to change (2026-09-10).
                "project", "title", "day", "from_link", "created", "work_dir", "trim",
                "trim_pending", "error", "remade_as", "area", "check",
                # The error in the user's language, as the screens show it
                # ("error" stays English: the desktop app sorts failures by
                # its words, and the failure reports send it). Kept, so a
                # restart still shows it; the language of the moment it failed.
                "error_shown",
                # What caused it, in the same language, when the engine kept
                # that apart from the sentence (shown_error's detail): the
                # screen writes it as a smaller line under the sentence, whole.
                "error_detail",
                "stt_engine", "translator", "tts", "quality", "separation",
                # The model the translator answered with ("gpt-5.6-luna"): the
                # screen names it beside the translator, after the default
                # has moved on (app/translate.py translator_model).
                "translator_model",
                "dub_mode", "perso_project_seq", "perso_space_seq",
                # The Perso voice model a cloud dubbing was started with.
                "perso_model",
                # What a finished dub cost in Perso credits and how long the
                # video was -- lifted off the result for the usage count the
                # shell sends the moment a job is done (desktop/src/usageIpc.js).
                "perso_credits", "duration",
                # What separated the voice from the background: "RoFormer",
                # "Demucs" or "Perso". "separation" above is the choice made
                # (demucs, roformer or perso); this is what ran.
                "separation_model",
                # A redub: Resume must stay voices-only, never replay the
                # original's (possibly paid) transcription.
                "voices_only",
                # What the boot re-arm needs to rebuild a queued job's work:
                # the speaker count, and (for a link job still waiting to
                # download) the link itself.
                "num_speakers", "source_url",
                # The held video a dub was cut from and the parts it kept:
                # Add language opens a new draft on them (dub_job_again).
                "download_id", "ranges", "ranges_pending",
                # A dubbing made with Add language: the id of its project's
                # first dubbing, so one video's languages are one project.
                # None on that first one, and on every job saved before it.
                "project_id",
                # The id a reopened separation's own video is held under
                # (app/api/separate.py separate_open). The held record lives in
                # memory only but its file stays on disk, so after a restart a
                # reopen holds that same file again instead of copying the
                # whole video into a new folder each time, and a dubbing that
                # names the id still finds the two sounds
                # (app/separate_launch.py stems_for).
                "held_again",
                # The subtitle file a "captions" job was made from, by name:
                # the Subtitle style tab shows it beside the video.
                "srt_name")

# A key a record carries only at run time, left out on purpose. `started`
# (app/separate_launch.py) is when a separation began, for the time the screen
# counts while it runs -- and nothing is running after a restart (restore turns
# it into an error). `started_hour`, `elapsed_seconds` and `stage_seconds`
# (JobStore._launch) are how long the run took, read by the shell's usage count
# the moment the job ends (desktop/src/analytics.js dubFacts) and by nothing
# after it.

# What GET /api/dub/jobs sends the screen: the same minus the two absolute
# paths. The sidebar names a job, colours its dot and addresses everything else
# -- open, delete, retry -- by id, so shipping the user's home directory in
# every row would be for nothing.
LIST_FIELDS = tuple(f for f in SAVED_FIELDS if f not in ("work_dir", "source_url"))

# What a job's "Inputs:" line (JobStore._launch) says the job was given: the
# record's settings, without its state (id, status, the error), without the two
# paths LIST_FIELDS already leaves out, and without the video's names (project,
# title) or the Perso workspace number. The job's log goes out with a failure
# report, which docs/privacy.md says never carries a project name or a
# filename, and the report's masker takes the workspace number out of every
# line it recognises (app/report_mask.py).
_INPUT_FIELDS = tuple(f for f in LIST_FIELDS if f not in (
    "id", "status", "error", "error_shown", "error_detail", "project", "title", "perso_space_seq"))


class JobStatus(StrEnum):
    """Where a job stands, in the words job.json, every HTTP answer and the
    screen use. A StrEnum, so a member IS that word: it equals the plain string
    a job.json is read back as, and json, f-strings and %s write it bare. Only
    repr() names the class -- keep it out of anything shown or saved.

    A job the app was closed under comes back as ERROR with the error
    "interrupted" (restore below); that word is not a status of its own.
    """
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    DONE = "done"
    # A Perso API dubbing a free-plan workspace cannot download: over and
    # paid for, its result on Perso's site instead of in the folder (owner,
    # 2026-10-28). The work says so in its result ({"on_perso": True}).
    ON_PERSO = "on_perso"
    ERROR = "error"


class JobKind(StrEnum):
    """What work a job is, as the `kind` field spells it. Read it through
    kind_of: a record that has no kind is a dub."""
    DUB = "dub"
    ERASE = "erase"
    SEPARATE = "separate"
    # A video and a subtitle file the user brought, for the Subtitle style
    # tab alone (app/api/captions.py): finished the moment it exists.
    CAPTIONS = "captions"


def kind_of(job: dict) -> str:
    """What kind of work this job is: "dub", "erase" or "separate" (the voice
    and the background of a video, apart -- app/separate_launch.py).

    The one place the default lives. Nothing writes "dub" onto a record -- a
    dub is what every job in this app was until subtitle erasing arrived, so a
    record that says nothing is one, whether it came from a file written last
    year or from a job started a second ago.
    """
    return job.get("kind") or JobKind.DUB


class JobCancelled(Exception):
    """Raised by a job's target function (see app/pipeline.py's cancel_check
    checkpoints) to signal cooperative cancellation -- caught by JobStore's
    thread wrapper and turned into a "cancelled" status instead of "error"."""


def raise_if_cancelled(cancel_check: Optional[Callable[[], bool]], log: Callable[[str], None]) -> None:
    """Cooperative cancellation checkpoint: when cancel_check says Cancel was
    pressed, write "Cancelled by user request" to the job log and raise
    JobCancelled.

    cancel_check is polled instead of killing the worker thread/subprocess
    mid-stage -- the safest form of interruption here (see
    JobStore.request_cancel). Work already in flight (e.g. the Qwen3-TTS
    sidecar call) always finishes; cancellation takes effect at the next
    checkpoint: between pipeline stages (app/pipeline.py), between voice
    lines and between pace-fit rounds (app/qwen_pipeline.py). The log line is
    written at every one of them: without it a cancel in the voices left no
    trace in the log.
    """
    if cancel_check is not None and cancel_check():
        log("Cancelled by user request")
        raise JobCancelled("cancelled by user")


def _trace_memory(trace) -> None:
    """A memory line (app/memline.py) through `trace`, when there is one."""
    line = mem_line()
    if line:
        trace(line)


# The app/ package. A failure's "At:" places are named from the folder above
# it, as the repository names them ("app/pipeline.py").
_APP_DIR = os.path.dirname(os.path.abspath(__file__))


def _chain(exc: Optional[BaseException], most: int = 6) -> list:
    """The exception and the ones it came from, walked as Python's traceback
    walks them: __cause__, else __context__ unless `from None` hid it."""
    found = []
    while exc is not None and len(found) < most:
        found.append(exc)
        exc = exc.__cause__ if exc.__cause__ is not None else (
            None if exc.__suppress_context__ else exc.__context__)
    return found


def _http_line(exc: BaseException) -> str:
    """"HTTP 503 GET https://host/path: <the answer's first words>". The
    address goes without its query string, which can carry a key or a name."""
    response = exc.response
    words = ["HTTP", str(response.status_code)]
    for owner in (exc, response):
        with contextlib.suppress(Exception):   # httpx raises when none was set
            if owner.request is not None:
                words += [str(owner.request.method), str(owner.request.url).split("?", 1)[0]]
                break
    body = ""
    with contextlib.suppress(Exception):   # an answer that was never read
        body = " ".join(_no_query(response.text).split())[:_CUT]
    return " ".join(words) + (f": {body}" if body else "")


def _output_lines(exc: subprocess.CalledProcessError) -> list:
    """The last 20 lines a program that failed printed: its errors, else its output."""
    out = exc.stderr or exc.output or ""
    if isinstance(out, bytes):
        out = out.decode("utf-8", "replace")
    tail = [_no_query(line.rstrip())[:_CUT] for line in out.strip().splitlines()[-20:]]
    return ["  Output:"] + ["    " + line for line in tail] if tail else []


def _app_places(chain: list) -> list:
    """Up to three "app/pipeline.py:812 in _stage_finish", innermost first,
    from the deepest error in the chain that passed through app/: where it
    broke, not where it was put into words. Nothing from this file: the step
    timer's own frame sits in every step's traceback."""
    root, here = os.path.dirname(_APP_DIR), os.path.abspath(__file__)
    for exc in reversed(chain):
        frames = [(os.path.abspath(f.filename), f) for f in traceback.extract_tb(exc.__traceback__)]
        frames = [(path, f) for path, f in frames if path.startswith(_APP_DIR + os.sep) and path != here]
        if frames:
            return ["%s:%s in %s" % (os.path.relpath(path, root).replace(os.sep, "/"), f.lineno, f.name)
                    for path, f in reversed(frames[-3:])]
    return []


def _failure_lines(exc: BaseException) -> list:
    """The block under a step's FAILED line, each part only when it applies:
    the errors it came from, the HTTP answer or the program output behind it,
    and where in app/ it broke."""
    chain = _chain(exc)
    lines = [f"  Caused by: {_described(c)}" for c in chain[1:]]
    answered = next((c for c in chain
                     if getattr(getattr(c, "response", None), "status_code", None) is not None), None)
    if answered is not None:
        lines.append("  " + _http_line(answered))
    ran = next((c for c in chain if isinstance(c, subprocess.CalledProcessError)), None)
    if ran is not None:
        lines += _output_lines(ran)
    return lines + [f"  At: {place}" for place in _app_places(chain)]


@contextlib.contextmanager
def timed_step(log, step: str, name: str, **context):
    """One step of a job between a START line and a DONE, CANCELLED or FAILED
    line with its seconds ("[Step 1/6] separate DONE (12.3s)"), each followed
    by a memory line, so the job's file reads like an operations log.

    Written through log.trace, the file-only line JobStore's log carries
    (_launch below): the screen keeps exactly the progress lines it parses. A
    log without one (a test's list) is handed them as plain lines. `context`
    is what the step was given -- settings and counts, never a file name or a
    path -- for a Context line under START; None is left out. A failure says
    what it was and, under that, why and where (_failure_lines), and leaves
    with the step it stopped in (persodub_step), which the job's own FAILED
    line names.
    """
    trace = getattr(log, "trace", None) or (lambda msg, level="INFO": log(msg))
    label = f"[Step {step}] {name}"
    trace("#" * 30)
    trace(f"{label} START")
    given = " ".join(f"{key}={value}" for key, value in context.items() if value is not None)
    if given:
        trace(f"{label} Context: {given}")
    _trace_memory(trace)
    began = time.monotonic()
    # The job's tally of each step's whole seconds, when its log keeps one
    # (JobStore._launch): a step that ran, done or failed, is in it by name.
    tally = getattr(log, "stage_seconds", None)
    try:
        yield
    except JobCancelled:
        trace(f"{label} CANCELLED ({time.monotonic() - began:.1f}s)")
        _trace_memory(trace)
        raise
    except Exception as e:
        trace(f"{label} FAILED ({time.monotonic() - began:.1f}s): {_described(e)}", level="ERROR")
        if tally is not None:
            tally[name] = round(time.monotonic() - began)
        # Describing a failure must never become the failure.
        with contextlib.suppress(Exception):
            for line in _failure_lines(e):
                trace(line, level="ERROR")
        _trace_memory(trace)
        # An exception that takes no attributes still fails the job; its
        # FAILED line just cannot say where.
        with contextlib.suppress(AttributeError):
            e.persodub_step = f"{step} {name}"
        raise
    trace(f"{label} DONE ({time.monotonic() - began:.1f}s)")
    if tally is not None:
        tally[name] = round(time.monotonic() - began)
    _trace_memory(trace)


def _failed_step(exc: Optional[BaseException]) -> str:
    """The step a failure stopped in (timed_step's persodub_step), looked for
    down the exception's chain too: the cloud dub re-raises Perso's error as a
    sentence of its own (app/dub_launch.py), and that is what reaches the job.
    "?" for a failure between steps."""
    for e in _chain(exc):
        step = getattr(e, "persodub_step", None)
        if step:
            return step
    return "?"


# The exception types whose message was WRITTEN for the user, and so can go
# straight under the red bar on the done screen. This table decides one thing
# and one thing only: which sentence error_text_for_ui hands the red bar, and
# whether the run wrapper below also appends a traceback to the job log. It is
# not a privacy boundary -- the job log has always carried
# `Error: <Type>: <text>` for every failure, unchanged by this branch, and
# GET /api/dub/jobs/{jid} returns those lines.
#
# RuntimeError is the whole of the pipeline's user-facing vocabulary: every
# sentence app/pipeline.py hands a failed job comes out of _raise_notice or one
# of its `raise RuntimeError(msg)` sites ("Perso credits are used up. Recharge
# to continue.", "No dialogue lines were found in this video."), and the Perso
# client's PersoCreditExhausted/InvalidKey/Unavailable errors, source_fetch's
# FetchError and translate.py's Gemini errors are all RuntimeError subclasses.
# ValueError is here because the engines raise it with a written-out sentence
# too (app/engines/qwen_tts.py's ICL check) and tests/test_jobs.py pins that
# text as what a failed job shows.
#
# Anything else -- an AttributeError, a KeyError, an OSError from a corner of
# the code nobody wrote a message for -- is a bug, and its text is usually
# meaningless as a sentence ("'NoneType' object is not subscriptable"), so the
# red bar names the type and points at the job log instead.
USER_FACING_ERRORS = (JobCancelled, RuntimeError, ValueError)


def error_text_for_ui(exc: BaseException) -> str:
    """The sentence a failed job shows the user, from the exception that ended it."""
    if isinstance(exc, USER_FACING_ERRORS):
        return str(exc) or type(exc).__name__
    return "Unexpected error (%s) - see the job log" % type(exc).__name__


def shown_error(message: str, shown: str, detail: Optional[str] = None) -> RuntimeError:
    """A failure the engine words itself, in two languages: the message is
    the English sentence (the job's error, its log, the failure reports and
    the desktop app's sorting of failures all read that one), and `shown` is
    the same sentence in the user's language, the job's error_shown. Built
    from app/i18n.py's both(): raise shown_error(*both("No dialogue ...")).

    `detail` is what caused it, in the user's language too ("Reason: no
    reply", "Perso said: ... (VT5001)"), for a failure whose sentence says
    what to do and whose cause is someone else's words: the job's
    error_detail, which the screen shows under the sentence. `message` keeps
    the cause as well, for the log and the reports.

    A plain RuntimeError with one attribute more, so every handler and every
    test that knew the RuntimeError a site raised before still knows it."""
    e = RuntimeError(message)
    e.shown = shown
    e.detail = detail
    return e


def shown_text_for_ui(exc: BaseException) -> str:
    """error_text_for_ui in the user's language: the twin the exception
    carries (shown_error, or app/source_fetch.py's FetchError), else the
    same English."""
    return getattr(exc, "shown", None) or error_text_for_ui(exc)


class JobStore:
    def __init__(self, log_dir: Optional[str] = None):
        self._jobs: Dict[str, dict] = {}
        self._lock = threading.Lock()
        self._log_dir = log_dir
        # One dub at a time (see start): the id on air, and the jobs waiting
        # behind it with the function each will run when its turn comes.
        self._active: Optional[str] = None
        self._pending: List[tuple] = []

    @property
    def log_dir(self) -> str:
        # Resolved on every read, not in __init__: app/state.py builds its store
        # at import time, before test fixtures can redirect PERSODUB_LOG_DIR --
        # a snapshot taken then would litter the real logs/ on every test run.
        return self._log_dir or PERSODUB_LOG_DIR

    @staticmethod
    def _blank(jid: str) -> dict:
        """A fresh record. Also the shape a restored job is filled out to, so
        every reader (the screen, the poll endpoint) finds the keys it expects
        even on a job that came back from a file."""
        return {
            "id": jid,
            "status": JobStatus.RUNNING,
            "result": None,
            "error": None,
            "logs": [],
            "notices": [],
            "cancel_requested": False,
            # When the job was started -- the only thing that can order the
            # Projects list, since a dict remembers nothing after a restart.
            # Down to the microsecond: two jobs started in the same second
            # would otherwise tie, and the list would order them by chance.
            "created": datetime.now().isoformat(),
        }

    def create(self) -> str:
        jid = uuid.uuid4().hex[:8]
        with self._lock:
            self._jobs[jid] = self._blank(jid)
        return jid

    def claim(self, jid: str, allowed, **kw) -> bool:
        """Set `kw` on the job only if its status is one of `allowed`, in one
        step under the lock -- two quick Resume clicks must not both start
        the same job in the same folder (review 2026-09-23)."""
        with self._lock:
            j = self._jobs.get(jid)
            if j is None or j.get("status") not in allowed:
                return False
            j.update(kw)
            return True

    def update(self, jid: str, **kw):
        with self._lock:
            if jid in self._jobs:
                self._jobs[jid].update(kw)

    # The old name of update(). No production code calls it any more -- it is
    # kept for the tests that patch or call `_update` on a store, and it goes
    # the day those move to `update`.
    # A method rather than `_update = update`: the class-body alias froze the
    # original function, so a test that replaced update on one store still had
    # _update calling the real thing.
    def _update(self, jid: str, **kw):
        return self.update(jid, **kw)

    def _write_log_line(self, jid: str, msg: str, level: Optional[str] = None):
        """Mirror a log line to log_dir/job-<jid>.log, stamped the way the app's
        own log is (app/logging_setup.py LOG_FORMAT): the time, the job, the
        level (ERROR for an "Error:" line or a traceback unless told otherwise), the line.
        Best-effort: a logging problem must never fail the dub it is describing."""
        level = level or ("ERROR" if msg.lstrip().startswith(("Error:", "Traceback (")) else "INFO")
        now = datetime.now()
        stamp = now.strftime("%Y-%m-%d %H:%M:%S") + ",%03d" % (now.microsecond // 1000)
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with open(os.path.join(self.log_dir, "job-%s.log" % jid), "a", encoding="utf-8") as f:
                f.write("%s - job-%s - %s - %s\n" % (stamp, jid, level, msg))
        except Exception as e:
            # The type only: this line's own message is a job log line, which
            # can carry a file name the user chose.
            logger.debug("Could not mirror a log line for job %s (%s)", jid, type(e).__name__)

    def append_log(self, jid: str, msg: str, screen: bool = True, level: Optional[str] = None):
        """A line of the job's log: always into its file, and into the list the
        screen reads only when `screen`. log.trace (_launch) writes the
        structural lines with screen=False, so the screen shows what it always
        has. `level` is the file's level for a line that cannot say it itself."""
        with self._lock:
            if jid not in self._jobs:
                return
            if screen:
                self._jobs[jid]["logs"].append(msg)
        self._write_log_line(jid, msg, level)

    def append_notice(self, jid: str, notice: dict):
        """Record a structured mid-job event (e.g. {"type": "perso_credit_exhausted",
        "message": ..., "link": ...}) in the job status JSON -- for events the UI
        needs to render specially (a message + link), not just as a plain log line.
        See app/pipeline.py's on_notice parameter and app/api/dub.py, which wires it here.
        """
        with self._lock:
            if jid in self._jobs:
                self._jobs[jid]["notices"].append(notice)

    def get(self, jid: str) -> Optional[dict]:
        with self._lock:
            return dict(self._jobs[jid]) if jid in self._jobs else None

    def all(self) -> List[dict]:
        """Every job, newest first, without the logs or the file paths. What
        GET /api/dub/jobs (and so the Projects sidebar) is built from."""
        with self._lock:
            jobs = [dict(j) for j in self._jobs.values()]
        jobs.sort(key=lambda j: j.get("created") or "", reverse=True)
        return [{**{k: j.get(k) for k in LIST_FIELDS}, "kind": kind_of(j)} for j in jobs]

    @staticmethod
    def _saved(j: dict) -> dict:
        rec = {k: j.get(k) for k in SAVED_FIELDS}
        result = j.get("result") or {}
        out = result.get("out_path")
        rec["result"] = {"out_path": out} if out else None
        # The done screen reads the source language from here when the job was
        # left on auto-detect, so it has to be in the file too -- otherwise a
        # restart empties that column.
        if rec["result"] and result.get("detected_source_language"):
            rec["result"]["detected_source_language"] = result["detected_source_language"]
        return rec

    def persist(self, jid: str, work_dir: str) -> None:
        """Write the job's record to work_dir/job.json.

        The record itself lives in memory and dies with the process, but the
        folder it describes does not -- so the file beside the video is what
        lets Projects reopen a job after a restart. Best-effort, like the log
        mirror: a job must not fail because its bookkeeping could not be saved.

        The folder is never created here. A real job always has one already, and
        making it would resurrect a folder the user has just deleted -- a ghost
        row in Projects holding nothing but a job.json.
        """
        j = self.get(jid)
        if j is None:
            return
        # Written beside the real file and then swapped in, never over the top
        # of it. open(..., "w") empties the file first, and the two moments this
        # is called -- as a job starts and as it ends -- are exactly when the
        # app is most likely to be quit; a half-written file would leave the
        # folder holding invalid JSON for good. os.replace within one folder is
        # atomic, so the file on disk is either the old record or the new one.
        final = os.path.join(work_dir, "job.json")
        tmp = final + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._saved(j), f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, final)
        except Exception:
            # Best-effort, like the log mirror -- but don't leave the scratch
            # file behind to be mistaken for something.
            with contextlib.suppress(OSError):
                os.remove(tmp)

    def restore(self, root: str) -> None:
        """Read every job.json under root back into the store.

        Both folder depths are searched: real jobs live at
        <workspace>/<day>/<project_lang>/job.json, and a caller pointed
        straight at a day's folder is one level shallower.
        """
        paths = (glob.glob(os.path.join(root, "*", "*", "job.json"))
                 + glob.glob(os.path.join(root, "*", "job.json")))
        loaded = set()
        for path in sorted(paths):
            try:
                with open(path, encoding="utf-8") as f:
                    rec = json.load(f)
                jid = rec["id"]
            except Exception as e:
                # One unreadable file must not cost the user every other job.
                # The day it sits under, never its own folder: that folder is
                # named after the video's file, and persodub.log is sent with a
                # failure report, which docs/privacy.md says carries no
                # filename. The day is a date and names nothing.
                logger.warning("Skipping a job folder under %s (%s)",
                               os.path.basename(os.path.dirname(os.path.dirname(path))),
                               type(e).__name__)
                continue
            if rec.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING):
                # The thread died with the process; nothing will ever finish it.
                # The token stays machine-readable; the screen turns it into a
                # sentence.
                rec["status"] = JobStatus.ERROR
                rec["error"] = "interrupted"
            loaded.add(os.path.dirname(path))
            self._restore_clipped(rec, os.path.dirname(path))
            job = self._blank(jid)
            job.update(rec)
            with self._lock:
                self._jobs.setdefault(jid, job)
        self._restore_old_folders(root, loaded)

    @staticmethod
    def _restore_clipped(rec: dict, work_dir: str) -> None:
        """Put the lines the assembly step cut short back on a finished job.

        job.json does not hold them; clipped_lines.json beside it does, and the
        script table reads them from result.clipped. Without this a restart
        turns every cut-off line back into one that "fits".
        """
        result = rec.get("result")
        if not result or "clipped" in result:
            return
        try:
            with open(os.path.join(work_dir, "clipped_lines.json"), encoding="utf-8") as f:
                info = json.load(f)
            clipped = list(info["clipped"])
        except Exception:
            return
        result["clipped"] = clipped
        result["clipped_count"] = len(clipped)

    def _restore_old_folders(self, root: str, loaded) -> None:
        """Rebuild a record for a finished folder that has no readable job.json.

        Only what the folder itself says: it holds a dubbed.mp4, its name is
        <project>_<lang> (plus _001 when the name was taken) and its parent is
        the day. The id is derived from the path so a second restore finds the
        same job rather than a duplicate.

        `loaded` is the folders whose job.json actually parsed -- not merely the
        ones that have a file. A folder whose job.json is damaged falls through
        to here and is rebuilt, instead of the broken file hiding a finished dub
        from Projects on every launch with no way back inside the app.
        """
        for work in sorted(glob.glob(os.path.join(root, "*", "*"))):
            if work in loaded:
                continue
            try:
                out = os.path.join(work, "dubbed.mp4")
                if not os.path.isfile(out):
                    continue
                parts = os.path.basename(work).split("_")
                if len(parts) > 1 and parts[-1].isdigit():
                    parts = parts[:-1]
                jid = hashlib.md5(work.encode("utf-8")).hexdigest()[:8]
                job = self._blank(jid)
                job.update(
                    status=JobStatus.DONE,
                    project="_".join(parts[:-1]) or os.path.basename(work),
                    language_code=parts[-1] if len(parts) > 1 else None,
                    day=os.path.basename(os.path.dirname(work)),
                    work_dir=work,
                    created=datetime.fromtimestamp(os.path.getmtime(out)).isoformat(timespec="seconds"),
                    result={"out_path": out},
                )
            except Exception as e:
                # Same promise as above, and the same rule about the name:
                # one odd folder is skipped, not fatal, and only the day it
                # sits under goes in the log.
                logger.warning("Skipping a job folder under %s (%s)",
                               os.path.basename(os.path.dirname(work)), type(e).__name__)
                continue
            with self._lock:
                self._jobs.setdefault(jid, job)

    def forget(self, jid: str) -> None:
        """Drop a job's record. Called when its folder is deleted: the record
        is what puts a row in Projects, so a job whose files are gone has to
        leave the list with them."""
        with self._lock:
            self._jobs.pop(jid, None)
            self._pending = [(i, t) for i, t in self._pending if i != jid]

    def is_cancel_requested(self, jid: str) -> bool:
        """Polled by app/pipeline.py's cancel_check at stage boundaries."""
        with self._lock:
            j = self._jobs.get(jid)
            return bool(j and j.get("cancel_requested"))

    def request_cancel(self, jid: str) -> Optional[str]:
        """Ask a running job to stop at its next stage boundary.

        Returns the job's status right after the call, or None if jid is
        unknown. A job that isn't "running" is left untouched (e.g. an
        already-finished job can't be cancelled) -- its current status is
        returned so the caller (POST /api/dub/jobs/{id}/cancel) can tell a
        real cancel apart from a no-op.
        """
        with self._lock:
            j = self._jobs.get(jid)
            if j is None:
                return None
            if j["status"] == JobStatus.QUEUED:
                # No thread to wind down: it stops the moment it is told to,
                # and _dispatch_next skips it when its turn would have come.
                j["status"] = JobStatus.CANCELLED
                self._pending = [(i, t) for i, t in self._pending if i != jid]
                work_dir = j.get("work_dir")
            elif j["status"] != JobStatus.RUNNING:
                return j["status"]
            else:
                j["cancel_requested"] = True
                j["status"] = JobStatus.CANCELLING
                return JobStatus.CANCELLING
        if work_dir:
            self.persist(jid, work_dir)
        return JobStatus.CANCELLED

    def run_async(self, target: Callable[[Callable[[str], None]], Any]) -> str:
        """Create a job, run target(log) on a background thread, return the job id.

        target is passed a log(msg) function it can use to record progress.
        """
        jid = self.create()
        self.start(jid, target)
        return jid

    def start(self, jid: str, target: Callable[[Callable[[str], None]], Any],
              parallel: bool = False) -> None:
        """Run target(log) now -- or, when another job is on air, queue it.

        One dub at a time, whichever door it came in through (a new upload,
        Try again, a redub): two pipelines at once would fight over the same
        GPU and memory. A queued job starts by itself the moment the one
        before it ends, however that one ends. Used instead of run_async when
        the caller needs the job id before the thread starts (e.g. to build a
        cancel_check closure bound to that id -- see app/api/dub.py).

        `parallel` is for work another machine does (a Perso cloud dub): it
        starts at once beside whatever is on air, never takes the air, and
        its ending frees nothing -- waiting in the local line would have
        idled both machines.
        """
        if parallel:
            self.update(jid, status=JobStatus.RUNNING)
            self._launch(jid, target, holds_air=False)
            return
        with self._lock:
            if self._active is not None:
                self._jobs[jid]["status"] = JobStatus.QUEUED
                self._pending.append((jid, target))
                work_dir = self._jobs[jid].get("work_dir")
                queued = True
            else:
                self._active = jid
                # Fresh jobs are born "running"; a re-armed queued one is not.
                self._jobs[jid]["status"] = JobStatus.RUNNING
                queued = False
        if queued:
            # The file beside the video has to say "queued" too, or a restart
            # would read the "running" written when the record was made and
            # turn a job that lost nothing into an error.
            if work_dir:
                self.persist(jid, work_dir)
            return
        self._launch(jid, target)

    def _dispatch_next(self) -> None:
        """The job on air is over -- put the next waiting one on."""
        while True:
            with self._lock:
                self._active = None
                if not self._pending:
                    return
                jid, target = self._pending.pop(0)
                j = self._jobs.get(jid)
                if j is None or j.get("status") != JobStatus.QUEUED:
                    continue      # cancelled or deleted while it waited
                j["status"] = JobStatus.RUNNING
                self._active = jid
            work_dir = (self.get(jid) or {}).get("work_dir")
            if work_dir:
                self.persist(jid, work_dir)
            self._launch(jid, target)
            return

    def _launch(self, jid: str, target: Callable[[Callable[[str], None]], Any],
                holds_air: bool = True) -> None:
        """Run target(log) on a background thread.

        holds_air: this job owns the one local seat (self._active is jid), so
        its ending must hand the seat to the next in line. A parallel (cloud)
        job never held it, and must not hand it to anyone."""
        def log(msg: str):
            self.append_log(jid, msg)

        def trace(msg: str, level: str = "INFO"):
            # A structural line -- a step's banner, the inputs, how the job
            # ended: the job's file and the app log only, never the screen,
            # whose progress bar is read off its own lines.
            self.append_log(jid, msg, screen=False, level=level)
            (logger.error if level == "ERROR" else logger.info)("job-%s: %s", jid, msg)

        log.trace = trace
        log.stage_seconds = {}   # filled by timed_step, one entry per step that ran

        def _wrap():
            began = time.monotonic()
            # When it started, on this computer's clock, and how long it took:
            # whole numbers for the usage count, which lands on the record with
            # the ending, before the status flips, as the credits do below.
            started_hour = datetime.now().hour

            def timing():
                return {"started_hour": started_hour,
                        "elapsed_seconds": round(time.monotonic() - began),
                        "stage_seconds": dict(log.stage_seconds)}
            try:
                rec = self.get(jid) or {}
                trace("JOB START (%s)" % kind_of(rec))
                # The edition first: it decides where a dub runs when nothing
                # is chosen (app/setup.py), and the desktop shell hands it over
                # (desktop/src/orchestrator.js). A plain server run has none.
                given = {"edition": os.environ.get("PERSODUB_EDITION") or "opensource",
                         **{k: rec[k] for k in _INPUT_FIELDS if k in rec}}
                trace("Inputs: " + json.dumps(given, ensure_ascii=False, default=str))
                _trace_memory(trace)
                result = target(log)
                # A job left on auto-detect only learns its source language by
                # running, and the answer arrives inside the result. Copying it
                # onto the record is what makes it outlive the process: the file
                # keeps the record, and the done screen names the source column
                # from it. A language the user actually chose is never overwritten.
                detected = result.get("detected_source_language") if isinstance(result, dict) else None
                # The Perso credits spent and the video's length travel the
                # same way, and land on the record BEFORE the status flips:
                # the shell reads them off the job the moment it sees "done".
                spent = {k: result[k] for k in ("perso_credits", "duration", "separation_model")
                         if isinstance(result, dict) and result.get(k) is not None}
                on_perso = isinstance(result, dict) and bool(result.get("on_perso"))
                # The memory line before the status flips, as on the other two
                # endings: measuring takes a moment, and a job that reads "done"
                # while it still holds the air leaves the next one queued behind it.
                _trace_memory(trace)
                with self._lock:
                    cancelled = self._jobs[jid]["status"] == JobStatus.CANCELLING
                    if cancelled:
                        self._jobs[jid]["status"] = JobStatus.CANCELLED
                    else:
                        self._jobs[jid].update(spent, **timing())
                        self._jobs[jid]["status"] = JobStatus.ON_PERSO if on_perso else JobStatus.DONE
                        # No file came home: nothing to read the result's out_path for.
                        self._jobs[jid]["result"] = None if on_perso else result
                        if detected and not self._jobs[jid].get("source_lang"):
                            self._jobs[jid]["source_lang"] = detected
                # Cancel pressed while the work ran to its end: still a cancel.
                trace("JOB %s (%.1fs)" % ("CANCELLED" if cancelled else "DONE ON PERSO" if on_perso else "ALL DONE",
                                          time.monotonic() - began))
            except JobCancelled:
                _trace_memory(trace)
                trace("JOB CANCELLED (%.1fs)" % (time.monotonic() - began))
                self.update(jid, status=JobStatus.CANCELLED)
            except Exception as e:
                # The class name stays in the log for debugging; the stored
                # error is what the UI shows the user under the red bar, and
                # "RuntimeError:" in front of a plain-language sentence only
                # made it read like a crash.
                log(f"Error: {type(e).__name__}: {e}")
                # An unexpected failure also gets its traceback in the job's
                # own log, where the "see the job log" sentence is pointing;
                # a failure with a written-out message (credits used up, no
                # dialogue found) is not a bug and gets none on the screen, so
                # the friendly sentence stays the last thing under the red bar.
                if not isinstance(e, USER_FACING_ERRORS):
                    log(traceback.format_exc())
                else:
                    # A failure worded for the user still came from somewhere:
                    # its traceback goes to the file, never the screen, and the
                    # errors it quotes keep their links but not their queries.
                    trace(_no_query("".join(traceback.format_exception(e))).rstrip(), level="ERROR")
                _trace_memory(trace)
                trace("JOB FAILED at step %s (%.1fs): %s: %s" % (
                    _failed_step(e), time.monotonic() - began, type(e).__name__, error_text_for_ui(e)),
                    level="ERROR")
                self.update(jid, status=JobStatus.ERROR, error=error_text_for_ui(e),
                            error_shown=shown_text_for_ui(e), error_detail=getattr(e, "detail", None),
                            **timing())
            # However it ended, the file beside the video now says so -- this is
            # the only moment the final status exists to be written down.
            work_dir = (self.get(jid) or {}).get("work_dir")
            if work_dir:
                self.persist(jid, work_dir)
            # However this one ended, the air is free now -- unless this job
            # never held it (a parallel cloud dub beside the local line).
            if holds_air:
                self._dispatch_next()

        threading.Thread(target=_wrap, daemon=True).start()
