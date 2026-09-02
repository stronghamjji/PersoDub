"""place_lines: resample + place per-line wavs over the background track.

Builds tiny synthetic wavs with the stdlib wave module (no external audio deps).
"""
import audioop
import struct
import wave

from app import qwen_assemble as qa
from app.qwen_assemble import (
    GAIN_MAX,
    GAIN_MIN,
    MIX_WIDTH,
    NCHANNELS,
    SR,
    gate_vocals_chunks,
    match_line_gains,
    place_lines,
)


def _write_wav(path, framerate, nchannels, sampwidth, frames: bytes):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frames)


def _const_frames(value: int, n: int, nchannels: int) -> bytes:
    """n frames of a constant 16-bit sample value, repeated across channels."""
    one = value.to_bytes(2, "little", signed=True)
    return (one * nchannels) * n


def test_place_lines_writes_48k_stereo_output(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, 44100, 2, 2, _const_frames(0, 44100, 2))  # 1s silence @44.1k stereo

    line = tmp_path / "line0.wav"
    _write_wav(line, 24000, 1, 2, _const_frames(1000, 2400, 1))  # 0.1s tone @24k mono

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.0], str(out))

    with wave.open(str(out), "rb") as w:
        assert w.getframerate() == SR
        assert w.getnchannels() == 2
        assert w.getsampwidth() == 2
        # background was ~1s @44.1k -> resampled to 48k, should stay close to 1s
        assert abs(w.getnframes() - SR) < SR * 0.02


def test_place_lines_stretch_watchdog_logs_rate_near_1(tmp_path):
    # No time-stretch anywhere in this app -- the resample-only path should always log a
    # stretch_rate of (very close to) 1.000, with no warning.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    line = tmp_path / "line0.wav"
    _write_wav(line, 24000, 1, 2, _const_frames(1000, 2400, 1))  # 0.1s @24k mono

    out = tmp_path / "out.wav"
    logs = []
    place_lines(str(bg), [str(line)], [0.0], str(out), log=logs.append)

    rate_logs = [m for m in logs if "stretch_rate line 0" in m]
    assert len(rate_logs) == 1
    rate = float(rate_logs[0].split(":")[1].strip().split(" ")[0])
    assert abs(rate - 1.0) <= 0.001  # within the watchdog's own tolerance
    assert not any("STRETCH WATCHDOG" in m for m in logs)  # no warning for a normal resample


def test_place_lines_stretch_watchdog_warns_on_deviation(tmp_path, monkeypatch):
    # Simulate a regression (e.g. someone adding a hidden speed-up) by making the resample
    # step return audio shorter than it should be for its source duration -- the watchdog
    # must catch this loudly.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(1000, 4800, 1))  # 0.1s @48k mono

    real_resample = qa._to_48k_stereo_pcm16

    def half_speed_resample(data, sr, w, ch):
        out = real_resample(data, sr, w, ch)
        return out[: len(out) // 2]  # half the frames -> half the duration -> stretch_rate ~0.5

    monkeypatch.setattr(qa, "_to_48k_stereo_pcm16", half_speed_resample)

    out = tmp_path / "out.wav"
    logs = []
    place_lines(str(bg), [str(line)], [0.0], str(out), log=logs.append)

    warnings = [m for m in logs if "STRETCH WATCHDOG" in m]
    assert len(warnings) == 1
    assert "line 0" in warnings[0]


def test_place_lines_positions_line_at_cue_start(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR * 2, 2))  # 2s silence @48k stereo already

    line = tmp_path / "line0.wav"
    tone = _const_frames(5000, 4800, 1)  # 0.1s tone @48k mono
    _write_wav(line, SR, 1, 2, tone)

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [1.0], str(out))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    bytes_per_frame = 4  # 16-bit stereo
    pos = int(1.0 * SR) * bytes_per_frame
    # right before the placed tone: still silence
    assert data[pos - bytes_per_frame:pos] == b"\x00\x00\x00\x00"
    # at the placed tone: non-zero (the tone sample, both channels)
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    assert sample == 5000


def test_place_lines_skips_none_paths(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    out = tmp_path / "out.wav"
    # must not raise when a line failed to synthesize (None placeholder)
    place_lines(str(bg), [None], [0.5], str(out))
    with wave.open(str(out), "rb") as w:
        assert w.getnframes() > 0


def test_place_lines_overlap_fades_tail_before_next_line_starts(tmp_path):
    # Deliberate behavior change from the old "overlap sums" model: a line that
    # would still be sounding when the next line starts must fade out first,
    # not sum with it (ported from desktop-app's anti-overlap rule).
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))  # 1s silence

    line_a = tmp_path / "a.wav"
    _write_wav(line_a, SR, 1, 2, _const_frames(8000, int(0.3 * SR), 1))  # 0.3s tone
    line_b = tmp_path / "b.wav"
    _write_wav(line_b, SR, 1, 2, _const_frames(2000, 4800, 1))  # 0.1s @2000

    out = tmp_path / "out.wav"
    # a starts at 0.2s and (if untouched) would still be sounding at 0.5s,
    # well past b's start at 0.4s.
    place_lines(str(bg), [str(line_a), str(line_b)], [0.2, 0.4], str(out))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    assert sample_at(0.25) == 8000  # well before b starts: a is still audible, unfaded
    assert sample_at(0.4) == 2000   # at b's start: only b -- a has faded out, not summed (would be 10000)


def test_place_lines_identical_starts_resolved_deterministically_not_summed(tmp_path):
    # desktop-app's `>` comparison let two lines sharing the exact same start
    # slip past its overlap check unbounded. Stable-sorting by (start, index)
    # instead means the pair is still detected as a collision.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    line_a = tmp_path / "a.wav"
    _write_wav(line_a, SR, 1, 2, _const_frames(1000, 4800, 1))
    line_b = tmp_path / "b.wav"
    _write_wav(line_b, SR, 1, 2, _const_frames(2000, 4800, 1))

    out = tmp_path / "out.wav"
    logs = []
    place_lines(str(bg), [str(line_a), str(line_b)], [0.2, 0.2], str(out), log=logs.append)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(0.2 * SR) * 4
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    assert sample == 2000  # the later-sorted line wins, not summed with the earlier one
    collisions = [m for m in logs if "collides" in m]
    assert len(collisions) == 1  # collision is logged, not silent


def test_place_lines_near_collision_under_30ms_warns_instead_of_silent_drop(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    line_a = tmp_path / "a.wav"
    _write_wav(line_a, SR, 1, 2, _const_frames(1000, 4800, 1))
    line_b = tmp_path / "b.wav"
    _write_wav(line_b, SR, 1, 2, _const_frames(2000, 4800, 1))

    out = tmp_path / "out.wav"
    logs = []
    # only 10ms apart -- after the 30ms end-headroom there is no room for a at
    # all, so it must be dropped WITH a warning, not silently.
    place_lines(str(bg), [str(line_a), str(line_b)], [0.2, 0.21], str(out), log=logs.append)

    warnings = [m for m in logs if "Warning:" in m and "collides" in m]
    assert len(warnings) == 1


def test_place_lines_applies_gains_when_given(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))  # 1s silence
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(1000, 4800, 1))  # 0.1s @1000

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.2], str(out), gains=[2.0])

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(0.2 * SR) * 4
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    assert sample == 2000  # gained 2x before being placed


def test_place_lines_none_gain_means_unchanged(tmp_path):
    # A dub materialized from Perso has no measured loudness, so its manifest
    # carries gain None for every line -- that must mean "as is", not a crash.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))  # 1s silence
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(1000, 4800, 1))  # 0.1s @1000

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.2], str(out), gains=[None])

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(0.2 * SR) * 4
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    assert sample == 1000  # placed at its own loudness


def test_place_lines_peak_guard_avoids_hard_clipping(tmp_path):
    # Background and a (gained) line both near full-scale and fully overlapping --
    # a naive 16-bit sum would hard-clip (flat-top at 32767). The peak guard should
    # instead scale the whole mix down so the result stays proportional, not clipped.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(30000, 4800, 2))  # 0.1s loud tone
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(30000, 4800, 1))  # 0.1s loud tone, same span

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.0], str(out))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    sample = int.from_bytes(data[0:2], "little", signed=True)
    assert sample < 32767  # not hard-clipped
    assert 32000 <= sample <= 32460  # scaled down close to the 0.99 ceiling, not flattened


def test_place_lines_peak_guard_is_noop_for_normal_levels(tmp_path):
    # Regression: ordinary (non-clipping) levels must pass through unscaled.
    # Two non-overlapping lines (far enough apart to not trigger the anti-overlap
    # fade) so this purely tests the peak guard, not the overlap rule.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))
    line_a = tmp_path / "a.wav"
    _write_wav(line_a, SR, 1, 2, _const_frames(1000, 4800, 1))
    line_b = tmp_path / "b.wav"
    _write_wav(line_b, SR, 1, 2, _const_frames(2000, 4800, 1))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line_a), str(line_b)], [0.2, 0.5], str(out))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    assert sample_at(0.2) == 1000
    assert sample_at(0.5) == 2000


# --- match_line_gains -------------------------------------------------------

def _write_mono_wav(path, framerate, value, n):
    _write_wav(path, framerate, 1, 2, _const_frames(value, n, 1))


def test_match_line_gains_boosts_quiet_line_toward_loud_original(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 6000, 16000)  # 1s @6000 RMS
    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 2000, 12000)  # 0.5s @2000 RMS

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [str(line)])
    assert len(gains) == 1
    assert abs(gains[0] - 3.0) < 0.05  # 6000/2000


def test_match_line_gains_reduces_loud_line_toward_quiet_original(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 500, 16000)
    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 8000, 12000)

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [str(line)])
    assert gains[0] == GAIN_MIN  # 500/8000 = 0.0625, clamped up to the floor


def test_match_line_gains_clamps_extreme_ratio_to_max(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 20000, 16000)
    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 50, 12000)

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [str(line)])
    assert gains[0] == GAIN_MAX  # 20000/50 = 400, clamped down to the ceiling


def test_match_line_gains_silent_original_span_falls_back_to_1(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 0, 16000)  # silent original
    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 5000, 12000)  # loud line

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [str(line)])
    assert gains[0] == 1.0


def test_match_line_gains_out_of_range_cue_falls_back_to_1(tmp_path):
    # cue span entirely past the end of the (short) vocals file -- no original signal
    # to measure, so it must not raise and must fall back to 1.0.
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 6000, 1600)  # only 0.1s long
    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 2000, 12000)

    gains = match_line_gains(str(vocals), [{"start": 5.0, "end": 6.0}], [str(line)])
    assert gains[0] == 1.0


def test_match_line_gains_missing_line_falls_back_to_1(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 6000, 16000)

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [None])
    assert gains[0] == 1.0


def test_match_line_gains_multiple_lines_independent(tmp_path):
    vocals = tmp_path / "vocals.wav"
    # 2s: first half loud (6000), second half quiet (600)
    with wave.open(str(vocals), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        one_loud = (6000).to_bytes(2, "little", signed=True)
        one_quiet = (600).to_bytes(2, "little", signed=True)
        w.writeframes(one_loud * 16000 + one_quiet * 16000)

    line0 = tmp_path / "line0.wav"
    _write_mono_wav(line0, 24000, 2000, 12000)
    line1 = tmp_path / "line1.wav"
    _write_mono_wav(line1, 24000, 2000, 12000)

    cues = [{"start": 0.0, "end": 1.0}, {"start": 1.0, "end": 2.0}]
    # gain_step_max=0 disables the adjacent-line cap (see the dedicated cap
    # tests below) so this test isolates each line's own gain computation.
    gains = match_line_gains(str(vocals), cues, [str(line0), str(line1)], gain_step_max=0)
    assert abs(gains[0] - 3.0) < 0.05   # 6000/2000, loud original -> line boosted
    assert abs(gains[1] - 0.3) < 0.02   # 600/2000, quiet original -> line brought down (within clamp)


# --- gate_vocals_chunks (faithful mix: preserve laughter/breaths between lines) ---

def _sample_at_frame(chunks, frame_idx, ch=0):
    """Look up one MIX_WIDTH sample out of a list of (chunk_start_frame, bytes)
    pairs, as gate_vocals_chunks yields them."""
    bytes_per_frame = MIX_WIDTH * NCHANNELS
    for start_frame, data in chunks:
        n = len(data) // bytes_per_frame
        if start_frame <= frame_idx < start_frame + n:
            off = (frame_idx - start_frame) * bytes_per_frame + ch * MIX_WIDTH
            return struct.unpack("<i", data[off:off + 4])[0]
    return None


def test_gate_vocals_chunks_silences_speech_and_preserves_gaps(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))  # 1s constant tone (e.g. a laugh/breath bed)

    # gate_pad_sec=0.0: tests the core gating boundary itself, not the padding
    # feature (see the padding/merge tests below for that). gate_duck_db=inf:
    # old hard-mute behavior, isolating the boundary mechanism from the new
    # default ducking level (see the dedicated ducking tests below for that).
    chunks = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0, gate_duck_db=float("inf")))

    before = _sample_at_frame(chunks, int(0.1 * SR))
    inside = _sample_at_frame(chunks, int(0.45 * SR))
    after = _sample_at_frame(chunks, int(0.9 * SR))

    assert before != 0 and after != 0  # outside the dialogue span: original vocals preserved
    assert before == after
    assert inside == 0  # inside the dialogue span: silenced


def test_gate_vocals_chunks_crossfade_is_a_smooth_ramp_not_a_jump(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    chunks = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0))
    full = _sample_at_frame(chunks, int(0.1 * SR))
    # inside the 60ms ramp-down window [0.24s, 0.3s) leading into the span
    ramp_mid = _sample_at_frame(chunks, int(0.27 * SR))
    assert 0 < ramp_mid < full  # strictly between full volume and silence -- a ramp, not a jump


def test_gate_vocals_chunks_streams_in_bounded_chunks_not_the_whole_file(tmp_path):
    # A memory-bounded chunk/generator API is a hard requirement (a whole-file
    # numpy float approach costs ~13.8GB/hour of video). This asserts the shape
    # of that streaming: multiple, size-bounded chunks -- not process RSS.
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(1000, SR * 2, 1))  # 2s of audio
    small_chunk = 4800  # 0.1s of output frames per chunk

    chunks = list(gate_vocals_chunks(str(vocals), [], chunk_frames=small_chunk))

    assert len(chunks) > 1  # genuinely streamed, not one giant blob
    bytes_per_frame = MIX_WIDTH * NCHANNELS
    for _start_frame, data in chunks:
        assert len(data) <= small_chunk * bytes_per_frame  # each chunk stays bounded in size

    total_frames = sum(len(d) // bytes_per_frame for _, d in chunks)
    assert abs(total_frames - SR * 2) <= 1  # chunks are contiguous and cover the whole file


def test_place_lines_preserves_original_vocals_between_lines_when_gated(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))  # 1s silent background

    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))  # constant tone (e.g. a breath/laugh)

    out = tmp_path / "out.wav"
    # No TTS line placed (path=None) -- the dub track itself is silent, so
    # anything audible outside the dialogue span must come from the gated
    # original vocals. gate_duck_db=inf isolates this from the new default
    # ducking level (see the dedicated ducking tests for that).
    place_lines(str(bg), [None], [0.0], str(out), vocals_path=str(vocals),
               speech_regions=[(0.3, 0.6)], gate_pad_sec=0.0, gate_duck_db=float("inf"))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    assert sample_at(0.1) != 0   # before dialogue: original vocals audible
    assert sample_at(0.45) == 0  # during dialogue: silenced
    assert sample_at(0.9) != 0   # after dialogue: original vocals audible


# --- gate padding (coarse STT timestamps can leave original-language leakage
# right at a cue edge unless the gated span is padded a bit wider) ---

def test_gate_vocals_chunks_pad_widens_the_silenced_span(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    # a point 50ms before the raw region's start -- inside a 0.2s pad, but
    # outside a 0s pad (only within the 60ms crossfade there, still audible).
    # gate_duck_db=inf isolates the padding mechanism from the new default
    # ducking level (see the dedicated ducking tests below for that).
    probe = int(0.25 * SR)
    unpadded = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0, gate_duck_db=float("inf")))
    padded = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.2, gate_duck_db=float("inf")))

    assert _sample_at_frame(unpadded, probe) != 0  # no padding: still audible this close to the cue edge
    assert _sample_at_frame(padded, probe) == 0    # padded: silenced ahead of a (possibly-late) cue edge


def test_gate_vocals_chunks_merges_regions_that_overlap_after_padding(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    # Two regions with a 0.1s gap between them (0.3-0.4 and 0.5-0.6). A 0.1s pad
    # each side widens them to (0.2-0.5) and (0.4-0.7), which overlap -- they
    # must merge into one continuous silence, not leave a preserved sliver at
    # the midpoint where two separately-padded regions would almost, but not
    # quite, touch. gate_duck_db=inf isolates the merge mechanism from the new
    # default ducking level.
    chunks = list(gate_vocals_chunks(str(vocals), [(0.3, 0.4), (0.5, 0.6)], gate_pad_sec=0.1, gate_duck_db=float("inf")))
    mid = _sample_at_frame(chunks, int(0.45 * SR))
    assert mid == 0


def test_gate_vocals_chunks_uses_config_default_pad_when_not_overridden(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_PAD_SEC", 0.2)

    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))
    # gate_pad_sec not passed -> falls back to app.config.QWEN_GATE_PAD_SEC.
    # gate_duck_db=inf isolates the pad-default mechanism from the new default
    # ducking level.
    chunks = list(qa.gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_duck_db=float("inf")))

    probe = int(0.25 * SR)
    assert _sample_at_frame(chunks, probe) == 0  # picked up the monkeypatched 0.2s default


# --- gate ducking (Fix 1: full-mute -> attenuation, so a gated span isn't a
# stark digital-silence hole -- room tone/ambience from the vocals stem, and a
# low level of the original-language dialogue, bleeds through instead) ---

def test_gate_vocals_chunks_default_ducks_instead_of_hard_muting(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    chunks = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0))
    full = _sample_at_frame(chunks, int(0.1 * SR))
    inside = _sample_at_frame(chunks, int(0.45 * SR))

    assert inside != 0  # not hard-muted anymore
    expected_factor = 10 ** (-18 / 20.0)  # default QWEN_GATE_DUCK_DB=18
    assert abs(inside / float(full) - expected_factor) < 0.01


def test_gate_vocals_chunks_duck_db_env_configurable(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_DUCK_DB", 6.0)
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    chunks = list(qa.gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0))
    full = _sample_at_frame(chunks, int(0.1 * SR))
    inside = _sample_at_frame(chunks, int(0.45 * SR))

    assert abs(inside / float(full) - 10 ** (-6.0 / 20.0)) < 0.01


def test_gate_vocals_chunks_duck_db_param_overrides_config(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_DUCK_DB", 6.0)  # would be ignored -- param wins
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    chunks = list(qa.gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0, gate_duck_db=24.0))
    full = _sample_at_frame(chunks, int(0.1 * SR))
    inside = _sample_at_frame(chunks, int(0.45 * SR))

    assert abs(inside / float(full) - 10 ** (-24.0 / 20.0)) < 0.01


def test_gate_vocals_chunks_crossfade_ramps_to_duck_level_not_zero(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    chunks = list(gate_vocals_chunks(str(vocals), [(0.3, 0.6)], gate_pad_sec=0.0, gate_duck_db=18.0))
    full = _sample_at_frame(chunks, int(0.1 * SR))
    ramp_mid = _sample_at_frame(chunks, int(0.27 * SR))  # inside the 60ms ramp-down window
    body = _sample_at_frame(chunks, int(0.45 * SR))      # settled deep in the ducked body

    duck_factor = 10 ** (-18.0 / 20.0)
    assert abs(body / float(full) - duck_factor) < 0.01
    # the ramp midpoint must sit strictly between full and the (nonzero) duck
    # level, not between full and zero
    assert body < ramp_mid < full


# --- lead/tail silence trimming (Fix 2: Qwen's TTS output can start with real
# dead air, which otherwise opens a silent hole right after the cue start,
# drags dub_rms down with silence instead of voice, and makes the line sound
# longer than its real speech) ---

def test_trim_lead_tail_silence_removes_lead_and_tail(tmp_path):
    lead = _const_frames(0, int(0.3 * SR), 1)    # 0.3s silence
    tone = _const_frames(5000, int(0.2 * SR), 1)  # 0.2s voice
    tail = _const_frames(0, int(0.1 * SR), 1)    # 0.1s silence
    data = lead + tone + tail

    trimmed = qa._trim_lead_tail_silence(data, 2, 1, SR)

    assert trimmed == tone


def test_trim_lead_tail_silence_caps_lead_trim(tmp_path):
    lead = _const_frames(0, int(0.9 * SR), 1)     # 0.9s of lead silence
    tone = _const_frames(5000, int(0.2 * SR), 1)  # 0.2s voice
    data = lead + tone

    trimmed = qa._trim_lead_tail_silence(data, 2, 1, SR, lead_cap_sec=0.3)

    # only 0.3s of the 0.9s lead trimmed -> 0.6s of silence remains before the tone
    expected_len = int(0.6 * SR) * 2 + len(tone)
    assert len(trimmed) == expected_len
    assert trimmed[:2] == b"\x00\x00"
    assert trimmed[-2:] == (5000).to_bytes(2, "little", signed=True)


def test_trim_lead_tail_silence_uses_config_default_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_TRIM_LEAD_SEC", 0.3)
    lead = _const_frames(0, int(0.9 * SR), 1)
    tone = _const_frames(5000, int(0.2 * SR), 1)
    data = lead + tone

    trimmed = qa._trim_lead_tail_silence(data, 2, 1, SR)  # lead_cap_sec not passed

    expected_len = int(0.6 * SR) * 2 + len(tone)
    assert len(trimmed) == expected_len


def test_place_lines_trims_lead_silence_so_dub_starts_at_cue_start(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR, 2))  # 1s silent background

    line = tmp_path / "line0.wav"
    lead = _const_frames(0, int(0.3 * SR), 1)     # 0.3s of dead air, Qwen-style
    tone = _const_frames(5000, int(0.2 * SR), 1)
    tail = _const_frames(0, int(0.1 * SR), 1)
    _write_wav(line, SR, 1, 2, lead + tone + tail)

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.5], str(out))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    # without the trim, this would still be silence (the 0.3s lead hasn't
    # played out yet) -- with the trim, the voice starts right at cue start
    assert sample_at(0.5) == 5000


def test_match_line_gains_dub_rms_ignores_lead_tail_silence(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_mono_wav(vocals, 16000, 2000, 16000)  # 1s @2000 RMS original

    line = tmp_path / "line0.wav"
    lead = _const_frames(0, int(0.3 * 24000), 1)
    tone = _const_frames(2000, int(0.2 * 24000), 1)  # matches the original level exactly
    tail = _const_frames(0, int(0.1 * 24000), 1)
    _write_wav(line, 24000, 1, 2, lead + tone + tail)

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 1.0}], [str(line)])
    # without the trim, dub_rms would be diluted by the silence padding,
    # inflating the gain well above 1.0 even though the voiced level matches
    assert abs(gains[0] - 1.0) < 0.05


# --- gain stabilization (Fix 3: orig_rms measured on the voiced part of the
# cue span, not the whole span; adjacent-line gain step capped) ---

def test_match_line_gains_orig_rms_ignores_silence_within_cue_span(tmp_path):
    # cue span 0.0-2.0s: first half silent (the subtitle's timing is wider
    # than the actual speech), second half a loud constant tone.
    vocals = tmp_path / "vocals.wav"
    silence = _const_frames(0, 16000, 1)    # 1s silence @16kHz
    tone = _const_frames(8000, 16000, 1)    # 1s @8000
    _write_wav(vocals, 16000, 1, 2, silence + tone)

    line = tmp_path / "line0.wav"
    _write_mono_wav(line, 24000, 8000, 12000)  # matches the voiced original level exactly

    gains = match_line_gains(str(vocals), [{"start": 0.0, "end": 2.0}], [str(line)], gain_step_max=0)
    # without the fix, whole-span RMS (half silence) would understate the
    # original's real loudness and produce a gain well below 1.0
    assert abs(gains[0] - 1.0) < 0.05


def test_match_line_gains_caps_adjacent_gain_step(tmp_path):
    vocals = tmp_path / "vocals.wav"
    with wave.open(str(vocals), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        one_loud = (6000).to_bytes(2, "little", signed=True)
        one_quiet = (600).to_bytes(2, "little", signed=True)
        w.writeframes(one_loud * 16000 + one_quiet * 16000)

    line0 = tmp_path / "line0.wav"
    _write_mono_wav(line0, 24000, 2000, 12000)
    line1 = tmp_path / "line1.wav"
    _write_mono_wav(line1, 24000, 2000, 12000)

    cues = [{"start": 0.0, "end": 1.0}, {"start": 1.0, "end": 2.0}]
    # default QWEN_GAIN_STEP_MAX=1.5: the raw ratio here is 3.0/0.3 = 10x
    gains = match_line_gains(str(vocals), cues, [str(line0), str(line1)])
    assert abs(gains[0] - 3.0) < 0.05
    assert abs(gains[1] - gains[0] / 1.5) < 0.05  # capped, not the raw 0.3


def test_match_line_gains_gain_step_max_env_configurable(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GAIN_STEP_MAX", 2.0)
    vocals = tmp_path / "vocals.wav"
    with wave.open(str(vocals), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        one_loud = (6000).to_bytes(2, "little", signed=True)
        one_quiet = (600).to_bytes(2, "little", signed=True)
        w.writeframes(one_loud * 16000 + one_quiet * 16000)
    line0 = tmp_path / "line0.wav"
    _write_mono_wav(line0, 24000, 2000, 12000)
    line1 = tmp_path / "line1.wav"
    _write_mono_wav(line1, 24000, 2000, 12000)

    cues = [{"start": 0.0, "end": 1.0}, {"start": 1.0, "end": 2.0}]
    gains = qa.match_line_gains(str(vocals), cues, [str(line0), str(line1)])
    assert abs(gains[1] - gains[0] / 2.0) < 0.05


def test_cap_gain_steps_limits_adjacent_ratio():
    capped = qa._cap_gain_steps([1.0, 4.0, 0.1], 1.5)
    assert capped[0] == 1.0
    assert abs(capped[1] - 1.5) < 1e-9    # 1.0 * 1.5 ceiling
    assert abs(capped[2] - capped[1] / 1.5) < 1e-9  # stepped down from the already-capped previous


def test_cap_gain_steps_disabled_when_step_max_is_zero():
    assert qa._cap_gain_steps([1.0, 4.0, 0.1], 0) == [1.0, 4.0, 0.1]


# --- union gating (Fix 4: gate regions = padded source-cue spans UNION each
# placed line's actual playback span, so a dub line that runs past its own
# padded source-cue span doesn't leave the original vocals leaking through
# underneath it while the dub is still speaking) ---

def test_place_lines_gates_beyond_padded_source_span_for_a_long_running_line(tmp_path):
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, int(2.0 * SR), 2))  # 2s silent bg

    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, int(2.0 * SR), 1))  # constant original vocals throughout

    # TTS line placed at 0.5s, running a full 1s to 1.5s -- well past its own
    # source-cue span (0.5-0.8s, padded by 0.1 to 0.4-0.9s).
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(5000, int(1.0 * SR), 1))

    out = tmp_path / "out.wav"
    # gate_duck_db=inf isolates the union mechanism itself (hard mute) from
    # the default ducking level, which is covered by the dedicated ducking tests.
    place_lines(str(bg), [str(line)], [0.5], str(out), vocals_path=str(vocals),
               speech_regions=[(0.5, 0.8)], gate_pad_sec=0.1, gate_duck_db=float("inf"))

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    # 1.3s: inside the line's actual playback (0.5-1.5s) but outside the
    # padded source-cue span (0.4-0.9s). Without the union fix, the original
    # vocals would leak through here (unbounded by any gate) underneath the
    # still-playing dub line, summing to 5000+9000=14000. With the fix, the
    # vocals are gated here too -- only the dub line is audible.
    assert sample_at(1.3) == 5000

    # sanity check: well before the line/cue span, the original vocals are
    # still audible at full level (proves the setup isn't just always muted)
    assert sample_at(0.2) == 9000


def test_gate_vocals_chunks_extra_regions_are_unioned_unpadded(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    # extra_regions are exact spans -- not padded the way speech_regions are.
    chunks = list(gate_vocals_chunks(str(vocals), [], gate_pad_sec=0.2, gate_duck_db=float("inf"),
                                     extra_regions=[(0.3, 0.6)]))

    just_inside = _sample_at_frame(chunks, int(0.31 * SR))
    well_outside = _sample_at_frame(chunks, int(0.15 * SR))  # 150ms before the region start --
    # well clear of even the 60ms crossfade, but would be deep inside a
    # 0.2s-padded region's body (i.e. within [0.1, 0.8)) if extra_regions
    # were (incorrectly) padded the way speech_regions are.

    assert just_inside == 0    # gated (well inside the extra region's body)
    assert well_outside != 0   # NOT gated -- extra_regions aren't padded like speech_regions are



# --- energy-VAD speech detection on the vocals stem (root fix for original-
# dialogue leakage: gate regions must not depend solely on transcribed cue
# spans -- STT can miss lines entirely, leaving the original voice audible at
# full level under/next to the dub) ---

def _burst_frames(quiet: int, loud: int, spans, total_sec: float, sr: int) -> bytes:
    """Mono 16-bit frames: `quiet` everywhere, `loud` inside each [a, b) span."""
    n = int(total_sec * sr)
    vals = [quiet] * n
    for a, b in spans:
        for i in range(int(a * sr), min(n, int(b * sr))):
            vals[i] = loud
    return b"".join(v.to_bytes(2, "little", signed=True) for v in vals)


def test_detect_speech_regions_finds_a_loud_burst_over_a_quiet_floor(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 2.0)], 4.0, SR))

    regions = qa.detect_speech_regions(str(vocals))

    assert len(regions) == 1
    a, b = regions[0]
    # detected span must cover the burst (with some margin), not miss it
    assert a <= 1.0 and b >= 2.0
    # ...but not balloon out to the whole file either
    assert a >= 0.5 and b <= 2.8


def test_detect_speech_regions_ignores_a_sub_min_duration_blip(tmp_path):
    vocals = tmp_path / "vocals.wav"
    # 40ms blip -- shorter than the 100ms minimum speech duration
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 1.04)], 3.0, SR))

    assert qa.detect_speech_regions(str(vocals)) == []


def test_detect_speech_regions_merges_bursts_within_hangover(tmp_path):
    vocals = tmp_path / "vocals.wav"
    # two bursts 0.2s apart -- inside the hangover, so one continuous region
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 1.5), (1.7, 2.2)], 4.0, SR))

    regions = qa.detect_speech_regions(str(vocals))

    assert len(regions) == 1
    a, b = regions[0]
    assert a <= 1.0 and b >= 2.2


def test_detect_speech_regions_silent_file_has_no_regions(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(0, SR * 2, 1))

    assert qa.detect_speech_regions(str(vocals)) == []


def test_detect_speech_regions_separate_bursts_stay_separate(tmp_path):
    vocals = tmp_path / "vocals.wav"
    # 1.5s apart -- far beyond hangover + pad, must stay two regions
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(0.5, 1.0), (2.5, 3.0)], 4.0, SR))

    regions = qa.detect_speech_regions(str(vocals))

    assert len(regions) == 2


# --- two-tier ducking: VAD-detected SPEECH gets a deep duck (near-silent --
# it's actual original dialogue), while gated non-speech spans keep the
# gentler ambience duck ---

def test_gate_vocals_chunks_deep_regions_get_the_speech_duck(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR * 2, 1))

    chunks = list(gate_vocals_chunks(
        str(vocals), [(0.3, 1.5)], gate_pad_sec=0.0, gate_duck_db=18.0,
        deep_regions=[(0.6, 1.0)], speech_duck_db=40.0))

    full = _sample_at_frame(chunks, int(0.1 * SR))
    ambience = _sample_at_frame(chunks, int(0.45 * SR))   # gated, not speech
    speech = _sample_at_frame(chunks, int(0.8 * SR))      # gated AND speech-detected

    assert abs(ambience / float(full) - 10 ** (-18.0 / 20.0)) < 0.01
    assert abs(speech / float(full) - 10 ** (-40.0 / 20.0)) < 0.005


def test_gate_vocals_chunks_speech_duck_shallower_than_duck_is_a_noop(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _const_frames(9000, SR, 1))

    # speech_duck_db <= gate_duck_db must never RAISE the gated level
    chunks = list(gate_vocals_chunks(
        str(vocals), [(0.3, 0.9)], gate_pad_sec=0.0, gate_duck_db=18.0,
        deep_regions=[(0.4, 0.6)], speech_duck_db=12.0))

    full = _sample_at_frame(chunks, int(0.1 * SR))
    inside = _sample_at_frame(chunks, int(0.5 * SR))
    assert abs(inside / float(full) - 10 ** (-18.0 / 20.0)) < 0.01


def test_place_lines_gates_speech_that_stt_missed(tmp_path):
    # Original dialogue at 2.0-2.5s that STT produced no cue for: the energy
    # VAD must find it on the vocals stem and duck it anyway (this is the
    # exact failure mode behind "original voice audible under the dub").
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR * 4, 2))
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(0.5, 1.0), (2.0, 2.5)], 4.0, SR))
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(5000, int(0.4 * SR), 1))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.5], str(out), vocals_path=str(vocals),
               speech_regions=[(0.5, 1.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    # 2.25s: inside the un-transcribed speech burst. Must be deeply ducked --
    # not the untouched 9000 of a missed gate, and quieter than even the
    # ambience duck (two-tier: detected speech gets the deep duck).
    leak = abs(sample_at(2.25))
    assert leak < 9000 * 10 ** (-30.0 / 20.0)
    # 3.5s: quiet floor far from any speech -- passes through untouched
    assert abs(sample_at(3.5)) == 30


def test_place_lines_keep_nonspeech_disables_the_vad_gate_extension(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_KEEP_NONSPEECH", 1)
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR * 4, 2))
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(0.5, 1.0), (2.0, 2.5)], 4.0, SR))
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(5000, int(0.4 * SR), 1))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.5], str(out), vocals_path=str(vocals),
               speech_regions=[(0.5, 1.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(2.25 * SR) * 4
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    # A/B escape hatch: with the extension off, the untranscribed burst is
    # left untouched (old behavior -- preserves laughter at the cost of leaks)
    assert sample == 9000


def test_place_lines_vad_off_disables_detection_entirely(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_VAD", 0)
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR * 4, 2))
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(0.5, 1.0), (2.0, 2.5)], 4.0, SR))
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(5000, int(0.4 * SR), 1))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.5], str(out), vocals_path=str(vocals),
               speech_regions=[(0.5, 1.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(2.25 * SR) * 4
    sample = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    assert sample == 9000


# --- bed (background stem) residue duck: Demucs' background stem can carry a
# bleed of the original dialogue; where a detected-speech region's bed content
# is mostly that bleed (strong lag-0 correlation with the vocals stem), it
# must be ducked too, or the original voice stays audible under the dub even
# with the vocals stem perfectly gated ---

def test_place_lines_ducks_bed_that_is_mostly_vocal_residue(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 2.0)], 4.0, SR))
    # bed = scaled copy of the vocals during the speech burst (pure residue)
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 1, 2, _burst_frames(0, 900, [(1.0, 2.0)], 4.0, SR))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [], [], str(out), vocals_path=str(vocals),
               speech_regions=[(1.0, 2.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(1.5 * SR) * 4
    total = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    # bed residue (900) must be deeply ducked; the remaining level is the
    # vocals' own deep-ducked speech (9000 * 10^-40/20 = 90) plus the ducked
    # bed -- well under an un-ducked bed's 900.
    assert abs(total) < 200


def test_place_lines_keeps_uncorrelated_bed_content(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 2.0)], 4.0, SR))
    # bed = alternating-sign "music" at 900 -- same energy as the residue case
    # above but uncorrelated with the vocals at lag 0
    n = 4 * SR
    frames = bytearray()
    for i in range(n):
        val = 900 if (i // 24) % 2 == 0 else -900  # 1kHz square-ish wave
        frames += val.to_bytes(2, "little", signed=True)
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 1, 2, bytes(frames))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [], [], str(out), vocals_path=str(vocals),
               speech_regions=[(1.0, 2.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    # music during dialogue must survive: sample magnitude stays ~900 somewhere
    # inside the speech region (allow for the vocals' ducked bleed on top)
    peaks = []
    for t in (1.4, 1.5, 1.6):
        pos = int(t * SR) * 4
        peaks.append(abs(int.from_bytes(data[pos:pos + 2], "little", signed=True)))
    assert max(peaks) > 600


# --- order bug: bed residue-duck must run BEFORE dub lines are summed into
# the bed, or it can crush freshly-placed dub speech down to the speech-duck
# depth right along with the residue it's meant to clean up (the reported
# the reported "speech cuts off into silence" symptom -- see the leakage-analysis note, 2026-07-30) ---

def test_place_lines_residue_duck_runs_before_line_placement_so_dub_speech_survives(tmp_path):
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 2.0)], 4.0, SR))
    # bg = a scaled copy of the vocals burst -- pure Demucs residue bleed,
    # same pattern as test_place_lines_ducks_bed_that_is_mostly_vocal_residue.
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 1, 2, _burst_frames(0, 900, [(1.0, 2.0)], 4.0, SR))

    # dub line: a 0.1s square wave (uncorrelated with the constant-tone vocals
    # burst at lag 0, same trick as test_place_lines_keeps_uncorrelated_bed_content)
    # placed inside the same region the bed residue lives in.
    amp = 2000
    n = int(0.1 * SR)
    frames = bytearray()
    for i in range(n):
        val = amp if (i // 24) % 2 == 0 else -amp
        frames += val.to_bytes(2, "little", signed=True)
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, bytes(frames))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [1.2], str(out), vocals_path=str(vocals),
               speech_regions=[], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(1.2 * SR) * 4
    end = int(1.3 * SR) * 4
    rms = audioop.rms(data[pos:end], 2)
    # the dub line's own amplitude (2000) must survive -- if residue ducking
    # ran after placement (the bug), this span would be crushed toward the
    # -40dB speech-duck floor (measured ~100 on the unfixed code).
    assert rms > 1000


# --- QWEN_GATE_MODE: "preserve" hard-mutes detected speech instead of the
# default -40dB duck, so no original dialogue can bleed through even faintly
# (safe mode, the default, never reaches this code at all -- it doesn't mix
# the original vocals track in to begin with; see test_qwen_pipeline.py) ---

def test_place_lines_preserve_mode_hard_mutes_detected_speech(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_MODE", "preserve")
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 2, 2, _const_frames(0, SR * 4, 2))
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(0.5, 1.0), (2.0, 2.5)], 4.0, SR))
    line = tmp_path / "line0.wav"
    _write_wav(line, SR, 1, 2, _const_frames(5000, int(0.4 * SR), 1))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [str(line)], [0.5], str(out), vocals_path=str(vocals),
               speech_regions=[(0.5, 1.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())

    def sample_at(t):
        pos = int(t * SR) * 4
        return int.from_bytes(data[pos:pos + 2], "little", signed=True)

    # 2.25s: inside the un-transcribed speech burst that STT missed -- in
    # preserve mode this must be an exact hard mute, not the ~-40dB residual
    # the default speech duck leaves.
    assert sample_at(2.25) == 0
    # 3.5s: quiet floor far from any speech -- ambience still passes through
    assert abs(sample_at(3.5)) == 30


def test_place_lines_preserve_mode_hard_mutes_bed_residue_too(tmp_path, monkeypatch):
    monkeypatch.setattr(qa, "QWEN_GATE_MODE", "preserve")
    vocals = tmp_path / "vocals.wav"
    _write_wav(vocals, SR, 1, 2, _burst_frames(30, 9000, [(1.0, 2.0)], 4.0, SR))
    bg = tmp_path / "bg.wav"
    _write_wav(bg, SR, 1, 2, _burst_frames(0, 900, [(1.0, 2.0)], 4.0, SR))

    out = tmp_path / "out.wav"
    place_lines(str(bg), [], [], str(out), vocals_path=str(vocals),
               speech_regions=[(1.0, 2.0)], gate_pad_sec=0.1, gate_duck_db=18.0)

    with wave.open(str(out), "rb") as w:
        data = w.readframes(w.getnframes())
    pos = int(1.5 * SR) * 4
    total = int.from_bytes(data[pos:pos + 2], "little", signed=True)
    # both the bed residue and the vocals-gate's own speech pass are hard-
    # muted in preserve mode -- nothing left to sum at all.
    assert total == 0


# --- leading-pause borrow (v3: port of the 2026-07-30 emergency reassembly fix
# into the real pipeline -- a line whose audio would be cut by the next line's
# start may begin up to 0.8s BEFORE its cue start, as long as it keeps >=120ms
# after the previous placed line's audio ends; never any time-stretch) ---

def test_borrow_shifts_cut_line_earlier():
    # Line 1 (3.0s of audio) starts at 10.0 but line 2 starts at 12.0 -> ~1.03s
    # would be cut. Previous line 0 ends at 5.0, so a full 0.8s borrow is legal.
    starts = [4.0, 10.0, 12.0]
    durs = [1.0, 3.0, 1.0]
    new = qa.borrow_lead_starts(starts, durs)
    assert new[0] == 4.0 and new[2] == 12.0
    assert abs(new[1] - 9.2) < 1e-6  # capped at the 0.8s max borrow


def test_borrow_respects_previous_tail_gap():
    # Previous line's audio ends at 9.5 -> line 1 may move back only to 9.62
    # (>=120ms gap), not the full 0.8s.
    starts = [4.0, 10.0, 12.0]
    durs = [5.5, 3.0, 1.0]
    new = qa.borrow_lead_starts(starts, durs)
    assert abs(new[1] - 9.62) < 1e-6


def test_borrow_not_applied_when_line_fits():
    starts = [4.0, 10.0, 14.0]
    durs = [1.0, 3.0, 1.0]
    assert qa.borrow_lead_starts(starts, durs) == starts


def test_borrow_chain_effect_multiple_passes():
    # Line 1 borrows, freeing nothing for line 2 directly -- but line 2 is also
    # cut and can borrow only until 120ms after line 1's SHIFTED audio end.
    # line1: start 10, dur 2.5, next start 12 -> cut 0.53 -> shift to 9.47 (prev end 5.0, fine)
    # line1 audio now ends 11.97; line2: start 12, dur 2.0, next start 13.5 ->
    # cut 0.53 -> wants 11.47+..., floor = 11.97+0.12 = 12.09 > 12.0 -> no shift possible.
    starts = [4.0, 10.0, 12.0, 13.5]
    durs = [1.0, 2.5, 2.0, 1.0]
    new = qa.borrow_lead_starts(starts, durs)
    assert abs(new[1] - (12.0 - qa.END_HEADROOM_SECONDS - 2.5)) < 1e-6
    assert new[2] == 12.0  # floor blocked: never overlaps the previous tail
    assert new[3] == 13.5


def test_borrow_skips_missing_lines():
    # A None/0-duration line is not placed -- it neither borrows nor blocks others.
    starts = [4.0, 8.0, 10.0, 12.0]
    durs = [1.0, 0.0, 3.0, 1.0]
    new = qa.borrow_lead_starts(starts, durs)
    assert new[1] == 8.0
    assert abs(new[2] - 9.2) < 1e-6  # borrowed relative to line 0's tail, 0.8 cap
