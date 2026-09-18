"""app/separate.py: subprocess bridge to the local Demucs separator (the app's
only separation path -- no container, no fallback).

All subprocess.run calls are monkeypatched (no real interpreter, no GPU, no
network). Any failure raises RuntimeError; app/pipeline.py catches it at the
call site and fails the whole dub job rather than falling back to anything.
"""
import json
import os

import pytest

from app import separate as sep


def _write_output(out_dir, payload):
    with open(os.path.join(out_dir, "sep_output.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)


# --- SeparationEngine.separate ----------------------------------------------

def test_separate_raises_when_interpreter_missing(tmp_path):
    engine = sep.SeparationEngine(python_path="/no/such/python")
    with pytest.raises(RuntimeError, match="interpreter not found"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_resolves_bare_command_via_path(monkeypatch, tmp_path):
    # The SEP_PYTHON default is the bare command "python3" -- it must be
    # resolved via PATH (shutil.which), not rejected by the exists() check.
    import sys

    monkeypatch.setattr(sep.shutil, "which", lambda name: sys.executable if name == "python3" else None)

    class _R:
        returncode = 1
        stderr = "boom"

    monkeypatch.setattr(sep.subprocess, "run", lambda *a, **k: _R())
    engine = sep.SeparationEngine(python_path="python3")
    # Gets past the interpreter check and fails later at the (fake) subprocess.
    with pytest.raises(RuntimeError, match="exited with an error"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_raises_when_script_missing(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(sep, "SCRIPT_PATH", "/no/such/script.py")
    engine = sep.SeparationEngine(python_path=sys.executable)
    with pytest.raises(RuntimeError, match="script missing"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_raises_on_nonzero_exit(monkeypatch, tmp_path):
    import sys

    class _R:
        returncode = 1
        stderr = "boom"

    monkeypatch.setattr(sep.subprocess, "run", lambda *a, **k: _R())
    engine = sep.SeparationEngine(python_path=sys.executable)
    with pytest.raises(RuntimeError, match="exited with an error"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_raises_on_subprocess_exception(monkeypatch, tmp_path):
    import sys

    def boom(*a, **k):
        raise OSError("no such file")

    monkeypatch.setattr(sep.subprocess, "run", boom)
    engine = sep.SeparationEngine(python_path=sys.executable)
    with pytest.raises(RuntimeError, match="failed to start"):
        engine.separate("/fake/video.mp4", str(tmp_path))


# The failure of 2026-09-11..15: eleven separations gave up at the 900-second
# limit and every report said only "failed to run (Command '['C:\\Users\\...".
# TimeoutExpired writes the whole command line before the reason, so the
# reason has to be said first or it does not survive the trip.
def test_separate_says_it_timed_out_before_anything_else(monkeypatch, tmp_path):
    import sys

    long_command = [r"C:\Users\someone\AppData\Local\PersoDub\engines_venv\Scripts\python.exe",
                    r"C:\Users\someone\AppData\Local\PersoDub\app\scripts\demucs_separate.py"]

    def boom(*a, **k):
        raise sep.subprocess.TimeoutExpired(cmd=long_command, timeout=900)

    monkeypatch.setattr(sep.subprocess, "run", boom)
    engine = sep.SeparationEngine(python_path=sys.executable, timeout=900)
    with pytest.raises(RuntimeError) as caught:
        engine.separate("/fake/video.mp4", str(tmp_path))
    said = str(caught.value)
    assert "timed out after 900 seconds" in said
    assert said.index("timed out") < 40, said
    assert "python.exe" not in said, said


def test_separate_raises_when_script_reports_failure(monkeypatch, tmp_path):
    import sys

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout, **_kw):
        _write_output(str(tmp_path), {"ok": False, "error": "weights not found"})
        return _R()

    monkeypatch.setattr(sep.subprocess, "run", fake_run)
    engine = sep.SeparationEngine(python_path=sys.executable)
    with pytest.raises(RuntimeError, match="reported an error"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_raises_on_invalid_json_output(monkeypatch, tmp_path):
    import sys

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout, **_kw):
        with open(os.path.join(str(tmp_path), "sep_output.json"), "w") as f:
            f.write("{not json")
        return _R()

    monkeypatch.setattr(sep.subprocess, "run", fake_run)
    engine = sep.SeparationEngine(python_path=sys.executable)
    with pytest.raises(RuntimeError, match="invalid output"):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_separate_returns_paths_on_success(monkeypatch, tmp_path):
    import sys

    class _R:
        returncode = 0
        stderr = ""

    captured_input = {}

    def fake_run(cmd, capture_output, text, timeout, **_kw):
        with open(cmd[cmd.index("--input") + 1], encoding="utf-8") as f:
            captured_input.update(json.load(f))
        _write_output(str(tmp_path), {
            "ok": True,
            "vocals": str(tmp_path / "vocals.wav"),
            "background": str(tmp_path / "background.wav"),
        })
        return _R()

    monkeypatch.setattr(sep.subprocess, "run", fake_run)
    engine = sep.SeparationEngine(python_path=sys.executable, model_dir="/fake/model_dir")
    result = engine.separate("/fake/video.mp4", str(tmp_path))

    assert result == {
        "vocals": str(tmp_path / "vocals.wav"),
        "background": str(tmp_path / "background.wav"),
    }
    assert captured_input["input"] == "/fake/video.mp4"
    assert captured_input["out_dir"] == str(tmp_path)
    assert captured_input["model_dir"] == "/fake/model_dir"


# --- timeout scales with the video's length (long videos used to die on a
# fixed 900s wall regardless of how long the video actually was). The formula
# itself is tested once, shared, in tests/test_timeouts.py -- this is just the
# wiring: SeparationEngine's computed timeout must actually reach subprocess.run.

def test_separation_engine_keeps_default_timeout_without_video_duration():
    # Existing callers that never pass video_duration must see no change.
    assert sep.SeparationEngine().timeout == 900


def test_separate_passes_computed_timeout_to_subprocess_run(monkeypatch, tmp_path):
    import sys

    from app import timeouts

    class _R:
        returncode = 0
        stderr = ""

    captured = {}

    def fake_run(cmd, capture_output, text, timeout, **_kw):
        captured["timeout"] = timeout
        _write_output(str(tmp_path), {
            "ok": True, "vocals": "v.wav", "background": "b.wav",
        })
        return _R()

    monkeypatch.setattr(sep.subprocess, "run", fake_run)
    monkeypatch.setattr(timeouts, "PERSODUB_TIMEOUT_PER_SEC", 10.0)
    monkeypatch.setattr(timeouts, "PERSODUB_TIMEOUT_CAP", 100000.0)
    engine = sep.SeparationEngine(python_path=sys.executable, video_duration=600.0)  # 10 min
    engine.separate("/fake/video.mp4", str(tmp_path))

    assert captured["timeout"] == 6000.0
