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
from app.run_errors import PartsMissing


def _write_output(out_dir, payload):
    with open(os.path.join(out_dir, "sep_output.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)


# --- SeparationEngine.separate ----------------------------------------------

def test_separate_raises_when_interpreter_missing(tmp_path):
    engine = sep.SeparationEngine(python_path="/no/such/python")
    # Its own kind: the advice is to download it again, not to check the video.
    with pytest.raises(PartsMissing, match="interpreter not found"):
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
    with pytest.raises(PartsMissing, match="script missing"):
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


# --- the RoFormer: used when its weights are downloaded, Demucs otherwise ----

def _capture_run(tmp_path, seen):
    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout, **_kw):
        seen["script"] = cmd[1]
        seen["timeout"] = timeout
        with open(cmd[cmd.index("--input") + 1], encoding="utf-8") as f:
            seen["payload"] = json.load(f)
        _write_output(str(tmp_path), {"ok": True, "vocals": "v.wav", "background": "b.wav"})
        return _R()
    return fake_run


def _kit_with_roformer(kit, monkeypatch):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    weights = kit / "models" / "melband-roformer" / "MelBandRoformer.ckpt"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")
    return weights


def test_the_roformer_separates_when_its_weights_are_downloaded(monkeypatch, tmp_path):
    import sys
    weights = _kit_with_roformer(tmp_path / "kit", monkeypatch)
    seen = {}
    monkeypatch.setattr(sep.subprocess, "run", _capture_run(tmp_path, seen))
    engine = sep.SeparationEngine(python_path=sys.executable)
    engine.separate("/fake/video.mp4", str(tmp_path))
    assert engine.name == "RoFormer"
    assert seen["script"] == sep.ROFORMER_SCRIPT_PATH
    assert seen["payload"]["model_path"] == str(weights)


def test_demucs_separates_while_the_roformer_is_not_downloaded(monkeypatch, tmp_path):
    import sys
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path / "kit"))
    seen = {}
    monkeypatch.setattr(sep.subprocess, "run", _capture_run(tmp_path, seen))
    engine = sep.SeparationEngine(python_path=sys.executable)
    engine.separate("/fake/video.mp4", str(tmp_path))
    assert engine.name == "Demucs"
    assert seen["script"] == sep.SCRIPT_PATH
    assert "model_path" not in seen["payload"]


def test_a_dub_that_chose_demucs_gets_demucs_with_the_roformer_downloaded(monkeypatch, tmp_path):
    # Advanced options offers the two apart: the one picked is the one that runs.
    import sys
    _kit_with_roformer(tmp_path / "kit", monkeypatch)
    seen = {}
    monkeypatch.setattr(sep.subprocess, "run", _capture_run(tmp_path, seen))
    engine = sep.SeparationEngine(python_path=sys.executable, roformer=False)
    engine.separate("/fake/video.mp4", str(tmp_path))
    assert engine.name == "Demucs"
    assert seen["script"] == sep.SCRIPT_PATH


def test_a_dub_that_chose_the_roformer_never_gets_demucs_in_its_place(monkeypatch, tmp_path):
    import sys
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path / "kit"))
    monkeypatch.setattr(sep.subprocess, "run", lambda *a, **k: pytest.fail("nothing may run"))
    engine = sep.SeparationEngine(python_path=sys.executable, roformer=True)
    assert engine.name == "RoFormer"
    with pytest.raises(sep.PartsMissing):
        engine.separate("/fake/video.mp4", str(tmp_path))


def test_half_downloaded_roformer_weights_are_not_used(monkeypatch, tmp_path):
    weights = _kit_with_roformer(tmp_path / "kit", monkeypatch)
    weights.write_bytes(b"")   # a cancelled download leaves the file empty
    assert sep.roformer_model_path() is None


def test_the_roformer_gets_a_longer_ceiling_than_demucs(tmp_path):
    demucs = sep.SeparationEngine(video_duration=600.0)
    roformer = sep.SeparationEngine(video_duration=600.0, roformer_path=str(tmp_path / "w.ckpt"))
    assert roformer.timeout == demucs.timeout * sep.ROFORMER_SLOWER
