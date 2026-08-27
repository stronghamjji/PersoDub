# -*- coding: utf-8 -*-
"""Running one CLI agent turn and reading what it says back.

The CLI is spawned, its stdout is read a line at a time as JSON, and each line
is handed to that CLI's translator (app/agents/claude.py and friends). Whatever
the translator returns is what the chat panel shows -- nothing here knows a
vendor's format.

A line that is not JSON is dropped. CLIs and their dependencies do print the odd
banner or warning, and one stray line must not blank the panel mid-answer.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable, Iterator, List, Optional

# A GUI app does not inherit the login shell's PATH, so `claude` can be on the
# PATH in Terminal and missing here. Look where these installers actually put
# things before giving up.
EXTRA_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.bun/bin"),
    os.path.expanduser("~/.npm-global/bin"),
]

TIMEOUT_SECONDS = float(os.environ.get("PERSODUB_AGENT_TIMEOUT", "180"))

# How long a stopped CLI is given to go quietly before it is made to.
STOP_GRACE = 2.0


def find_cli(name: str) -> Optional[str]:
    """Where this CLI lives, or None if it is not installed."""
    found = shutil.which(name)
    if found:
        return found
    for d in EXTRA_PATHS:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def write_mcp_config(dir_path: str, api_url: str) -> str:
    """Write the file that tells a CLI where PersoDub's script tools are.

    Written into the app's own folder, never into the user's global CLI config:
    their everyday setup must keep working exactly as it did.
    """
    # Absolute: the CLI runs with its cwd set to this folder, so a relative path
    # would be resolved against it a second time.
    dir_path = os.path.abspath(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, "persodub-mcp.json")
    config = {
        "mcpServers": {
            "persodub": {
                "command": sys.executable,
                "args": ["-m", "app.mcp_server"],
                "env": {
                    "PERSODUB_API": api_url,
                    # -m needs the repo on the path; cwd is not ours to assume.
                    "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(
                        os.path.abspath(__file__)))),
                },
            }
        }
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return path


# --- What a failed turn means, in words the user can act on -----------------
# The panel used to print "도우미가 3번 오류로 멈췄습니다" and 300 characters of a
# CLI's stderr. An exit code is the CLI's business; what the user needs is which
# of the three things went wrong and what to do about it.

# Said by a CLI that has no login. Whole phrases, and a bare number never
# counts on its own: matching "401" anywhere in a CLI's stderr told people to
# sign in when the real trouble was a full disk (/tmp/sess-4014), a stack trace
# (index.js:401) or a timing (elapsed 2401ms). A number only counts where the
# CLI put it next to the word that makes it a status.
_NOT_LOGGED_IN = (
    r"\bnot\s+logged\s+in\b",
    r"\bnot\s+authenticated\b",
    r"\bplease\s+log\s?in\b",
    r"\blogin\s+required\b",
    r"\bunauthorized\b",
    r"\bauthentication[ _](?:failed|error)\b",
    r"\binvalid[ _]api[ _]key\b",
    r"\bno\s+credentials\b",
    r"\bsession\s+expired\b",
    # "please run `codex login` to sign in"
    r"\brun\s+`?[a-z][\w-]*\s+login\b",
    r"\b401\s+unauthorized\b",
    r"\b(?:http|https|status|code|error)\s*(?:code)?\s*[:=]?\s*401\b",
)

# Said by a CLI that is out of allowance for now. "quota" alone is not one of
# them: a disk quota is a full disk, and telling somebody to wait for their
# allowance to come back would send them the wrong way entirely.
_RATE_LIMITED = (
    r"\brate[ _-]?limit(?:ed|s|ing)?\b",
    r"\btoo\s+many\s+requests\b",
    r"\busage\s+limit\b",
    r"(?<!disk )\bquota\s+exceeded\b",
    r"\bexceeded\s+your\s+quota\b",
    r"\binsufficient[_ ]quota\b",
    r"\bout\s+of\s+credit",
    r"\b429\s+too\s+many\s+requests\b",
    r"\b(?:http|https|status|code|error)\s*(?:code)?\s*[:=]?\s*429\b",
)

# A key printed inside an error message would otherwise sit in the panel for as
# long as the conversation does. It never leaves the machine either way, but it
# does not need to be on the screen.
_SECRETISH = re.compile(r"\b(sk|xox[abpsr]|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}")


def _says(patterns, text: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


# Killed rather than finished: our own timeout kills the process (SIGKILL), and
# so does the OS when it runs out of room. Both reach us as a negative code.
_KILLED = (-9, -15, 137, 143)


def explain_exit(code: int, output: str, agent_name: str = "The assistant",
                 login_command: str = "") -> dict:
    """One error event for a turn that ended badly.

    `message` is a sentence and a next step; `detail` is the CLI's own last
    words, which the panel keeps behind a "자세히" fold rather than in the user's
    face. Nothing here is a stack trace and nothing is an exit code.
    """
    text = (output or "").strip()
    tail = _SECRETISH.sub(r"\1-…", text[-1200:])

    if code in _KILLED:
        return {"kind": "error", "detail": tail,
                "message": "The assistant stopped partway. Please try again."}

    if _says(_NOT_LOGGED_IN, text):
        how = (" Run `%s` in Terminal." % login_command) if login_command else ""
        return {"kind": "error", "detail": tail,
                "message": "%s is not signed in.%s" % (agent_name, how)}

    if _says(_RATE_LIMITED, text):
        return {"kind": "error", "detail": tail,
                "message": "Usage limit reached. Wait a while or pick another assistant."}

    # Nothing we know. One line of what it said, and the rest behind the fold --
    # a summary the user can read out to somebody who can help.
    first = next((ln.strip() for ln in reversed(text.splitlines()) if ln.strip()), "")
    if len(first) > 160:
        first = first[:157] + "…"
    said = (" (%s)" % first) if first else ""
    return {"kind": "error", "detail": tail,
            "message": "The assistant did not finish its answer%s. Please try again." % said}


# --- Which account a CLI is signed in with ----------------------------------
# Only ever the KIND of account ("ChatGPT", "claude.ai"). These commands also
# print an email address and an organisation id, and neither leaves this file.

LOGIN_TIMEOUT = 8.0


def _run_quiet(cmd: List[str]) -> tuple:
    """(returncode, stdout, stderr) for a short read-only command, or None."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=LOGIN_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.returncode, r.stdout or "", r.stderr or ""


def login_state(kind: str, binary: str) -> dict:
    """Is this CLI signed in, and with what kind of account?

    `logged_in` is None when we cannot tell -- a CLI with no such command, one
    that is not installed, one that timed out. None means "say nothing", never
    "not signed in".
    """
    unknown = {"logged_in": None, "account": ""}
    if not binary:
        return unknown

    if kind == "codex":
        # `codex login status` prints "Logged in using ChatGPT" (on stderr, as
        # measured 2026-08-26) and exits 0; a signed-out CLI says so and exits 1.
        got = _run_quiet([binary, "login", "status"])
        if got is None:
            return unknown
        _code, out, err = got
        said = (out + "\n" + err).strip()
        low = said.lower()
        if "logged in" in low and "not logged in" not in low:
            # "Logged in using ChatGPT" -> "ChatGPT". Only what follows "using",
            # so an address on the same line cannot come along. Split however the
            # CLI capitalised it, and cope with it not being there at all.
            parts = re.split(r"using", said, maxsplit=1, flags=re.IGNORECASE)
            after = parts[1].strip() if len(parts) > 1 else ""
            account = after.splitlines()[0].strip() if after else ""
            # An account KIND is one or two words; anything longer is not one.
            if "@" in account or len(account.split()) > 2:
                account = ""
            return {"logged_in": True, "account": account}
        # Only a CLI that says it is signed out counts as signed out. A non-zero
        # exit on its own means any number of things -- an old CLI with no such
        # subcommand, an unreachable auth server -- and "cannot say" is the
        # honest answer to all of them.
        if re.search(r"not\s+logged\s+in|logged\s+out|no\s+credentials", low):
            return {"logged_in": False, "account": ""}
        return unknown

    if kind == "claude":
        # `claude auth status` prints JSON: loggedIn, authMethod, and several
        # keys about the person. Exactly two of them are read.
        got = _run_quiet([binary, "auth", "status"])
        if got is None:
            return unknown
        _code, out, _err = got
        try:
            data = json.loads(out)
        except ValueError:
            return unknown
        if not isinstance(data, dict) or not isinstance(data.get("loggedIn"), bool):
            return unknown
        method = data.get("authMethod")
        account = method if isinstance(method, str) and "@" not in method else ""
        return {"logged_in": data["loggedIn"], "account": account}

    return unknown


# --- Stopping the turn on air -----------------------------------------------
# One turn at a time per app, so "stop" needs no id: there is only ever one
# child to stop. SIGTERM first and SIGKILL only if that is ignored, because a
# CLI writes its session down on the way out and that saved session is what the
# next message carries on from -- a turn stopped with SIGKILL would take the
# conversation with it.

class _Turn:
    """The turn on air: the child running it, and whether it was stopped."""

    def __init__(self, proc):
        self.proc = proc
        self.stopped = False


_turn_lock = threading.Lock()
_turn = None            # the _Turn on air, or None


def _end(proc, grace: float = STOP_GRACE) -> None:
    """Ask this child to go, and insist if it will not.

    On Windows the child is an npm .cmd shim, and terminate() only reaches the
    shim (cmd.exe): the CLI under it kept streaming after Stop, and a stopped
    Codex kept writing its conversation -- the "already has an active writer"
    refusal on the very next message (2026-08-27). taskkill /T fells the whole
    tree; CREATE_NO_WINDOW because taskkill is a console program launched from
    a GUI app, and without it every stop flashed a console window.
    """
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            pass  # the kill below is the backstop
    else:
        try:
            proc.terminate()
        except OSError:
            return
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass


def _begin(turn: "_Turn") -> None:
    """This turn is now the one on air; any older one is ended, not left
    talking to a panel that has moved on."""
    global _turn
    with _turn_lock:
        old, _turn = _turn, turn
    if old is not None and old is not turn:
        old.stopped = True
        _end(old.proc)


def _finish(turn: "_Turn") -> None:
    global _turn
    with _turn_lock:
        if _turn is turn:
            _turn = None


def stop_turn(grace: float = STOP_GRACE) -> bool:
    """End the turn on air. False when there was nothing to stop."""
    with _turn_lock:
        turn = _turn
    if turn is None or turn.proc.poll() is not None:
        return False
    turn.stopped = True
    _end(turn.proc, grace)
    return True


# Codex marks a conversation "active writer" while a turn writes to it.
# Windows cannot end a CLI gracefully -- terminate() is a hard kill there --
# so a turn stopped mid-answer leaves that mark behind, and the very next
# resume failed on its face with this text (code -32600, seen 2026-08-27).
# The mark clears itself in a moment; one quiet retry is the whole cure.
_STALE_LOCK = "already has an active writer"
RETRY_DELAY = 1.5


def run(binary: str, args: List[str], translate: Callable[[dict], List[dict]],
        cwd: Optional[str] = None, agent_name: str = "The assistant",
        login_command: str = "",
        input_text: Optional[str] = None) -> Iterator[dict]:
    """Spawn one turn and yield our events as they arrive.

    `input_text` is the prompt, piped to the CLI's stdin (see the drivers'
    stdin_text). It must never travel in `args`: on Windows the CLIs are npm
    .cmd shims, and cmd.exe cuts a shim's command line at the first newline --
    the prompt always has one, and everything after it was silently lost.

    A turn that dies AT ONCE on Codex's stale conversation lock is respawned
    once, silently, after a short wait. Only that: an error after anything has
    already reached the panel is shown, and any other failure is shown the
    first time -- retrying real errors would double their wait, and double the
    work of anything that changes state.

    Yields an error event rather than raising: a failed turn is something the
    panel shows in a bubble, not a crash.
    """
    for attempt in (0, 1):
        yielded = False
        retry = False
        for event in _run_once(binary, args, translate, cwd=cwd,
                               agent_name=agent_name,
                               login_command=login_command,
                               input_text=input_text):
            if (attempt == 0 and not yielded
                    and event.get("kind") == "error"
                    and _STALE_LOCK in (event.get("detail") or "")):
                retry = True
                break
            yielded = True
            yield event
        if not retry:
            return
        time.sleep(RETRY_DELAY)


def _run_once(binary: str, args: List[str], translate: Callable[[dict], List[dict]],
              cwd: Optional[str] = None, agent_name: str = "The assistant",
              login_command: str = "",
              input_text: Optional[str] = None) -> Iterator[dict]:
    """One spawn of the CLI -- run() above decides whether it gets another."""
    try:
        proc = subprocess.Popen(
            [binary] + args,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            # With a prompt to send, a pipe that is closed right after it; the
            # EOF is what tells the CLI the question is complete. Without one,
            # closed outright -- a CLI that reads an open stdin would sit there
            # waiting on whatever terminal started the app.
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            cwd=cwd, text=True, encoding="utf-8", bufsize=1,
        )
    except OSError as e:
        yield {"kind": "error", "message": "Could not run the assistant: %s" % e}
        return

    if input_text is not None:
        try:
            # No newline translation: a text-mode pipe turns \n into \r\n on
            # Windows, and the prompt should reach the CLI exactly as typed.
            proc.stdin.reconfigure(newline="\n")
            proc.stdin.write(input_text)
            proc.stdin.close()
        except OSError:
            pass  # the CLI died before reading; its exit code says so below

    turn = _Turn(proc)
    _begin(turn)
    # _end, not proc.kill: on Windows kill() reaches only the .cmd shim and a
    # timed-out CLI would keep running underneath it (same story as Stop).
    timer = threading.Timer(TIMEOUT_SECONDS, _end, args=(proc,))
    timer.start()
    saw_done = False
    drained = False
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue  # a banner or a warning, not part of the stream
            for out in translate(event):
                # "How this turn ended". A translator that knows an error came
                # mid-turn -- a tool refusing the agent, a connection dropping
                # and coming back -- says so with ends_turn: False, and the
                # exit-code fallback below still gets its say.
                if out.get("kind") == "done" or (
                        out.get("kind") == "error" and out.get("ends_turn", True)):
                    saw_done = True
                yield out
        drained = True
    finally:
        timer.cancel()
        # Nobody is reading any more -- the browser went away mid-answer, or
        # whoever asked for this gave up. Without this the CLI kept running,
        # and the wait below sat here for as long as it took.
        if not drained:
            turn.stopped = True
            _end(proc)
        proc.stdout.close()
        code = proc.wait()
        stderr = (proc.stderr.read() or "").strip()
        proc.stderr.close()
        _finish(turn)

    if turn.stopped:
        # Asked to stop, not broken: the CLI was let out gracefully, so the
        # next message carries the same conversation on.
        yield {"kind": "done", "stopped": True, "text": ""}
        return

    if code != 0 and not saw_done:
        # The exit code is the CLI's business. What the user gets is which of
        # the three usual things went wrong and what to do about it.
        yield explain_exit(code, stderr, agent_name=agent_name,
                           login_command=login_command)
    elif not saw_done:
        yield {"kind": "done", "text": ""}
