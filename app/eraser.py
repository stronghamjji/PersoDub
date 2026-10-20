"""Subprocess bridge to the two subtitle-eraser scripts: erasing the subtitles
burned into a video (app/scripts/erase_subtitles.py) and finding where they sit
(app/scripts/suggest_area.py).

video-subtitle-remover brings paddleocr, paddlepaddle and its own torch build,
none of which are in the app's own venv, so both run as separate processes
under ERASER_PYTHON -- the same shape as app/separate.py, for the same reason.
Where that interpreter is, and where the tool is checked out, is asked afresh
every time (paths_now below) rather than read once at startup.

Unlike separation, an erase runs for minutes and says so as it goes: every
`progress N%` line the script prints is handed to the job's log, which is
where GET /api/erase/{jid} reads the percentage back from. And unlike the
pipeline, it has no stage boundary to stop at politely -- one blocking call
does the whole video -- so a cancelled job's process is killed.
"""
import collections
import contextlib
import json
import os
import queue
import re
import subprocess
import threading

from app.i18n import both, t
from app.jobs import JobCancelled, shown_error
from app.run_errors import advice_both, ran_out_of_memory
from app.settings_env import current_value

SCRIPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts")
ERASE_SCRIPT = os.path.join(SCRIPT_DIR, "erase_subtitles.py")
SUGGEST_SCRIPT = os.path.join(SCRIPT_DIR, "suggest_area.py")

# PaddleX asks four model hosts whether they are reachable the first time it is
# imported, which costs seconds and needs the network. The eraser wants none of
# it: video-subtitle-remover ships its own detector weights (backend/models/V5)
# and names them by path. Measured 2026-09-09 against an empty cache -- with
# the check skipped nothing is downloaded and nothing is looked up, so the pack
# also works on a computer that is offline.
CHILD_ENV = {"PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True"}

# How the script hands back what its own check of the finished video found.
# One line of JSON on stdout, not a log line: the numbers belong on the job
# record, where the screen and the agent read them.
CHECK_PREFIX = "check "

# A line the script wants on the job's record but that is not a percentage:
# something it noticed and worked around. Rare, and the kind of thing nobody
# can reconstruct afterwards if it is not written down.
NOTE_PREFIX = "note "

# How long suggest_area may take before it is given up on. It reads a dozen
# frames -- 27 seconds on this Mac for a 10-second clip (2026-09-09), most of
# it loading the detector, and seeking through a long video costs more. Three
# minutes is well past anything healthy, and the screen is waiting on this one.
SUGGEST_TIMEOUT = 180

# The one failure that is not a fault: the band the user drew held no writing,
# so there was nothing to rub out. video-subtitle-remover says so by raising,
# and its traceback carries both the name it looked the sentence up by and the
# sentence itself -- which ends in the user's own file path, which is why it is
# not the one shown.
NO_SUBTITLES_MARKS = ("NoSubtitleDetected", "No subtitles detected")
NO_SUBTITLES_MESSAGE = "No subtitles were found in that area. Move the box and try again."

# Lines the libraries underneath print in the ordinary course of starting up.
# The failure sentence quotes the last thing the script said, and when a run is
# killed outright that is whatever notice happened to be sitting there: a
# forced stop showed the user "failed (Connectivity check to the model hoster
# has been skipped...)", which is not an error at all -- it is Paddle saying a
# check WE turned off was not run (Windows, 2026-09-11).
QUIET_MARKS = (
    "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK",
    "Connectivity check",
    "Warning:", "warnings.warn", "UserWarning", "FutureWarning", "DeprecationWarning",
    # Windows writes its own notices into the same pipe: a shell command that
    # matched no files says "INFO: Could not find files for the given
    # pattern(s)", which arrived in the parentheses as the reason a kill had
    # failed the run (Windows, 2026-09-11).
    "INFO:",
)

# Which half of the work it died in. The script's own percentages say: 0-50 is
# the search, 50-100 the repainting. Naming the half is the difference between
# "the eraser broke" and something the user can act on -- a band in the wrong
# place fails in the first half, a video the decoder chokes on in the second.
# Each in English and in the user's language (app/i18n.py both()).
def _stopped_in(reached):
    if reached < 50:
        return both("The subtitle eraser stopped while looking for the subtitles.")
    return both("The subtitle eraser stopped while erasing them.")


# The same sentence the dubbing stages that run on this machine end with
# (app/pipeline.py's _check_file): there is no service to ask about work done
# here, so the file is the thing to look at -- unless the script's last words
# say the machine ran out of time or memory (app/run_errors.py advice_both),
# when the video was never the problem.
def _check_file():
    return both("Check the video file.")


def _why_stopped(reached, tail):
    """(English, the user's language) for a run that exited with an error."""
    last = _last_real_line(tail)
    # The graphics card's memory: CUDA and Apple's MPS say "out of memory"
    # with their name on it. Its own sentence, since the stage is beside the point.
    if ran_out_of_memory(last) and re.search(r"cuda|mps|gpu", last, re.IGNORECASE):
        return both("The subtitle eraser stopped because the graphics memory ran out. Close other apps and try again.")
    stopped, advice = _stopped_in(reached), advice_both(last, _check_file())
    return f"{stopped[0]} {advice[0]}", f"{stopped[1]} {advice[1]}"


class EraserMissing(RuntimeError):
    """The subtitle-eraser pack is not installed on this computer. The routes
    (app/api/erase.py) turn this into the 409 the screen offers a download on,
    rather than a failed job."""


def paths_now():
    """Where the eraser is right now: (interpreter, checkout), "" for either
    one nothing names.

    Asked afresh every time, through kit.env (settings_env.current_value, the
    way the API keys and STT_ENGINE are asked), because this pack is installed
    while the app is running: the desktop shell writes ERASER_PYTHON and
    ERASER_VSR_DIR into kit.env the moment the download finishes, and a value
    read once at startup would keep saying "not installed" until the next
    launch. Removing the pack takes those two lines back out again, so no line
    means no pack.
    """
    return current_value("ERASER_PYTHON"), current_value("ERASER_VSR_DIR")


def _resolve(python, vsr_dir):
    """The interpreter and the checkout to run with, or EraserMissing.

    The caller may name its own (that is what the tests do); otherwise this
    asks what is installed at this moment.
    """
    now_py, now_vsr = paths_now()
    py = python or now_py
    vsr = vsr_dir or now_vsr
    if not (py and vsr and os.path.isfile(py) and os.path.isdir(vsr)):
        raise EraserMissing("The subtitle eraser is not installed on this computer.")
    return py, vsr


def _child_env():
    return {**os.environ, **CHILD_ENV}


def _last_real_line(tail) -> str:
    """The last thing the script said that was actually about a failure.

    Startup notices are skipped: they are the only thing in the buffer when a
    run is killed rather than broken, and quoting one tells the user the wrong
    story entirely. If every line is a notice, say nothing rather than the
    wrong thing -- the sentence in front of this already says what happened.
    """
    for line in reversed(tail):
        if line.strip() and not any(mark in line for mark in QUIET_MARKS):
            return line
    return ""


def _fail(what, tail, shown=None):
    """A RuntimeError carrying the last thing the script said. One sentence for
    the user, then the line itself -- app/jobs.py shows this under the red bar.
    `shown`: the sentence in the user's language as well, for a failed job's
    error_shown (a shown_error then)."""
    last = _last_real_line(tail)[:200] or "no error was printed"
    if shown is None:
        return RuntimeError("%s (%s)" % (what, last))
    return shown_error("%s (%s)" % (what, last), "%s (%s)" % (shown, last))


def run_erase(input_path, out_path, area, *, log, cancel_check,
              python=None, vsr_dir=None):
    """Erase the subtitles from input_path into out_path. Blocks until done.

    `area` is (ymin, ymax, xmin, xmax) -- the band to work in, about twice as
    fast as the whole frame, which is what None means. `log` is the job's log
    function and gets every `progress N%` line; `cancel_check` is polled while
    the process runs, and a true answer kills it and raises JobCancelled.

    Returns what the script's own check of the finished video found --
    {"frames_checked", "frames_with_text", "sample_times", "repainted"} -- or
    None from a script too old to look. It is a number, not a log line: the job
    record carries it and the screen and the agent both read it there.
    """
    py, vsr = _resolve(python, vsr_dir)
    cmd = [py, ERASE_SCRIPT, "--vsr-dir", vsr, "-i", input_path, "-o", out_path]
    if area:
        cmd += ["--area"] + [str(int(v)) for v in area]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace",
                            env=_child_env())

    # Both pipes are drained on threads. stderr because a full pipe would
    # deadlock the child, and stdout because the wait below has to keep
    # polling for a cancel even through the minutes of detection work that
    # print nothing at all.
    errors = collections.deque(maxlen=20)
    lines: queue.Queue = queue.Queue()

    def _drain_errors():
        for line in proc.stderr:
            errors.append(line.rstrip())

    def _drain_output():
        for line in proc.stdout:
            lines.put(line.rstrip())
        lines.put(None)          # the end of the output, whatever ended it

    threading.Thread(target=_drain_errors, daemon=True).start()
    threading.Thread(target=_drain_output, daemon=True).start()

    checked = None
    # The last percentage seen, which is how the failure sentence knows which
    # half of the work it died in.
    reached = 0
    while True:
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            line = ""
        if line is None:          # stdout closed: the run is over, one way or another
            break
        if cancel_check():
            proc.kill()
            proc.wait()
            raise JobCancelled("Subtitle erasing was cancelled.")
        # Only the progress lines are kept. The rest of what the tool prints
        # (its own banners, a library's tips) would say nothing to the user.
        if line.startswith("progress "):
            log(line)
            # A line that is not "progress 42%" after all leaves `reached`
            # where it was: the stage the sentence names is then the last one
            # we did hear about, which is the right answer anyway.
            with contextlib.suppress(IndexError, ValueError):
                reached = int(line.split()[1].rstrip("%"))
        elif line.startswith(NOTE_PREFIX):
            log("   %s" % line[len(NOTE_PREFIX):])
        elif line.startswith(CHECK_PREFIX):
            try:
                checked = json.loads(line[len(CHECK_PREFIX):])
            except ValueError:
                checked = None
    proc.wait()
    if proc.returncode != 0:
        tail = list(errors)
        # A band with no writing in it is something the user can fix, and the
        # sentence says how. Every other failure keeps naming what went wrong.
        if any(mark in line for line in tail for mark in NO_SUBTITLES_MARKS):
            raise shown_error(NO_SUBTITLES_MESSAGE,
                             t("No subtitles were found in that area. Move the box and try again."))
        said, shown = _why_stopped(reached, tail)
        raise _fail(said, tail, shown)
    if not os.path.exists(out_path):
        wrote, check = both("The subtitle eraser finished without writing a video."), _check_file()
        raise _fail(f"{wrote[0]} {check[0]}", list(errors), f"{wrote[1]} {check[1]}")
    return checked


def suggest_area(input_path, *, python=None, vsr_dir=None) -> dict:
    """Where this video's subtitles sit, as the screen's opening guess.

    {"found": bool, "area": [ymin, ymax, xmin, xmax], "width", "height",
    "frames"} -- found false means nothing was detected and `area` is the
    bottom quarter, which is still a sane band to start the user off in.
    """
    py, vsr = _resolve(python, vsr_dir)
    try:
        r = subprocess.run([py, SUGGEST_SCRIPT, "--vsr-dir", vsr, "-i", input_path],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=_child_env(), timeout=SUGGEST_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(t("Looking for the subtitles took too long on this video."))
    if r.returncode != 0:
        raise _fail(t("Could not look for subtitles in this video"), (r.stderr or "").splitlines())
    # The last line, not the whole of stdout: the libraries underneath print
    # banners of their own before the answer.
    try:
        return json.loads((r.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise _fail(t("Could not read where the subtitles are"), (r.stdout or "").splitlines())
