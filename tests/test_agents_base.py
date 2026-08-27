# -*- coding: utf-8 -*-
"""What the panel says when a turn fails, and which account a CLI is signed in with.

No CLI is spawned: `explain_exit` is a pure function over what one printed, and
the login checks are exercised against recorded output.
"""
import subprocess
import sys
import threading
import time

import pytest

from app.agents import base


# --- the failure sentences --------------------------------------------------
# The panel used to print an exit code and 300 characters of stderr. What a
# person needs is which of the three usual things went wrong, and what to do.

def test_a_killed_turn_says_it_stopped_and_to_try_again():
    for code in (-9, 137):
        out = base.explain_exit(code, "Killed")
        assert out["message"] == "The assistant stopped partway. Please try again."
        assert str(code) not in out["message"]


def test_a_signed_out_cli_says_which_command_signs_it_in():
    for said in ("Error: 401 Unauthorized", "You are not logged in.",
                 "authentication_error: invalid api key"):
        out = base.explain_exit(1, said, agent_name="Codex", login_command="codex login")
        assert "is not signed in" in out["message"]
        assert "Codex" in out["message"]
        assert "codex login" in out["message"]


def test_the_sign_in_line_names_the_cli_that_was_asked():
    out = base.explain_exit(1, "not logged in", agent_name="Claude", login_command="claude")
    assert out["message"].startswith("Claude is not signed in")
    assert "`claude`" in out["message"]


def test_running_out_of_allowance_says_to_wait_or_pick_another():
    for said in ("rate limit exceeded", "HTTP 429", "You have hit your usage limit"):
        out = base.explain_exit(1, said)
        assert out["message"] == (
            "Usage limit reached. Wait a while or pick another assistant.")


def test_anything_else_is_one_line_with_the_rest_kept_behind_it():
    said = "warming up\nloading config\nTypeError: cannot read property of undefined"
    out = base.explain_exit(3, said)
    # One line, and it is the CLI's last word rather than its first.
    assert "TypeError" in out["message"]
    assert "warming up" not in out["message"]
    assert out["message"].endswith("Please try again.")
    # The whole thing is still there for anyone who wants it.
    assert out["detail"] == said
    # Never the exit code: a number is the CLI's business, not the user's.
    assert "code 3" not in out["message"]


def test_a_failure_with_nothing_said_still_reads_as_a_sentence():
    out = base.explain_exit(1, "")
    assert out["message"] == "The assistant did not finish its answer. Please try again."
    assert out["detail"] == ""


# The other half of the mapping, and the half that was missing: a failure that
# merely CONTAINS a number must not be read as one. Matching "401" anywhere in a
# CLI's output sent people off to sign in a CLI that was already signed in while
# the real fault -- a full disk -- went unmentioned.
def test_a_number_that_happens_to_look_like_a_status_is_left_alone():
    for said in (
        "codex: request failed after 3 retries (elapsed 2401ms)",
        "Traceback: at /Users/x/node_modules/foo/index.js:401:12",
        "tokens used: 14012 of 200000",
        "Error: ENOSPC: no space left on device, write '/tmp/sess-4014'",
        "fatal: unable to access repo: SSL error at offset 429",
        "disk quota exceeded while writing cache",
    ):
        out = base.explain_exit(1, said, agent_name="Codex", login_command="codex login")
        assert "signed in" not in out["message"], said
        assert "Usage limit" not in out["message"], said
        assert out["message"].endswith("Please try again."), said


def test_a_status_next_to_the_word_that_makes_it_one_still_counts():
    assert "signed in" in base.explain_exit(1, "Error: 401 Unauthorized")["message"]
    assert "signed in" in base.explain_exit(1, "request failed with status 401")["message"]
    assert "Usage limit" in base.explain_exit(1, "HTTP 429 Too Many Requests")["message"]
    assert "Usage limit" in base.explain_exit(1, "openai: status code 429")["message"]


def test_a_key_printed_in_an_error_is_not_kept_on_the_screen():
    out = base.explain_exit(1, "auth failed for token sk-abcdef1234567890")
    assert "sk-abcdef1234567890" not in out["detail"]
    assert "sk-" in out["detail"]


def test_a_very_long_line_is_cut_rather_than_filling_the_panel():
    out = base.explain_exit(1, "x" * 500)
    assert len(out["message"]) < 220
    assert out["detail"].endswith("x")


# --- which account, if any --------------------------------------------------

class _Recorded:
    """Stands in for subprocess.run with output recorded from the real CLI."""

    def __init__(self, code=0, stdout="", stderr="", raises=None):
        self.code, self.stdout, self.stderr, self.raises = code, stdout, stderr, raises
        self.cmd = None

    def __call__(self, cmd, **kw):
        self.cmd = cmd
        if self.raises:
            raise self.raises
        return subprocess.CompletedProcess(cmd, self.code, self.stdout, self.stderr)


def test_codex_signed_in_reports_the_kind_of_account(monkeypatch):
    # Measured 2026-08-26: codex prints this on stderr and exits 0.
    run = _Recorded(0, "", "Logged in using ChatGPT\n")
    monkeypatch.setattr(base.subprocess, "run", run)
    assert base.login_state("codex", "/bin/codex") == {"logged_in": True, "account": "ChatGPT"}
    assert run.cmd == ["/bin/codex", "login", "status"]


def test_codex_signed_out_says_so(monkeypatch):
    monkeypatch.setattr(base.subprocess, "run", _Recorded(1, "", "Not logged in\n"))
    assert base.login_state("codex", "/bin/codex") == {"logged_in": False, "account": ""}


def test_codex_capitalised_differently_is_still_read_and_never_raises(monkeypatch):
    """A capitalisation change in somebody else's CLI used to be an IndexError,
    which left that assistant showing nothing at all for the rest of the run."""
    monkeypatch.setattr(base.subprocess, "run", _Recorded(0, "", "Logged in Using ChatGPT\n"))
    assert base.login_state("codex", "/bin/codex") == {"logged_in": True, "account": "ChatGPT"}

    # And "using" not being there at all is a shrug, not a crash.
    monkeypatch.setattr(base.subprocess, "run", _Recorded(0, "", "Logged in.\n"))
    assert base.login_state("codex", "/bin/codex")["logged_in"] is True


def test_a_codex_that_fails_for_some_other_reason_is_not_called_signed_out(monkeypatch):
    """An old CLI with no such subcommand, or one that cannot reach its auth
    server, is "cannot say" -- not an accusation that the user is signed out."""
    monkeypatch.setattr(base.subprocess, "run",
                        _Recorded(2, "", "error: unrecognized subcommand 'login'\n"))
    assert base.login_state("codex", "/bin/codex")["logged_in"] is None

    monkeypatch.setattr(base.subprocess, "run",
                        _Recorded(1, "", "dns error: failed to lookup address\n"))
    assert base.login_state("codex", "/bin/codex")["logged_in"] is None


def test_claude_reads_only_the_two_keys_it_needs(monkeypatch):
    # The real command also prints an email address, an organisation id and a
    # subscription type. None of them may leave this function.
    said = ('{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.com",'
            ' "orgId": "9082", "orgName": "a@b.com\'s Organization"}')
    monkeypatch.setattr(base.subprocess, "run", _Recorded(0, said, ""))
    out = base.login_state("claude", "/bin/claude")
    assert out == {"logged_in": True, "account": "claude.ai"}
    assert "a@b.com" not in str(out) and "9082" not in str(out)


def test_claude_signed_out_says_so(monkeypatch):
    monkeypatch.setattr(base.subprocess, "run", _Recorded(0, '{"loggedIn": false}', ""))
    assert base.login_state("claude", "/bin/claude") == {"logged_in": False, "account": ""}


def test_a_cli_that_hangs_or_answers_nonsense_says_nothing_either_way(monkeypatch):
    """None is "we cannot tell", and it must never be shown as "signed out"."""
    monkeypatch.setattr(base.subprocess, "run",
                        _Recorded(raises=subprocess.TimeoutExpired("claude", 8)))
    assert base.login_state("claude", "/bin/claude")["logged_in"] is None

    monkeypatch.setattr(base.subprocess, "run", _Recorded(0, "not json at all", ""))
    assert base.login_state("claude", "/bin/claude")["logged_in"] is None

    # A CLI that is not installed is not signed out either.
    assert base.login_state("codex", "")["logged_in"] is None
    # And one we have no check for.
    assert base.login_state("nosuchcli", "/bin/nosuchcli")["logged_in"] is None


# --- the prompt travels over stdin ------------------------------------------
# On Windows both CLIs are npm .cmd shims, and cmd.exe cuts a shim's command
# line at the first newline. The prompt always has one (job context + blank
# line + question), so passed as an argument it lost the question and every
# flag after it -- the panel answered "(empty answer)" with the tool fences
# gone (2026-08-27). run() pipes it instead; argv stays newline-free.

def test_the_prompt_is_piped_whole_including_its_newlines():
    # Bytes, decoded as UTF-8 by hand: run() writes UTF-8, and the real CLIs
    # read stdin as UTF-8 -- but this stand-in is Python, whose text stdin
    # follows the locale (cp1252 on CI's Windows, which garbled the Korean).
    echo = ("import json, sys\n"
            "got = sys.stdin.buffer.read().decode('utf-8')\n"
            "print(json.dumps({'type': 'echo', 'got': got}))\n")
    out = list(base.run(sys.executable, ["-c", echo],
                        lambda e: [{"kind": "text", "text": e["got"]}]
                        if e.get("type") == "echo" else [],
                        input_text="(job: abc123)\n\n둘째 줄 질문"))
    assert {"kind": "text", "text": "(job: abc123)\n\n둘째 줄 질문"} in out


# --- stop fells the whole process tree --------------------------------------
# On Windows the CLIs run behind npm .cmd shims, and terminate() only reached
# the shim (cmd.exe): the CLI itself kept streaming after Stop, and a stopped
# Codex kept writing its conversation -- which is what "already has an active
# writer" was (2026-08-27). Stopping must end the children too.

# A stand-in shim: spawns a grandchild that stamps a file forever, then waits
# on it -- exactly the shape of cmd.exe wrapping node.
SHIM_CLI = (
    "import os, subprocess, sys\n"
    "child = subprocess.Popen([sys.executable, '-c', '''\n"
    "import os, sys, time\n"
    "sys.stdout.write('{\"type\": \"hello\"}\\\\n')\n"
    "sys.stdout.flush()\n"
    "while True:\n"
    "    open(os.environ['STAMP'], 'a').write('x')\n"
    "    time.sleep(0.1)\n"
    "'''], stdout=sys.stdout)\n"
    "child.wait()\n")


@pytest.mark.skipif(sys.platform != "win32", reason="the shim problem is Windows's")
def test_stop_ends_the_shims_children_too(tmp_path, monkeypatch):
    stamp = tmp_path / "stamp"
    monkeypatch.setenv("STAMP", str(stamp))
    started = threading.Event()
    out = []
    turn = _drain(SHIM_CLI, lambda e: (started.set(), [])[1], out)
    assert started.wait(20), "the stand-in shim never started"
    assert base.stop_turn() is True
    turn.join(20)
    size = stamp.stat().st_size if stamp.exists() else 0
    time.sleep(0.6)
    grown = (stamp.stat().st_size if stamp.exists() else 0) - size
    assert grown == 0, "the grandchild kept running after the stop"


# --- a stale conversation lock is retried, not shown ------------------------
# Windows cannot end a CLI gracefully (terminate there is a hard kill), so a
# turn stopped mid-answer leaves Codex's conversation marked "already has an
# active writer". The very next resume then failed on its face (2026-08-27).
# The lock clears itself in a moment, so one quiet retry is the whole cure.

# Fails with Codex's lock message until a marker file exists, then answers.
# The marker doubles as proof that a second spawn actually happened.
LOCKED_ONCE_CLI = (
    "import os, sys\n"
    "flag = os.environ['LOCK_FLAG']\n"
    "if os.path.exists(flag):\n"
    "    sys.stdout.write('{\"type\": \"fine\"}\\n')\n"
    "else:\n"
    "    open(flag, 'w').close()\n"
    "    sys.stderr.write('thread/resume failed: thread 01a0 already has an "
    "active writer (code -32600)\\n')\n"
    "    sys.exit(1)\n")


def test_a_stale_lock_is_retried_quietly(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCK_FLAG", str(tmp_path / "flag"))
    monkeypatch.setattr(base, "RETRY_DELAY", 0.05)
    out = list(base.run(sys.executable, ["-c", LOCKED_ONCE_CLI],
                        lambda e: [{"kind": "text", "text": "ok"}]
                        if e.get("type") == "fine" else []))
    assert (tmp_path / "flag").exists(), "the first, failing spawn never ran"
    assert {"kind": "text", "text": "ok"} in out
    assert not any(e.get("kind") == "error" for e in out)


def test_any_other_failure_is_not_retried(tmp_path, monkeypatch):
    """Only the stale lock earns a second spawn: retrying a real failure would
    double every error's wait and, for anything that changes state, its work."""
    monkeypatch.setenv("RUN_COUNT", str(tmp_path / "runs"))
    monkeypatch.setattr(base, "RETRY_DELAY", 0.05)
    broken = ("import os, sys\n"
              "open(os.environ['RUN_COUNT'], 'a').write('x')\n"
              "sys.stderr.write('no such model')\n"
              "sys.exit(1)\n")
    out = list(base.run(sys.executable, ["-c", broken], lambda e: []))
    assert any(e.get("kind") == "error" for e in out)
    assert (tmp_path / "runs").read_text() == "x"


# --- stopping the turn on air -----------------------------------------------
# The panel's Stop button ends up here. A stopped turn must end quickly, must
# say it was stopped rather than that it broke, and must leave the next turn
# free to run -- the conversation carries on from the CLI's saved session.

# A stand-in CLI: one line of JSON so the runner knows it has started, then it
# sits there. Long enough that only a stop can end it inside a test.
SLOW_CLI = ("import sys, time\n"
            "sys.stdout.write('{\"type\": \"hello\"}\\n')\n"
            "sys.stdout.flush()\n"
            "time.sleep(30)\n")

QUICK_CLI = ("import sys\n"
             "sys.stdout.write('{\"type\": \"bye\"}\\n')\n")


def _drain(script, translate, out):
    """Run one turn to the end on a thread, collecting what it yielded."""
    t = threading.Thread(
        target=lambda: out.extend(
            base.run(sys.executable, ["-c", script], translate)))
    t.start()
    return t


def test_stop_ends_the_turn_and_says_it_was_stopped():
    started = threading.Event()
    out = []

    def translate(event):
        started.set()
        return []

    turn = _drain(SLOW_CLI, translate, out)
    assert started.wait(20), "the stand-in CLI never started"
    assert base.stop_turn() is True
    turn.join(20)
    assert not turn.is_alive(), "the turn was still running after the stop"
    # Not "the assistant stopped partway. Please try again." -- it did what it
    # was told, and the panel marks it rather than showing a failure.
    assert out[-1] == {"kind": "done", "stopped": True, "text": ""}
    # Nothing is on air any more, so a second press is not an error.
    assert base.stop_turn() is False


def test_the_turn_after_a_stopped_one_runs_normally():
    started = threading.Event()
    first = []

    def note(event):
        started.set()
        return []

    turn = _drain(SLOW_CLI, note, first)
    assert started.wait(20)
    base.stop_turn()
    turn.join(20)

    second = list(base.run(sys.executable, ["-c", QUICK_CLI],
                           lambda e: [{"kind": "text", "text": "hi"}]))
    assert {"kind": "text", "text": "hi"} in second
    assert not any(e.get("stopped") for e in second)
