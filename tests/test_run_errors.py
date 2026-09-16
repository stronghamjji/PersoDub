"""What a failed helper process says, and what the person watching is told.

Both were wrong in the four days after 0.6.0 (see app/run_errors.py): the
reason was written past the cut, and the advice sent people to check a video
file that had nothing wrong with it.
"""
import subprocess

from app.run_errors import advice_for, describe_exit_failure, describe_start_failure


class _Result:
    def __init__(self, stderr="", stdout="", returncode=1):
        self.stderr = stderr
        self.stdout = stdout
        self.returncode = returncode


def test_a_timeout_says_so_at_the_front():
    exc = subprocess.TimeoutExpired(cmd=[r"C:\a\very\long\path\python.exe"] * 4, timeout=900)
    said = describe_start_failure("local separation", exc, 900)
    assert said == "local separation timed out after 900 seconds"


def test_anything_else_names_the_type():
    said = describe_start_failure("local separation", FileNotFoundError("python.exe"), 900)
    assert "FileNotFoundError" in said
    assert "failed to start" in said


def test_a_process_that_complained_to_stdout_is_still_quoted():
    # "no output produced" is not a diagnosis, and two reports carried nothing
    # else (2026-09-15).
    said = describe_exit_failure("local separation", _Result(stdout="Killed: not enough memory"))
    assert "not enough memory" in said


def test_a_process_that_said_nothing_at_least_names_its_exit_code():
    said = describe_exit_failure("local separation", _Result(returncode=137))
    assert "137" in said


def test_advice_follows_the_failure_not_the_stage():
    check = "Check the video file."
    assert advice_for("local separation timed out after 900 seconds", check) != check
    assert "more time" in advice_for("local STT timed out after 900 seconds", check)
    assert "memory" in advice_for("DefaultCPUAllocator: not enough memory", check)
    # A file that really is broken still gets the old sentence.
    assert advice_for("moov atom not found", check) == check
