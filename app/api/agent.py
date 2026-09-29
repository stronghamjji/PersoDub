"""The script assistant: a chat panel driving whichever CLI agent the user
already subscribes to. It reaches the script through the same five MCP tools a
terminal agent uses -- see app/mcp_server.py. Starting or cancelling a dub is
deliberately not among them.

Three routes: which assistants are installed and signed in, stop the turn on
air, and one streamed turn.

Lifted out of app/main.py unchanged (2026-09-06), the login cache with it. The
cache stayed module state rather than becoming a LoginCache class: it is read
by exactly one route, nothing outside this module touches it, and wrapping the
four globals in an instance would move them one attribute deeper without
removing a single caller or a single shared name -- while the tests, which
clear _login_cache/_login_busy directly and pin AGENT_LOGIN_TTL, would have to
reach through the instance to do the same thing. Nothing here is read off
app.main, so there is no _main() seam: the tests patch this module.
"""
import json
import logging
import os
import queue
import re
import subprocess
import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app import codex_fetch
from app.agents import base as agent_base
from app.agents import claude as claude_agent
from app.agents import codex as codex_agent
from app.config import PERSODUB_LOG_DIR
from app.translate import CHATGPT_DEFAULT_MODEL

logger = logging.getLogger("persodub.api.agent")

router = APIRouter()


AGENTS = {
    # `login` is what the user types in a terminal to sign this CLI in. It is
    # here rather than in the screen so one place names it: the failure message
    # and the strip's status line both say the same command.
    "claude": {"binary": "claude", "name": "Claude", "vendor": "Anthropic",
               "driver": claude_agent, "login": "claude"},
    # Codex signs in once with ChatGPT's own sign-in, in PersoDub's folder:
    # one Sign In covers translation and the Dub Agent (user, 2026-09-28).
    # No terminal command to name -- the app's sign-in window does it.
    "codex": {"binary": "codex", "name": "Codex", "vendor": "OpenAI",
              "driver": codex_agent, "login": "", "private_home": True,
              # Its own folder, so the remembered conversation is one kept in
              # PersoDub's home: the one remembered from ~/.codex could not be
              # resumed there ("no rollout found", Mac tester 2026-09-28).
              "dir": "codex"},
    # ChatGPT's own sign-in, for translation. Listed so Settings and the
    # sign-in window can ask about it and start it, but not a Dub Agent
    # choice: ChatGPT only chats, it does not work on the script (user,
    # 2026-09-24).
    "chatgpt": {"binary": "codex", "name": "ChatGPT", "vendor": "OpenAI",
                "driver": codex_agent, "login": "codex login", "kind": "codex",
                "model": CHATGPT_DEFAULT_MODEL, "models": [CHATGPT_DEFAULT_MODEL],
                "dir": "chatgpt", "private_home": True, "sign_in_only": True},
    # An assistant listed with "driver": None and a "reason" is offered but
    # greyed out, with the reason printed under its name. Nothing is in that
    # state today -- Gemini was, and was dropped rather than left on the list
    # as a row nobody could pick -- but the next CLI to be added can be shown
    # before it is wired up.
}

# Where the assistant's own files live. Never the user's global CLI config:
# their everyday setup has to keep working exactly as it did.
AGENT_DIR = os.path.join(PERSODUB_LOG_DIR, "agent")

# --- Which account each CLI is signed in with -------------------------------
# Asking costs a process, so the answer is kept for a minute -- and the asking
# happens on a thread of its own. /api/agent/status answers from what is known
# this instant: the picker has to open now, not when a CLI feels like replying.
AGENT_LOGIN_TTL = 60.0
# What a deliberate ask is held to instead. A minute is right for the page
# asking in passing, and wrong for the one moment the user is standing there:
# they signed in (or out) in a Terminal and opened the picker to see it. Held
# to the minute, the picker showed the old answer three opens running and only
# came right on the fourth, fifty seconds later -- which reads as broken
# (Windows measured it, 2026-09-11). Only ?login=1 gets this, and only the
# strip's own moments send it, so the extra cost is one child process per
# picker-open at worst.
AGENT_LOGIN_ASK_TTL = 5.0
_login_cache = {}          # agent id -> {"logged_in", "account", "at"}
_login_busy = set()        # ids with a check already running
_login_broken = set()      # ids whose check has already been complained about
_login_lock = threading.Lock()


def _login_refresh(key: str, binary: str) -> None:
    """Ask one CLI, and write down whatever came of it -- including nothing.

    The write and the clearing of the busy marker happen whatever the CLI does:
    a check that threw used to leave its marker behind, and that assistant then
    showed "not known" for the life of the app, with nothing on screen to say
    why and no way back but a restart.
    """
    state = {"logged_in": None, "account": ""}
    try:
        # "kind" is which CLI's answer to read; an assistant that borrows
        # another's sign-in (ChatGPT borrows Codex's) names it.
        meta = AGENTS.get(key, {})
        state = agent_base.login_state(meta.get("kind", key), binary, env=_env_of(meta))
    except Exception as e:   # noqa: BLE001 -- a CLI can fail in any way at all
        # Once per assistant per run: this is for whoever reads the log, and a
        # line every minute would bury the rest of it.
        if key not in _login_broken:
            _login_broken.add(key)
            # The type only, not the message: a CLI's error text can quote
            # the command line it was given, tokens and all.
            logger.warning("Could not check %s's login (%s)", key, type(e).__name__)
    finally:
        with _login_lock:
            _login_cache[key] = dict(state, at=time.monotonic())
            _login_busy.discard(key)


def _models_of(driver) -> list:
    """What this assistant may be asked for. A driver with a models() knows
    how to find out; one without has a written-down MODELS; one that is not
    installed has neither."""
    if not driver:
        return []
    finder = getattr(driver, "models", None)
    if callable(finder):
        try:
            return list(finder())
        except Exception:  # noqa: BLE001 -- a bad config file is not a broken app
            logger.debug("Could not read %s's model", getattr(driver, "__name__", "?"))
            return []
    return list(getattr(driver, "MODELS", []))


def _login_of(key: str, binary: str, ask: bool) -> dict:
    """What is known about this CLI's login right now, refreshing behind us.

    `ask` is what allows a check to be started at all: every check is a child
    process, and the first screen -- where the assistant is not even on show --
    must not start one. The screen asks the first time the strip is visible,
    and again whenever the user opens the picker -- which is also why an ask is
    held to the shorter of the two lifetimes above: it is the moment somebody
    is standing there waiting to see the answer change.

    None for `logged_in` means "we cannot say yet", never "signed out" -- the
    screen shows nothing rather than an accusation it has not checked.
    """
    now = time.monotonic()
    with _login_lock:
        row = _login_cache.get(key)
        ttl = AGENT_LOGIN_ASK_TTL if ask else AGENT_LOGIN_TTL
        stale = row is None or now - row["at"] >= ttl
        start = bool(ask and stale and binary and key not in _login_busy)
        if start:
            _login_busy.add(key)
    if start:
        threading.Thread(target=_login_refresh, args=(key, binary), daemon=True).start()
    if row is None:
        return {"logged_in": None, "account": ""}
    return {"logged_in": row["logged_in"], "account": row["account"]}


class AgentChatRequest(BaseModel):
    message: str
    agent: str = "claude"
    resume: bool = True
    # "" keeps whatever the CLI is set up to use.
    model: str = ""
    # The job the user is looking at. Every script tool needs one, and the user
    # has no way of knowing the id -- the panel reads it off the page instead.
    job_id: Optional[str] = None


def _with_job(message: str, job_id: Optional[str]) -> str:
    """Tell the assistant which job is on screen before it reads the question."""
    if not job_id:
        # The home screen has the strip too, and there no job is open. Said
        # outright, or the assistant asks for a job number the user never sees.
        return ("(No job is open on screen right now -- the user is on the "
                "home screen.)\n\n%s" % message)
    return "(The job open on screen right now: %s)\n\n%s" % (job_id, message)


@router.get("/api/agent/status")
def agent_status(login: int = 0):
    """Which assistants are installed on this machine, and which are ready.

    Only one of them is needed -- whichever the user subscribes to. The panel
    greys out the rest rather than asking anyone to install both.
    """
    out = []
    for key, meta in AGENTS.items():
        path = agent_base.find_cli(meta["binary"])
        driver = meta["driver"]
        # Only asked of a CLI we would actually run, and only when the caller
        # says the assistant is on screen (?login=1). `logged_in` is None until
        # the answer lands, and this call never waits for it.
        state = (_login_of(key, path, ask=bool(login)) if path and driver
                 else {"logged_in": None, "account": ""})
        # ChatGPT's sign-in program is fetched on the first Sign In, so a
        # computer without it is "not signed in yet", not "not available".
        fetchable = bool(meta["binary"] == "codex" and not path and codex_fetch.package())
        if fetchable:
            state = {"logged_in": False, "account": ""}
        out.append({
            "id": key,
            "name": meta["name"],
            "vendor": meta["vendor"],
            "installed": bool(path) or fetchable,
            "supported": driver is not None,
            # True, False, or None for "not known yet". The account is its KIND
            # ("ChatGPT", "claude.ai") -- never an address, never a token.
            "logged_in": state["logged_in"],
            "account": state["account"],
            # What to type in a terminal to sign in, said in one place.
            "login_command": meta.get("login", ""),
            # Why it is greyed out, in the picker's own words. Empty when the
            # assistant is usable, and "not installed" is the panel's line.
            "reason": "" if driver else meta.get("reason", ""),
            # A driver that can work out its own list at run time says so
            # with models(); the rest have theirs written down. Codex is the
            # first of the former -- the one model it is set up to use lives
            # in its config and nowhere else (user, 2026-09-11).
            # Codex's list is the account's own, so it waits for a sign-in:
            # before one, Codex would list models the account may not have.
            "models": (list(meta["models"]) if "models" in meta
                       else _models_of(driver) if state["logged_in"] is True or not callable(getattr(driver, "models", None))
                       else []),
            # A sign-in the app keeps (ChatGPT for translation), not an assistant.
            "sign_in_only": bool(meta.get("sign_in_only")),
        })
    return {"agents": out}


def _env_of(meta: dict) -> Optional[dict]:
    """The ChatGPT assistant runs in PersoDub's own OpenAI home (agents/base.py
    chatgpt_env); the others in the user's own."""
    return agent_base.chatgpt_env() if meta.get("private_home") else None


# A model name is letters, digits and . _ : - only. It reaches a command line,
# and on Windows an npm .cmd shim hands that line to cmd.exe (review 2026-09-23).
_MODEL_NAME = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

# The one sign-in in flight. A second click used to start a second `codex
# login` that fought the first for its callback port (review 2026-09-23).
_login_proc = None


class AgentLoginRequest(BaseModel):
    agent: str = "chatgpt"


@router.post("/api/agent/login")
def agent_login(body: AgentLoginRequest):
    """Start this CLI's own sign-in. Codex opens the browser itself and waits
    for the callback; nothing here reads or keeps what comes back. The cached
    answer is dropped so the next ?login=1 asks afresh -- the screen polls
    that until the sign-in lands. What the user sees is "Sign in with
    ChatGPT" (the ChatGPT translator, app/translate.py); the CLI is the wire."""
    meta = AGENTS.get(body.agent)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"Unknown assistant: {body.agent}")
    binary = agent_base.find_cli(meta["binary"])
    if not binary and meta["binary"] == "codex":
        # No Codex on this computer: fetch PersoDub's own copy first (about
        # 150 MB, seconds on a home connection), then sign in with it.
        try:
            codex_fetch.fetch()
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))
        binary = agent_base.find_cli(meta["binary"])
    if not binary:
        raise HTTPException(status_code=409, detail=f"{meta['name']} is not installed on this computer.")
    codex_agent.forget_models()
    global _login_proc
    if _login_proc is not None and _login_proc.poll() is None:
        agent_base._end(_login_proc)
    try:
        _login_proc = subprocess.Popen([binary, "login"], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env=_env_of(meta))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not start the sign-in ({type(e).__name__}).")
    # Every assistant that reads this same sign-in is asked afresh.
    with _login_lock:
        for key, other in AGENTS.items():
            if key == body.agent or (_env_of(other) is not None) == (_env_of(meta) is not None) \
                    and other.get("binary") == meta.get("binary"):
                _login_cache.pop(key, None)
    return {"started": True}


@router.get("/api/agent/login/progress")
def agent_login_progress():
    """How far fetching ChatGPT's sign-in program has got (app/codex_fetch.py).
    The sign-in window asks while its Sign In request is still out."""
    return dict(codex_fetch.progress)


@router.post("/api/agent/stop")
def agent_stop():
    """End the turn on air, leaving the conversation there to carry on.

    The CLI is asked to go rather than shot: it writes its session down on the
    way out, and that is what the next message resumes from. `stopped` is False
    when there was no turn running -- pressing Stop twice is not an error.
    """
    return {"stopped": agent_base.stop_turn()}


@router.post("/api/agent/chat")
async def agent_chat(body: AgentChatRequest, request: Request):
    """One turn with the assistant, streamed back a line of JSON at a time.

    Streaming is the point: a turn takes seconds, and a panel that sits blank
    that whole time reads as broken. Each line is one of our five events.
    """
    meta = AGENTS.get(body.agent)
    if meta is None or meta.get("sign_in_only"):
        raise HTTPException(status_code=422, detail="Unknown assistant: %s" % body.agent)
    driver = meta["driver"]
    if driver is None:
        raise HTTPException(status_code=501, detail="%s: %s"
                            % (meta["name"], meta.get("reason", "not wired up yet")))

    binary = agent_base.find_cli(meta["binary"])
    if not binary and meta["binary"] == "codex" and codex_fetch.package():
        # Fetched at launch (app/codex_fetch.py); a message sent before that
        # finished waits for it here rather than failing.
        try:
            await run_in_threadpool(codex_fetch.fetch)
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        binary = agent_base.find_cli(meta["binary"])
    if not binary:
        raise HTTPException(status_code=503,
                            detail="%s is not installed." % meta["name"])

    api_url = str(request.base_url).rstrip("/")
    agent_dir = os.path.join(AGENT_DIR, meta["dir"]) if meta.get("dir") else AGENT_DIR
    mcp_config = agent_base.write_mcp_config(agent_dir, api_url)
    work_dir = os.path.dirname(mcp_config)
    # The question goes to the CLI over stdin, never argv: on Windows the CLIs
    # are npm .cmd shims, and cmd.exe cuts a shim's command line at the first
    # newline -- which this text always has between job context and question.
    prompt = driver.stdin_text(_with_job(body.message, body.job_id))
    try:
        model = body.model or meta.get("model", "")
        if model and not _MODEL_NAME.match(model):
            raise ValueError("not a model name")
        args = driver.command(mcp_config, body.resume, model)
    except (OSError, ValueError, KeyError) as e:
        # Everything else on this path answers with a bubble rather than a
        # stack trace, and building the command line should not be the one
        # place that hands the user a 500.
        raise HTTPException(status_code=500,
                            detail="Could not prepare the assistant: %s" % e)

    async def stream():
        # The runner blocks -- it reads the CLI's stdout a line at a time -- so
        # it gets a thread of its own and posts what it reads here. That is what
        # leaves this side free to notice the browser going away mid-answer: a
        # closed tab used to leave the CLI running to the end, talking to
        # nobody, with the next turn queued behind it.
        events = queue.Queue()

        def pump():
            try:
                for event in agent_base.run(binary, args, driver.translate,
                                            cwd=work_dir, agent_name=meta["name"],
                                            login_command=meta.get("login", ""),
                                            input_text=prompt, env=_env_of(meta)):
                    events.put(event)
            finally:
                events.put(None)      # whatever happened, the turn is over

        threading.Thread(target=pump, daemon=True).start()
        finished = False
        try:
            while True:
                try:
                    event = await run_in_threadpool(events.get, True, 0.25)
                except queue.Empty:
                    if await request.is_disconnected():
                        break
                    continue
                if event is None:
                    finished = True
                    break
                yield json.dumps(event, ensure_ascii=False) + "\n"
        finally:
            # Stopped, or nobody left to read it. Either way the child goes.
            if not finished:
                agent_base.stop_turn()

    return StreamingResponse(stream(), media_type="application/x-ndjson")
