"""Why a helper process failed, said so that the reason survives the trip.

A failure report carries a few hundred characters of the sentence a job died
with, and everything past that is cut. subprocess.TimeoutExpired writes its
own message as "Command '[<the whole command line>]' timed out after 900
seconds" -- on Windows the command line alone is longer than the budget, so
eleven reports in four days arrived saying "failed to run (Command '['C:\\Users
\\...\\python.exe'" and nothing else. The decisive words were written, then cut
off (issues #40 #46 #63, 2026-09-15).

So the reason goes first here, and the command line does not travel at all:
which python ran is in the logs, and the archive behind the issue has them.
"""
import subprocess
from typing import Tuple

from app.i18n import both


class PartsMissing(RuntimeError):
    """A helper's own interpreter or script is not on this computer: the part
    of the app it comes in is missing or broken. Downloading it again is the
    answer, and the video is not the thing to check."""


# What a model library says when the weights on disk are there but cannot be
# read: faster-whisper's model.bin cut short or overwritten says "Cannot load
# the target vocabulary from the model directory" (2026-10-20, a 4 KB file).
# The download is broken, so the advice is the same as PartsMissing.
_BROKEN_MODEL_WORDS = ("vocabulary", "model directory", "unable to open", "corrupt",
                       "invalid model", "unable to load", "failed to load")


def model_failed_to_load(detail: str) -> bool:
    """Whether a failure's own words say a model file on disk could not be read."""
    text = str(detail or "").lower()
    return "model" in text and any(w in text for w in _BROKEN_MODEL_WORDS)


def describe_start_failure(what: str, exc: BaseException, timeout=None) -> str:
    """The process never returned a result: it timed out, or never started."""
    if isinstance(exc, subprocess.TimeoutExpired):
        seconds = int(exc.timeout if exc.timeout is not None else (timeout or 0))
        return "%s timed out after %d seconds" % (what, seconds)
    # Not a timeout: the type is the diagnosis (FileNotFoundError, OSError,
    # PermissionError), and it is short, so it leads.
    return "%s failed to start (%s: %s)" % (what, type(exc).__name__, str(exc)[:200])


# A process the operating system kills outright for running out of memory
# leaves no message of its own to read -- POSIX SIGKILL (returncode -9, or
# 137 when something in the chain reports it the shell's 128+signal way) and
# Windows' STATUS_NO_MEMORY (0xC0000017, which Python reports as the signed
# -1073741801). Named here so advice_for's own "out of memory" match still
# finds it, instead of "exited with code -9 and said nothing" sending someone
# to check a video that was never the problem.
_OOM_EXIT_CODES = (-9, 137, -1073741801)


def describe_exit_failure(what: str, result) -> str:
    """The process ran and failed. Its own last words, wherever it left them.

    stderr is where a Python traceback lands, so it is read first; a process
    that writes its complaint to stdout used to produce "no output produced",
    which is not a diagnosis (issues #44 #53).
    """
    if result.returncode in _OOM_EXIT_CODES:
        return "%s was killed by the operating system, out of memory" % what
    tail = (result.stderr or "").strip()[-400:]
    if not tail:
        tail = (result.stdout or "").strip()[-400:]
    if not tail:
        return "%s exited with code %s and said nothing" % (what, result.returncode)
    return "%s exited with an error (%s)" % (what, tail)


# What to tell the person watching. A stage that stopped because the computer
# was too slow or too full is not a broken file, and "Check the video file"
# sent them to look at the one thing that was fine (2026-09-15: eleven
# separations and nine transcriptions, every one of them advised wrongly).
def advice_both(detail: str, otherwise: Tuple[str, str]) -> Tuple[str, str]:
    """The one sentence under a failed stage, chosen by what actually failed,
    in English and in the user's language (app/i18n.py both()); `otherwise`
    is such a pair too."""
    text = str(detail or "").lower()
    if "timed out" in text or "timeout" in text:
        return both("This computer needed more time than allowed. A shorter video will finish.")
    if ran_out_of_memory(text):
        return both("This computer ran out of memory. Close other apps and try again.")
    return otherwise


def ran_out_of_memory(detail: str) -> bool:
    """Whether a failure's own words say the memory ran out."""
    text = str(detail or "").lower()
    return "not enough memory" in text or "out of memory" in text or "cannot allocate" in text


def advice_for(detail: str, otherwise: str) -> str:
    """advice_both's sentence in English."""
    return advice_both(detail, (otherwise, otherwise))[0]
