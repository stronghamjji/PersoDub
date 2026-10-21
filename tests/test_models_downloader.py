"""The catalog's HF downloads run through app_venv's own interpreter -- the one
venv a light install always has. Until 0.5.1 it ran from qwen_venv, which is
gone; since issue #48 it runs `python -m huggingface_hub.cli.hf`, not the
hf(.exe) launcher app_venv also installs (an unsigned, freshly created file
Smart App Control or an antivirus can refuse to run -- same fix as
desktop/src/installSpec.js's models step)."""
import json
import logging
import os
import re
import sys
import threading
import time
import types

import pytest
import requests

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


def test_pull_hf_has_no_figure_before_the_first_byte(monkeypatch, tmp_path):
    # "Downloading… 0%" from the press on, held 4 s before the first percent,
    # read as stuck (Windows C2, 2026-10-21): no figure while nothing of the
    # model is on disk, and under 1% is 0 once something is.
    pieces = tmp_path / "models" / "melband-roformer" / ".cache" / "huggingface" / "download"

    class FakeProc:
        def __init__(self):
            # The tool's own first byte, there before it asks the server for anything.
            pieces.parent.mkdir(parents=True, exist_ok=True)
            (pieces.parent / ".gitignore").write_text("*")
            self.stdout = iter([])

        def wait(self):
            return 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    entry = {"id": "vocal-separator", "dir": "models/melband-roformer", "bytes": 1000,
             "source": {"kind": "hf", "repo": "KimberleyJSN/melbandroformer", "rev": "abc"}}
    pcts = []
    models_module._pull_hf(entry, str(tmp_path), pcts.append, lambda: False)
    assert pcts[-1] is None and 0 not in pcts, pcts
    pieces.mkdir(parents=True)
    (pieces / "a1b2c3.etag.incomplete").write_bytes(b"x" * 5)
    models_module._pull_hf(entry, str(tmp_path), pcts.append, lambda: False)
    assert pcts[-1] == 0, pcts


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


# ── The download's own lines (app/netlog.py): where from, where to, each
#    file, and how it ended -- the vocabulary the desktop shell writes too.

def _model_lines(caplog):
    return [(r.levelname, r.getMessage()) for r in caplog.records if r.name == "persodub.models"]


def test_a_hf_download_names_its_source_its_folder_and_every_file_it_holds(monkeypatch, tmp_path, caplog):
    dest = tmp_path / "models" / "whisper" / "x"

    class FakeProc:
        def __init__(self):
            (dest / ".cache" / "huggingface").mkdir(parents=True)
            (dest / ".cache" / "huggingface" / "config.json.metadata").write_bytes(b"m")
            (dest / "sub").mkdir()
            (dest / "config.json").write_bytes(b"c" * 2100)
            (dest / "sub" / "model.bin").write_bytes(b"w" * 3_100_000)
            self.stdout = iter(["100%"])

        def wait(self):
            return 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    rev = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
    entry = {"id": "whisper", "dir": "models/whisper/x",
             "source": {"kind": "hf", "repo": "Systran/faster-whisper-large-v3", "rev": rev}}
    with caplog.at_level(logging.INFO, logger="persodub.models"):
        models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    lines = [msg for _level, msg in _model_lines(caplog)]
    what, base = "hf Systran/faster-whisper-large-v3@edaa852", "https://huggingface.co/Systran/faster-whisper-large-v3"
    # The tool's own .cache folder is not the model's.
    assert lines[:3] == [
        f"DOWNLOAD START {what} from {base} to {dest}",
        f"DOWNLOAD FILE {what}: config.json 2.1 kB from {base}/resolve/{rev}/config.json",
        f"DOWNLOAD FILE {what}: sub/model.bin 3.1 MB from {base}/resolve/{rev}/sub/model.bin",
    ]
    assert re.fullmatch(rf"DOWNLOAD DONE {re.escape(what)}: 2 files, 3\.1 MB in \d+\.\ds( \(.+/s\))?, "
                        r"size checked by hf", lines[3])
    assert len(lines) == 4


def test_a_hf_download_that_fails_says_so_after_its_retry(monkeypatch, tmp_path, caplog):
    class FakeProc:
        def __init__(self):
            self.stdout = iter(["Read timed out."])

        def wait(self):
            return 1

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    monkeypatch.setattr(models_module, "HF_ATTEMPTS", 2)
    monkeypatch.setattr(time, "sleep", lambda s: None)
    # A mirror the hf tool is pointed at is where the lines say it came from.
    monkeypatch.setenv("HF_ENDPOINT", "https://hf-mirror.com/")
    entry = {"id": "qwen3-tts", "dir": "models/qwen3-tts", "source": {"kind": "hf", "repo": "Qwen/x", "rev": "abc"}}
    with caplog.at_level(logging.INFO, logger="persodub.models"), pytest.raises(RuntimeError):
        models_module._pull_hf(entry, str(tmp_path), lambda p: None, lambda: False)
    lines = _model_lines(caplog)
    assert lines[0] == (
        "INFO", f"DOWNLOAD START hf Qwen/x@abc from https://hf-mirror.com/Qwen/x to {tmp_path / 'models' / 'qwen3-tts'}")
    # The seconds since START, as the shell counts a RETRY's (desktop/src/installSpec.js).
    assert lines[1][0] == "WARNING"
    assert re.fullmatch(r"DOWNLOAD RETRY hf Qwen/x@abc \(2/2\) after \d+\.\ds: hf download exited 1: Read timed out\.",
                        lines[1][1])
    assert lines[2][0] == "ERROR"
    assert re.fullmatch(r"DOWNLOAD FAILED hf Qwen/x@abc after \d+\.\ds: RuntimeError: hf download exited 1: "
                        r"Read timed out\. \| Read timed out\. \(hf-mirror\.com\)", lines[2][1])
    assert len(lines) == 3


class _Pull:
    """Ollama's answer to /api/pull: a stream of status objects, one a line."""
    status_code = 200

    def __init__(self, *objects):
        self.objects = objects

    def raise_for_status(self):
        pass

    def iter_lines(self):
        for o in self.objects:
            yield json.dumps(o).encode()

    def close(self):
        pass


def _ollama(monkeypatch, answer):
    posted = []
    monkeypatch.setattr(models_module._requests, "post", lambda url, **kw: posted.append(url) or answer)
    monkeypatch.setattr(models_module._runtime, "url", lambda name: "http://127.0.0.1:11434")
    return posted


def test_an_ollama_pull_names_its_registry_each_layer_once_and_ollamas_own_check(monkeypatch, caplog):
    big, small = "sha256:aeda25e63ebd" + "0" * 52, "sha256:e0a42594d802" + "1" * 52
    posted = _ollama(monkeypatch, _Pull(
        {"status": "pulling manifest"},
        {"status": "pulling aeda25e63ebd", "digest": big, "total": 8_100_000_000},
        {"status": "pulling aeda25e63ebd", "digest": big, "total": 8_100_000_000, "completed": 8_100_000_000},
        {"status": "pulling aeda25e63ebd", "digest": big, "total": 8_100_000_000, "completed": 8_100_000_000},
        # Ollama's last word on a layer can fall short of its size: it is in
        # once Ollama has gone on to check them.
        {"status": "pulling e0a42594d802", "digest": small, "total": 358, "completed": 100},
        {"status": "verifying sha256 digest"}, {"status": "verifying sha256 digest"},
        {"status": "writing manifest"}, {"status": "success"}))
    entry = {"id": "gemma", "source": {"kind": "ollama", "tag": "gemma3:12b"}}
    with caplog.at_level(logging.INFO, logger="persodub.models"):
        models_module._pull_ollama(entry, lambda p: None, lambda: False)
    lines = [msg for _level, msg in _model_lines(caplog)]
    source = "https://registry.ollama.ai/library/gemma3:12b"
    assert lines[:-1] == [
        f"DOWNLOAD START ollama gemma3:12b from {source} via http://127.0.0.1:11434/api/pull",
        "DOWNLOAD CONNECTED ollama gemma3:12b: HTTP 200 from 127.0.0.1:11434, size unknown",
        f"DOWNLOAD FILE ollama gemma3:12b: layer aeda25e63ebd 8.1 GB from {source}",
        f"DOWNLOAD FILE ollama gemma3:12b: layer e0a42594d802 358 B from {source}",
        "DOWNLOAD ollama gemma3:12b: verifying sha256 digest",
        "DOWNLOAD ollama gemma3:12b: success",
    ]
    assert re.fullmatch(r"DOWNLOAD DONE ollama gemma3:12b: 2 files, 8\.1 GB in \d+\.\ds( \(.+/s\))?, "
                        r"sha256 checked by ollama", lines[-1])
    assert posted == ["http://127.0.0.1:11434/api/pull"]


def test_an_ollama_pull_has_no_figure_before_the_first_byte(monkeypatch):
    # No 0% while nothing has come (Windows C2, 2026-10-21); under 1% is 0 once it has.
    layer = "sha256:" + "a" * 64
    _ollama(monkeypatch, _Pull(
        {"status": "pulling manifest"},
        {"status": "pulling aaaaaaaaaaaa", "digest": layer, "total": 1000},
        {"status": "pulling aaaaaaaaaaaa", "digest": layer, "total": 1000, "completed": 0},
        {"status": "pulling aaaaaaaaaaaa", "digest": layer, "total": 1000, "completed": 5},
        {"status": "pulling aaaaaaaaaaaa", "digest": layer, "total": 1000, "completed": 500}))
    pcts = []
    models_module._pull_ollama({"id": "gemma", "source": {"kind": "ollama", "tag": "gemma3:12b"}},
                               pcts.append, lambda: False)
    assert pcts == [None, 0, 50]


def test_ollama_fetches_a_name_from_the_host_it_begins_with():
    assert models_module._ollama_source("gemma3:12b") == "https://registry.ollama.ai/library/gemma3:12b"
    assert models_module._ollama_source("someone/model:7b") == "https://registry.ollama.ai/someone/model:7b"
    assert models_module._ollama_source("hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M") == (
        "https://hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M")


def test_an_ollama_pull_that_fails_says_what_the_stream_or_the_answer_said(monkeypatch, caplog):
    entry = {"id": "hunyuan", "source": {"kind": "ollama", "pull": "hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M",
                                         "tag": "hy-mt2:1.8b"}}
    _ollama(monkeypatch, _Pull({"status": "pulling manifest"}, {"error": "pull model manifest: file does not exist"}))
    with caplog.at_level(logging.INFO, logger="persodub.models"), pytest.raises(RuntimeError):
        models_module._pull_ollama(entry, lambda p: None, lambda: False)
    level, msg = _model_lines(caplog)[-1]
    assert level == "ERROR"
    assert re.fullmatch(r"DOWNLOAD FAILED ollama hf\.co/tencent/Hy-MT2-1\.8B-GGUF:Q4_K_M after \d+\.\ds: "
                        r"RuntimeError: pull model manifest: file does not exist \(hf\.co\)", msg)

    class Refused(_Pull):
        status_code = 500

        def raise_for_status(self):
            raise requests.HTTPError("500 Server Error: Internal Server Error for url: http://127.0.0.1:11434/api/pull")

    caplog.clear()
    _ollama(monkeypatch, Refused())
    with caplog.at_level(logging.INFO, logger="persodub.models"), pytest.raises(requests.HTTPError):
        models_module._pull_ollama(entry, lambda p: None, lambda: False)
    lines = _model_lines(caplog)
    assert lines[1] == ("INFO", "DOWNLOAD CONNECTED ollama hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M: "
                                "HTTP 500 from 127.0.0.1:11434, size unknown")
    assert lines[2][0] == "ERROR" and " after " in lines[2][1] and lines[2][1].endswith(
        ": HTTPError: 500 Server Error: Internal Server Error for url: http://127.0.0.1:11434/api/pull (hf.co)")


def test_a_cancelled_hf_download_closes_its_start(monkeypatch, tmp_path, caplog):
    import app.agents.base as base
    monkeypatch.setattr(base, "_end", lambda proc: None)
    stop = threading.Event()

    class FakeProc:
        def __init__(self):
            def lines():
                stop.set()   # Cancel pressed while the tool runs
                yield "Fetching 3 files"
            self.stdout = lines()

        def wait(self):
            return 0

    monkeypatch.setattr(models_module._subprocess, "Popen", lambda argv, **kw: FakeProc())
    entry = {"id": "whisper", "dir": "models/whisper/x", "source": {"kind": "hf", "repo": "r/x", "rev": "abc"}}
    with caplog.at_level(logging.INFO, logger="persodub.models"):
        models_module._run_download(entry, str(tmp_path), lambda p: None, stop.is_set)
    lines = _model_lines(caplog)
    assert [level for level, _msg in lines] == ["INFO"] * 4
    assert lines[1][1].startswith("DOWNLOAD START hf r/x@abc from ")
    assert re.fullmatch(r"DOWNLOAD CANCELLED hf r/x@abc after \d+\.\ds", lines[2][1])
    assert re.fullmatch(r"MODEL whisper DOWNLOAD CANCELLED \(\d+\.\ds\)", lines[3][1])


def test_a_cancelled_ollama_pull_closes_its_start_whichever_way_it_stops(monkeypatch, caplog):
    stop = threading.Event()
    entry = {"id": "gemma", "source": {"kind": "ollama", "tag": "gemma3:12b"}}

    class Stopped(_Pull):
        def iter_lines(self):
            yield json.dumps({"status": "pulling manifest"}).encode()
            stop.set()
            yield json.dumps({"status": "pulling aeda25e63ebd", "digest": "sha256:" + "a" * 64, "total": 10}).encode()

    _ollama(monkeypatch, Stopped())
    with caplog.at_level(logging.INFO, logger="persodub.models"):
        models_module._pull_ollama(entry, lambda p: None, stop.is_set)
    level, msg = _model_lines(caplog)[-1]
    assert level == "INFO" and re.fullmatch(r"DOWNLOAD CANCELLED ollama gemma3:12b after \d+\.\ds", msg)

    # A cancel that broke the stream on its way out is a cancel, never a failure.
    class Broken(_Pull):
        def iter_lines(self):
            raise requests.ConnectionError("Connection aborted.")

    caplog.clear()
    _ollama(monkeypatch, Broken())
    with caplog.at_level(logging.INFO, logger="persodub.models"), pytest.raises(requests.ConnectionError):
        models_module._pull_ollama(entry, lambda p: None, stop.is_set)
    lines = _model_lines(caplog)
    assert [level for level, _msg in lines] == ["INFO"] * 3
    assert re.fullmatch(r"DOWNLOAD CANCELLED ollama gemma3:12b after \d+\.\ds", lines[-1][1])
