"""The Claude Code translator turns that CLI's stream-json into our five events.

The samples below are real lines recorded from `claude -p --output-format
stream-json --verbose` on 2026-08-24. Recording them means this test runs on a
machine with no CLI installed, and a format change shows up here first rather
than as a blank chat panel.
"""
import json

from app.agents.claude import translate


def ev(line: str):
    return translate(json.loads(line))


def test_init_line_starts_the_turn():
    out = ev('{"type":"system","subtype":"init","model":"claude-opus-5"}')
    assert [e["kind"] for e in out] == ["start"]
    assert out[0]["model"] == "claude-opus-5"


def test_a_finished_assistant_text_block_is_dropped():
    """We always run with --include-partial-messages, so the completed text
    block repeats what the deltas already streamed. Measured 2026-08-24: without
    this the answer appeared three times."""
    out = ev('{"type":"assistant","message":{"content":[{"type":"text","text":"3번 줄을 고쳤습니다."}]}}')
    assert out == []


def test_tool_use_becomes_progress_with_a_korean_label():
    out = ev('{"type":"assistant","message":{"content":['
             '{"type":"tool_use","name":"mcp__persodub__get_script","input":{}}]}}')
    assert out == [{"kind": "progress", "tool": "get_script", "label": "Reading the script"}]


def test_an_unknown_tool_still_reports_progress():
    out = ev('{"type":"assistant","message":{"content":['
             '{"type":"tool_use","name":"Read","input":{}}]}}')
    assert out[0]["kind"] == "progress"
    assert out[0]["tool"] == "Read"


def test_tool_results_are_not_shown():
    """A tool result is bookkeeping. Showing it would dump raw JSON at the user."""
    out = ev('{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}')
    assert out == []


def test_result_line_ends_the_turn():
    out = ev('{"type":"result","subtype":"success","result":"끝냈습니다."}')
    assert out == [{"kind": "done", "text": "끝냈습니다."}]


def test_a_failed_result_is_an_error():
    out = ev('{"type":"result","subtype":"error_during_execution","is_error":true,'
             '"result":"rate limit"}')
    assert out[0]["kind"] == "error"
    assert "rate limit" in out[0]["message"]


def test_partial_deltas_stream_text():
    out = ev('{"type":"stream_event","event":{"type":"content_block_delta",'
             '"delta":{"type":"text_delta","text":"이 "}}}')
    assert out == [{"kind": "text", "text": "이 "}]


def test_a_message_holding_text_and_a_tool_call_reports_only_the_tool():
    out = ev('{"type":"assistant","message":{"content":['
             '{"type":"text","text":"확인해볼게요."},'
             '{"type":"tool_use","name":"mcp__persodub__check_fit","input":{}}]}}')
    assert [e["kind"] for e in out] == ["progress"]
    assert out[0]["label"] == "Checking the timing"


def test_lines_we_do_not_recognise_are_ignored():
    """Unknown lines must not raise: a new event type should not break the panel."""
    assert ev('{"type":"something_new","whatever":1}') == []
    assert ev('{}') == []


def test_the_command_fences_the_assistant_in():
    from app.agents.claude import command

    args = command("고쳐줘", "/tmp/mcp.json", resume=False)
    # Only our own MCP server: without this the user's personal MCP servers
    # would come along and hand the assistant tools this app never offered.
    assert "--strict-mcp-config" in args
    allowed = args[args.index("--allowedTools") + 1]
    assert allowed.count("mcp__persodub__") == 7
    denied = args[args.index("--disallowedTools") + 1]
    for tool in ("Bash", "Write", "WebFetch"):
        assert tool in denied
    assert "-c" not in args


def test_resuming_continues_the_same_conversation():
    from app.agents.claude import command

    assert "-c" in command("또", "/tmp/mcp.json", resume=True)


def test_the_job_on_screen_is_handed_to_the_assistant():
    """The user cannot know a job id -- the panel reads it off the page and the
    server puts it in front of the question."""
    from app.main import _with_job

    out = _with_job("대본 읽어줘", "abc123")
    assert "abc123" in out
    assert out.endswith("대본 읽어줘")
    # No job open: the question goes through untouched.
    assert _with_job("안녕", None) == "안녕"


def test_remaking_the_voices_is_a_handle_the_assistant_has():
    """2026-08-24 reversal: an assistant that rewrites a line and then asks the
    user to press a button is doing nothing the user could not do alone."""
    out = ev('{"type":"assistant","message":{"content":['
             '{"type":"tool_use","name":"mcp__persodub__remake_voices","input":{}}]}}')
    assert out == [{"kind": "progress", "tool": "remake_voices",
                    "label": "Remaking the changed voices"}]


def test_a_job_is_refused_when_the_disk_is_nearly_full(monkeypatch):
    """Failing here beats failing three stages in with a half-written folder."""
    import app.main as m
    from fastapi import HTTPException

    monkeypatch.setattr(m, "free_bytes", lambda p: 100 * 1024 ** 2)  # 100 MB
    try:
        m.check_space("/tmp")
    except HTTPException as e:
        assert e.status_code == 507
        assert "지난 작업 폴더" in e.detail  # says what to do about it
    else:
        raise AssertionError("a nearly full disk should have been refused")


def test_plenty_of_room_starts_the_job():
    import app.main as m
    m.check_space("/tmp")  # must not raise on a normal disk


def test_a_chosen_model_is_passed_as_an_alias():
    """Aliases, not version numbers: 'fable' keeps pointing at the current model,
    so the picker does not rot the way a hardcoded 'claude-fable-5' would."""
    from app.agents.claude import MODELS, command

    assert "fable" in MODELS
    args = command("고쳐줘", "/tmp/mcp.json", resume=False, model="fable")
    assert args[args.index("--model") + 1] == "fable"


def test_an_unknown_model_is_ignored_rather_than_passed_on():
    from app.agents.claude import command
    assert "--model" not in command("고쳐줘", "/tmp/mcp.json", resume=False, model="wat")
    assert "--model" not in command("고쳐줘", "/tmp/mcp.json", resume=False)
