"""What the chat panel asks the server: which assistants there are, and one turn.

No CLI is spawned. The runner is replaced, so these say what the two endpoints
promise the panel -- which assistant is usable, why one is not, and that the
backend the panel names is the backend that answers.
"""
import time

from fastapi.testclient import TestClient

import app.main as main
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


def test_status_names_both_and_says_which_can_answer():
    rows = _rows()
    assert set(rows) == {"claude", "codex"}
    assert rows["claude"]["supported"] is True
    assert rows["codex"]["supported"] is True


def test_an_assistant_that_cannot_answer_says_why(monkeypatch):
    """An assistant listed without a driver is offered greyed out, with the
    reason printed under its name. Nothing is in that state today, so the
    mechanism is checked against one put there for the test -- an empty reason
    would be a dead end with no explanation."""
    monkeypatch.setitem(main.AGENTS, "someday", {
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


def test_only_claude_offers_a_choice_of_models():
    """Codex names its models by version, which would go stale in a picker."""
    rows = _rows()
    assert "fable" in rows["claude"]["models"]
    assert rows["codex"]["models"] == []


def test_status_never_starts_a_cli(monkeypatch):
    """Asking what is available must stay cheap: it looks for the binaries and
    stops there. A turn per row would cost the user's quota to open a menu."""
    def boom(*a, **kw):
        raise AssertionError("agent_status must not run anything")

    monkeypatch.setattr(main.agent_base, "run", boom)
    _rows()


def test_an_unknown_assistant_is_refused():
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "nope"})
    assert r.status_code == 422


def test_an_assistant_without_a_driver_is_refused_with_the_pickers_reason(monkeypatch):
    monkeypatch.setitem(main.AGENTS, "someday", {
        "binary": "someday", "name": "Someday", "vendor": "Nobody",
        "driver": None, "reason": "this one is not wired up yet",
    })
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "someday"})
    assert r.status_code == 501
    assert _rows()["someday"]["reason"] in r.json()["detail"]


def _capture(monkeypatch, tmp_path):
    """Run a turn with the CLI replaced, and hand back what was asked of it."""
    seen = {}

    def fake_run(binary, args, translate, cwd=None, agent_name="", login_command=""):
        seen["binary"] = binary
        seen["args"] = args
        seen["translate"] = translate
        # The runner is told which CLI it is running and how that CLI is signed
        # in, so a failed turn can name both.
        seen["agent_name"] = agent_name
        seen["login_command"] = login_command
        yield {"kind": "done", "text": "ok"}

    monkeypatch.setattr(main.agent_base, "run", fake_run)
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    # Without this the tests leave a real persodub-mcp.json in the user's own
    # log folder. Written where pytest cleans up instead.
    real_write = main.agent_base.write_mcp_config
    monkeypatch.setattr(main.agent_base, "write_mcp_config",
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
    assert seen["translate"] is main.codex_agent.translate
    assert "abc123" in seen["args"][-1]        # the job on screen went with it


def test_claude_still_gets_claudes_command_line(monkeypatch, tmp_path):
    seen = _capture(monkeypatch, tmp_path)
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "claude"})
    assert r.status_code == 200
    assert seen["binary"].endswith("claude")
    assert "--strict-mcp-config" in seen["args"]
    assert seen["translate"] is main.claude_agent.translate


def test_an_assistant_that_is_not_installed_says_so(monkeypatch):
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: None)
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "codex"})
    assert r.status_code == 503


def test_a_damaged_config_comes_back_as_a_message_not_a_stack_trace(monkeypatch):
    """command() reads a file inside the handler. A bad one must reach the user
    as something the panel can print in a bubble."""
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(main.agent_base, "write_mcp_config",
                        lambda d, url: __import__("os").path.join(d, "missing.json"))
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "codex"})
    assert r.status_code == 500
    assert "Could not prepare the assistant" in r.json()["detail"]


def test_every_turn_asks_to_carry_on_the_conversation(monkeypatch, tmp_path):
    """The panel never sends `resume`, so the request default is what reaches
    the driver -- and that default is what makes a follow-up remember."""
    seen = _capture(monkeypatch, tmp_path)
    client.post("/api/agent/chat", json={"message": "또", "agent": "codex"})
    assert seen["args"][:3] == ["exec", "resume", "--last"]


# --- which account each assistant is signed in with -------------------------
# The strip says this on every screen, so the row has to carry it -- and asking
# must never be what makes the picker slow to open.

def test_status_says_whether_each_assistant_is_signed_in(monkeypatch):
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(main.agent_base, "login_state",
                        lambda kind, binary: {"logged_in": True, "account": "ChatGPT"})
    main._login_cache.clear()
    rows = _settled("codex")
    assert rows["codex"]["logged_in"] is True
    assert rows["codex"]["account"] == "ChatGPT"
    # What to type to sign in, named by the server so one place says it.
    assert rows["codex"]["login_command"] == "codex login"
    assert rows["claude"]["login_command"] == "claude"


def test_an_assistant_we_cannot_run_is_never_called_signed_out(monkeypatch):
    """None means "we have not been able to ask". Showing that as "sign in"
    would send the user off to fix something that is not broken."""
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: None)
    main._login_cache.clear()
    rows = _rows()
    assert rows["codex"]["logged_in"] is None
    assert rows["claude"]["logged_in"] is None


def test_status_answers_at_once_even_while_a_cli_is_thinking(monkeypatch):
    """The check runs on a thread of its own. A CLI that takes seconds to say
    whether it is signed in must not be what the picker waits for."""
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)

    def slow(kind, binary):
        time.sleep(1.5)
        return {"logged_in": True, "account": "ChatGPT"}

    monkeypatch.setattr(main.agent_base, "login_state", slow)
    main._login_cache.clear()
    started = time.monotonic()
    rows = _rows(login=True)
    assert time.monotonic() - started < 0.5
    assert rows["codex"]["logged_in"] is None    # not known yet, and not waited for


def test_opening_the_app_does_not_start_a_single_cli(monkeypatch):
    """Every check is a child process. The first screen does not even show the
    assistant, so the screen asks for these only once the strip is visible."""
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)

    def boom(kind, binary):
        raise AssertionError("no login check may start without being asked for")

    monkeypatch.setattr(main.agent_base, "login_state", boom)
    main._login_cache.clear()
    main._login_busy.clear()
    rows = _rows()                      # no ?login=1 -- what the app asks at launch
    assert rows["codex"]["logged_in"] is None
    time.sleep(0.1)                     # a thread would have run by now
    assert rows["claude"]["logged_in"] is None


def test_a_login_check_that_blows_up_does_not_wedge_that_assistant(monkeypatch):
    """The check used to leave its "already running" marker behind when it threw,
    and that assistant then showed nothing for the life of the app."""
    monkeypatch.setattr(main.agent_base, "find_cli", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(main, "AGENT_LOGIN_TTL", 0.0)   # ask again on the next look

    def boom(kind, binary):
        raise RuntimeError("the CLI exploded")

    monkeypatch.setattr(main.agent_base, "login_state", boom)
    main._login_cache.clear()
    main._login_busy.clear()
    _rows(login=True)
    for _ in range(200):                # let the failing thread finish
        if not main._login_busy:
            break
        time.sleep(0.02)
    assert main._login_busy == set(), "the busy marker outlived the check"
    assert _rows(login=True)["codex"]["logged_in"] is None

    # And the next check still runs.
    monkeypatch.setattr(main.agent_base, "login_state",
                        lambda kind, binary: {"logged_in": True, "account": "ChatGPT"})
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
