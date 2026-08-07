"""Characterization tests for the two Qwen dub-path helpers that had no direct
coverage: qwen_pipeline._score_and_select (best-of-N take selection core) and
qwen_pipeline._synth_merged_unit (ultra-short-line merge path).

These pin CURRENT behaviour before a refactor: what gets chosen and why, and
what happens on every degradation branch. Nothing here asserts on log text.

_score_and_select never opens the take files (it only forwards their paths to
the scorer), so the take paths below are plain strings; the scorer itself is
faked, exactly as the existing synth_lines tests do.
"""
import io
import math
import os
import struct
import wave

from app import qwen_pipeline as qp

# --- helpers ---------------------------------------------------------------

def _row(k, sim=0.8, sim_other=0.1, asr=0.9, dur=1.0, emb=(1.0, 0.0), **extra):
    """One scorer output row for take k (app/qwen_scoring.py's output contract)."""
    row = {"k": k, "sim": sim, "sim_other": sim_other, "asr": asr, "dur": dur,
           "emb": None if emb is None else list(emb)}
    row.update(extra)
    return row


def _select(monkeypatch, take_paths, scored, segments=None, seg_speakers=None,
            usable_slots=None, refs=None, captured=None):
    """Run _score_and_select with a fake scorer returning `scored`."""
    n = len(take_paths)
    if segments is None:
        segments = [{"text": "line %d" % i} for i in range(n)]
    if seg_speakers is None:
        seg_speakers = ["A"] * n
    if usable_slots is None:
        usable_slots = [2.0] * n
    if refs is None:
        refs = {"A": "/work/qwen_ref_A.wav"}

    def fake_score_takes(speaker_ref_paths, lines_payload, language, work_dir, log=None, timeout=900):
        if captured is not None:
            captured.append({"speaker_ref_paths": speaker_ref_paths, "lines_payload": lines_payload,
                             "language": language, "work_dir": work_dir})
        return scored

    monkeypatch.setattr(qp, "score_takes", fake_score_takes)
    return qp._score_and_select(take_paths, segments, seg_speakers, usable_slots,
                                refs, "Korean", "/work", lambda m: None)


# --- _score_and_select: degradation branches (return None -> caller uses take 0) --

def test_no_speaker_refs_skips_scoring_entirely(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("scoring must not be attempted without speaker references")

    monkeypatch.setattr(qp, "score_takes", boom)
    for refs in (None, {}):
        out = qp._score_and_select([["/w/t0.wav"]], [{"text": "a"}], ["A"], [2.0],
                                   refs, "Korean", "/work", lambda m: None)
        assert out is None


def test_scoring_unavailable_returns_none(monkeypatch):
    # app/qwen_scoring.score_takes turns every failure (missing interpreter,
    # crash, bad JSON, ok=false) into None -- that must degrade, not raise.
    assert _select(monkeypatch, [["/w/l0_t0.wav", "/w/l0_t1.wav"]], None) is None


def test_returns_none_when_every_line_lost_all_its_takes(monkeypatch):
    # Nothing synthesized anywhere -> no payload to score at all.
    assert _select(monkeypatch, [[None, None], [None]], {0: [_row(0)], 1: [_row(0)]}) is None


def test_line_with_no_surviving_take_is_left_out_of_selection(monkeypatch):
    # Line 0's takes all failed to synthesize; line 1 is still selected normally.
    winners = _select(monkeypatch, [[None, None], ["/w/l1_t0.wav", "/w/l1_t1.wav"]],
                      {1: [_row(0, sim=0.5), _row(1, sim=0.9)]})
    assert winners == {1: 1}


def test_lines_missing_from_the_scorer_output_are_left_out(monkeypatch):
    # line 0: absent key, line 1: empty row list, line 2: real rows.
    take_paths = [["/w/a.wav"], ["/w/b.wav"], ["/w/c0.wav", "/w/c1.wav"]]
    winners = _select(monkeypatch, take_paths,
                      {1: [], 2: [_row(0, sim=0.5), _row(1, sim=0.9)]})
    assert winners == {2: 1}  # 0 and 1 fall back to take 0 at the caller


def test_returns_none_when_no_take_has_an_embedding(monkeypatch):
    # Every take is too short (<0.4s) for an embedding -> nothing can join the
    # coherence rule -> whole selection degrades.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, emb=None), _row(1, emb=None)]})
    assert winners is None


# --- _score_and_select: which take wins, and why ---------------------------

def test_single_take_line_selects_take_zero(monkeypatch):
    assert _select(monkeypatch, [["/w/l0_t0.wav"]], {0: [_row(0)]}) == {0: 0}


def test_higher_speaker_similarity_wins_all_else_equal(monkeypatch):
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav", "/w/t2.wav"]],
                      {0: [_row(0, sim=0.5), _row(1, sim=0.95), _row(2, sim=0.7)]})
    assert winners == {0: 1}


def test_take_overshooting_its_slot_is_excluded_even_with_the_best_similarity(monkeypatch):
    # usable=2.0, DUR_TOL=0.15: a 3.0s take cannot fit, so the shorter-but-less
    # similar take wins (slot fit outranks raw similarity).
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, sim=0.95, dur=3.0), _row(1, sim=0.70, dur=1.9)]})
    assert winners == {0: 1}


def test_no_eligible_take_falls_back_to_the_biggest_speaker_margin(monkeypatch):
    # Both takes fail the ASR floor (0.70), so eligibility falls back to the
    # single best (sim - sim_other) take -- NOT the highest-sim one.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, sim=0.90, sim_other=0.85, asr=0.2),   # margin 0.05
                           _row(1, sim=0.60, sim_other=0.10, asr=0.2)]})  # margin 0.50
    assert winners == {0: 1}


def test_duration_fit_breaks_a_quality_tie(monkeypatch):
    # Identical embedding + similarity -> quality-equal (FIT_QUALITY_BAND); the
    # take whose duration lands closest to the 2.0s slot wins.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, dur=1.0), _row(1, dur=1.95)]})
    assert winners == {0: 1}


def test_takes_without_an_embedding_are_dropped_from_the_pool(monkeypatch):
    # Take 0 scores far higher but has no embedding (too-short audio) -> take 1 wins.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, sim=0.99, emb=None), _row(1, sim=0.50)]})
    assert winners == {0: 1}


def test_a_line_whose_takes_all_lack_embeddings_is_skipped_but_others_are_kept(monkeypatch):
    winners = _select(monkeypatch, [["/w/a0.wav", "/w/a1.wav"], ["/w/b0.wav", "/w/b1.wav"]],
                      {0: [_row(0, emb=None), _row(1, emb=None)],
                       1: [_row(0, sim=0.5), _row(1, sim=0.9)]})
    assert winners == {1: 1}


def test_coherence_pulls_a_line_toward_the_speakers_other_takes(monkeypatch):
    # Lines 0 and 1 (same speaker) both sound like [1,0]. Line 2's take 0 has the
    # higher raw similarity but a different-sounding embedding; take 1 matches the
    # speaker's centroid, so the coherence rounds pick it despite the lower sim.
    take_paths = [["/w/a.wav"], ["/w/b.wav"], ["/w/c0.wav", "/w/c1.wav"]]
    scored = {
        0: [_row(0, sim=0.8, emb=(1.0, 0.0))],
        1: [_row(0, sim=0.8, emb=(1.0, 0.0))],
        2: [_row(0, sim=0.9, emb=(0.0, 1.0)), _row(1, sim=0.8, emb=(1.0, 0.0))],
    }
    assert _select(monkeypatch, take_paths, scored) == {0: 0, 1: 0, 2: 1}


def test_take_index_survives_an_earlier_failed_take(monkeypatch):
    # Take 0 failed to synthesize; the returned index must still be the ORIGINAL
    # take number (2), because the caller indexes the take row with it.
    winners = _select(monkeypatch, [[None, "/w/t1.wav", "/w/t2.wav"]],
                      {0: [_row(1, sim=0.5), _row(2, sim=0.9)]})
    assert winners == {0: 2}


# --- _score_and_select: what the pipeline supplies vs. what the scorer echoes --

def test_pipeline_slot_wins_over_the_scorer_echoed_usable(monkeypatch):
    # The scorer echoes a "usable" field, but selection uses the pipeline's
    # usable_slots. With the real slot (1.0s) the 5.0s take is ineligible;
    # had the echoed 99.0 been used it would have won the duration-fit pass.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, dur=0.9, usable=99.0), _row(1, dur=5.0, usable=99.0)]},
                      usable_slots=[1.0])
    assert winners == {0: 0}


def test_pipeline_speaker_wins_over_the_scorer_echoed_label(monkeypatch):
    # Same coherence setup as above, but the scorer labels line 2 as a different
    # speaker. Grouping follows seg_speakers, so line 2 still joins A's centroid
    # and picks take 1 (with the scorer's label it would be alone and pick take 0).
    take_paths = [["/w/a.wav"], ["/w/b.wav"], ["/w/c0.wav", "/w/c1.wav"]]
    scored = {
        0: [_row(0, sim=0.8, emb=(1.0, 0.0), spk="A")],
        1: [_row(0, sim=0.8, emb=(1.0, 0.0), spk="A")],
        2: [_row(0, sim=0.9, emb=(0.0, 1.0), spk="Z"), _row(1, sim=0.8, emb=(1.0, 0.0), spk="Z")],
    }
    assert _select(monkeypatch, take_paths, scored, seg_speakers=["A", "A", "A"]) == {0: 0, 1: 0, 2: 1}


def test_missing_speaker_and_slot_info_degrade_to_none_and_zero(monkeypatch):
    # seg_speakers / usable_slots shorter than the take rows: speaker becomes
    # None and the slot 0.0, so no take fits and the best-margin take wins.
    winners = _select(monkeypatch, [["/w/t0.wav", "/w/t1.wav"]],
                      {0: [_row(0, sim=0.5, sim_other=0.1), _row(1, sim=0.9, sim_other=0.1)]},
                      seg_speakers=[], usable_slots=[])
    assert winners == {0: 1}


def test_scorer_payload_carries_one_entry_per_scorable_line(monkeypatch):
    # The scorer input contract: line index, speaker, slot, text, and every
    # surviving take keyed by its ORIGINAL take number.
    captured = []
    _select(monkeypatch, [[None, "/w/l0_t1.wav"], [None, None], ["/w/l2_t0.wav"]],
            {0: [_row(1)], 2: [_row(0)]},
            segments=[{"text": "zero"}, {"text": "one"}, {"text": "two"}],
            seg_speakers=["A", "A", "B"], usable_slots=[1.5, 2.0, 2.5],
            refs={"A": "/work/qwen_ref_A.wav", "B": "/work/qwen_ref_B.wav"},
            captured=captured)
    payload = captured[0]["lines_payload"]
    assert payload == [
        {"i": 0, "spk": "A", "usable": 1.5, "text": "zero", "takes": [{"k": 1, "path": "/w/l0_t1.wav"}]},
        {"i": 2, "spk": "B", "usable": 2.5, "text": "two", "takes": [{"k": 0, "path": "/w/l2_t0.wav"}]},
    ]
    assert captured[0]["speaker_ref_paths"] == {"A": "/work/qwen_ref_A.wav", "B": "/work/qwen_ref_B.wav"}


# --- _synth_merged_unit ----------------------------------------------------

def _wav_bytes(chunks, sr=24000):
    """16-bit mono wav bytes from [(seconds, amplitude), ...] (amplitude 0 = silence)."""
    frames = bytearray()
    for dur, amp in chunks:
        for i in range(int(dur * sr)):
            frames += struct.pack("<h", int(amp * math.sin(2 * math.pi * 440 * i / sr)) if amp else 0)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
    return buf.getvalue()


# tone / silence / tone: one clean energy valley in the middle to split at
TWO_SENTENCE_WAV = _wav_bytes([(0.45, 9000), (0.10, 0), (0.45, 9000)])


class _RecordingEngine:
    """Fake TTS engine: records every SynthesisRequest, writes fixed audio bytes."""

    def __init__(self, audio=TWO_SENTENCE_WAV, fail=False):
        self.requests = []
        self.audio = audio
        self.fail = fail

    def synthesize(self, req):
        self.requests.append(req)
        if self.fail:
            raise RuntimeError("sidecar down")
        audio = self.audio

        class _Res:
            audio_bytes = audio

        return _Res()


def _out_paths(tmp_path, n):
    return [str(tmp_path / ("qwen_line_%d.wav" % i)) for i in range(n)]


def _wav_duration(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def test_merged_unit_synthesizes_once_and_splits_into_member_files(tmp_path):
    # Real split_unit_audio (not faked): one TTS call for the combined text,
    # then one wav per member cut at the energy valley.
    engine = _RecordingEngine()
    segments = [{"text": "a normal line"}, {"text": "short"}]
    outs = _out_paths(tmp_path, 2)

    ok = qp._synth_merged_unit(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean",
                               str(tmp_path), [0, 1], 0, outs, lambda m: None)

    assert ok is True
    assert len(engine.requests) == 1
    assert engine.requests[0].text == "a normal line short"
    assert all(os.path.exists(p) for p in outs)
    # the two pieces together are the whole 1.0s unit, cut inside the silence
    assert abs(_wav_duration(outs[0]) + _wav_duration(outs[1]) - 1.0) < 0.01
    assert 0.4 < _wav_duration(outs[0]) < 0.7
    # the intermediate unit wav is cleaned up
    assert not os.path.exists(str(tmp_path / "qwen_unit_0_seed0.wav"))


def test_merged_unit_uses_the_first_members_voice_for_the_whole_unit(tmp_path):
    engine = _RecordingEngine()
    segments = [{"text": "first"}, {"text": "second"}]
    qp._synth_merged_unit(engine, segments, ["A", "B"], {"A": "vidA", "B": "vidB"}, "Korean",
                          str(tmp_path), [0, 1], 0, _out_paths(tmp_path, 2), lambda m: None)
    assert engine.requests[0].voice_id == "vidA"
    assert engine.requests[0].language == "Korean"
    assert engine.requests[0].seed == 0


def test_merged_unit_voice_is_none_when_the_speaker_is_unknown(tmp_path):
    engine = _RecordingEngine()
    segments = [{"text": "first"}, {"text": "second"}]
    qp._synth_merged_unit(engine, segments, [], {"A": "vidA"}, "Korean",
                          str(tmp_path), [0, 1], 0, _out_paths(tmp_path, 2), lambda m: None)
    assert engine.requests[0].voice_id is None


def test_merged_unit_joins_texts_with_one_space_and_keeps_empty_members(tmp_path, monkeypatch):
    captured = {}

    def fake_split(wav_path, member_texts, out_paths):
        captured["member_texts"] = member_texts
        captured["wav_path"] = wav_path
        for p in out_paths:
            with open(p, "wb") as f:
                f.write(b"x")
        return True

    monkeypatch.setattr(qp, "split_unit_audio", fake_split)
    engine = _RecordingEngine()
    qp._synth_merged_unit(engine, [{"text": "hello"}, {}], ["A", "A"], {"A": "vidA"}, "Korean",
                          str(tmp_path), [0, 1], 0, _out_paths(tmp_path, 2), lambda m: None)
    assert engine.requests[0].text == "hello "        # missing text -> empty member
    assert captured["member_texts"] == ["hello", ""]


def test_merged_unit_returns_false_and_writes_nothing_when_synthesis_fails(tmp_path):
    engine = _RecordingEngine(fail=True)
    outs = _out_paths(tmp_path, 2)
    ok = qp._synth_merged_unit(engine, [{"text": "a"}, {"text": "b"}], ["A", "A"], {"A": "vidA"},
                               "Korean", str(tmp_path), [0, 1], 0, outs, lambda m: None)
    assert ok is False
    assert not any(os.path.exists(p) for p in outs)
    assert not os.path.exists(str(tmp_path / "qwen_unit_0_seed0.wav"))


def test_merged_unit_returns_false_and_cleans_up_when_the_split_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(qp, "split_unit_audio", lambda wav_path, texts, out_paths: False)
    engine = _RecordingEngine()
    outs = _out_paths(tmp_path, 2)
    ok = qp._synth_merged_unit(engine, [{"text": "a"}, {"text": "b"}], ["A", "A"], {"A": "vidA"},
                               "Korean", str(tmp_path), [0, 1], 0, outs, lambda m: None)
    assert ok is False
    assert not any(os.path.exists(p) for p in outs)   # caller re-synthesizes each member
    assert not os.path.exists(str(tmp_path / "qwen_unit_0_seed0.wav"))


def test_merged_unit_of_one_member_cannot_split_and_reports_failure(tmp_path):
    # split_unit_audio refuses anything with fewer than 2 members.
    engine = _RecordingEngine()
    outs = _out_paths(tmp_path, 1)
    ok = qp._synth_merged_unit(engine, [{"text": "alone"}], ["A"], {"A": "vidA"}, "Korean",
                               str(tmp_path), [0], 0, outs, lambda m: None)
    assert ok is False
    assert not os.path.exists(outs[0])


def test_merged_unit_temp_file_is_scoped_to_the_seed(tmp_path, monkeypatch):
    # Best-of-N runs one merged unit per take; their intermediate wavs must not
    # collide, or take k would split take k-1's audio.
    seen = []

    def fake_split(wav_path, member_texts, out_paths):
        seen.append(os.path.basename(wav_path))
        for p in out_paths:
            with open(p, "wb") as f:
                f.write(b"x")
        return True

    monkeypatch.setattr(qp, "split_unit_audio", fake_split)
    engine = _RecordingEngine()
    segments = [{"text": "line %d" % i} for i in range(5)]
    for seed in (3000, 3001):
        qp._synth_merged_unit(engine, segments, ["A"] * 5, {"A": "vidA"}, "Korean",
                              str(tmp_path), [3, 4], seed, _out_paths(tmp_path, 2), lambda m: None)
    assert seen == ["qwen_unit_3_seed3000.wav", "qwen_unit_3_seed3001.wav"]


def test_merged_unit_falls_back_when_engine_audio_is_unparsable(tmp_path):
    """Unreadable engine audio must degrade, not kill the job.

    _synth_merged_unit's docstring promises False "on any failure", and
    synth_lines' promises a merge unit "never aborts the job". split_unit_audio
    opens the unit wav with the `wave` module, so audio bytes that are not a
    readable RIFF wav (a truncated response, or an error body served as HTTP
    200) raised wave.Error straight out through synth_lines and run_qwen_dub,
    aborting the whole dub after all the GPU work. It must return False so the
    caller falls back to per-line synthesis, and must not leak the intermediate
    unit wav (os.remove sits after the split, so the exception skipped it).
    """
    engine = _RecordingEngine(audio=b"NOT-A-WAV-FILE")
    outs = _out_paths(tmp_path, 2)

    ok = qp._synth_merged_unit(engine, [{"text": "a"}, {"text": "b"}], ["A", "A"], {"A": "vidA"},
                               "Korean", str(tmp_path), [0, 1], 0, outs, lambda m: None)

    assert ok is False
    assert not os.path.exists(str(tmp_path / "qwen_unit_0_seed0.wav")), "temp unit wav leaked"
    assert not any(os.path.exists(p) for p in outs), "wrote member wavs despite failing"
