"""The ChatGPT translator: the sign-in program is the wire, the reply file is
the answer, and the two account states become their own errors."""
import os

import pytest

from app import engines_status, translate
from app.translate import ChatGptLimitError, ChatGptNotSignedInError, ChatGptTranslator

# Taken at collection time, before conftest's autouse fixture swaps it out.
_REAL_CHATGPT_AVAILABLE = engines_status.chatgpt_available


def _fake_run(reply=None, code=0, stderr="", stdout=""):
    """A subprocess.Popen stand-in that writes `reply` where -o points.
    Named for what it replaces in spirit: one CLI run. `.calls` keeps
    (argv, {"input": prompt, "env": env}) per run."""
    calls = []

    class _Proc:
        def __init__(self, cmd, **kw):
            self.args = cmd
            self.returncode = code
            self._kw = kw

        def communicate(self, input=None, timeout=None):
            calls.append((self.args, {"input": input, "env": self._kw.get("env")}))
            out = self.args[self.args.index("-o") + 1]
            if reply is not None:
                with open(out, "w", encoding="utf-8") as f:
                    f.write(reply)
            return stdout, stderr

    _Proc.calls = calls
    return _Proc


def test_registered_and_named():
    t = translate.get_translator("chatgpt")
    assert isinstance(t, ChatGptTranslator)
    assert t.display_name == "ChatGPT"
    assert t.max_budget_retries == 1


def test_asks_over_stdin_with_the_sandbox_flags(monkeypatch):
    run = _fake_run('["Hola", "Adiós"]')
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    t = ChatGptTranslator(binary="/bin/codex", model="gpt-test")
    assert t.translate(["안녕", "잘 가"], "Spanish", "Korean", [1.0, 1.0]) == ["Hola", "Adiós"]
    cmd, kw = run.calls[0]
    assert cmd[:2] == ["/bin/codex", "exec"]
    for flag in ("--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "-o"):
        assert flag in cmd
    assert cmd[cmd.index("--sandbox") + 1] == "read-only"
    assert cmd[cmd.index("-m") + 1] == "gpt-test"
    assert 'model_reasoning_effort="low"' in cmd
    assert cmd[cmd.index("--disable") + 1] == "shell_tool"
    assert cmd.count("--disable") == len(translate.CHATGPT_NO_TOOLS)
    assert cmd[-1] == "-"
    assert "exactly 2 strings" in kw["input"]
    assert "안녕" in kw["input"]


def test_no_model_flag_when_none_configured(monkeypatch):
    run = _fake_run('["Hola"]')
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")
    assert "-m" not in run.calls[0][0]


def test_signed_out_is_its_own_error(monkeypatch):
    run = _fake_run(None, code=1, stderr="Error: not logged in. Please run `codex login`.")
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    with pytest.raises(ChatGptNotSignedInError):
        ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")


def test_usage_limit_is_its_own_error(monkeypatch):
    run = _fake_run(None, code=1, stderr="ERROR: You've hit your usage limit. Try again at 6pm.")
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    with pytest.raises(ChatGptLimitError):
        ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")


def test_missing_program_reads_as_signed_out():
    with pytest.raises(ChatGptNotSignedInError):
        ChatGptTranslator(binary="", model="").translate(["안녕"], "Spanish")


def test_other_failure_quotes_the_last_line(monkeypatch):
    run = _fake_run(None, code=2, stderr="something\nerror: stream disconnected before completion")
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    with pytest.raises(RuntimeError) as e:
        ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")
    assert "stream disconnected" in str(e.value)
    assert not isinstance(e.value, (ChatGptLimitError, ChatGptNotSignedInError))


def test_stage_turns_signed_out_into_a_notice(tmp_path, monkeypatch):
    from app import pipeline

    run = _fake_run(None, code=1, stderr="Error: not logged in")
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    monkeypatch.setattr(translate, "TRANSLATORS",
                        dict(translate.TRANSLATORS, chatgpt=lambda: ChatGptTranslator(binary="/bin/codex", model="")))
    notices, logs = [], []
    cues = [{"start": 0.0, "end": 1.5, "text": "안녕하세요"}]
    with pytest.raises(RuntimeError):
        pipeline._stage_translate(None, cues, "Spanish", "chatgpt", None, str(tmp_path),
                                  notices.append, logs.append)
    assert notices and notices[-1]["type"] == "chatgpt_signed_out"


def test_find_cli_walks_extra_paths_with_platform_suffixes(tmp_path, monkeypatch):
    from app.agents import base

    exe = tmp_path / "codex.exe"
    exe.write_text("")
    exe.chmod(0o755)
    monkeypatch.setattr(base.shutil, "which", lambda name: None)
    monkeypatch.setattr(base, "EXTRA_PATHS", ["", str(tmp_path)])
    monkeypatch.setattr(base, "_SUFFIXES", ("", ".exe", ".cmd"))
    assert base.find_cli("codex") == str(exe)
    monkeypatch.setattr(base, "_SUFFIXES", ("",))
    assert base.find_cli("codex") is None


def test_default_model_is_chatgpts_own_not_codex_config(monkeypatch):
    monkeypatch.delenv("PERSODUB_CHATGPT_MODEL", raising=False)
    t = ChatGptTranslator(binary="/bin/codex")
    assert t.model == translate.CHATGPT_DEFAULT_MODEL == "gpt-5.6-luna"
    monkeypatch.setenv("PERSODUB_CHATGPT_MODEL", "gpt-6-luna")
    assert ChatGptTranslator(binary="/bin/codex").model == "gpt-6-luna"


def test_chatgpt_available_needs_the_program_and_a_sign_in(monkeypatch):
    from app.agents import base

    monkeypatch.setattr(base, "find_cli", lambda name: None)
    assert _REAL_CHATGPT_AVAILABLE() is False
    monkeypatch.setattr(base, "find_cli", lambda name: "/bin/codex")
    # Cannot tell yet: the dub is let run (a real sign-out stops it at
    # translation with its own notice).
    monkeypatch.setattr(base, "login_state", lambda kind, binary, env=None: {"logged_in": None, "account": ""})
    assert _REAL_CHATGPT_AVAILABLE() is True
    monkeypatch.setattr(base, "login_state", lambda kind, binary, env=None: {"logged_in": False, "account": ""})
    assert _REAL_CHATGPT_AVAILABLE() is False
    monkeypatch.setattr(base, "login_state", lambda kind, binary, env=None: {"logged_in": True, "account": "ChatGPT"})
    assert _REAL_CHATGPT_AVAILABLE() is True


def test_codex_command_names_a_model_only_when_given(tmp_path):
    import json

    from app.agents import codex

    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"mcpServers": {"persodub": {"command": "x", "args": [], "env": {}}}}))
    plain = codex.command(str(cfg), resume=False)
    assert not any(a.startswith("model=") for a in plain)
    named = codex.command(str(cfg), resume=False, model="gpt-5.6-luna")
    assert 'model="gpt-5.6-luna"' in named


def test_the_videos_own_words_are_not_an_account_state(monkeypatch):
    """The CLI echoes the prompt; a line of dialogue about a usage limit is
    not ChatGPT's limit, and never reaches the error message."""
    run = _fake_run(None, code=1, stderr="user\n1. You've hit your usage limit, unauthorized!\n")
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    with pytest.raises(RuntimeError) as e:
        ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")
    assert not isinstance(e.value, (ChatGptLimitError, ChatGptNotSignedInError))
    assert "usage limit" not in str(e.value)


def test_a_reply_on_stdout_is_used_when_the_file_is_empty(monkeypatch):
    monkeypatch.setattr(translate.subprocess, "Popen", _fake_run("", code=0, stdout='["Hola"]'))
    assert ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish") == ["Hola"]


def test_runs_in_its_own_openai_home(monkeypatch, tmp_path):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    run = _fake_run('["Hola"]')
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    ChatGptTranslator(binary="/bin/codex", model="").translate(["안녕"], "Spanish")
    assert run.calls[0][1]["env"]["CODEX_HOME"] == str(tmp_path / "chatgpt")


def test_a_bad_model_name_from_the_environment_is_ignored(monkeypatch):
    monkeypatch.setenv("PERSODUB_CHATGPT_MODEL", "x & calc")
    assert ChatGptTranslator(binary="/bin/codex").model == translate.CHATGPT_DEFAULT_MODEL


def test_a_resumed_job_reuses_answers_it_already_got(tmp_path, monkeypatch):
    # First run: ChatGPT answers, and the answer is kept in the job folder.
    run = _fake_run('["Hola", "Adiós"]')
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    first = ChatGptTranslator(binary="/bin/codex", model="gpt-test")
    first.answers_dir = str(tmp_path / "chatgpt_answers")
    assert first.translate(["안녕", "잘 가"], "Spanish", "Korean", [1.0, 1.0]) == ["Hola", "Adiós"]
    assert len(run.calls) == 1

    # Resume: the same question is answered from the folder, ChatGPT is not asked.
    again = _fake_run('["WRONG", "WRONG"]')
    monkeypatch.setattr(translate.subprocess, "Popen", again)
    second = ChatGptTranslator(binary="/bin/codex", model="gpt-test")
    second.answers_dir = first.answers_dir
    assert second.translate(["안녕", "잘 가"], "Spanish", "Korean", [1.0, 1.0]) == ["Hola", "Adiós"]
    assert again.calls == []


def test_a_failed_ask_keeps_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(translate.subprocess, "Popen",
                        _fake_run(code=1, stderr="ERROR: You've hit your usage limit."))
    t = ChatGptTranslator(binary="/bin/codex", model="gpt-test")
    t.answers_dir = str(tmp_path / "chatgpt_answers")
    with pytest.raises(ChatGptLimitError):
        t.translate(["안녕"], "Spanish")
    assert not os.path.exists(t.answers_dir) or os.listdir(t.answers_dir) == []


def test_a_cancel_stops_the_translation_before_the_next_request(tmp_path, monkeypatch):
    # A cancel during 3/6 kept asking ChatGPT for 2.5 minutes -- 8 requests off
    # the user's allowance (Windows 2026-09-25). Now the next ask checks first.
    from app import pipeline
    from app.jobs import JobCancelled

    run = _fake_run('["Hola"]')
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    monkeypatch.setattr(translate, "TRANSLATORS",
                        dict(translate.TRANSLATORS, chatgpt=lambda: ChatGptTranslator(binary="/bin/codex", model="")))
    asked = []
    def cancelled():        # cancelled the moment one request has gone out
        return bool(run.calls)
    cues = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": "안녕하세요 %d" % i} for i in range(40)]
    logs = []
    with pytest.raises(JobCancelled):
        pipeline._stage_translate(None, cues, "Spanish", "chatgpt", None, str(tmp_path),
                                  asked.append, logs.append, cancel_check=cancelled)
    assert len(run.calls) == 1
    assert "Cancelled by user request" in logs


def _answering(line):
    """A Popen stand-in that answers every prompt with `line`, in the shape the
    prompt asks for (one string per line, or 3 candidates per line)."""
    import re as _re
    calls = []

    class _Proc:
        def __init__(self, cmd, **kw):
            self.args, self.returncode = cmd, 0

        def communicate(self, input=None, timeout=None):
            calls.append(input)
            n = int((_re.search(r"exactly (\d+)", input) or _re.search(r"of (\d+) items", input)).group(1))
            one = [line] * 3 if "3 DIFFERENT candidate" in input else line
            import json as _json
            with open(self.args[self.args.index("-o") + 1], "w", encoding="utf-8") as f:
                f.write(_json.dumps([one] * n, ensure_ascii=False))
            return "", ""

    _Proc.calls = calls
    return _Proc


def test_chatgpts_english_product_name_is_kept_as_written(tmp_path, monkeypatch):
    # "Claude" stays in Latin letters: ChatGPT's wording stands, it is not
    # re-asked twice and no "needs review" warning is written (user, 2026-09-25).
    from app import pipeline
    line = "구글 클라우드의 Claude로 앱을 만들어요."
    run = _answering(line)
    monkeypatch.setattr(translate.subprocess, "Popen", run)
    logs = []
    cues = [{"start": 0.0, "end": 3.0, "text": "Build an app with Claude on Google Cloud."}]
    srt = pipeline._auto_translate_srt(cues, "Korean", ChatGptTranslator(binary="/bin/codex", model=""),
                                       str(tmp_path), log=logs.append)
    assert "Claude" in open(srt, encoding="utf-8-sig").read()
    assert not any("not in the target language" in l for l in logs)
    assert any("as the translator wrote them" in l for l in logs)


def test_a_local_translator_is_still_asked_again_for_the_wrong_script():
    assert ChatGptTranslator.recheck_script is False
    assert translate.OllamaTranslator.recheck_script is True
    assert translate.GeminiTranslator.recheck_script is True
