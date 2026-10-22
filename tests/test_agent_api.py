"""What the chat panel asks the server: which assistants there are, and one turn.

No CLI is spawned. The runner is replaced, so these say what the two endpoints
promise the panel -- which assistant is usable, why one is not, and that the
backend the panel names is the backend that answers.
"""
import json
import os
import time

from fastapi.testclient import TestClient

import app.api.agent as agent_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _rows(login=False):
    """The status rows. `login` is what the screen sends once the strip is on
    show: without it the route answers from what it already knows and starts
    nothing, so opening the app spawns no CLI at all."""
    r = client.get("/api/agent/status" + ("?login=1" if login else ""))
    assert r.status_code == 200
    return {a["id"]: a for a in r.json()["agents"]}


def _settled(key, login=True, secs=4.0):
    """Poll until that assistant's login answer has landed."""
    deadline = time.monotonic() + secs
    rows = _rows(login=login)
    while rows[key]["logged_in"] is None and time.monotonic() < deadline:
        time.sleep(0.02)
        rows = _rows(login=login)
    return rows


def _settled_to(key, want, secs=4.0):
    """Poll until that assistant's login answer is `want`. Unlike _settled, the
    answer it is waiting for replaces an answer that is already there."""
    deadline = time.monotonic() + secs
    rows = _rows(login=True)
    while rows[key]["logged_in"] is not want and time.monotonic() < deadline:
        time.sleep(0.02)
        rows = _rows(login=True)
    return rows


def test_status_names_both_and_says_which_can_answer():
    rows = _rows()
    assert set(rows) == {"claude", "codex", "chatgpt"}
    assert rows["claude"]["supported"] is True
    assert rows["codex"]["supported"] is True
    # ChatGPT is Codex's sign-in answering as ChatGPT does: one model, the
    # free plan's own, whatever the user's Codex config names.
    assert rows["chatgpt"]["supported"] is True
    assert rows["chatgpt"]["vendor"] == "OpenAI"
    assert rows["chatgpt"]["models"] == ["gpt-5.6-luna"]
    # Listed for its sign-in only: Settings and the sign-in window read it,
    # the Dub Agent picker leaves it out (user, 2026-09-24).
    assert rows["chatgpt"]["sign_in_only"] is True
    assert rows["claude"]["sign_in_only"] is False and rows["codex"]["sign_in_only"] is False


def test_chatgpt_is_not_a_dub_agent():
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "chatgpt"})
    assert r.status_code == 422


def test_an_assistant_that_cannot_answer_says_why(monkeypatch):
    """An assistant listed without a driver is offered greyed out, with the
    reason printed under its name. Nothing is in that state today, so the
    mechanism is checked against one put there for the test -- an empty reason
    would be a dead end with no explanation."""
    monkeypatch.setitem(agent_api.AGENTS, "someday", {
        "binary": "someday", "name": "Someday", "vendor": "Nobody",
        "driver": None, "reason": "this one is not wired up yet",
    })
    rows = _rows()
    assert rows["someday"]["supported"] is False
    assert len(rows["someday"]["reason"].split()) > 3  # a sentence, not a label
    assert rows["someday"]["models"] == []
    # A usable assistant has nothing to excuse.
    assert rows["claude"]["reason"] == ""
    assert rows["codex"]["reason"] == ""


def test_claude_offers_its_aliases_and_codex_the_accounts_own_list(monkeypatch):
    """Claude's four aliases always point at the newest of each line. Codex
    offers the models its account has answered with (app/agents/codex.py
    models), once signed in (user, 2026-09-28)."""
    from app.agents import codex as codex_mod
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api.agent_base, "login_state",
                        lambda kind, binary, env=None: {"logged_in": True, "account": "ChatGPT"})
    monkeypatch.setattr(codex_mod, "models", lambda: ["gpt-6-luna", "gpt-5.6-luna"])
    agent_api._login_cache.clear()
    rows = _settled("codex")
    assert "fable" in rows["claude"]["models"]
    assert rows["codex"]["models"] == ["gpt-6-luna", "gpt-5.6-luna"]


def test_a_signed_out_codex_offers_no_models(monkeypatch):
    """Before a sign-in Codex lists every model it knows; a free account could
    then pick one it does not have. The row says to sign in instead."""
    from app.agents import codex as codex_mod
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api.agent_base, "login_state",
                        lambda kind, binary, env=None: {"logged_in": False, "account": ""})
    monkeypatch.setattr(codex_mod, "models",
                        lambda: (_ for _ in ()).throw(AssertionError("asked while signed out")))
    monkeypatch.setattr(codex_mod, "model_states",
                        lambda: (_ for _ in ()).throw(AssertionError("asked while signed out")))
    agent_api._login_cache.clear()
    assert _settled("codex")["codex"]["models"] == []
    assert _settled("codex")["codex"]["model_states"] == []


def test_status_never_starts_a_cli(monkeypatch):
    """Asking what is available must stay cheap: it looks for the binaries and
    stops there. A turn per row would cost the user's quota to open a menu."""
    def boom(*a, **kw):
        raise AssertionError("agent_status must not run anything")

    monkeypatch.setattr(agent_api.agent_base, "run", boom)
    _rows()


def test_an_unknown_assistant_is_refused():
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "nope"})
    assert r.status_code == 422


def test_an_assistant_without_a_driver_is_refused_with_what_to_do(monkeypatch):
    monkeypatch.setitem(agent_api.AGENTS, "someday", {
        "binary": "someday", "name": "Someday", "vendor": "Nobody",
        "driver": None, "reason": "this one is not wired up yet",
    })
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "someday"})
    assert r.status_code == 501
    # What to do, in words; its own reason is under its name in the picker.
    assert r.json()["detail"] == "This assistant cannot be used in Dub Agent yet. Pick another assistant."


def _capture(monkeypatch, tmp_path):
    """Run a turn with the CLI replaced, and hand back what was asked of it."""
    seen = {}

    def fake_run(binary, args, translate, cwd=None, agent_name="", login_command="",
                 input_text=None, env=None):
        seen["binary"] = binary
        seen["args"] = args
        seen["translate"] = translate
        # The runner is told which CLI it is running and how that CLI is signed
        # in, so a failed turn can name both.
        seen["agent_name"] = agent_name
        seen["login_command"] = login_command
        seen["input_text"] = input_text
        yield {"kind": "done", "text": "ok"}

    monkeypatch.setattr(agent_api.agent_base, "run", fake_run)
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    # Without this the tests leave a real persodub-mcp.json in the user's own
    # log folder. Written where pytest cleans up instead.
    real_write = agent_api.agent_base.write_mcp_config
    monkeypatch.setattr(agent_api.agent_base, "write_mcp_config",
                        lambda d, url: real_write(str(tmp_path), url))
    return seen


def test_a_turn_goes_to_the_backend_the_panel_named(monkeypatch, tmp_path):
    seen = _capture(monkeypatch, tmp_path)
    r = client.post("/api/agent/chat",
                    json={"message": "3번 줄 짧게", "agent": "codex", "job_id": "abc123"})
    assert r.status_code == 200
    assert '"kind": "done"' in r.text or '"kind":"done"' in r.text
    assert seen["binary"].endswith("codex")
    assert seen["args"][0] == "exec"           # Codex's own command line
    assert seen["translate"] is agent_api.codex_agent.translate
    # The job on screen went with the question -- over stdin, never argv (a
    # newline in argv is where cmd.exe cut the .cmd shim's command line).
    assert "abc123" in seen["input_text"]
    assert not any("abc123" in a for a in seen["args"])


def test_a_turn_ended_on_a_usage_limit_says_so_once(monkeypatch, tmp_path):
    # The reader ends the turn on the limit, and the CLI it stopped says the
    # same thing again on its way out: the panel showed the sentence twice
    # (Windows test H18, 2026-10-10).
    _capture(monkeypatch, tmp_path)
    limit = "Usage limit reached. Wait a while or pick another assistant."
    stopped = []

    def fake_run(binary, args, translate, **kw):
        yield {"kind": "progress", "tool": "transport", "label": "Reconnecting…"}
        yield {"kind": "error", "message": limit, "stop": True}
        yield {"kind": "error", "message": limit}

    monkeypatch.setattr(agent_api.agent_base, "run", fake_run)
    monkeypatch.setattr(agent_api.agent_base, "stop_turn", lambda: stopped.append(1) or True)
    r = client.post("/api/agent/chat", json={"message": "hi", "agent": "codex"})
    assert r.status_code == 200
    assert r.text.count("Usage limit reached") == 1 and stopped
    assert "Reconnecting" in r.text   # what came before the stop still shows


def test_home_screen_turn_says_no_job_is_open(monkeypatch, tmp_path):
    # The strip is on the home screen too, where no job is open. The assistant
    # is told so, or it asks for a job number the user never sees.
    seen = _capture(monkeypatch, tmp_path)
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "claude"})
    assert r.status_code == 200
    assert "No job is open" in seen["input_text"]


def test_claude_still_gets_claudes_command_line(monkeypatch, tmp_path):
    seen = _capture(monkeypatch, tmp_path)
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "claude"})
    assert r.status_code == 200
    assert seen["binary"].endswith("claude")
    assert "--strict-mcp-config" in seen["args"]
    assert seen["translate"] is agent_api.claude_agent.translate


def test_an_assistant_that_is_not_installed_says_so(monkeypatch):
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: None)
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "codex"})
    assert r.status_code == 503


def test_a_damaged_config_comes_back_as_a_message_not_a_stack_trace(monkeypatch):
    """command() reads a file inside the handler. A bad one must reach the user
    as something the panel can print in a bubble."""
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api.agent_base, "write_mcp_config",
                        lambda d, url: __import__("os").path.join(d, "missing.json"))
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "codex"})
    assert r.status_code == 500
    assert "Could not prepare the assistant" in r.json()["detail"]


def test_every_turn_asks_to_carry_on_the_conversation(monkeypatch, tmp_path):
    """The panel never sends `resume`, so the request default is what reaches
    the driver -- and that default is what makes a follow-up remember."""
    seen = _capture(monkeypatch, tmp_path)
    # The thread the app started, remembered beside the MCP config. Resumed by
    # its id and never --last, which could pick Codex's own auto-review thread
    # (2026-09-17).
    (tmp_path / "codex-thread").write_text("01a0-main-thread", encoding="utf-8")
    client.post("/api/agent/chat", json={"message": "또", "agent": "codex"})
    assert seen["args"][:3] == ["exec", "resume", "01a0-main-thread"]


# --- which account each assistant is signed in with -------------------------
# The strip says this on every screen, so the row has to carry it -- and asking
# must never be what makes the picker slow to open.

def test_status_says_whether_each_assistant_is_signed_in(monkeypatch):
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api.agent_base, "login_state",
                        lambda kind, binary, env=None: {"logged_in": True, "account": "ChatGPT"})
    agent_api._login_cache.clear()
    rows = _settled("codex")
    assert rows["codex"]["logged_in"] is True
    assert rows["codex"]["account"] == "ChatGPT"
    # What to type to sign in, named by the server so one place says it.
    # Codex signs in through the app's own window now (one ChatGPT sign-in for
    # translation and the agent, 2026-09-28): no terminal command to name.
    assert rows["codex"]["login_command"] == ""
    assert rows["claude"]["login_command"] == "claude"


def test_an_assistant_we_cannot_run_is_never_called_signed_out(monkeypatch):
    """None means "we have not been able to ask". Showing that as "sign in"
    would send the user off to fix something that is not broken."""
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: None)
    # And no sign-in program the app could fetch in its place either.
    monkeypatch.setattr(agent_api.codex_fetch, "package", lambda: None)
    agent_api._login_cache.clear()
    rows = _rows()
    assert rows["codex"]["logged_in"] is None
    assert rows["claude"]["logged_in"] is None


def test_status_answers_at_once_even_while_a_cli_is_thinking(monkeypatch):
    """The check runs on a thread of its own. A CLI that takes seconds to say
    whether it is signed in must not be what the picker waits for."""
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)

    def slow(kind, binary, env=None):
        time.sleep(1.5)
        return {"logged_in": True, "account": "ChatGPT"}

    monkeypatch.setattr(agent_api.agent_base, "login_state", slow)
    agent_api._login_cache.clear()
    started = time.monotonic()
    rows = _rows(login=True)
    assert time.monotonic() - started < 0.5
    assert rows["codex"]["logged_in"] is None    # not known yet, and not waited for


def test_opening_the_app_does_not_start_a_single_cli(monkeypatch):
    """Every check is a child process. The first screen does not even show the
    assistant, so the screen asks for these only once the strip is visible."""
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)

    def boom(kind, binary, env=None):
        raise AssertionError("no login check may start without being asked for")

    monkeypatch.setattr(agent_api.agent_base, "login_state", boom)
    agent_api._login_cache.clear()
    agent_api._login_busy.clear()
    rows = _rows()                      # no ?login=1 -- what the app asks at launch
    assert rows["codex"]["logged_in"] is None
    time.sleep(0.1)                     # a thread would have run by now
    assert rows["claude"]["logged_in"] is None


def test_a_login_check_that_blows_up_does_not_wedge_that_assistant(monkeypatch):
    """The check used to leave its "already running" marker behind when it threw,
    and that assistant then showed nothing for the life of the app."""
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api, "AGENT_LOGIN_TTL", 0.0)   # ask again on the next look

    def boom(kind, binary, env=None):
        raise RuntimeError("the CLI exploded")

    monkeypatch.setattr(agent_api.agent_base, "login_state", boom)
    agent_api._login_cache.clear()
    agent_api._login_busy.clear()
    _rows(login=True)
    for _ in range(200):                # let the failing thread finish
        if not agent_api._login_busy:
            break
        time.sleep(0.02)
    assert agent_api._login_busy == set(), "the busy marker outlived the check"
    assert _rows(login=True)["codex"]["logged_in"] is None

    # And the next check still runs.
    monkeypatch.setattr(agent_api.agent_base, "login_state",
                        lambda kind, binary, env=None: {"logged_in": True, "account": "ChatGPT"})
    assert _settled("codex")["codex"]["logged_in"] is True


# --- stopping a turn --------------------------------------------------------

def test_stop_says_whether_there_was_a_turn_to_stop():
    """Pressing Stop with nothing running is not an error -- the panel can call
    it before every send without having to know."""
    r = client.post("/api/agent/stop")
    assert r.status_code == 200
    assert r.json()["stopped"] is False


def test_the_message_after_a_stop_carries_the_conversation_on(monkeypatch, tmp_path):
    """A stopped turn must not cost the user the conversation: the next message
    still asks the CLI to continue where it left off."""
    seen = _capture(monkeypatch, tmp_path)
    client.post("/api/agent/stop")
    r = client.post("/api/agent/chat", json={"message": "그럼 이렇게", "agent": "claude"})
    assert r.status_code == 200
    assert "-c" in seen["args"]          # Claude's "carry on" flag


def test_a_deliberate_ask_does_not_get_a_minute_old_answer(monkeypatch):
    """Signing out in a Terminal and opening the picker showed "signed in"
    three opens running, and only came right on the fourth, fifty seconds
    later: every open was inside the minute the answer is kept for, so none of
    them started a fresh check (Windows measured it, 2026-09-11).

    The minute stands for the page asking in passing. An ask -- ?login=1, which
    only the strip's own moments send -- is held to a few seconds instead.
    """
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    agent_api._login_cache.clear()
    agent_api._login_busy.clear()

    answer = {"logged_in": True, "account": "ChatGPT"}
    monkeypatch.setattr(agent_api.agent_base, "login_state", lambda kind, binary, env=None: dict(answer))
    assert _settled("codex")["codex"]["logged_in"] is True

    # They sign out in a Terminal. The app is none the wiser yet.
    answer = {"logged_in": False, "account": ""}

    # Ten seconds later: inside the minute, outside the few seconds an ask gets.
    for key in agent_api._login_cache:
        agent_api._login_cache[key]["at"] -= 10.0
    # A passing look still answers from what it has and starts nothing.
    assert _rows()["codex"]["logged_in"] is True
    assert agent_api._login_busy == set()

    # Opening the picker starts the check, and the answer that lands is the new one.
    assert _settled_to("codex", False)["codex"]["logged_in"] is False


def test_claude_runs_without_the_users_memory_files(monkeypatch):
    # Even with no settings files, the CLI read CLAUDE.md / AGENTS.md up the
    # folder tree and the auto-memory of the repository the agent folder sits
    # in (measured 2026-10-11: ~/.claude/projects/<repo>/memory/MEMORY.md).
    # Two switches in its environment turn both off; the user's own env stays.
    monkeypatch.setenv("PERSODUB_TEST_MARK", "kept")
    env = agent_api._turn_env(agent_api.AGENTS["claude"])
    assert env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] == "1"
    assert env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
    assert env["PERSODUB_TEST_MARK"] == "kept"
    # Codex and ChatGPT keep PersoDub's own home, as before, and Claude's
    # sign-in runs in the user's own environment, untouched.
    assert "CODEX_HOME" in agent_api._turn_env(agent_api.AGENTS["codex"])
    assert agent_api._env_of(agent_api.AGENTS["claude"]) is None


def _chat_events(fake_run, monkeypatch, tmp_path):
    _capture(monkeypatch, tmp_path)
    monkeypatch.setattr(agent_api.agent_base, "run", fake_run)
    r = client.post("/api/agent/chat", json={"message": "hi", "agent": "claude"})
    assert r.status_code == 200
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


# The words held back for the address check went out after the tool chip that
# followed them, so one sentence was split across two bubbles: "Let me read
# the" · chip · "script.Line 3 is too long." (final review, 2026-10-12).
def test_the_words_before_a_tool_reach_the_panel_before_its_chip(monkeypatch, tmp_path):
    def fake_run(binary, args, translate, **kw):
        yield {"kind": "text", "text": "Let me read"}
        yield {"kind": "text", "text": " the script."}
        yield {"kind": "progress", "tool": "get_script"}
        yield {"kind": "text", "text": "Line 3"}
        yield {"kind": "text", "text": " is too long."}
        yield {"kind": "done", "text": "Line 3 is too long."}

    events = _chat_events(fake_run, monkeypatch, tmp_path)
    chip = next(i for i, e in enumerate(events) if e.get("kind") == "progress")
    assert _texts(events[:chip]) == "Let me read the script."
    assert _texts(events[chip:]) == "Line 3 is too long."


# An error's sentence and the CLI's own last words go to the panel too, and
# the CLI can name the signed-in account there (final review, 2026-10-12).
def test_an_email_address_never_reaches_the_panel_in_an_error_either(monkeypatch, tmp_path):
    def fake_run(binary, args, translate, **kw):
        yield {"kind": "error", "message": "Stopped for some.one@example.com.",
               "detail": "auth: some.one@example.com expired"}

    events = _chat_events(fake_run, monkeypatch, tmp_path)
    error = next(e for e in events if e.get("kind") == "error")
    assert "@" not in json.dumps(events)
    assert error["message"] == "Stopped for (email hidden)."


def _texts(events):
    return "".join(e.get("text", "") for e in events if e.get("kind") == "text")


# Text with no spaces (Chinese, Japanese) was held back whole until a line
# break or the end of the reply, so those users saw no live answer.
def test_text_without_spaces_streams_as_it_comes(monkeypatch, tmp_path):
    def fake_run(binary, args, translate, **kw):
        yield {"kind": "text", "text": "你好"}
        yield {"kind": "text", "text": "世界。"}
        yield {"kind": "done", "text": "你好世界。"}

    events = _chat_events(fake_run, monkeypatch, tmp_path)
    assert [e["text"] for e in events if e.get("kind") == "text"] == ["你好", "世界。"]


def test_an_email_address_never_reaches_the_panel_even_cut_in_pieces(monkeypatch, tmp_path):
    # Claude Code puts the signed-in account's address into the assistant's
    # context, and told not to repeat it, Sonnet still answered "Who am I
    # signed in as?" with it three times in three (2026-10-11, Windows test
    # F1). The panel can be on a shared screen: the address is taken out on
    # the way, also when the stream cuts it between two pieces.
    _capture(monkeypatch, tmp_path)

    def fake_run(binary, args, translate, **kw):
        for piece in ["You're signed in as some.on", "e@exam", "ple.com", ". Anything else?"]:
            yield {"kind": "text", "text": piece}
        yield {"kind": "done", "text": "You're signed in as some.one@example.com. Anything else?"}

    monkeypatch.setattr(agent_api.agent_base, "run", fake_run)
    r = client.post("/api/agent/chat", json={"message": "who am I", "agent": "claude"})
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    shown = "".join(e.get("text", "") for e in events if e.get("kind") == "text")
    assert "@" not in r.text and "some.on" not in shown
    assert shown == "You're signed in as (email hidden). Anything else?"


def test_the_agent_folder_stays_where_it_was_when_the_logs_move():
    # The logs go where the desktop app says (PERSODUB_LOG_DIR); the CLI runs
    # in this folder, and Claude's -c continues the conversation of the folder
    # it runs in, so it stays in the app's own logs/agent.
    assert os.path.join("logs", "agent") == agent_api.AGENT_DIR


def test_a_signed_in_codex_lists_every_model_with_its_check(monkeypatch):
    """Beside the models that can be picked, the whole list with where each
    one's check stands, so the picker can show it at once (owner, 2026-10-18).
    Claude's list is written down and has no checks."""
    from app.agents import codex as codex_mod
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(agent_api.agent_base, "login_state",
                        lambda kind, binary, env=None: {"logged_in": True, "account": "ChatGPT"})
    monkeypatch.setattr(codex_mod, "models", lambda: ["gpt-6-astra"])
    states = [{"id": "gpt-6-astra", "state": "ok"}, {"id": "gpt-6-luna", "state": "checking"}]
    monkeypatch.setattr(codex_mod, "model_states", lambda: states)
    agent_api._login_cache.clear()
    rows = _settled("codex")
    assert rows["codex"]["models"] == ["gpt-6-astra"]
    assert rows["codex"]["model_states"] == states
    assert rows["claude"]["model_states"] == []
