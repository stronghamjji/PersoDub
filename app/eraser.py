"""Subprocess bridge to the two subtitle-eraser scripts: erasing the subtitles
burned into a video (app/scripts/erase_subtitles.py) and finding where they sit
(app/scripts/suggest_area.py).

video-subtitle-remover brings paddleocr, paddlepaddle and its own torch build,
none of which are in the app's own venv, so both run as separate processes
under ERASER_PYTHON (config.py) -- the same shape as app/separate.py, for the
same reason.

Unlike separation, an erase runs for minutes and says so as it goes: every
`progress N%` line the script prints is handed to the job's log, which is
where GET /api/erase/{jid} reads the percentage back from. And unlike the
pipeline, it has no stage boundary to stop at politely -- one blocking call
does the whole video -- so a cancelled job's process is killed.
"""
import collections
import json
import os
import queue
import subprocess
import threading

from app import config
from app.jobs import JobCancelled

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


class EraserMissing(RuntimeError):
    """The subtitle-eraser pack is not installed on this computer. The routes
    (app/api/erase.py) turn this into the 409 the screen offers a download on,
    rather than a failed job."""


def _resolve(python, vsr_dir):
    """The interpreter and the checkout to run with, or EraserMissing.

    Read off app.config at call time, not imported by name: a pack installed
    while the app is open works without a restart, and the tests point these
    at a stand-in script.
    """
    py = python or config.ERASER_PYTHON
    vsr = vsr_dir or config.ERASER_VSR_DIR
    if not (py and vsr and os.path.isfile(py) and os.path.isdir(vsr)):
        raise EraserMissing("The subtitle eraser is not installed on this computer.")
    return py, vsr


def _child_env():
    return {**os.environ, **CHILD_ENV}


def _fail(what, tail):
    """A RuntimeError carrying the last thing the script said. One sentence for
    the user, then the line itself -- app/jobs.py shows this under the red bar."""
    last = next((line for line in reversed(tail) if line.strip()), "")
    return RuntimeError("%s (%s)" % (what, last[:200] or "no output"))


def run_erase(input_path, out_path, area, *, log, cancel_check,
              python=None, vsr_dir=None) -> None:
    """Erase the subtitles from input_path into out_path. Blocks until done.

    `area` is (ymin, ymax, xmin, xmax) -- the band to work in, about twice as
    fast as the whole frame, which is what None means. `log` is the job's log
    function and gets every `progress N%` line; `cancel_check` is polled while
    the process runs, and a true answer kills it and raises JobCancelled.
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
    proc.wait()
    if proc.returncode != 0:
        tail = list(errors)
        # A band with no writing in it is something the user can fix, and the
        # sentence says how. Every other failure keeps naming what went wrong.
        if any(mark in line for line in tail for mark in NO_SUBTITLES_MARKS):
            raise RuntimeError(NO_SUBTITLES_MESSAGE)
        raise _fail("The subtitle eraser stopped with an error", tail)
    if not os.path.exists(out_path):
        raise _fail("The subtitle eraser produced no video", list(errors))


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
        raise RuntimeError("Looking for the subtitles took too long on this video.")
    if r.returncode != 0:
        raise _fail("Could not look for subtitles in this video", (r.stderr or "").splitlines())
    # The last line, not the whole of stdout: the libraries underneath print
    # banners of their own before the answer.
    try:
        return json.loads((r.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise _fail("Could not read where the subtitles are", (r.stdout or "").splitlines())
