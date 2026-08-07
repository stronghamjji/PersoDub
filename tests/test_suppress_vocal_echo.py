"""Vocal-echo suppressor (app/scripts/suppress_vocal_echo.py): the Qwen
sidecar can echo a low-level fragment of the speaker-reference audio into the
head of a synthesized line (prompt bleed). When the reference span overlaps
the line's own timeline, that echo is the ORIGINAL language landing at almost
its original time -- inside the dub line itself, where no vocals gating can
reach it. The suppressor cancels it: on persistent leak runs found by the
leakage gate, subtract the least-squares projection of the vocals stem from
the mix, window by window.
"""
import wave

from app.scripts.check_leakage import measure_leakage
from app.scripts.suppress_vocal_echo import suppress_vocal_echo


def _write_wav(path, framerate, nchannels, sampwidth, frames: bytes):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frames)


def _frames(vals, nchannels=1):
    return b"".join(v.to_bytes(2, "little", signed=True) * nchannels for v in vals)


def _vocals_vals(sr=48000, total=4.0):
    import math
    n = int(total * sr)
    vals = [30] * n
    for i in range(int(1.0 * sr), int(2.0 * sr)):
        # speech-like: 180Hz tone with a slow wobble so windows differ
        vals[i] = int(9000 * math.sin(2 * math.pi * 180 * i / sr) *
                      (0.7 + 0.3 * math.sin(2 * math.pi * 1.5 * i / sr)))
    return vals


def test_suppresses_a_persistent_aligned_echo(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    # mix = loud uncorrelated TTS + 30% of the original (a strong echo)
    mix = []
    for i, v in enumerate(vals):
        tts = 8000 if int(1.0 * sr) <= i < int(2.0 * sr) and (i // 24) % 2 == 0 else \
              -8000 if int(1.0 * sr) <= i < int(2.0 * sr) else 0
        mix.append(max(-32768, min(32767, tts + int(v * 0.3))))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(mix, nchannels=2))

    before = measure_leakage(str(final), str(vocals))
    assert before["pass"] is False  # the echo is a real persistent leak

    out = tmp_path / "fixed.wav"
    n_runs = suppress_vocal_echo(str(final), str(vocals), str(out))
    assert n_runs >= 1

    after = measure_leakage(str(out), str(vocals))
    assert after["pass"] is True
    assert after["max_rel_db"] < before["max_rel_db"] - 6.0


def test_leaves_a_clean_mix_untouched(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    mix = []
    for i, v in enumerate(vals):
        tts = 8000 if int(1.0 * sr) <= i < int(2.0 * sr) and (i // 24) % 2 == 0 else \
              -8000 if int(1.0 * sr) <= i < int(2.0 * sr) else 0
        mix.append(max(-32768, min(32767, tts + int(v * 0.005))))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(mix, nchannels=2))

    out = tmp_path / "fixed.wav"
    n_runs = suppress_vocal_echo(str(final), str(vocals), str(out))

    assert n_runs == 0
    with wave.open(str(final), "rb") as a, wave.open(str(out), "rb") as b:
        assert a.readframes(a.getnframes()) == b.readframes(b.getnframes())
