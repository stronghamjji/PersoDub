"""run_dub diar_engine='campplus' branch, using fakes (no container, no ffmpeg)."""
import os

from app import pipeline
from app.text.cues import cue_speaker


class _FakeSeparationEngine:
    def separate(self, video_path, out_dir):
        return {"vocals": "/local/vocals.wav", "background": "/local/background.wav"}


def _fake_mux(video, audio, out, dur):
    with open(out, "wb") as f:
        f.write(b"FINALMP4")

    class _R:
        returncode = 0
        stderr = ""
    return _R()


def test_campplus_labels_written_into_src_cues(monkeypatch, tmp_path):
    captured = {}

    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    # Local Whisper produced two cues with no speaker labels at all -- the exact
    # situation CAM++ exists to fix.
    monkeypatch.setattr(pipeline, "transcribe_local", lambda audio_path, language=None, **k: [
        {"start": 0.0, "end": 2.0, "text": "line one"},
        {"start": 9.0, "end": 11.0, "text": "line two"},
    ])

    def _fake_diarize(vocals_path, cues, num_speakers=None):
        captured["num_speakers"] = num_speakers
        captured["vocals_path"] = vocals_path
        labels = ["SPK0", "SPK1"]
        return [dict(c, speaker=labels[i]) for i, c in enumerate(cues)]

    monkeypatch.setattr(pipeline, "diarize", _fake_diarize)

    # Capture the cues the pipeline actually feeds downstream (ref_cues, which the
    # Qwen path builds its per-speaker voice references from), to prove the CAM++
    # labels are the ones cue_speaker() sees (not left unlabeled).
    def fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                          language=None, n_takes=1, log=None, on_notice=None):
        captured["ref_labels"] = [cue_speaker(c) for c in ref_cues]
        p = os.path.join(work_dir, "qwen_dub_48k.wav")
        with open(p, "wb") as f:
            f.write(b"MIXED")
        return p

    monkeypatch.setattr(pipeline, "run_qwen_dub", fake_run_qwen_dub)

    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    out = tmp_path / "dubbed.mp4"
    srt = tmp_path / "sub.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nhi\n")

    logs = []
    pipeline.run_dub(
        video_path=str(video), out_path=str(out), srt_path=str(srt),
        language="Korean", language_code="ko",
        num_speakers=2, diar_engine="campplus",
        log=logs.append,
    )
    # CAM++ ran on the whisper cues (fed straight off the local vocals track) and asked for 2 speakers
    assert captured["num_speakers"] == 2
    assert captured["vocals_path"] == "/local/vocals.wav"
    assert any("CAM++" in m or "campplus" in m for m in logs)
    assert captured["ref_labels"] == ["SPK0", "SPK1"]


# test_no_diar_engine_leaves_cues_untouched used to live here (container-based
# transcription already carried speaker labels, so diar_engine stayed unset). That
# STT source no longer exists -- the equivalent guarantee ("diarize() must not run
# when speaker labels are already known") is now covered by
# tests/test_stt_engine_wiring.py::test_stt_engine_perso_success_skips_local_whisper_and_campplus.

def test_source_srt_keeps_diarization_labels(monkeypatch, tmp_path):
    """Uploading a source script must not throw away who is speaking.

    run_dub replaced the diarized cues with the uploaded SRT's own cues, which
    parse_srt returns as bare {start,end,text}. speakers_in(ref_cues) then saw
    no speakers at all and the Qwen path collapsed everyone onto one voice --
    the whole video dubbed in a single voice.
    """
    captured = {}

    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    monkeypatch.setattr(pipeline, "transcribe_local", lambda audio_path, language=None, **k: [
        {"start": 0.0, "end": 2.0, "text": "line one"},
        {"start": 9.0, "end": 11.0, "text": "line two"},
    ])

    labels = ["SPK0", "SPK1"]
    monkeypatch.setattr(pipeline, "diarize",
                        lambda vocals_path, cues, num_speakers=None:
                        [dict(c, speaker=labels[i]) for i, c in enumerate(cues)])

    def fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                          language=None, n_takes=1, log=None, on_notice=None):
        captured["ref_labels"] = [cue_speaker(c) for c in ref_cues]
        p = os.path.join(work_dir, "qwen_dub_48k.wav")
        with open(p, "wb") as f:
            f.write(b"MIXED")
        return p

    monkeypatch.setattr(pipeline, "run_qwen_dub", fake_run_qwen_dub)

    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    out = tmp_path / "dubbed.mp4"
    srt = tmp_path / "sub.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nhi\n")
    # A professional script for the same two lines -- accurate timing, no speakers.
    source_srt = tmp_path / "source.srt"
    source_srt.write_text(
        "1\n00:00:00,000 --> 00:00:02,000\nline one\n\n"
        "2\n00:00:09,000 --> 00:00:11,000\nline two\n"
    )

    pipeline.run_dub(
        video_path=str(video), out_path=str(out), srt_path=str(srt),
        source_srt_path=str(source_srt),
        language="Korean", language_code="ko",
        num_speakers=2, diar_engine="campplus",
        log=[].append,
    )

    assert captured["ref_labels"] == ["SPK0", "SPK1"], (
        "diarization was discarded by the source-SRT branch: %r"
        % (captured["ref_labels"],)
    )
