"""What the chat panel asks the server: which assistants there are, and one turn.

No CLI is spawned. The runner is replaced, so these say what the two endpoints
promise the panel -- which assistant is usable, why one is not, and that the
backend the panel names is the backend that answers.
"""
from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _rows():
    r = client.get("/api/agent/status")
    assert r.status_code == 200
    return {a["id"]: a for a in r.json()["agents"]}


def test_status_names_all_three_and_says_which_can_answer():
    rows = _rows()
    assert set(rows) == {"claude", "codex", "gemini"}
    assert rows["claude"]["supported"] is True
    assert rows["codex"]["supported"] is True
    assert rows["gemini"]["supported"] is False


def test_an_assistant_that_cannot_answer_says_why():
    """The picker greys the row out and prints this underneath it, so an empty
    reason would be a dead end with no explanation."""
    rows = _rows()
    assert len(rows["gemini"]["reason"].split()) > 3  # a sentence, not a label
    # A usable assistant has nothing to excuse.
    assert rows["claude"]["reason"] == ""
    assert rows["codex"]["reason"] == ""


def test_only_claude_offers_a_choice_of_models():
    """Codex names its models by version, which would go stale in a picker."""
    rows = _rows()
    assert "fable" in rows["claude"]["models"]
    assert rows["codex"]["models"] == []
    assert rows["gemini"]["models"] == []


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


def test_gemini_is_refused_with_the_same_reason_the_picker_shows():
    r = client.post("/api/agent/chat", json={"message": "안녕", "agent": "gemini"})
    assert r.status_code == 501
    assert _rows()["gemini"]["reason"] in r.json()["detail"]


def _capture(monkeypatch, tmp_path):
    """Run a turn with the CLI replaced, and hand back what was asked of it."""
    seen = {}

    def fake_run(binary, args, translate, cwd=None):
        seen["binary"] = binary
        seen["args"] = args
        seen["translate"] = translate
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
    assert "도우미 설정" in r.json()["detail"]


def test_every_turn_asks_to_carry_on_the_conversation(monkeypatch, tmp_path):
    """The panel never sends `resume`, so the request default is what reaches
    the driver -- and that default is what makes a follow-up remember."""
    seen = _capture(monkeypatch, tmp_path)
    client.post("/api/agent/chat", json={"message": "또", "agent": "codex"})
    assert seen["args"][:3] == ["exec", "resume", "--last"]
