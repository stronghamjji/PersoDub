"""The language Whisper detects has to reach the screen.

Today it is written to the log and discarded (app/stt_local.py:86), and
static/index.html records the resulting gap.
"""
import json

from app import stt_local


def _fake_worker(monkeypatch, tmp_path, payload):
    """Make transcribe_local's subprocess produce payload, with no real venv."""
    class _Result:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kw):
        out_path = cmd[cmd.index("--output") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return _Result()

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    py = tmp_path / "py"
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    monkeypatch.setattr(stt_local, "STT_PYTHON", str(py))
    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    return str(audio)


def test_detected_language_is_reported(monkeypatch, tmp_path):
    audio = _fake_worker(monkeypatch, tmp_path, {
        "ok": True, "language": "ko",
        "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}],
    })
    seen = []
    stt_local.transcribe_local(audio, on_language=seen.append)
    assert seen == ["ko"]


def test_no_callback_when_the_caller_pinned_a_language(monkeypatch, tmp_path):
    audio = _fake_worker(monkeypatch, tmp_path, {
        "ok": True, "language": "ko",
        "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}],
    })
    seen = []
    stt_local.transcribe_local(audio, language="en", on_language=seen.append)
    assert seen == []  # nothing was detected -- the caller already knew
