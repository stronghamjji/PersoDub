# -*- coding: utf-8 -*-
"""What the panel says when a turn fails, and which account a CLI is signed in with.

No CLI is spawned: `explain_exit` is a pure function over what one printed, and
the login checks are exercised against recorded output.
"""
import subprocess

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
    assert base.login_state("gemini", "/bin/gemini")["logged_in"] is None
