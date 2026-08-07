"""Leakage verification gate (app/scripts/check_leakage.py): given a finished
dub mix and the original vocals stem, measure how much ORIGINAL speech is
still audible in the mix. This is the mandatory pre-delivery check born from
the 2026-07-30 rejection (original voice audible under the dub in all four
delivered videos).

Metric per 100ms window, restricted to windows where the vocals stem carries
speech (energy VAD): g = lag-0 least-squares projection of the vocals onto
the mix (with a shifted-lag null significance test, so TTS-vs-vocals chance
correlation doesn't false-alarm); residual = vocals RMS * |g| (absolute dBFS
level of leaked original speech); rel = residual vs the mix's own RMS.
FAIL when residual > abs_floor_db AND rel > rel_bar_db on any window.
"""
import wave

from app.scripts.check_leakage import measure_leakage


def _write_wav(path, framerate, nchannels, sampwidth, frames: bytes):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frames)


def _frames(vals, nchannels=1):
    return b"".join(v.to_bytes(2, "little", signed=True) * nchannels for v in vals)


def _vocals_vals(total_sec=4.0, burst=(1.0, 2.0), quiet=30, loud=9000, sr=48000):
    n = int(total_sec * sr)
    vals = [quiet] * n
    for i in range(int(burst[0] * sr), int(burst[1] * sr)):
        vals[i] = loud
    return vals


def test_unity_leak_fails_loudly(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr=sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    # worst case: the finished mix IS the original vocals (nothing gated)
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(vals, nchannels=2))

    r = measure_leakage(str(final), str(vocals))

    assert r["pass"] is False
    assert r["max_rel_db"] > -5.0            # leak as loud as the mix itself
    assert any(1.0 <= w["t"] <= 2.0 for w in r["fail_windows"])


def test_deeply_ducked_mix_passes(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr=sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    # mix = loud uncorrelated "TTS" + original ducked by 40dB
    mix = []
    for i, v in enumerate(vals):
        tts = 8000 if (1.0 * sr) <= i < (2.0 * sr) and (i // 24) % 2 == 0 else \
              -8000 if (1.0 * sr) <= i < (2.0 * sr) else 0
        mix.append(max(-32768, min(32767, tts + int(v * 0.01))))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(mix, nchannels=2))

    r = measure_leakage(str(final), str(vocals))

    assert r["pass"] is True
    assert r["fail_windows"] == []


def test_faint_absolute_residue_in_a_quiet_mix_passes(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr=sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    # mix = original at -54dB and nothing else: rel is huge (the mix IS the
    # residue) but the absolute level is below audibility -> must still pass
    mix = [int(v * 0.002) for v in vals]
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(mix, nchannels=2))

    r = measure_leakage(str(final), str(vocals))

    assert r["pass"] is True


def test_reports_max_rel_and_counts(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr=sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(vals, nchannels=2))

    r = measure_leakage(str(final), str(vocals))

    assert r["n_windows"] > 0
    assert r["n_fail"] == len(r["fail_windows"]) > 0
    assert isinstance(r["max_rel_db"], float)


def test_fleeting_coincidence_blip_is_suspect_not_fail(tmp_path):
    sr = 48000
    vals = _vocals_vals(sr=sr)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    # mix: original well-ducked everywhere EXCEPT one 80ms window-sized blip of
    # unity correlation (models the dub voice phonetically coinciding with the
    # original for an instant -- e.g. both saying the name "Dent")
    mix = []
    for i, v in enumerate(vals):
        if int(1.40 * sr) <= i < int(1.48 * sr):
            mix.append(v)                     # 80ms of unity "leak"
        else:
            tts = 8000 if int(1.0 * sr) <= i < int(2.0 * sr) and (i // 24) % 2 == 0 else \
                  -8000 if int(1.0 * sr) <= i < int(2.0 * sr) else 0
            mix.append(max(-32768, min(32767, tts + int(v * 0.01))))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(mix, nchannels=2))

    r = measure_leakage(str(final), str(vocals))

    assert r["pass"] is True                  # too short to be a real leak
    assert len(r["suspect_windows"]) >= 1     # ...but it IS reported


# --- nonverbal whitelist awareness (laughter copied back on purpose must not
# --- read as a leak, while everything OUTSIDE the whitelist still must) ---

def test_whitelist_manifest_excludes_only_the_kept_span(tmp_path):
    import json
    import random

    from app.scripts.check_leakage import main

    sr = 48000
    n = int(4.0 * sr)
    rng = random.Random(7)  # two bursts must be UNcorrelated noise, not the
    # same DC value -- identical bursts also correlate at the shifted null
    # lags, which would (correctly) suppress the detection we assert on
    vals = [30] * n
    for i in range(int(1.0 * sr), int(2.0 * sr)):
        vals[i] = rng.randint(-9000, 9000)  # whitelisted laughter, original volume
    for i in range(int(3.0 * sr), int(3.5 * sr)):
        vals[i] = rng.randint(-9000, 9000)  # NOT whitelisted: a genuine leak
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(vals, nchannels=2))

    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps(
        {"kept": [{"start": 1.0, "end": 2.0, "text": "Hehehe.", "keep": True}],
         "rejected": []}))

    # whole laugh whitelisted + genuine leak still present -> still FAIL at 3.0-3.5s
    assert main([str(final), str(vocals), str(manifest)]) == 1

    manifest_all = tmp_path / "m2.json"
    manifest_all.write_text(json.dumps(
        {"kept": [{"start": 1.0, "end": 2.0, "text": "Hehehe.", "keep": True},
                  {"start": 3.0, "end": 3.5, "text": "", "keep": True}],
         "rejected": []}))
    assert main([str(final), str(vocals), str(manifest_all)]) == 0

    # without a manifest the same mix fails (default behavior unchanged)
    assert main([str(final), str(vocals)]) == 1


def test_manifest_validation_rejects_abuse(tmp_path):
    # Important-2: the gate must not blindly trust a manifest -- a span list
    # can otherwise blank the entire measurement ({"start":0,"end":9999}).
    import json

    from app.scripts.check_leakage import main

    sr = 48000
    dur = 12.0
    silent = b"\x00" * (int(dur * sr) * 2)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, silent)
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, silent * 2)

    def run(kept):
        p = tmp_path / "m.json"
        p.write_text(json.dumps({"kept": kept, "rejected": []}))
        return main([str(final), str(vocals), str(p)])

    assert run([]) == 0                                            # sanity: clean mix passes
    assert run([{"start": 0, "end": 9999, "text": ""}]) == 1       # whole-file span
    assert run([{"start": 1.0, "end": 4.5, "text": ""}]) == 1      # single span > 3.0s
    assert run([{"start": 1.0, "end": 2.0}]) == 1                  # no whisper transcript field
    assert run([{"start": 2.0, "end": 1.0, "text": ""}]) == 1      # end <= start
    assert run([{"start": float(i * 3), "end": float(i * 3 + 2.5), "text": ""}
                for i in range(3)]) == 1                           # 7.5s total > max(5, 1.2)
    assert run([{"start": 1.0, "end": 2.5, "text": "Hehehe."}]) == 0  # sane manifest ok


def test_exclude_spans_skip_boundary_straddling_windows(tmp_path):
    # Minor-5: a 100ms window STARTING inside the measured area but reaching
    # into an excluded span partially correlates with the approved copy and
    # showed up as a permanent suspect blip -- windows overlapping an excluded
    # span must be skipped entirely (conservatism outside is unchanged).
    import random

    from app.scripts.check_leakage import measure_leakage

    sr = 48000
    rng = random.Random(11)
    vals = [30] * int(4.0 * sr)
    for i in range(int(1.0 * sr), int(2.0 * sr)):
        vals[i] = rng.randint(-9000, 9000)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, sr, 1, 2, _frames(vals))
    final = tmp_path / "final.wav"
    _write_wav(final, sr, 2, 2, _frames(vals, nchannels=2))

    r = measure_leakage(str(final), str(vocals), exclude_spans=[(1.0, 2.0)])

    assert r["pass"] is True
    assert r["fail_windows"] == []
    assert r["suspect_windows"] == []
