"""Ultra-short-line merge grouping + energy-valley audio splitting
(app/qwen_merge.py) -- pure logic + synthetic-audio tests, no TTS/network."""
import struct
import wave

from app import config
from app.audio.merge import group_merge_units, split_unit_audio


def _cue(start, end, text="x"):
    return {"start": start, "end": end, "text": text}


# --- group_merge_units ------------------------------------------------------

def test_merges_ultra_short_line_with_same_speaker_previous_line():
    segments = [_cue(0.0, 2.0, "a normal line"), _cue(2.0, 2.3, "short")]
    seg_speakers = ["A", "A"]
    usable = [2.0, 0.3]  # line 1 is under the 0.8s default threshold
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1]]


def test_does_not_merge_when_line_is_not_short():
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 3.0, "b")]
    seg_speakers = ["A", "A"]
    usable = [2.0, 1.0]  # neither line is under threshold
    assert group_merge_units(segments, seg_speakers, usable) == [[0], [1]]


def test_does_not_merge_across_different_speakers():
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 2.3, "short")]
    seg_speakers = ["A", "B"]
    usable = [2.0, 0.3]
    assert group_merge_units(segments, seg_speakers, usable) == [[0], [1]]


def test_does_not_merge_when_gap_too_large():
    segments = [_cue(0.0, 2.0, "a"), _cue(4.0, 4.3, "short")]  # 2s gap > 1.5s default max
    seg_speakers = ["A", "A"]
    usable = [2.0, 0.3]
    assert group_merge_units(segments, seg_speakers, usable) == [[0], [1]]


def test_merges_when_gap_within_limit():
    segments = [_cue(0.0, 2.0, "a"), _cue(3.0, 3.3, "short")]  # 1.0s gap, within 1.5s default
    seg_speakers = ["A", "A"]
    usable = [2.0, 0.3]
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1]]


def test_first_line_never_merges_even_if_short():
    segments = [_cue(0.0, 0.3, "short first line")]
    seg_speakers = ["A"]
    usable = [0.3]
    assert group_merge_units(segments, seg_speakers, usable) == [[0]]


def test_chain_of_two_short_lines_merges_into_one_unit():
    # normal, short, short -- all same speaker, adjacent -> one 3-member unit
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 2.3, "b"), _cue(2.3, 2.5, "c")]
    seg_speakers = ["A", "A", "A"]
    usable = [2.0, 0.3, 0.2]
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1, 2]]


def test_chain_breaks_at_speaker_change():
    # normal(A), short(A) merges with it, short(B) does not (different speaker)
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 2.3, "b"), _cue(2.3, 2.5, "c")]
    seg_speakers = ["A", "A", "B"]
    usable = [2.0, 0.3, 0.2]
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1], [2]]


def test_missing_cue_timing_skips_merge():
    # No start/end at all (plain-text segments, as some unit tests use) -- must
    # never merge since adjacency/gap can't be judged.
    segments = [{"text": "a"}, {"text": "b"}]
    seg_speakers = ["A", "A"]
    usable = [0.01, 0.01]
    assert group_merge_units(segments, seg_speakers, usable) == [[0], [1]]


def test_threshold_param_overridable():
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 3.0, "b")]
    seg_speakers = ["A", "A"]
    usable = [2.0, 1.0]  # not short under the 0.8s default...
    assert group_merge_units(segments, seg_speakers, usable) == [[0], [1]]
    # ...but is short under an explicit, higher threshold
    assert group_merge_units(segments, seg_speakers, usable, threshold=1.5) == [[0, 1]]


def test_reads_threshold_from_config_by_default(monkeypatch):
    monkeypatch.setattr(config, "QWEN_SHORT_LINE_SEC", 1.5)
    segments = [_cue(0.0, 2.0, "a"), _cue(2.0, 3.0, "b")]
    seg_speakers = ["A", "A"]
    usable = [2.0, 1.0]
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1]]


def test_reads_max_gap_from_config_by_default(monkeypatch):
    monkeypatch.setattr(config, "QWEN_MERGE_MAX_GAP_SEC", 3.0)
    segments = [_cue(0.0, 2.0, "a"), _cue(4.0, 4.3, "short")]  # 2s gap
    seg_speakers = ["A", "A"]
    usable = [2.0, 0.3]
    assert group_merge_units(segments, seg_speakers, usable) == [[0, 1]]


# --- split_unit_audio --------------------------------------------------------

SR = 16000


def _write_wav(path, framerate, nchannels, sampwidth, frames: bytes):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frames)


def _tone(value, n_frames):
    """n_frames of a constant-amplitude 16-bit mono sample."""
    return struct.pack("<%dh" % n_frames, *([value] * n_frames))


def _two_burst_wav(path, burst_sec=0.5, gap_sec=0.3, amp=8000):
    """burst - silence - burst, mono 16k, roughly modeling 'two sentences with
    a quiet gap between them' for the valley splitter to find."""
    burst_frames = int(burst_sec * SR)
    gap_frames = int(gap_sec * SR)
    frames = _tone(amp, burst_frames) + _tone(0, gap_frames) + _tone(amp, burst_frames)
    _write_wav(path, SR, 1, 2, frames)
    return burst_frames, gap_frames


def test_split_finds_valley_in_the_quiet_gap_between_two_bursts(tmp_path):
    unit_wav = tmp_path / "unit.wav"
    burst_frames, gap_frames = _two_burst_wav(unit_wav)
    out0 = tmp_path / "line0.wav"
    out1 = tmp_path / "line1.wav"

    ok = split_unit_audio(str(unit_wav), ["first sentence here", "second"], [str(out0), str(out1)])
    assert ok is True

    with wave.open(str(out0), "rb") as w:
        dur0 = w.getnframes() / w.getframerate()
    with wave.open(str(out1), "rb") as w:
        dur1 = w.getnframes() / w.getframerate()
    total = (2 * burst_frames + gap_frames) / SR
    assert abs((dur0 + dur1) - total) < 0.01
    # first member ("first sentence here", longer text) should end up with
    # noticeably more than half the total -- proportional-to-text-length split
    assert dur0 > dur1


def test_split_boundary_lands_in_silence_not_mid_burst(tmp_path):
    unit_wav = tmp_path / "unit.wav"
    burst_frames, gap_frames = _two_burst_wav(unit_wav, burst_sec=0.4, gap_sec=0.4)
    out0 = tmp_path / "line0.wav"
    out1 = tmp_path / "line1.wav"
    # equal-length texts -> expected boundary right at the burst/gap midpoint
    split_unit_audio(str(unit_wav), ["equal length one", "equal length two"], [str(out0), str(out1)])

    with wave.open(str(out0), "rb") as w:
        tail = w.readframes(w.getnframes())[-2:]
    with wave.open(str(out1), "rb") as w:
        head = w.readframes(w.getnframes())[:2]
    # right at the cut, both sides should be silence (the valley), not the tone
    assert int.from_bytes(tail, "little", signed=True) == 0
    assert int.from_bytes(head, "little", signed=True) == 0


def test_split_three_way_for_a_chain_of_three_members(tmp_path):
    # burst - gap - burst - gap - burst: models a normal line + two chained shorts
    burst = _tone(8000, int(0.3 * SR))
    gap = _tone(0, int(0.2 * SR))
    frames = burst + gap + burst + gap + burst
    unit_wav = tmp_path / "unit.wav"
    _write_wav(unit_wav, SR, 1, 2, frames)
    outs = [tmp_path / "l0.wav", tmp_path / "l1.wav", tmp_path / "l2.wav"]
    ok = split_unit_audio(str(unit_wav), ["equal one", "equal two", "equal three"], [str(p) for p in outs])
    assert ok is True
    for p in outs:
        with wave.open(str(p), "rb") as w:
            assert w.getnframes() > 0


def test_split_returns_false_for_too_short_audio(tmp_path):
    unit_wav = tmp_path / "unit.wav"
    _write_wav(unit_wav, SR, 1, 2, _tone(1000, 1))  # single sample, nothing to split
    out0, out1 = tmp_path / "a.wav", tmp_path / "b.wav"
    assert split_unit_audio(str(unit_wav), ["a", "b"], [str(out0), str(out1)]) is False
    assert not out0.exists()
    assert not out1.exists()


def test_split_requires_at_least_two_members():
    assert split_unit_audio("/nonexistent.wav", ["only one"], ["/tmp/out.wav"]) is False
