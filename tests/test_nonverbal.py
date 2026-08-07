"""Unit tests for app/nonverbal.py -- the laughter whitelist.

Fake wavs only; whisper is NEVER run here (the veto is injected as a callable).
"""
import audioop
import math
import struct
import wave

from app import nonverbal as nv

SR16 = 16000
AMP = 9000


def _write_tone_wav(path, spans, dur, sr=SR16, amp=AMP):
    """Mono 16-bit wav: 440Hz tone inside each [start, end) span, silence elsewhere."""
    n = int(dur * sr)
    buf = bytearray()
    for i in range(n):
        t = i / sr
        on = any(a <= t < b for a, b in spans)
        v = int(amp * math.sin(2 * math.pi * 440 * t)) if on else 0
        buf += struct.pack("<h", v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(buf))
    return str(path)


def _write_silent_48k_stereo(path, dur):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00" * (int(dur * 48000) * 4))
    return str(path)


def _rms_span_48k(path, start, end):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        w.setpos(int(start * sr))
        raw = w.readframes(int((end - start) * sr))
    return audioop.rms(raw, w.getsampwidth())


# --- (1) candidate discovery: rules (a) speech overlap, (b) dub overlap, (c) min duration ---

def test_extract_candidates_respects_speech_dub_and_duration_rules(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [
        (1.0, 1.6),    # laughter -- the only survivor
        (3.0, 4.0),    # original speech (covered by an STT cue)
        (5.0, 5.5),    # under a placed dub line
        (7.0, 7.6),    # mostly covered by a speech cue; the sliver left is < 0.15s
    ], dur=9.0)
    speech_spans = [(3.0, 4.0), (7.25, 8.5)]
    dub_spans = [(5.0, 5.5)]

    cands = nv.extract_nonverbal_segments(vocals, speech_spans, dub_spans)

    assert len(cands) == 1
    a, b = cands[0]
    assert 0.7 <= a <= 1.05 and 1.5 <= b <= 1.9  # the 1.0-1.6s burst (VAD pads a little)
    # never overlaps a padded speech span (+-0.3s) or padded dub span (+-0.1s)
    for s, e in speech_spans:
        assert b <= s - 0.3 + 1e-9 or a >= e + 0.3 - 1e-9
    for s, e in dub_spans:
        assert b <= s - 0.1 + 1e-9 or a >= e + 0.1 - 1e-9


def test_extract_candidates_empty_on_silent_stem(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [], dur=3.0)
    assert nv.extract_nonverbal_segments(vocals, [], []) == []


# --- (2) transcript classification (the veto's decision rule) ---

def test_classify_keeps_only_laughter_like_transcripts():
    keep = ["", "   ", "...", "(laughs)", "[laughter]", "(웃음)", "하하하!", "Haha.",
            "하하 하하", "ho ho ho", "Hehehe.", "ㅋㅋㅋ", "ㅎㅎ", "hah", "ehehe"]
    reject = ["Thank you", "그래서 뭐 할 건데", "MBC 뉴스", "시청해주셔서 감사합니다",
              "I think so", "you you you you", "그만해", "stop it", "(speaking korean)"]
    for t in keep:
        assert nv.classify_transcript(t) is True, t
    for t in reject:
        assert nv.classify_transcript(t) is False, t


def test_classify_fails_closed_on_foreign_scripts_and_digits():
    # Critical-1: characters outside the punctuation whitelist (Japanese,
    # Chinese, Cyrillic, digits, ...) must survive normalization and REJECT --
    # the old normalizer deleted them, turning these into "empty = KEEP".
    for t in ["ありがとうございます", "谢谢大家", "ご視聴ありがとうございました",
              "оставьте комментарий", "123 456"]:
        assert nv.classify_transcript(t) is False, t


def test_classify_rejects_real_words_the_old_lexicon_passed():
    # Important-4: real words assembled from "laugh" letters/syllables, plus
    # single breath-ish tokens -- the whole string must be a REPEATED laugh
    # pattern (haha/hehe/ㅋㅋ/하하...), everything else fails closed.
    for t in ["오후", "아우", "우아", "어우", "hue", "hoe", "음", "Hmm", "후..."]:
        assert nv.classify_transcript(t) is False, t


# --- (3) overlay preserves amplitude and applies fades ---

def test_overlay_preserves_amplitude_and_fades_edges(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(0.5, 1.5)], dur=2.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 3.0)
    out = str(tmp_path / "out.wav")

    nv.overlay_segments(mix, vocals, [(0.75, 1.25)], out)

    # center of the copied span: same RMS as the vocals stem there (original volume)
    out_rms = _rms_span_48k(out, 0.9, 1.1)
    with wave.open(vocals, "rb") as w:
        w.setpos(int(0.9 * SR16))
        v_rms = audioop.rms(w.readframes(int(0.2 * SR16)), 2)
    assert abs(20 * math.log10(out_rms / v_rms)) < 1.0  # within 1dB

    # fade-in: the first 20ms is much quieter than the center; before the span: silence
    head_rms = _rms_span_48k(out, 0.75, 0.77)
    assert head_rms < 0.6 * out_rms
    assert _rms_span_48k(out, 0.2, 0.7) == 0
    assert _rms_span_48k(out, 1.3, 2.9) == 0


# --- (4) veto rejection drops a segment; manifest reports both ---

def test_apply_whitelist_injectable_veto_drops_rejected_segment(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(1.0, 1.5), (2.0, 2.5)], dur=4.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 4.0)

    def veto(vocals_path, cands):
        return [{"start": a, "end": b,
                 "text": "하하" if a < 1.8 else "hello there",
                 "keep": a < 1.8} for a, b in cands]

    manifest = nv.apply_nonverbal_whitelist(mix, vocals, [], [], veto=veto)

    assert len(manifest["kept"]) == 1
    assert len(manifest["rejected"]) == 1
    assert manifest["rejected"][0]["text"] == "hello there"
    assert _rms_span_48k(mix, 1.15, 1.35) > 100     # kept laughter is audible
    assert _rms_span_48k(mix, 2.15, 2.35) == 0      # rejected segment stayed out


def test_apply_whitelist_no_candidates_leaves_mix_untouched(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [], dur=2.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 2.0)
    before = open(mix, "rb").read()

    called = []
    manifest = nv.apply_nonverbal_whitelist(
        mix, vocals, [], [], veto=lambda v, c: called.append(c) or [])

    assert manifest["kept"] == [] and manifest["rejected"] == []
    assert called == []                      # veto not even invoked
    assert open(mix, "rb").read() == before  # bit-identical


# --- near-silent candidates must not qualify; reversed cue spans must still exclude ---

def test_extract_drops_near_silent_candidates(tmp_path):
    # Checker finding: a -51dBFS noise-floor sliver (edit60s_gemma 52.30-52.66s)
    # was whitelisted although there is nothing audible to preserve. A
    # candidate must carry >= -45dBFS RMS on the vocals stem.
    vocals = str(tmp_path / "vocals.wav")
    import struct as _s
    n = int(5.0 * SR16)
    buf = bytearray()
    for i in range(n):
        t = i / SR16
        if 1.0 <= t < 1.6:
            v = int(9000 * math.sin(2 * math.pi * 440 * t))   # ~-14dBFS: real laugh
        elif 3.0 <= t < 3.6:
            v = int(120 * math.sin(2 * math.pi * 440 * t))    # ~-52dBFS: floor noise
        else:
            v = 0
        buf += _s.pack("<h", v)
    with wave.open(vocals, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR16)
        w.writeframes(bytes(buf))

    cands = nv.extract_nonverbal_segments(vocals, [], [])

    assert len(cands) == 1
    assert 0.7 <= cands[0][0] <= 1.05 and 1.5 <= cands[0][1] <= 1.9


def test_reversed_speech_span_still_excludes(tmp_path):
    # Minor-6: an end<=start cue (bad STT timing) was silently dropped from
    # the exclusion list -- it must be swapped and kept as an exclusion.
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(3.2, 3.8)], dur=5.0)
    assert nv.extract_nonverbal_segments(vocals, [(3.9, 3.1)], []) == []


# --- Important-3: default interpreter + loud fail-closed drop ---

def test_config_default_whisper_python_is_the_venv_with_whisper(monkeypatch):
    import importlib

    from app import config
    monkeypatch.delenv("NONVERBAL_WHISPER_PYTHON", raising=False)
    cfg = importlib.reload(config)
    try:
        assert cfg.NONVERBAL_WHISPER_PYTHON == "python3"
    finally:
        importlib.reload(config)


def test_whisper_veto_fails_closed_when_interpreter_missing(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(1.0, 1.5)], dur=2.0)
    verdicts = nv.whisper_veto(vocals, [(1.0, 1.5)],
                               python_bin=str(tmp_path / "no-such-python"))
    assert len(verdicts) == 1
    assert verdicts[0]["keep"] is False
    assert verdicts[0].get("error") is True


def test_apply_whitelist_logs_error_when_whisper_unavailable(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(1.0, 1.5)], dur=3.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 3.0)
    logs = []

    def broken_veto(vocals_path, cands):
        return [{"start": a, "end": b, "keep": False, "error": True,
                 "text": "<whisper unavailable: boom>"} for a, b in cands]

    manifest = nv.apply_nonverbal_whitelist(mix, vocals, [], [],
                                            veto=broken_veto, log=logs.append)
    assert manifest["kept"] == []
    assert any("ERROR" in m for m in logs)


# --- Minor-7: peak-guard activation must be visible in the log ---

def test_overlay_logs_when_peak_guard_engages(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(0.5, 1.5)], dur=2.0, amp=30000)
    mix = str(tmp_path / "mix.wav")
    import struct as _s
    n = int(2.0 * 48000)
    frames = bytearray()
    for i in range(n):
        v = int(30000 * math.sin(2 * math.pi * 440 * i / 48000)) if 0.4 <= i / 48000 < 1.6 else 0
        frames += _s.pack("<hh", v, v)
    with wave.open(mix, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(bytes(frames))
    logs = []
    nv.overlay_segments(mix, vocals, [(0.6, 1.4)], str(tmp_path / "out.wav"),
                        log=logs.append)
    assert any("peak guard" in m for m in logs)


# --- overlay boundary conditions ---

def test_overlay_at_time_zero_and_past_mix_end(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(0.0, 0.4), (1.6, 2.0)], dur=2.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 1.5)  # shorter than vocals
    out = str(tmp_path / "out.wav")

    nv.overlay_segments(mix, vocals, [(0.0, 0.4), (1.6, 2.0)], out)

    assert _rms_span_48k(out, 0.1, 0.3) > 1000    # t=0 segment landed
    assert _rms_span_48k(out, 1.75, 1.95) > 1000  # mix buffer was extended
    with wave.open(out, "rb") as w:
        # 1ms tolerance: audioop.ratecv's unflushed tail can run a frame or two short
        assert w.getnframes() >= int(2.0 * 48000) - 48


def test_overlay_adjacent_segments_no_gap_overrun(tmp_path):
    vocals = _write_tone_wav(tmp_path / "vocals.wav", [(0.5, 1.3)], dur=2.0)
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 2.0)
    out = str(tmp_path / "out.wav")

    nv.overlay_segments(mix, vocals, [(0.5, 0.9), (0.9, 1.3)], out)

    assert _rms_span_48k(out, 0.6, 0.8) > 1000
    assert _rms_span_48k(out, 1.0, 1.2) > 1000
    assert _rms_span_48k(out, 1.45, 1.95) == 0    # nothing past the segments
