"""Unit tests for app/company_gate.py -- the company-style ambience layer.

Fake wavs only; whisper is NEVER run here (the veto is injected as a callable).
"""
import audioop
import json
import math
import struct
import wave

import pytest

from app.audio import ambience as cg
from app.scripts.check_leakage import _validate_manifest_spans

SR48 = 48000
AMP = 12000
QUIET_AMP = 60  # ~-58dBFS room tone -- below the VAD's -55dBFS absolute floor


def _write_vocals_wav(path, loud_spans, dur, quiet_spans=(), sr=SR48):
    """Mono 16-bit wav: 440Hz tone at AMP inside loud_spans, at QUIET_AMP inside
    quiet_spans, silence elsewhere."""
    n = int(dur * sr)
    buf = bytearray()
    for i in range(n):
        t = i / sr
        if any(a <= t < b for a, b in loud_spans):
            v = int(AMP * math.sin(2 * math.pi * 440 * t))
        elif any(a <= t < b for a, b in quiet_spans):
            v = int(QUIET_AMP * math.sin(2 * math.pi * 440 * t))
        else:
            v = 0
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


def _covered(regions, a, b):
    """True if [a, b) is fully inside the union of regions."""
    cur = a
    for s, e in sorted(regions):
        if s <= cur < e:
            cur = e
        if cur >= b:
            return True
    return cur >= b


def _intersects(regions, a, b):
    return any(s < b and e > a for s, e in regions)


# Test scene layout (10s):
#   0.2-0.9   quiet room tone (below VAD threshold)  -> kept, full volume
#   2.0-3.0   original speech (STT cue)              -> muted +-0.3s
#   4.0-4.6   energetic, veto REJECTS (missed speech)-> muted
#   6.0-6.8   energetic, veto KEEPS (laughter)       -> kept, 0dB
#   8.0-8.5   energetic, under a placed dub line     -> muted +-0.1s
SPEECH_SPANS = [(2.0, 3.0)]
DUB_SPANS = [(8.0, 8.6)]


def _veto_keep_laugh(vocals_path, candidates):
    out = []
    for a, b in candidates:
        keep = a < 6.8 and b > 6.0
        out.append({"start": a, "end": b, "keep": keep,
                    "text": "hahaha" if keep else "you thought I was laughing"})
    return out


@pytest.fixture()
def scene(tmp_path):
    vocals = _write_vocals_wav(
        tmp_path / "vocals.wav",
        loud_spans=[(2.0, 3.0), (4.0, 4.6), (6.0, 6.8), (8.0, 8.5)],
        quiet_spans=[(0.2, 0.9)],
        dur=10.0,
    )
    return vocals


# --- (1) mute-set composition --------------------------------------------------

def test_mute_set_covers_cues_unverified_vad_and_dub_spans(scene):
    mute, verdicts = cg.compute_mute_set(scene, SPEECH_SPANS, DUB_SPANS,
                                         veto=_veto_keep_laugh)
    # (a) original speech cue span +-0.3s
    assert _covered(mute, 2.0 - 0.3, 3.0 + 0.3)
    # (b) energetic region the veto rejected (fail-closed missed speech)
    assert _covered(mute, 4.05, 4.55)
    # (c) placed dub-line span +-0.1s
    assert _covered(mute, 8.0 - 0.1, 8.6 + 0.1)
    # verified laughter is NOT muted
    assert not _intersects(mute, 6.05, 6.75)
    # quiet room tone (below the VAD threshold) is NOT muted
    assert not _intersects(mute, 0.25, 0.85)
    # the verdicts carry the whisper transcripts for the manifest
    kept = [v for v in verdicts if v["keep"]]
    assert len(kept) == 1 and kept[0]["text"] == "hahaha"


def test_mute_set_fails_closed_when_veto_errors(scene):
    def veto_error(vocals_path, candidates):
        return [{"start": a, "end": b, "keep": False, "error": True,
                 "text": "<whisper unavailable>"} for a, b in candidates]

    mute, verdicts = cg.compute_mute_set(scene, SPEECH_SPANS, DUB_SPANS, veto=veto_error)
    # unverifiable energetic regions => muted (including the would-be laugh)
    assert _covered(mute, 6.05, 6.75)
    assert not any(v["keep"] for v in verdicts)


# --- (2) layer audio: 0dB kept spans, true-zero mute, quiet tone kept ------------

def test_ambience_layer_levels(scene, tmp_path):
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 10.0)
    out = str(tmp_path / "out.wav")
    cg.apply_company_ambience(mix, scene, SPEECH_SPANS, DUB_SPANS, out_path=out,
                              veto=_veto_keep_laugh)

    # verified laughter at ORIGINAL volume (0dB copy, not ducked)
    orig = _rms_span_48k(scene, 6.2, 6.6)
    got = _rms_span_48k(out, 6.2, 6.6)
    assert abs(got - orig) <= max(2, orig * 0.02)

    # muted spans are TRUE zero in their interior (not just quiet)
    with wave.open(out, "rb") as w:
        w.setpos(int(2.3 * 48000))
        assert w.readframes(int(0.4 * 48000)) == b"\x00" * (int(0.4 * 48000) * 4)
        w.setpos(int(8.1 * 48000))
        assert w.readframes(int(0.3 * 48000)) == b"\x00" * (int(0.3 * 48000) * 4)

    # quiet room tone below the VAD threshold survives at full volume
    orig_q = _rms_span_48k(scene, 0.3, 0.8)
    got_q = _rms_span_48k(out, 0.3, 0.8)
    assert abs(got_q - orig_q) <= max(2, orig_q * 0.05)


def test_crossfade_continuity_no_step(tmp_path):
    """A constant-amplitude signal through one mute boundary must ramp smoothly:
    no sample-to-sample jump bigger than the raised-cosine slope allows."""
    sr = 48000
    n = int(3.0 * sr)
    buf = b"".join(struct.pack("<h", 10000) for _ in range(n))
    vocals = str(tmp_path / "flat.wav")
    with wave.open(vocals, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(buf)

    layer = cg.build_ambience_layer(vocals, [(1.0, 2.0)])
    mono = struct.unpack("<%di" % (len(layer) // 4), layer)[::2]
    fade = int(round(cg.CROSSFADE_SEC * sr))
    assert 0.06 * sr <= fade <= 0.08 * sr  # 60-80ms crossfade requirement
    amp32 = 10000 << 16  # 16-bit input scaled up to the 32-bit mix width
    # interior of the mute region: true zero
    assert all(v == 0 for v in mono[int(1.2 * sr):int(1.8 * sr)])
    # far from the boundary: untouched
    assert all(v == amp32 for v in mono[int(0.2 * sr):int(0.8 * sr)])
    # continuity: the raised-cosine max slope is pi/2 * (amp/fade) per sample
    max_step = max(abs(mono[i] - mono[i - 1]) for i in range(1, len(mono)))
    assert max_step <= int(math.pi / 2 * amp32 / fade) + 2


# --- (3) manifest emission -------------------------------------------------------

def test_manifest_spans_split_and_validate(scene, tmp_path):
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 10.0)
    manifest_path = str(tmp_path / "gate_manifest.json")
    cg.apply_company_ambience(mix, scene, SPEECH_SPANS, DUB_SPANS,
                              veto=_veto_keep_laugh, manifest_path=manifest_path)
    m = json.load(open(manifest_path))
    assert m["mode"] == "company"
    assert len(m["kept"]) >= 1
    for k in m["kept"]:
        assert "text" in k and k["end"] - k["start"] <= 3.0
    # the emitted manifest must satisfy check_leakage's validation as-is
    assert _validate_manifest_spans(m["kept"], 10.0, mode=m.get("mode")) is None


def test_manifest_is_utf8_whatever_the_platform_encoding_is(scene, tmp_path):
    """A transcript is in the video's own language, so the manifest holds
    non-ASCII; app/pipeline.py reads it back as UTF-8. Writing it in the
    platform's locale encoding (cp949 on a Korean Windows) made the 5/6
    leakage gate skip itself with a UnicodeDecodeError on that machine.
    """
    mix = _write_silent_48k_stereo(tmp_path / "mix.wav", 10.0)
    manifest_path = str(tmp_path / "gate_manifest.json")

    def veto(vocals_path, candidates):
        return [{"start": a, "end": b, "keep": True, "text": "하하하"}
                for a, b in candidates]

    cg.apply_company_ambience(mix, scene, SPEECH_SPANS, DUB_SPANS,
                              veto=veto, manifest_path=manifest_path)
    # exactly how app/pipeline.py:_manifest_exclude_spans reads it
    m = json.load(open(manifest_path, encoding="utf-8"))
    assert m["kept"] and all(k["text"] == "하하하" for k in m["kept"])


def test_long_verified_span_is_split_at_quiet_dips(tmp_path):
    # one 4.5s energetic span with a clear quiet dip at ~2.2s into it
    vocals = _write_vocals_wav(tmp_path / "v.wav",
                               loud_spans=[(1.0, 3.1), (3.3, 5.5)],
                               dur=7.0)
    pieces = cg.split_span_at_dips(vocals, 1.0, 5.5, max_len=3.0)
    assert all(b - a <= 3.0 + 1e-6 for a, b in pieces)
    assert abs(pieces[0][0] - 1.0) < 1e-6 and abs(pieces[-1][1] - 5.5) < 1e-6
    for (a0, b0), (a1, b1) in zip(pieces, pieces[1:]):
        assert abs(b0 - a1) < 1e-6  # contiguous tiling, nothing lost
    # the chosen split sits in the quiet dip
    assert any(3.05 <= b <= 3.35 for _, b in pieces[:-1])


# --- (4) check_leakage validation: company mode marker ---------------------------

def test_leakage_manifest_cap_accepts_company_mode_marker():
    kept = [{"start": float(i * 3), "end": float(i * 3 + 2.5), "text": "hahaha"}
            for i in range(4)]  # 10s total, over the max(5s, 10% of 20s) = 5s cap
    # without the marker: rejected (cap unchanged)
    assert _validate_manifest_spans(kept, 20.0) is not None
    # with the company marker: accepted (the layer legitimately keeps more)
    assert _validate_manifest_spans(kept, 20.0, mode="company") is None
    # per-span cap still enforced even in company mode
    bad = [{"start": 0.0, "end": 4.0, "text": "hahaha"}]
    assert _validate_manifest_spans(bad, 20.0, mode="company") is not None
