"""run_dub STT-engine chain: Perso (if requested) -> local Whisper only.

The container-based STT link has been removed entirely -- there is no more
"default = container transcription, fall back to local Whisper only on failure"
middle step. Either Perso runs (falling back to local Whisper on failure), or
local Whisper runs directly (the default, and what stt_engine="local" also
selects explicitly). Either way, local Whisper sets no speaker_id, so
diar_engine is forced to "campplus" (unless the caller already set one) so
downstream per-speaker voice-reference building still works.
"""
import os

import pytest

from app import pipeline
from app.perso_client import PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError


class _FakeSeparationEngine:
    def separate(self, video_path, out_dir):
        return {"vocals": "/local/vocals.wav", "background": "/local/background.wav"}


def _fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                       language=None, n_takes=1, log=None, on_notice=None):
    p = os.path.join(work_dir, "qwen_dub_48k.wav")
    with open(p, "wb") as f:
        f.write(b"MIXED")
    return p


def _fake_mux(video, audio, out, dur):
    with open(out, "wb") as f:
        f.write(b"FINALMP4")

    class _R:
        returncode = 0
        stderr = ""
    return _R()


def _stub_common(monkeypatch):
    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "run_qwen_dub", _fake_run_qwen_dub)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)


def _write_inputs(tmp_path):
    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    out = tmp_path / "dubbed.mp4"
    srt = tmp_path / "sub.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nhi\n")
    return str(video), str(out), str(srt)


def test_stt_engine_default_uses_local_whisper_directly(monkeypatch, tmp_path):
    # No stt_engine given -> straight to local Whisper, no container in between.
    _stub_common(monkeypatch)
    captured = {}

    def fake_transcribe_local(audio_path, language=None, **k):
        captured["audio_path"] = audio_path
        captured["language"] = language
        return [{"start": 0.0, "end": 2.0, "text": "hi there"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)

    def _fake_diarize(vocals_path, cues, num_speakers=None):
        captured["diarize_called"] = True
        captured["vocals_path"] = vocals_path
        return [dict(c, speaker="SPK0") for c in cues]

    monkeypatch.setattr(pipeline, "diarize", _fake_diarize)

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko",
        log=logs.append,
    )

    assert captured["audio_path"] == video
    # language_code names the TARGET language (see ui/src/dubApi.mjs) -- it must
    # never be handed to the transcriber, which listens to the SOURCE audio.
    assert captured["language"] is None
    assert captured.get("diarize_called") is True  # diar_engine forced to campplus
    # diarize() reads straight off the local Demucs vocals track -- no container fetch step
    assert captured["vocals_path"] == "/local/vocals.wav"
    assert result["out_path"] == out


def test_stt_engine_local_is_same_as_default(monkeypatch, tmp_path):
    _stub_common(monkeypatch)
    called = {}

    def fake_transcribe_local(audio_path, language=None, **k):
        called["yes"] = True
        return [{"start": 0.0, "end": 2.0, "text": "hi there"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    video, out, srt = _write_inputs(tmp_path)
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko", stt_engine="local",
        log=[].append,
    )
    assert called.get("yes") is True
    assert result["out_path"] == out


def test_stt_engine_local_failure_raises(monkeypatch, tmp_path):
    # Local Whisper is the last resort now -- when it fails there is nothing left
    # to fall back to, so the job must fail loudly.
    _stub_common(monkeypatch)

    def _boom(audio_path, language=None, **k):
        raise RuntimeError("local STT produced no segments")

    monkeypatch.setattr(pipeline, "transcribe_local", _boom)

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    try:
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko",
            log=logs.append,
        )
        assert False, "expected RuntimeError to propagate"
    except RuntimeError as e:
        assert "no segments" in str(e)
    assert any("Local STT failed" in m for m in logs)


class _FakePerso:
    def transcribe(self, video_path, space_seq=None):
        return [
            {"text_original": "hello there friend", "speaker_name": "SPK0",
             "words": [[{"start": 0.0, "end": 2.0}]]},
        ]


def test_stt_engine_perso_success_skips_local_whisper_and_campplus(monkeypatch, tmp_path):
    _stub_common(monkeypatch)
    called = {"local": False}

    def fake_transcribe_local(*a, **k):
        called["local"] = True
        return [{"start": 0.0, "end": 2.0, "text": "hi"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)
    # Perso already sets speaker_id, so diar_engine is never forced to campplus here --
    # diarize() must not run at all.
    monkeypatch.setattr(pipeline, "diarize",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("campplus must not run")))

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    fake = _FakePerso()
    fake.describe_workspace = lambda: {"seq": 114, "name": "EST", "credits": 191175}
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko", stt_engine="perso",
        perso_client=fake,
        log=logs.append,
    )
    assert called["local"] is False
    assert result["out_path"] == out
    # Which workspace paid, stated in the job log: a saved-but-not-restarted
    # workspace pick means the active one can differ from what Settings shows.
    assert any("EST" in m and "#114" in m for m in logs)


def test_stt_engine_perso_logs_credits_used(monkeypatch, tmp_path):
    # The job log states how many credits THIS job consumed (balance before
    # minus after), not just the remaining balance (user feedback 2026-08-06:
    # log the amount consumed, not just the remaining balance).
    _stub_common(monkeypatch)
    monkeypatch.setattr(pipeline, "diarize", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("campplus must not run")))

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    fake = _FakePerso()
    balances = iter([191175, 191100])
    fake.describe_workspace = lambda: {"seq": 114, "name": "EST", "credits": next(balances)}
    pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko", stt_engine="perso",
        perso_client=fake,
        log=logs.append,
    )
    assert any("credits used: 75" in m for m in logs)


def test_stt_engine_perso_failure_fails_the_job(monkeypatch, tmp_path):
    # The user PICKED Perso; substituting the local engine behind their back
    # is not an upgrade path (user decision 2026-08-06: no silent local fallback).
    # The job must fail with an actionable message, and local Whisper must
    # not run at all.
    _stub_common(monkeypatch)
    called = {}

    def fake_transcribe_local(audio_path, language=None, **k):
        called["yes"] = True
        return [{"start": 0.0, "end": 2.0, "text": "hi there"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    class _BrokenPerso:
        def transcribe(self, video_path, space_seq=None):
            raise RuntimeError("network failure")

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    with pytest.raises(RuntimeError, match="Perso STT failed"):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko", stt_engine="perso",
            perso_client=_BrokenPerso(),
            log=logs.append,
        )
    assert called.get("yes") is None  # local Whisper must NOT have run


def test_stt_engine_perso_credit_exhausted_fails_with_recharge_notice(monkeypatch, tmp_path):
    # HTTP 402 from Perso -- a dedicated exception, distinct from other failures (see
    # PersoCreditExhaustedError). The job FAILS (no silent local substitute: the user
    # picked Perso) with the recharge link in both the error message and a structured
    # notice, so the UI can render a clickable Recharge next to the red bar.
    _stub_common(monkeypatch)
    called = {}

    def fake_transcribe_local(audio_path, language=None, **k):
        called["yes"] = True
        return [{"start": 0.0, "end": 2.0, "text": "hi there"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    class _BrokePerso:
        def transcribe(self, video_path, space_seq=None):
            raise PersoCreditExhaustedError(link="https://perso.ai/en/workspace/space-settings?tab=Subscription")

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    notices = []
    with pytest.raises(RuntimeError, match="[Cc]redits"):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko", stt_engine="perso",
            perso_client=_BrokePerso(),
            log=logs.append,
            on_notice=notices.append,
        )
    assert called.get("yes") is None  # local Whisper must NOT have run
    assert len(notices) == 1
    assert notices[0]["type"] == "perso_credit_exhausted"
    assert notices[0]["link"] == "https://perso.ai/en/workspace/space-settings?tab=Subscription"
    assert "recharge" in notices[0]["message"].lower()


def test_pipeline_hands_cancel_check_to_the_perso_client(monkeypatch, tmp_path):
    # Cancel must be able to interrupt the Perso progress wait (up to an hour
    # of polling) -- the pipeline passes its cancel_check via the client's
    # cancel_check attribute (see PersoClient._wait_completed).
    _stub_common(monkeypatch)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)
    seen = {}

    class _CapturingPerso:
        cancel_check = None

        def transcribe(self, video_path, space_seq=None):
            seen["cancel_check"] = self.cancel_check
            return [{"text_original": "hi", "speaker_name": "A",
                     "words": [[{"start": 0.0, "end": 2.0}]]}]

    video, out, srt = _write_inputs(tmp_path)
    def sentinel():
        return False
    pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko", stt_engine="perso",
        perso_client=_CapturingPerso(), cancel_check=sentinel, log=lambda m: None,
    )
    assert seen["cancel_check"] is sentinel


def test_cancel_during_perso_wait_is_not_rewrapped_as_a_perso_failure(monkeypatch, tmp_path):
    from app.jobs import JobCancelled

    _stub_common(monkeypatch)

    class _CancelledPerso:
        def transcribe(self, video_path, space_seq=None):
            raise JobCancelled("cancelled while waiting for Perso STT")

    video, out, srt = _write_inputs(tmp_path)
    notices = []
    with pytest.raises(JobCancelled):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko", stt_engine="perso",
            perso_client=_CancelledPerso(), on_notice=notices.append, log=lambda m: None,
        )
    assert notices == []


def test_stt_engine_perso_credits_log_never_kills_a_paid_job(monkeypatch, tmp_path):
    # The "credits used" line is computed AFTER transcription succeeded and was
    # billed. Perso returning credits as strings (or any surprise shape) must
    # degrade to a missing log line, never a failed job (review HIGH-5).
    _stub_common(monkeypatch)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    class _StringCreditsPerso:
        def __init__(self):
            self.calls = 0

        def describe_workspace(self):
            self.calls += 1
            return {"seq": 1, "name": "WS", "credits": "5" if self.calls == 1 else object()}

        def transcribe(self, video_path, space_seq=None):
            return [{"text_original": "hi", "speaker_name": "A",
                     "words": [[{"start": 0.0, "end": 2.0}]]}]

    video, out, srt = _write_inputs(tmp_path)
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko", stt_engine="perso",
        perso_client=_StringCreditsPerso(),
        log=lambda m: None,
    )
    assert result["num_segments"] == 1


def test_stt_engine_perso_invalid_key_fails_with_settings_notice(monkeypatch, tmp_path):
    # 401/403 from Perso -> the key is wrong. The job fails with a notice the UI
    # turns into a "check your key" popup whose button opens Settings (no link:
    # the fix is inside the app, not on a web page).
    _stub_common(monkeypatch)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    class _BadKeyPerso:
        def transcribe(self, video_path, space_seq=None):
            raise PersoInvalidKeyError("Perso rejected the API key (HTTP 401)")

    video, out, srt = _write_inputs(tmp_path)
    notices = []
    with pytest.raises(RuntimeError, match="[Kk]ey"):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko", stt_engine="perso",
            perso_client=_BadKeyPerso(),
            log=lambda m: None,
            on_notice=notices.append,
        )
    assert len(notices) == 1
    assert notices[0]["type"] == "perso_invalid_key"
    assert "link" not in notices[0]


def test_stt_engine_perso_5xx_fails_with_try_later_notice(monkeypatch, tmp_path):
    # 5xx from Perso -> their outage, not the user's fault. The job fails with a
    # "try again later" notice (no link -- nothing for the user to fix).
    _stub_common(monkeypatch)
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)

    class _DownPerso:
        def transcribe(self, video_path, space_seq=None):
            raise PersoUnavailableError("Perso server error (HTTP 503)")

    video, out, srt = _write_inputs(tmp_path)
    notices = []
    with pytest.raises(RuntimeError, match="unavailable"):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko", stt_engine="perso",
            perso_client=_DownPerso(),
            log=lambda m: None,
            on_notice=notices.append,
        )
    assert len(notices) == 1
    assert notices[0]["type"] == "perso_unavailable"
    assert "link" not in notices[0]


def test_local_stt_is_never_told_to_decode_in_the_target_language(monkeypatch, tmp_path):
    """run_dub's language_code is the TARGET language (ui/src/dubApi.mjs:39-40).

    Forwarding it to local Whisper forces the decoder into the wrong language --
    an en->ko job would transcribe English audio as Korean, yielding phonetic
    gibberish that is then "translated" ko->ko and dubbed. The source language
    is not known to run_dub, so the transcriber must auto-detect it.
    """
    _stub_common(monkeypatch)
    captured = {}

    def fake_transcribe_local(audio_path, language=None, **k):
        captured["language"] = language
        return [{"start": 0.0, "end": 2.0, "text": "hi there"}]

    monkeypatch.setattr(pipeline, "transcribe_local", fake_transcribe_local)
    monkeypatch.setattr(pipeline, "diarize",
                        lambda vocals_path, cues, num_speakers=None: cues)

    video, out, srt = _write_inputs(tmp_path)
    pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko",
        log=[].append,
    )

    assert captured["language"] is None, (
        "local STT was told to decode as %r -- that is the target language"
        % captured["language"]
    )
