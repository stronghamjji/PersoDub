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


def describe_start_failure(what: str, exc: BaseException, timeout=None) -> str:
    """The process never returned a result: it timed out, or never started."""
    if isinstance(exc, subprocess.TimeoutExpired):
        seconds = int(exc.timeout if exc.timeout is not None else (timeout or 0))
        return "%s timed out after %d seconds" % (what, seconds)
    # Not a timeout: the type is the diagnosis (FileNotFoundError, OSError,
    # PermissionError), and it is short, so it leads.
    return "%s failed to start (%s: %s)" % (what, type(exc).__name__, str(exc)[:200])


def describe_exit_failure(what: str, result) -> str:
    """The process ran and failed. Its own last words, wherever it left them.

    stderr is where a Python traceback lands, so it is read first; a process
    that writes its complaint to stdout used to produce "no output produced",
    which is not a diagnosis (issues #44 #53).
    """
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
_TOO_SLOW = "This computer needed more time than allowed. A shorter video will finish."
_TOO_FULL = "This computer ran out of memory. Close other apps and try again."


def advice_for(detail: str, otherwise: str) -> str:
    """The one sentence under a failed stage, chosen by what actually failed."""
    text = str(detail or "").lower()
    if "timed out" in text or "timeout" in text:
        return _TOO_SLOW
    if "not enough memory" in text or "out of memory" in text or "cannot allocate" in text:
        return _TOO_FULL
    return otherwise
