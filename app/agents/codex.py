# -*- coding: utf-8 -*-
"""Codex's `exec --json` dialect -> our five events.

Recorded shapes (2026-08-26, codex-cli 0.149.0, `codex exec --json`):

    {"type":"thread.started","thread_id":...}
    {"type":"turn.started"}
    {"type":"item.started","item":{"type":"mcp_tool_call","tool":...,"status":...}}
    {"type":"item.completed","item":{"type":"agent_message","text":...}}
    {"type":"turn.completed","usage":{...}}

Two things separate this CLI from Claude Code. It streams nothing partial, so a
finished agent_message is the answer rather than a repeat of it; and it will not
let an MCP tool call through headless unless a reviewer is named -- see
command() below.

translate() is a pure function so it can be tested against recorded lines
without a CLI installed -- see tests/test_agents_codex.py.
"""
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from typing import List, Optional

# The chat panel's own vocabulary, shared with the other backends: which CLI is
# behind the strip must not change what a step is called on screen.
from app.agents import base
from app.agents.claude import SYSTEM_PROMPT, TOOL_LABELS, line_arg, model_arg

# The sentence a signed-out Codex gets instead of its own 401s. Kept as a
# name here because this file is where the translating happens.
SIGNED_OUT = base.signed_out_line("codex")
NO_ACCESS = "This model isn't available on your plan. Pick another one."


# The conversation the app itself started, remembered beside the MCP config.
# `codex exec resume --last` means "the thread touched last in this folder",
# and Codex's auto-review runs in a thread of its own (a "guardian" subagent)
# in that same folder: whenever a tool call was reviewed last, --last resumed
# the REVIEWER -- a thread with none of our tools -- and the assistant said
# there were no PersoDub tools for the rest of the session (2026-09-17).
THREAD_FILE = "codex-thread"
# It lands on a command line, so it is held to the shape thread ids have.
_THREAD_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z-]{7,63}$")
# Where command() last pointed; translate() is handed one line at a time by
# the runner and has no other way to know the folder.
_thread_dir = None  # type: Optional[str]


def _remember_thread(dir_path: Optional[str], thread_id) -> None:
    if not dir_path or not isinstance(thread_id, str) or not _THREAD_ID.match(thread_id):
        return
    try:
        with open(os.path.join(dir_path, THREAD_FILE), "w", encoding="utf-8") as f:
            f.write(thread_id)
    except OSError:
        pass  # a thread that cannot be remembered costs one new conversation


def _remembered_thread(dir_path: str) -> str:
    try:
        with open(os.path.join(dir_path, THREAD_FILE), encoding="utf-8") as f:
            thread_id = f.read().strip()
    except OSError:
        return ""
    return thread_id if _THREAD_ID.match(thread_id) else ""


def translate(event: dict, remember_in: Optional[str] = None) -> List[dict]:
    """One line of Codex's JSONL -> zero or more of our events.

    Never raises on an unfamiliar line: a new event type from a CLI update
    should leave the panel working, not blank it.
    """
    if not isinstance(event, dict):
        return []
    kind = event.get("type")

    if kind == "thread.started":
        _remember_thread(remember_in or _thread_dir, event.get("thread_id"))
        # Codex names the thread, never the model. The key is passed on anyway
        # so the panel starts saying so by itself the day the CLI reports it.
        return [{"kind": "start", "model": event.get("model")}]

    if kind in ("item.started", "item.completed"):
        item = event.get("item")
        if not isinstance(item, dict):
            return []
        return _item(kind, item)

    if kind == "turn.completed":
        # The text has already gone out as agent_message events.
        return [{"kind": "done", "text": ""}]

    if kind == "turn.failed":
        message = ((event.get("error") or {}).get("message")
                   or "The assistant stopped before finishing.")
        # A 401 is a sentence the user can act on, not a URL and a trace id.
        # The CLI's own words are kept, folded away under "Details".
        if base.is_signed_out("codex", message):
            return [{"kind": "error", "message": SIGNED_OUT,
                     "detail": message, "signed_out": True}]
        # A model the account's list offered but the account cannot use
        # ("The model `gpt-5.5` does not exist or you do not have access to
        # it", Mac tester 2026-09-28): said plainly, and taken off the list.
        denied = _NO_ACCESS.search(message)
        if denied:
            refused(denied.group(1))
            return [{"kind": "error", "message": NO_ACCESS, "detail": message,
                     "models_changed": True}]
        if base._says(base._RATE_LIMITED, message):
            return [{"kind": "error", "detail": message,
                     "message": "Usage limit reached. Wait a while or pick another assistant."}]
        # Anything else: one plain sentence; the program's words go to the log.
        base.logger.warning("Codex turn failed: %s", message[-600:])
        return [{"kind": "error", "message": "The assistant stopped partway. Please try again.",
                 "detail": message}]

    if kind == "error":
        # A transport complaint, not the end of the turn. Recorded 2026-08-26
        # against an empty CODEX_HOME: a failing run printed eleven of these
        # ("Reconnecting... 2/5 (unexpected status 401 ...)") and then said how
        # it really ended with turn.failed. Showing them keeps a turn that dies
        # quietly from reading as "(empty answer)".
        return [_transport_error(event.get("message"))]

    return []


def _transport_error(message) -> dict:
    """One of Codex's connection complaints, as a step rather than a failure.

    Grey, never red: a run that reconnects and then answers perfectly well
    prints several of these, so showing them as errors would put a red line
    under a good answer. The turn's real ending still comes through turn.failed,
    which is red. Trimmed because a chip is one line, and these carry a URL and
    a trace id that say nothing to the person reading them.
    """
    if isinstance(message, str) and base.is_signed_out("codex", message):
        return {"kind": "progress", "tool": "transport", "label": SIGNED_OUT}
    # One wording for every retry, so they fold into a single step instead of
    # ten lines of status codes and URLs (Mac tester, 2026-09-28).
    return {"kind": "progress", "tool": "transport", "label": "Reconnecting…"}


def _item(kind: str, item: dict) -> List[dict]:
    """The half of the stream that is about one thing the agent did."""
    what = item.get("type")

    if what == "mcp_tool_call":
        if kind == "item.started":
            name = item.get("tool") or ""
            step = {"kind": "progress", "tool": name,
                    "label": TOOL_LABELS.get(name, "Running %s" % name)}
            line = line_arg(item.get("arguments"))
            if line is not None:
                step["line"] = line
            model = model_arg(name, item.get("arguments"))
            if model:
                step["model"] = model
            return [step]
        error = item.get("error") or {}
        if error.get("message"):
            # ends_turn: the agent usually carries on after a tool refuses it,
            # so this must not be mistaken for the end -- otherwise a turn that
            # then dies loses the exit code and the stderr behind it.
            return [{"kind": "error", "ends_turn": False,
                     "message": "%s failed: %s"
                     % (item.get("tool") or "the tool", error["message"])}]
        # A finished call is bookkeeping between the agent and its tools -- its
        # result would put the whole script on screen as raw JSON. Only that one
        # call has landed is said, which is what the chip counts ("· 1 of 2").
        return [{"kind": "progress", "done": True}]

    if what == "command_execution":
        # Codex keeps a shell that no setting takes away, so the honest thing is
        # to show that it went off to run something rather than hide it.
        if kind == "item.started":
            return [{"kind": "progress", "tool": "shell",
                     "label": "Running a command"}]
        return [{"kind": "progress", "done": True}]

    if what == "error":
        # The same transport chatter, wrapped as an item ("Falling back from
        # WebSockets to HTTPS transport."). Only once, on completion.
        if kind == "item.completed":
            return [_transport_error(item.get("message"))]
        return []

    if what == "agent_message" and kind == "item.completed":
        text = item.get("text")
        if not isinstance(text, str) or not text:
            return []
        # Codex answers in whole messages, often a preamble and then the answer.
        # The newline is what keeps the two from reading as one sentence.
        return [{"kind": "text", "text": text + "\n"}]

    return []


# Codex names its models by version ("gpt-5.5"), and a written-down list of
# those would go stale with the next release. It has no command that will list
# them either -- every subcommand was checked, and it accepts a model name it
# has never heard of without a word (2026-09-11). So nothing is written down
# here, and nothing passes -m: Codex answers with whatever it is set up to use.
MODELS: List[str] = []


# The models this ChatGPT account can use. Codex lists what it knows
# (`codex debug models`, under PersoDub's own sign-in), but the list carries no
# plan: a free account was offered gpt-5.5 and refused it with a 404 (Mac
# tester, 2026-09-28). So each listed model is tried once in the background
# with a one-word question, and only the ones that answer are offered. Asked
# only once signed in (app/api/agent.py); kept in a small file beside the
# sign-in until the next sign-in, so a launch does not ask again.
_CHECK_FILE = "persodub-models.json"
_PROBE = "Reply with the single word OK."
_checking = threading.Lock()
_checked = {"ok": [], "no": [], "listed": []}
_loaded = {"done": False}
# A model that could not be judged (offline, a timeout, the usage limit) is
# asked again, but not on every look at the list: each ask is a real request
# on the user's account, and at the limit they never stopped (review, 2026-09-29).
_RECHECK_SECONDS = 600
_last_check = {"at": 0.0}
_NO_ACCESS = re.compile(r"model `([A-Za-z0-9._:-]{1,64})` does not exist or you do not have access", re.I)
_SLUG = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def _check_path() -> str:
    return os.path.join(base.chatgpt_env()["CODEX_HOME"], _CHECK_FILE)


def _load_checked() -> None:
    if _loaded["done"]:
        return
    _loaded["done"] = True
    try:
        with open(_check_path(), encoding="utf-8") as f:
            data = json.load(f)
        for k in ("ok", "no", "listed"):
            _checked[k] = [s for s in data.get(k, []) if isinstance(s, str) and _SLUG.match(s)]
    except (OSError, ValueError, AttributeError):
        pass


def _save_checked() -> None:
    try:
        with open(_check_path(), "w", encoding="utf-8") as f:
            json.dump(_checked, f)
    except OSError:
        pass


def forget_models() -> None:
    """A new sign-in may be another account, with another plan."""
    _loaded["done"] = True
    _last_check["at"] = 0.0
    for k in _checked:
        _checked[k] = []
    try:
        os.remove(_check_path())
    except OSError:
        pass


def refused(model: str) -> None:
    """A turn was turned down for this model: never offer it again."""
    if model and model not in _checked["no"]:
        _checked["no"].append(model)
        if model in _checked["ok"]:
            _checked["ok"].remove(model)
        _save_checked()


def _listed(binary: str) -> List[str]:
    got = base._run_quiet([binary, "debug", "models"], env=base.chatgpt_env())
    if got is None:
        return []
    try:
        data = json.loads(got[1])
        rows = data.get("models", []) if isinstance(data, dict) else data
        return [m["slug"] for m in rows
                if isinstance(m, dict) and m.get("visibility") == "list"
                and isinstance(m.get("slug"), str) and _SLUG.match(m["slug"])]
    except (ValueError, TypeError, KeyError):
        return []


def _answers(binary: str, model: str) -> Optional[bool]:
    """True when the model answers, False when the account is refused it,
    None when it could not be told (network, timeout)."""
    cmd = [binary, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
           "-c", "model=%s" % _toml(model), "-c", 'sandbox_mode="read-only"', "-"]
    try:
        r = subprocess.run(cmd, input=_PROBE, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=90, env=base.chatgpt_env(),
                           cwd=tempfile.gettempdir(),
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    said = (r.stdout or "") + (r.stderr or "")
    if '"type":"turn.completed"' in said:
        return True
    if _NO_ACCESS.search(said):
        return False
    return None


def _check_all(binary: str) -> None:
    if not _checking.acquire(blocking=False):
        return   # one check at a time
    try:
        listed = _listed(binary)
        if not listed:
            return
        _checked["listed"] = listed
        for model in listed:
            if model in _checked["ok"] or model in _checked["no"]:
                continue
            answer = _answers(binary, model)
            if answer is True:
                _checked["ok"].append(model)
            elif answer is False:
                _checked["no"].append(model)
            _save_checked()
    finally:
        _last_check["at"] = time.monotonic()
        _checking.release()


def models() -> List[str]:
    """The models this account has been seen to answer with, in Codex's own
    order. Checks the rest in the background; until then, the checked ones."""
    _load_checked()
    binary = base.find_cli("codex")
    pending = not _checked["listed"] or any(
        m not in _checked["ok"] and m not in _checked["no"] for m in _checked["listed"])
    rested = not _last_check["at"] or time.monotonic() - _last_check["at"] >= _RECHECK_SECONDS
    if binary and pending and rested and not _checking.locked():
        threading.Thread(target=_check_all, args=(binary,), daemon=True, name="codex-models").start()
    order = _checked["listed"] or _checked["ok"]
    return [m for m in order if m in _checked["ok"]]


def _toml(value) -> str:
    """A Python value as the TOML literal `codex -c key=value` expects.

    JSON and TOML agree on strings, numbers and arrays. They do not agree on
    tables: TOML writes `{ a = "b" }` where JSON writes `{"a": "b"}`, and Codex
    answers the JSON form with `expected a map` -- which is what it did the
    first time the panel ran a real turn (2026-08-26).
    """
    if isinstance(value, dict):
        return "{ %s }" % ", ".join(
            "%s = %s" % (json.dumps(k, ensure_ascii=False), _toml(v))
            for k, v in value.items())
    return json.dumps(value, ensure_ascii=False)


def stdin_text(prompt: str) -> str:
    """What run() pipes to the CLI's stdin: standing instructions, then the
    question. Codex reads its prompt from stdin when the argument is absent.

    Over stdin for the same reason as claude.stdin_text: on Windows the CLI is
    an npm .cmd shim, and cmd.exe cuts a shim's command line at the first
    newline -- this text is full of them. Codex has no --system-prompt, so the
    standing instructions ride in front of the question.
    """
    return SYSTEM_PROMPT + "\n\n" + prompt


def command(mcp_config: str, resume: bool, model: str = "") -> List[str]:
    """The command line to run for one message. The prompt itself is not on
    it -- see stdin_text.

    Codex has no --mcp-config, so the server written by base.write_mcp_config is
    read back here and handed over as -c overrides. --ignore-user-config is the
    other half of that fence: without it the user's own MCP servers come along
    and the assistant reaches tools this app never offered it.

    What --ignore-user-config does NOT cover: it skips ~/.codex/config.toml and
    nothing else. $CODEX_HOME/AGENTS.md -- whatever standing instructions the
    user keeps for their own Codex work -- still rides into every turn, and
    neither project_doc_max_bytes nor project_doc_fallback_filenames suppresses
    it. Pointing CODEX_HOME somewhere private would, but the user's login lives
    there too, so that trade is not ours to make quietly.

    `model` is empty for the Codex assistant (the picker offers only the one
    its config names, and Codex answers with that anyway) and set for the
    ChatGPT assistant, which is this same CLI told to answer as ChatGPT does.
    """
    with open(mcp_config, encoding="utf-8") as f:
        server = json.load(f)["mcpServers"]["persodub"]
    global _thread_dir
    _thread_dir = os.path.dirname(os.path.abspath(mcp_config))

    settings = [
        # Headless Codex refuses every MCP tool call unless a reviewer is named:
        # the approval prompt goes to a terminal that is not there, EOF reads as
        # "no", and the call is cancelled (openai/codex#24135). The CLI says
        # "approval policy is never" whatever the policy actually is -- measured
        # 2026-08-26 with approval_policy="on-request" and NO reviewer, which
        # got that exact refusal and a turn that changed nothing. So it is
        # `approvals_reviewer`, not the policy, that makes the script tools
        # reachable, and it cannot simply be dropped.
        #
        # Read what it permits, not just what it fixes. "on-request" lets the
        # model ASK to run a command with escalated privileges, and
        # "auto_review" hands that request to another model rather than to the
        # user -- nobody here is asked. `codex exec --help` says of its flag
        # form: "Route approval requests through automatic review using the
        # workspace-write sandbox". So read-only is the FLOOR, not the ceiling:
        # an escalation another model approves runs with write access to the
        # working directory, which is the app's own agent folder. It is not a
        # way out to the rest of the disk, and it is the same folder the run
        # could write to before read-only -- but it is a write path, and saying
        # otherwise here would be the comment talking the next person into
        # loosening the setting.
        'approvals_reviewer="auto_review"',
        'approval_policy="on-request"',
        # This app's own tools skip that review. Each review is a separate
        # model call, 15-80 s apiece on Windows, and a turn of a few tool calls
        # ran into the 180 s limit (full test, 2026-09-25). The reviewer above
        # stays for anything else Codex asks, and for a Codex too old to know
        # this setting, which then simply reviews as before.
        'mcp_servers.persodub.default_tools_approval_mode="approve"',
        # Read-only: Codex keeps a shell that no setting takes away, so the
        # sandbox is the fence. Verified 2026-08-26 that a real turn still
        # rewrites a script through it -- the MCP server is a separate process
        # talking HTTP to this app, so nothing the assistant needs is a write
        # the sandbox can see. Residual risk, and it is not small: read-only
        # stops writes and stops the shell reaching the network, but Codex can
        # still READ any file this user can read, and the model's own uplink
        # can carry it away. Claude's backend denies Read and Bash outright;
        # this one cannot.
        'sandbox_mode="read-only"',
        # The user's skills and the web are not this assistant's business. Left
        # on, the first run went off and read a skill file off the disk.
        "skills.include_instructions=false",
        "tools.web_search=false",
        "mcp_servers.persodub.command=%s" % _toml(server["command"]),
        "mcp_servers.persodub.args=%s" % _toml(server["args"]),
        "mcp_servers.persodub.env=%s" % _toml(server["env"]),
    ]

    # By id, never --last: see THREAD_FILE. With nothing remembered -- the first
    # turn after an install, or the first after this arrived -- a new thread is
    # started rather than guessed at.
    thread_id = _remembered_thread(_thread_dir) if resume else ""
    args = ["exec", "resume", thread_id, "--json"] if thread_id else ["exec", "--json"]
    args += [
        # The agent folder is not a git checkout, and the run must not stop for
        # that. The user's own .rules execpolicy is deliberately left in place:
        # it is a fence they built, and dropping it bought nothing -- a real
        # turn rewrote a script with the file loaded (2026-08-26).
        "--skip-git-repo-check",
        "--ignore-user-config",
    ]
    for setting in settings:
        args += ["-c", setting]
    # A named model rides the same way: the one picked from the account's
    # list (Codex), or ChatGPT's own for translation.
    if model:
        args += ["-c", "model=%s" % _toml(model)]
    # Everything above is a -c override rather than a flag on purpose:
    # --approve-for-me does the same as the two approval settings, but it is an
    # option of `codex exec` alone -- `codex exec resume` does not take it -- so
    # the -c form is the only one that works on both paths.
    return args
