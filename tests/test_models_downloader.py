"""The catalog's HF downloads run the `hf` CLI from app_venv -- the one venv a
light install always has. Until 0.5.1 it ran from qwen_venv, which is gone."""
import os
import sys

from app import models as models_module


def test_hf_cli_lives_in_app_venv():
    path = models_module._hf_cli("/kit")
    parts = path.replace("\\", "/").split("/")
    assert "app_venv" in parts
    assert "qwen_venv" not in parts
    assert parts[-1] == ("hf.exe" if sys.platform == "win32" else "hf")


def test_pull_hf_invokes_the_app_venv_cli(monkeypatch, tmp_path):
    seen = {}

    class FakeProc:
        stdout = iter(["  50%", " 100%"])

        def wait(self):
            return 0

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        return FakeProc()

    monkeypatch.setattr(models_module._subprocess, "Popen", fake_popen)
    entry = {"dir": "models/demucs/HTDemucs",
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc",
                        "files": ["htdemucs.yaml"]}}
    pcts = []
    models_module._pull_hf(entry, str(tmp_path), pcts.append, lambda: False)
    assert seen["argv"][0] == models_module._hf_cli(str(tmp_path))
    assert seen["argv"][-2:] == ["--local-dir", os.path.join(str(tmp_path), "models", "demucs", "HTDemucs")]


def test_pull_hf_reports_what_is_on_disk_not_the_tools_file_count(monkeypatch, tmp_path):
    # "Fetching 13 files: 92%" read as 92% while a third of the bytes had
    # arrived (Windows, 2026-09-07): the percent is disk bytes over the
    # catalog's size, .incomplete pieces included.
    dest = tmp_path / "models" / "demucs" / "HTDemucs"
    dest.mkdir(parents=True)

    class FakeProc:
        def __init__(self):
            def lines():
                yield "Fetching 2 files: 50%"
                (dest / "955717e8.safetensors.incomplete").write_bytes(b"x" * 500)
                yield "Fetching 2 files: 100%"
            self.stdout = lines()

        def wait(self):
            return 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    entry = {"id": "demucs", "dir": "models/demucs/HTDemucs", "bytes": 1000,
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc"}}
    pcts = []
    models_module._pull_hf(entry, str(tmp_path), pcts.append, lambda: False)
    assert pcts[-1] == 50, pcts
    assert 92 not in pcts


def test_pull_hf_tries_again_after_a_failed_run_and_ends_the_tool_on_our_own_error(monkeypatch, tmp_path):
    runs = {"n": 0}
    ended = []

    class FakeProc:
        def __init__(self):
            runs["n"] += 1
            self.stdout = iter(["Read timed out."] if runs["n"] == 1 else ["done"])

        def wait(self):
            return 1 if runs["n"] == 1 else 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    monkeypatch.setattr(models_module, "HF_ATTEMPTS", 2)
    import time
    monkeypatch.setattr(time, "sleep", lambda s: None)
    entry = {"id": "demucs", "dir": "models/demucs/HTDemucs", "bytes": 10,
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc"}}
    models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    assert runs["n"] == 2, "the second run succeeded, so no error"

    # Our own exception (the reader dying) must not leave the tool running.
    import app.agents.base as base
    monkeypatch.setattr(base, "_end", lambda proc: ended.append(proc))

    class Boom:
        stdout = iter([])

        def wait(self):
            raise ValueError("reader died")

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: Boom())
    import pytest
    with pytest.raises(ValueError):
        models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    assert len(ended) == 1


def test_a_failed_hf_download_carries_the_tools_last_words(monkeypatch, tmp_path):
    # "hf download exited 1" alone told nothing on Windows (2026-09-07); the
    # tool's own last lines are what a person can act on.
    class FakeProc:
        stdout = iter(["Fetching 3 files", "  10%",
                       "OSError: [WinError 1314] A required privilege is not held by the client"])

        def wait(self):
            return 1

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    entry = {"id": "qwen3-tts", "dir": "models/qwen3-tts",
             "source": {"kind": "hf", "repo": "Qwen/x", "rev": "abc"}}
    import pytest
    with pytest.raises(RuntimeError) as e:
        models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    assert "hf download exited 1: " in str(e.value)
    assert "WinError 1314" in str(e.value)
