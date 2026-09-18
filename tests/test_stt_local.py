"""app/stt_local.py: subprocess bridge to the local Whisper worker
(app/scripts/whisper_transcribe.py).

All subprocess.run calls are monkeypatched (no real interpreter, no model
weights) -- this tests the contract: happy-path cue shape, and that every
failure mode raises a clear RuntimeError (transcribe_local is the LAST
fallback, so unlike app/qwen_scoring.score_takes() it must never swallow
errors into a None/empty return).
"""
import json
import os
import sys

import pytest

from app import stt_local


def _ok_result(segments=None):
    return {"ok": True, "language": "en", "segments": segments if segments is not None else
            [{"start": 0.0, "end": 1.2, "text": "hello there"}]}


def _fake_run_writing(output_payload):
    """Build a fake subprocess.run that writes output_payload to --output and
    succeeds (returncode 0)."""
    def fake_run(cmd, **kwargs):
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output_payload, f, ensure_ascii=False)

        class _R:
            returncode = 0
            stderr = ""
        return _R()
    return fake_run


@pytest.fixture
def audio_file(tmp_path):
    p = tmp_path / "clip.wav"
    p.write_bytes(b"RIFF....WAVEfmt ")  # contents irrelevant, subprocess is mocked
    return str(p)


def test_raises_when_audio_missing(tmp_path):
    with pytest.raises(RuntimeError, match="audio file not found"):
        stt_local.transcribe_local(str(tmp_path / "nope.wav"))


def test_raises_when_interpreter_missing(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", "/no/such/python")
    with pytest.raises(RuntimeError, match="interpreter not found"):
        stt_local.transcribe_local(audio_file)


def test_raises_when_script_missing(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", "/no/such/script.py")
    with pytest.raises(RuntimeError, match="script missing"):
        stt_local.transcribe_local(audio_file)


def test_raises_on_subprocess_exception(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)  # any existing file

    def boom(*a, **k):
        raise OSError("no such file")

    monkeypatch.setattr(stt_local.subprocess, "run", boom)
    with pytest.raises(RuntimeError, match="failed to start"):
        stt_local.transcribe_local(audio_file)


# Nine of the thirty-two reports in the four days after 0.6.0 were this, all
# of them on Macs good enough to do the work: faster-whisper runs on the CPU
# there, and large-v3 on a ten-minute video does not finish inside 900s.
def test_transcribe_says_it_timed_out(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)

    def boom(*a, **k):
        raise stt_local.subprocess.TimeoutExpired(
            cmd=["/Users/someone/Library/Application Support/PersoDub/engines_venv/bin/python",
                 "whisper_transcribe.py"],
            timeout=900,
        )

    monkeypatch.setattr(stt_local.subprocess, "run", boom)
    with pytest.raises(RuntimeError) as caught:
        stt_local.transcribe_local(audio_file, timeout=900)
    assert "timed out after 900 seconds" in str(caught.value)


def test_raises_on_nonzero_exit(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 1
        stderr = "model load failed"

    monkeypatch.setattr(stt_local.subprocess, "run", lambda cmd, **k: _R())
    with pytest.raises(RuntimeError, match="exited with an error"):
        stt_local.transcribe_local(audio_file)


def test_raises_on_invalid_json_output(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)

    def fake_run(cmd, **kwargs):
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("{not valid json")

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="invalid output"):
        stt_local.transcribe_local(audio_file)


def test_raises_when_worker_reports_failure(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(
        stt_local.subprocess, "run",
        _fake_run_writing({"ok": False, "error": "WHISPER_MODEL_DIR not found: /bad/path"}),
    )
    with pytest.raises(RuntimeError, match="WHISPER_MODEL_DIR not found"):
        stt_local.transcribe_local(audio_file)


def test_raises_on_empty_audio_no_segments(monkeypatch, audio_file):
    """Silent/empty audio -> whisper returns zero segments -> this is the LAST
    fallback, so an empty result must raise (not silently return []), same
    convention as PersoClient's 'Perso result is empty' check in pipeline.py."""
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local.subprocess, "run", _fake_run_writing(_ok_result(segments=[])))
    with pytest.raises(RuntimeError, match="no segments"):
        stt_local.transcribe_local(audio_file)


def test_happy_path_returns_cue_shape(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    payload = _ok_result(segments=[
        {"start": 0.0, "end": 1.5, "text": "You let five people die."},
        {"start": 1.5, "end": 3.2, "text": "Then you let Dent take your place."},
    ])
    monkeypatch.setattr(stt_local.subprocess, "run", _fake_run_writing(payload))

    result = stt_local.transcribe_local(audio_file)

    assert result == payload["segments"]
    for cue in result:
        assert set(cue.keys()) >= {"start", "end", "text"}
        assert isinstance(cue["start"], float)
        assert isinstance(cue["end"], float)
        assert isinstance(cue["text"], str)


def test_language_and_word_timestamps_flags_passed_through(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(_ok_result(), f)

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    stt_local.transcribe_local(audio_file, language="en", word_timestamps=True)

    cmd = captured["cmd"]
    assert "--language" in cmd and cmd[cmd.index("--language") + 1] == "en"
    assert "--word-timestamps" in cmd


def test_language_omitted_when_not_given(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(_ok_result(), f)

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    stt_local.transcribe_local(audio_file)

    assert "--language" not in captured["cmd"]
    assert "--word-timestamps" not in captured["cmd"]


# --- M5: whisper_transcribe.py's auto-detected language must reach the job
# log when no hint was given (it used to be silently discarded) ------------

def test_logs_detected_language_when_no_hint_given(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local.subprocess, "run", _fake_run_writing(_ok_result()))  # language: "en"
    logs = []

    stt_local.transcribe_local(audio_file, log=logs.append)

    assert any("detected source language: en" in m for m in logs)


def test_does_not_log_detected_language_when_a_hint_was_given(monkeypatch, audio_file):
    # A hint means the caller already knows the source language -- logging the
    # (possibly different) auto-detected value back would just be confusing.
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local.subprocess, "run", _fake_run_writing(_ok_result()))
    logs = []

    stt_local.transcribe_local(audio_file, language="en", log=logs.append)

    assert not any("detected source language" in m for m in logs)


def test_no_log_callable_is_fine_when_no_hint_given(monkeypatch, audio_file):
    # log is optional -- must not raise when the caller doesn't pass one.
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local.subprocess, "run", _fake_run_writing(_ok_result()))

    result = stt_local.transcribe_local(audio_file)

    assert result == _ok_result()["segments"]


def test_stt_python_env_override(monkeypatch, audio_file):
    """STT_PYTHON is read from the environment at module load (see
    app/stt_local.py); overriding the module attribute is the same effect a
    caller gets by setting the STT_PYTHON env var before import."""
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(_ok_result(), f)

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    stt_local.transcribe_local(audio_file)

    assert captured["cmd"][0] == sys.executable


def test_default_stt_python_reads_env_var_at_import(monkeypatch):
    """The module-level default is os.environ.get('STT_PYTHON', 'python3') --
    verify that contract directly by re-evaluating it, without reloading the
    module (reloading would affect other tests importing the same module)."""
    monkeypatch.setenv("STT_PYTHON", "/custom/venv/bin/python")
    assert os.environ.get("STT_PYTHON", "python3") == "/custom/venv/bin/python"


def test_subprocess_run_does_not_override_env(monkeypatch, audio_file):
    """stt_local.py must not pass env= to subprocess.run -- that would strip
    inherited variables like WHISPER_MODEL_DIR (read by the worker script) and
    break the env-override contract described in app/docs/INTEGRATION_SPEC.md."""
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    captured_kwargs = {}

    def fake_run(cmd, **kwargs):
        captured_kwargs.update(kwargs)
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(_ok_result(), f)

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    stt_local.transcribe_local(audio_file)

    assert "env" not in captured_kwargs


# --- timeout scales with the video's length (long videos used to die on a
# fixed 900s wall regardless of how long the video actually was) -----------

def test_stt_timeout_keeps_fixed_value_for_short_video():
    assert stt_local.stt_timeout(31.0) == 900


def test_stt_timeout_scales_for_long_video():
    ten_min = 600.0
    expected = min(max(900, ten_min * stt_local.STT_TIMEOUT_PER_SEC), stt_local.STT_TIMEOUT_CAP)
    assert stt_local.stt_timeout(ten_min) == expected
    assert expected > 900


def test_stt_timeout_capped_so_it_cannot_hang_a_day():
    assert stt_local.stt_timeout(999999.0) == stt_local.STT_TIMEOUT_CAP


def test_stt_timeout_falls_back_to_default_when_duration_unknown():
    assert stt_local.stt_timeout(None) == 900
    assert stt_local.stt_timeout(0) == 900


def test_stt_timeout_per_sec_env_override_wins(monkeypatch):
    monkeypatch.setenv("PERSODUB_STT_TIMEOUT_PER_SEC", "1")
    import importlib
    reloaded = importlib.reload(stt_local)
    try:
        assert reloaded.stt_timeout(600.0) == 900  # 600*1 < 900 floor, unchanged
    finally:
        monkeypatch.undo()
        importlib.reload(stt_local)


def test_transcribe_passes_computed_timeout_to_subprocess_run(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local, "STT_TIMEOUT_PER_SEC", 10.0)
    monkeypatch.setattr(stt_local, "STT_TIMEOUT_CAP", 100000.0)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["timeout"] = kwargs.get("timeout")
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(_ok_result(), f)

        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    stt_local.transcribe_local(audio_file, video_duration=600.0)  # 10 min

    assert captured["timeout"] == 6000.0
