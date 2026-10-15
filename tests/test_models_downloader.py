"""The catalog's HF downloads run through app_venv's own interpreter -- the one
venv a light install always has. Until 0.5.1 it ran from qwen_venv, which is
gone; since issue #48 it runs `python -m huggingface_hub.cli.hf`, not the
hf(.exe) launcher app_venv also installs (an unsigned, freshly created file
Smart App Control or an antivirus can refuse to run -- same fix as
desktop/src/installSpec.js's models step)."""
import logging
import os
import re
import sys
import types

from app import models as models_module


def test_venv_python_lives_in_app_venv():
    path = models_module._venv_python("/kit")
    parts = path.replace("\\", "/").split("/")
    assert "app_venv" in parts
    assert "qwen_venv" not in parts
    assert parts[-1] == ("python.exe" if sys.platform == "win32" else "python")


def test_pull_hf_invokes_the_app_venv_interpreter_as_a_module(monkeypatch, tmp_path):
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
    assert seen["argv"][0] == models_module._venv_python(str(tmp_path))
    assert seen["argv"][1:4] == ["-m", "huggingface_hub.cli.hf", "download"]
    assert seen["argv"][-2:] == ["--local-dir", os.path.join(str(tmp_path), "models", "demucs", "HTDemucs")]


def test_a_model_download_is_written_between_start_and_done(monkeypatch, tmp_path, caplog):
    # The app log says when a download began and how long it took, whichever
    # way it ended (persodub.log goes with a failure report).
    class FakeProc:
        stdout = iter(["100%"])

        def wait(self):
            return 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    entry = {"id": "demucs", "dir": "models/demucs/HTDemucs",
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc"}}
    with caplog.at_level(logging.INFO, logger="persodub.models"):
        models_module._run_download(entry, str(tmp_path), lambda p: None, lambda: False)
    lines = [r.getMessage() for r in caplog.records if r.name == "persodub.models"]
    assert lines[0] == "MODEL demucs DOWNLOAD START (hf)"
    assert re.fullmatch(r"MODEL demucs DOWNLOAD DONE \(\d+\.\ds\)", lines[-1])


def test_pull_hf_never_regresses_to_the_unsigned_hf_launcher(monkeypatch, tmp_path):
    # A future edit could accidentally restore the hf(.exe) launcher as
    # argv[0] -- that is exactly the unsigned-launcher path issue #48 moved
    # away from, so guard it on its own (mirrors installSpec.test.mjs).
    seen = {}

    class FakeProc:
        stdout = iter(["100%"])

        def wait(self):
            return 0

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        return FakeProc()

    monkeypatch.setattr(models_module._subprocess, "Popen", fake_popen)
    entry = {"dir": "models/demucs/HTDemucs",
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc",
                        "files": ["htdemucs.yaml"]}}
    models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    bindir = "Scripts" if sys.platform == "win32" else "bin"
    hf_launcher = os.path.join(str(tmp_path), "app_venv", bindir, "hf.exe" if sys.platform == "win32" else "hf")
    assert seen["argv"][0] != hf_launcher


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
    monkeypatch.setattr(models_module, "HF_ATTEMPTS", 1)   # the error text, not the retries, is under test
    entry = {"id": "qwen3-tts", "dir": "models/qwen3-tts",
             "source": {"kind": "hf", "repo": "Qwen/x", "rev": "abc"}}
    import pytest
    with pytest.raises(RuntimeError) as e:
        models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    assert "hf download exited 1: " in str(e.value)
    assert "WinError 1314" in str(e.value)


def test_a_cancel_stops_a_tool_that_prints_nothing(monkeypatch, tmp_path):
    # Without a terminal the hf tool prints almost nothing while a file streams
    # in, and a cancel heard only between its lines left the download running
    # to the end (Windows test C3, 2026-10-10). The meter's clock hears it too.
    import subprocess
    import time
    real_popen = subprocess.Popen
    started = []

    def silent(argv, **kw):
        started.append(real_popen([sys.executable, "-c", "import time; time.sleep(8)"], **kw))
        return started[-1]

    # models.py's own Popen only: swapping subprocess.Popen itself also caught the
    # taskkill that app/agents/base._end stops the tree with on Windows, so there
    # the cancel waited out the fake tool (Windows tests, 2026-10-12).
    monkeypatch.setattr(models_module, "_subprocess", types.SimpleNamespace(
        Popen=silent, PIPE=subprocess.PIPE, STDOUT=subprocess.STDOUT))
    entry = {"id": "whisper", "dir": "models/whisper/x", "bytes": 1000,
             "source": {"kind": "hf", "repo": "r/x", "rev": "abc"}}
    t0 = time.monotonic()
    models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: time.monotonic() - t0 > 0.3)
    assert time.monotonic() - t0 < 5, "the cancel waited for the tool to finish"
    assert started[0].poll() is not None, "the tool was left downloading"
