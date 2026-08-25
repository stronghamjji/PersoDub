"""The Codex translator turns `codex exec --json` JSONL into our five events.

Every sample below is a real line recorded from codex-cli 0.149.0 on
2026-08-26 (`codex exec --json` against the persodub MCP server). Recording
them means this test runs on a machine with no CLI installed, and a format
change shows up here rather than as a blank chat panel.
"""
import json

from app.agents.codex import translate


def ev(line: str):
    return translate(json.loads(line))


def test_thread_started_starts_the_turn():
    """Codex names the thread, not the model -- so the panel keeps showing the
    model the user picked rather than replacing it with a guess."""
    out = ev('{"type":"thread.started","thread_id":"01a03ada-d733-7c82-9ea3-251084b54d2d"}')
    assert [e["kind"] for e in out] == ["start"]
    assert out[0]["model"] is None


def test_turn_started_says_nothing():
    assert ev('{"type":"turn.started"}') == []


def test_an_agent_message_is_the_answer():
    """Codex has no partial deltas, so the finished message IS the text --
    the opposite of Claude, where the same block is dropped as a repeat."""
    out = ev('{"type":"item.completed","item":{"id":"item_2","type":"agent_message",'
             '"text":"4"}}')
    assert out == [{"kind": "text", "text": "4\n"}]


def test_two_messages_in_one_turn_do_not_run_together():
    """Codex often opens with a preamble and answers in a second message. Both
    are shown, and the newline is what keeps them from reading as one word."""
    first = ev('{"type":"item.completed","item":{"id":"item_0","type":"agent_message",'
               '"text":"I’ll retrieve the script and count its lines."}}')
    second = ev('{"type":"item.completed","item":{"id":"item_2","type":"agent_message",'
                '"text":"4"}}')
    assert (first[0]["text"] + second[0]["text"]).endswith("lines.\n4\n")


def test_a_tool_call_becomes_progress_with_its_label():
    out = ev('{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call",'
             '"server":"persodub","tool":"get_script","arguments":{"job_id":"04caffe7"},'
             '"result":null,"error":null,"status":"in_progress"}}')
    assert out == [{"kind": "progress", "tool": "get_script",
                    "label": "Reading the script"}]


def test_a_finished_tool_call_is_not_shown():
    """The result is bookkeeping between the agent and its tools -- showing it
    would put the whole script back on screen as raw JSON."""
    out = ev('{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call",'
             '"server":"persodub","tool":"get_script","arguments":{"job_id":"04caffe7"},'
             '"result":{"content":[{"type":"text","text":"{...}"}]},"error":null,'
             '"status":"completed"}}')
    assert out == []


def test_a_refused_tool_call_says_so():
    """Recorded 2026-08-26: without the approval settings in command(), every
    MCP call comes back like this and the turn ends with an empty answer."""
    out = ev('{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call",'
             '"server":"persodub","tool":"get_script","arguments":{"job_id":"04caffe7"},'
             '"result":null,"error":{"message":"MCP tool call requires approval, '
             'but approval policy is never"},"status":"failed"}}')
    assert out[0]["kind"] == "error"
    assert "get_script" in out[0]["message"]
    assert "requires approval" in out[0]["message"]


def test_a_shell_command_is_reported_as_one_step():
    """Codex keeps a shell we cannot take away from it. The user should at
    least see that it went off to run something."""
    out = ev('{"type":"item.started","item":{"id":"item_1","type":"command_execution",'
             '"command":"/bin/zsh -lc \\"sed -n \'1,240p\' /tmp/x\\"",'
             '"aggregated_output":"","exit_code":null,"status":"in_progress"}}')
    assert out == [{"kind": "progress", "tool": "shell",
                    "label": "Running a command"}]


def test_turn_completed_ends_the_turn():
    out = ev('{"type":"turn.completed","usage":{"input_tokens":35079,'
             '"cached_input_tokens":34304,"output_tokens":100}}')
    assert out == [{"kind": "done", "text": ""}]


def test_a_failed_turn_is_an_error():
    out = ev('{"type":"turn.failed","error":{"message":"rate limit reached"}}')
    assert out[0]["kind"] == "error"
    assert "rate limit" in out[0]["message"]


def test_lines_we_do_not_recognise_are_ignored():
    assert ev('{"type":"item.updated","item":{"type":"todo_list"}}') == []
    assert ev('{"type":"something_new","whatever":1}') == []
    assert ev('{}') == []


# --- the command line -------------------------------------------------------

def _mcp_config(tmp_path):
    from app.agents.base import write_mcp_config
    return write_mcp_config(str(tmp_path), "http://127.0.0.1:8765")


def test_the_command_carries_our_mcp_server_and_leaves_the_user_config_alone(tmp_path):
    from app.agents.codex import command

    args = command("고쳐줘", _mcp_config(tmp_path), resume=False)
    assert args[0] == "exec"
    assert "--json" in args
    # The user's own ~/.codex/config.toml -- and every MCP server in it -- stays
    # out of this run. Ours is handed over on the command line instead.
    assert "--ignore-user-config" in args
    joined = " ".join(args)
    assert "mcp_servers.persodub.command=" in joined
    assert "app.mcp_server" in joined
    assert "PERSODUB_API" in joined
    assert args[-1].endswith("고쳐줘")


def test_the_command_lets_a_tool_call_through_without_anyone_to_ask(tmp_path):
    """Measured 2026-08-26: headless Codex refuses every MCP tool call unless a
    reviewer is named -- see openai/codex#24135. Without these three the panel
    runs, answers, and quietly changes nothing."""
    from app.agents.codex import command

    joined = " ".join(command("고쳐줘", _mcp_config(tmp_path), resume=False))
    assert 'approvals_reviewer="auto_review"' in joined
    assert 'approval_policy="on-request"' in joined
    assert 'sandbox_mode="workspace-write"' in joined


def test_the_command_keeps_the_users_skills_and_the_web_out(tmp_path):
    from app.agents.codex import command

    joined = " ".join(command("고쳐줘", _mcp_config(tmp_path), resume=False))
    assert "skills.include_instructions=false" in joined
    assert "tools.web_search=false" in joined


def test_the_assistant_is_told_what_it_is_for(tmp_path):
    """Codex has no --system-prompt, so the standing instructions ride in front
    of the question instead."""
    from app.agents.claude import SYSTEM_PROMPT
    from app.agents.codex import command

    args = command("고쳐줘", _mcp_config(tmp_path), resume=False)
    assert SYSTEM_PROMPT in args[-1]


def test_resuming_continues_the_same_conversation(tmp_path):
    """`--last` is filtered by working directory, and ours is the app's own
    agent folder -- so this can never pick up the user's own Codex session."""
    from app.agents.codex import command

    args = command("또", _mcp_config(tmp_path), resume=True)
    assert args[:4] == ["exec", "resume", "--last", "--json"]


def test_a_chosen_model_is_passed_on(tmp_path):
    from app.agents.codex import command

    args = command("고쳐줘", _mcp_config(tmp_path), resume=False, model="gpt-5.5")
    assert args[args.index("-m") + 1] == "gpt-5.5"
    assert "-m" not in command("고쳐줘", _mcp_config(tmp_path), resume=False)


def test_a_cli_that_reads_stdin_is_not_left_hanging(monkeypatch):
    """Codex reads stdin when nobody has closed it, and the app server's stdin
    is whatever started the app. Measured 2026-08-26: the very first headless
    run printed "Reading additional input from stdin..." and never returned."""
    import subprocess

    from app.agents import base

    seen = {}
    real = subprocess.Popen

    def spy(cmd, **kw):
        seen.update(kw)
        return real(cmd, **kw)

    monkeypatch.setattr(base.subprocess, "Popen", spy)
    monkeypatch.setattr(base, "TIMEOUT_SECONDS", 10.0)
    out = list(base.run("/bin/cat", [], lambda e: []))
    assert seen.get("stdin") == subprocess.DEVNULL
    assert [e["kind"] for e in out] == ["done"]


def test_the_environment_is_handed_over_as_a_toml_table(tmp_path):
    """A dict written the JSON way is refused: Codex answered the first real
    turn with `expected a map in mcp_servers.persodub.env` (2026-08-26)."""
    from app.agents.codex import command

    args = command("고쳐줘", _mcp_config(tmp_path), resume=False)
    env = next(a for a in args if a.startswith("mcp_servers.persodub.env="))
    assert '"PERSODUB_API" = "http://127.0.0.1:8765"' in env
    assert '"PERSODUB_API":' not in env  # the JSON form Codex refused
