"""app/stt_local.py: subprocess bridge to the local Whisper worker
(app/scripts/whisper_transcribe.py).

The process is replaced (stt_local._run) in most tests, with no model weights
-- this tests the contract: happy-path cue shape, and that every failure mode
raises a clear RuntimeError (transcribe_local is the LAST fallback, so unlike
app/qwen_scoring.score_takes() it must never swallow errors into a None/empty
return). A few run a tiny real child in Whisper's place (_child).
"""
import json
import os
import sys
import threading
import time

import pytest

from app import stt_local
from app.jobs import JobCancelled
from app.run_errors import PartsMissing


def _ok_result(segments=None):
    return {"ok": True, "language": "en", "segments": segments if segments is not None else
            [{"start": 0.0, "end": 1.2, "text": "hello there"}]}


def _fake_run_writing(output_payload):
    """Build a fake _run that writes output_payload to --output and
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


def _child(monkeypatch, tmp_path, code):
    """Whisper replaced by `code`, run as a real process the way Whisper is:
    for what a fake cannot show, that it is ended and both pipes are read."""
    script = tmp_path / "worker.py"
    script.write_text(code, encoding="utf-8")
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", str(script))


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
    # Its own kind: the advice is to download it again, not to check the video.
    with pytest.raises(PartsMissing, match="interpreter not found"):
        stt_local.transcribe_local(audio_file)


def test_raises_when_script_missing(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", "/no/such/script.py")
    with pytest.raises(PartsMissing, match="script missing"):
        stt_local.transcribe_local(audio_file)


def test_raises_on_subprocess_exception(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)  # any existing file

    def boom(*a, **k):
        raise OSError("no such file")

    monkeypatch.setattr(stt_local, "_run", boom)
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

    monkeypatch.setattr(stt_local, "_run", boom)
    with pytest.raises(RuntimeError) as caught:
        stt_local.transcribe_local(audio_file, timeout=900)
    assert "timed out after 900 seconds" in str(caught.value)


def test_raises_on_nonzero_exit(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 1
        stderr = "model load failed"

    monkeypatch.setattr(stt_local, "_run", lambda cmd, **k: _R())
    with pytest.raises(RuntimeError, match="exited with an error"):
        stt_local.transcribe_local(audio_file)


def test_a_broken_whisper_model_file_is_parts_missing(monkeypatch, audio_file):
    # A 4 KB junk model.bin: the advice is to download it again, not to check the video.
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 1
        stderr = ("__WHISPER_TRANSCRIBE_ERROR__ Cannot load the target vocabulary "
                  "from the model directory")

    monkeypatch.setattr(stt_local, "_run", lambda cmd, **k: _R())
    with pytest.raises(PartsMissing, match="target vocabulary"):
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

    monkeypatch.setattr(stt_local, "_run", fake_run)
    with pytest.raises(RuntimeError, match="invalid output"):
        stt_local.transcribe_local(audio_file)


def test_raises_when_worker_reports_failure(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(
        stt_local, "_run",
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
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(_ok_result(segments=[])))
    # Its own kind, so the job says no one speaks in it (app/pipeline.py).
    with pytest.raises(stt_local.NoSpeech, match="This video has no speech to transcribe"):
        stt_local.transcribe_local(audio_file)


def test_happy_path_returns_cue_shape(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    payload = _ok_result(segments=[
        {"start": 0.0, "end": 1.5, "text": "You let five people die."},
        {"start": 1.5, "end": 3.2, "text": "Then you let Dent take your place."},
    ])
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(payload))

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

    monkeypatch.setattr(stt_local, "_run", fake_run)
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

    monkeypatch.setattr(stt_local, "_run", fake_run)
    stt_local.transcribe_local(audio_file)

    assert "--language" not in captured["cmd"]
    assert "--word-timestamps" not in captured["cmd"]


# --- M5: whisper_transcribe.py's auto-detected language must reach the job
# log when no hint was given (it used to be silently discarded) ------------

def test_logs_detected_language_when_no_hint_given(monkeypatch, audio_file):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(_ok_result()))  # language: "en"
    logs = []

    stt_local.transcribe_local(audio_file, log=logs.append)

    assert any("detected source language: en" in m for m in logs)


def test_does_not_log_detected_language_when_a_hint_was_given(monkeypatch, audio_file):
    # A hint means the caller already knows the source language -- logging the
    # (possibly different) auto-detected value back would just be confusing.
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(_ok_result()))
    logs = []

    stt_local.transcribe_local(audio_file, language="en", log=logs.append)

    assert not any("detected source language" in m for m in logs)


def test_no_log_callable_is_fine_when_no_hint_given(monkeypatch, audio_file):
    # log is optional -- must not raise when the caller doesn't pass one.
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(_ok_result()))

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

    monkeypatch.setattr(stt_local, "_run", fake_run)
    stt_local.transcribe_local(audio_file)

    assert captured["cmd"][0] == sys.executable


def test_default_stt_python_reads_env_var_at_import(monkeypatch):
    """The module-level default is os.environ.get('STT_PYTHON', 'python3') --
    verify that contract directly by re-evaluating it, without reloading the
    module (reloading would affect other tests importing the same module)."""
    monkeypatch.setenv("STT_PYTHON", "/custom/venv/bin/python")
    assert os.environ.get("STT_PYTHON", "python3") == "/custom/venv/bin/python"


def test_subprocess_run_does_not_override_env(monkeypatch, audio_file, tmp_path):
    """stt_local.py must not pass env= to the process -- that would strip
    inherited variables like WHISPER_MODEL_DIR (read by the worker script) and
    break the env-override contract described in app/docs/INTEGRATION_SPEC.md."""
    monkeypatch.setenv("WHISPER_MODEL_DIR", "/kit/models/whisper")
    _child(monkeypatch, tmp_path, "import json, os, sys\n"
           "text = os.environ.get('WHISPER_MODEL_DIR', 'not inherited')\n"
           "with open(sys.argv[sys.argv.index('--output') + 1], 'w') as f:\n"
           "    json.dump({'ok': True, 'segments': [{'start': 0.0, 'end': 1.0, 'text': text}]}, f)\n")

    assert stt_local.transcribe_local(audio_file)[0]["text"] == "/kit/models/whisper"


# --- timeout scales with the video's length (long videos used to die on a
# fixed 900s wall regardless of how long the video actually was). The formula
# itself is tested once, shared, in tests/test_timeouts.py -- this is just the
# wiring: the computed timeout must actually reach the process (_run).

def test_transcribe_passes_computed_timeout_to_subprocess_run(monkeypatch, audio_file):
    from app import timeouts

    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(timeouts, "PERSODUB_TIMEOUT_PER_SEC", 10.0)
    monkeypatch.setattr(timeouts, "PERSODUB_TIMEOUT_CAP", 100000.0)
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

    monkeypatch.setattr(stt_local, "_run", fake_run)
    stt_local.transcribe_local(audio_file, video_duration=600.0)  # 10 min

    assert captured["timeout"] == 6000.0


# --- transcribe_batch: Fast mode hears its lines back (2026-10-01) ----------

def test_transcribe_batch_is_none_without_its_interpreter(monkeypatch, tmp_path):
    monkeypatch.setattr(stt_local, "NONVERBAL_WHISPER_PYTHON", str(tmp_path / "no-such-python"))
    assert stt_local.transcribe_batch([str(tmp_path / "a.wav")], "en") is None


def test_transcribe_batch_reads_what_the_runner_heard(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(stt_local, "NONVERBAL_WHISPER_PYTHON", sys.executable)
    seen = {}

    def fake_run(cmd, **_kw):
        seen["model"], seen["language"], list_path, out_path = cmd[3:7]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(dict.fromkeys(json.load(open(list_path)), "heard"), f)

        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(stt_local.subprocess, "run", fake_run)
    assert stt_local.transcribe_batch(["a.wav", "b.wav"], "es") == {"a.wav": "heard", "b.wav": "heard"}
    assert seen["language"] == "es"


# --- a trimmed clip and Whisper's made-up lines (Windows B5/D14, 2026-10-06) --
# A 27 s TikTok cut to 10 s came back as one line, "Thank you for watching!",
# at 0-29.98 s: Whisper's 30 s window, and words it made up over music.

def _vocals(path, seconds, loud_from=None, loud_to=None):
    """A 16 kHz mono vocals track: silence, with a loud tone over [loud_from, loud_to)."""
    import math
    import struct
    import wave
    rate = 16000
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        on = loud_from is not None and loud_from <= t < loud_to
        frames += struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * t)) if on else 0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return str(path)


def _heard(monkeypatch, segments):
    monkeypatch.setattr(stt_local, "STT_PYTHON", sys.executable)
    monkeypatch.setattr(stt_local, "SCRIPT_PATH", sys.executable)
    monkeypatch.setattr(stt_local, "_run", _fake_run_writing(_ok_result(segments=segments)))


def test_lines_end_where_the_video_ends(monkeypatch, audio_file):
    _heard(monkeypatch, [{"start": 0.0, "end": 29.98, "text": "We made it."},
                         {"start": 10.0, "end": 12.0, "text": "Past the end."}])
    assert stt_local.transcribe_local(audio_file, video_duration=10.0) == [
        {"start": 0.0, "end": 10.0, "text": "We made it."}]


def test_made_up_lines_over_quiet_vocals_are_dropped(monkeypatch, audio_file, tmp_path):
    vocals = _vocals(tmp_path / "vocals.wav", 6.0, loud_from=0.0, loud_to=1.0)
    _heard(monkeypatch, [{"start": 0.0, "end": 1.0, "text": "Real words."},
                         {"start": 1.0, "end": 3.0, "text": "Thank you for watching!"},
                         {"start": 3.0, "end": 4.5, "text": "시청해 주셔서 감사합니다."},
                         {"start": 4.5, "end": 6.0, "text": "Subtitles by the Amara.org community"}])
    assert stt_local.transcribe_local(audio_file, vocals_path=vocals) == [
        {"start": 0.0, "end": 1.0, "text": "Real words."}]


def test_a_speaker_who_says_it_is_kept(monkeypatch, audio_file, tmp_path):
    vocals = _vocals(tmp_path / "vocals.wav", 4.0, loud_from=1.0, loud_to=3.0)
    lines = [{"start": 1.0, "end": 3.0, "text": "Thanks for watching."}]
    _heard(monkeypatch, lines)
    assert stt_local.transcribe_local(audio_file, vocals_path=vocals) == lines


def test_quiet_lines_with_other_words_are_kept(monkeypatch, audio_file, tmp_path):
    vocals = _vocals(tmp_path / "vocals.wav", 4.0, loud_from=0.0, loud_to=1.0)
    lines = [{"start": 0.0, "end": 1.0, "text": "Look."},
             {"start": 1.0, "end": 4.0, "text": "Thank you for watching my brother play."}]
    _heard(monkeypatch, lines)
    assert stt_local.transcribe_local(audio_file, vocals_path=vocals) == lines


def test_a_clip_of_only_made_up_lines_has_no_speech(monkeypatch, audio_file, tmp_path):
    vocals = _vocals(tmp_path / "vocals.wav", 12.0)
    _heard(monkeypatch, [{"start": 0.0, "end": 29.98, "text": "Thank you for watching!"}])
    with pytest.raises(RuntimeError, match="This video has no speech to transcribe"):
        stt_local.transcribe_local(audio_file, video_duration=10.0, vocals_path=vocals)


def test_a_silent_video_with_a_made_up_line_in_any_language_has_no_speech(
        monkeypatch, audio_file, tmp_path):
    """A silent video came back as one invented line, language "nn", and was
    translated and voiced to "done" (Windows e2e, 2026-10-24). Every line over
    a quiet vocals track is no speech, whatever the words."""
    vocals = _vocals(tmp_path / "vocals.wav", 10.0)
    _heard(monkeypatch, [{"start": 0.0, "end": 9.0, "text": "Takk for at du såg på."}])
    with pytest.raises(stt_local.NoSpeech):
        stt_local.transcribe_local(audio_file, video_duration=10.0, vocals_path=vocals)


# --- Stop while Whisper runs (Windows test C10, 2026-10-20) ------------------
# Stop pressed during Transcribing waited for the whole Whisper run, 47 s.

def test_stop_ends_whisper_within_a_second(monkeypatch, audio_file, tmp_path):
    beat = tmp_path / "beat"
    # A run that says it is alive every 50 ms, for 20 s at most.
    _child(monkeypatch, tmp_path, "import time\nfor _ in range(400):\n"
           "    with open(%r, 'a') as f:\n        f.write('.')\n    time.sleep(0.05)\n" % str(beat))
    stop, pressed = threading.Event(), []

    def press():  # once the run is surely going
        while not beat.exists():
            time.sleep(0.01)
        pressed.append(time.monotonic())
        stop.set()

    threading.Thread(target=press, daemon=True).start()
    with pytest.raises(JobCancelled):
        stt_local.transcribe_local(audio_file, cancel_check=stop.is_set)
    assert time.monotonic() - pressed[0] < 1.5
    # Nothing runs it any more -- on Windows that includes the real python.exe
    # a venv's python.exe starts.
    size = beat.stat().st_size
    time.sleep(0.3)
    assert beat.stat().st_size == size


def test_whispers_words_on_stderr_still_name_a_broken_model(monkeypatch, audio_file, tmp_path):
    # Also more on stdout than a pipe holds: a pipe nobody reads stalls the
    # child, and the run would end on its timeout instead of on its error.
    _child(monkeypatch, tmp_path, "import sys\nsys.stdout.write('x' * 200000)\n"
           "sys.stderr.write('__WHISPER_TRANSCRIBE_ERROR__ Cannot load the target vocabulary "
           "from the model directory')\nsys.exit(1)\n")
    with pytest.raises(PartsMissing, match="target vocabulary"):
        stt_local.transcribe_local(audio_file, timeout=10)


def test_whisper_past_its_time_is_ended(monkeypatch, audio_file, tmp_path):
    _child(monkeypatch, tmp_path, "import time\ntime.sleep(20)\n")
    began = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out after 1 seconds"):
        stt_local.transcribe_local(audio_file, timeout=1)
    assert time.monotonic() - began < 5
