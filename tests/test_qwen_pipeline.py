"""Pure-function selection logic + mocked orchestration for the Qwen3-TTS dub path."""
import json
import os

from app import qwen_pipeline as qp
from app.engines.base import TTSEngine


def _cue(start, end, text, speaker):
    return {"start": start, "end": end, "text": text, "speaker_id": speaker}


# --- pick_speaker_ref_span -------------------------------------------------

def test_picks_span_in_4_to_7s_range():
    cues = [
        _cue(0.0, 2.0, "one two three four", "A"),
        _cue(2.0, 5.0, "five six seven eight", "A"),   # cumulative 0-5s -> in range
    ]
    span = qp.pick_speaker_ref_span(cues, "A")
    assert span == {"start": 0.0, "end": 5.0}


def test_never_crosses_a_speaker_boundary():
    # A's only way to reach 4-7s would be to span across B's line in the middle --
    # that must NOT happen (never concatenate non-contiguous / other-speaker audio).
    cues = [
        _cue(0.0, 3.0, "hello there friend", "A"),
        _cue(3.0, 4.0, "interrupting", "B"),
        _cue(4.0, 7.0, "continuing on here", "A"),
    ]
    span = qp.pick_speaker_ref_span(cues, "A")
    # Neither run alone reaches 4s -> falls back to the longest single run (3s, the first)
    assert span == {"start": 0.0, "end": 3.0}


def test_falls_back_to_longest_run_when_nothing_reaches_min_dur():
    # B's cue splits A's dialogue into two separate runs (1.5s and 2.5s); neither
    # reaches min_dur, so the longer run (2s-4.5s) wins as the best-effort fallback.
    cues = [
        _cue(0.0, 1.5, "short one", "A"),
        _cue(1.5, 2.0, "interjection", "B"),
        _cue(2.0, 4.5, "a bit longer this time", "A"),
    ]
    span = qp.pick_speaker_ref_span(cues, "A")
    assert span == {"start": 2.0, "end": 4.5}


def test_fallback_run_capped_to_max_dur():
    cues = [_cue(0.0, 20.0, "one very long single line", "A")]
    span = qp.pick_speaker_ref_span(cues, "A", min_dur=4.0, max_dur=7.0)
    assert span == {"start": 0.0, "end": 7.0}


def test_prefers_the_window_with_more_actual_speech():
    # Two candidate windows both land in [4,7]s: [0,7] (3s of actual speech, with a
    # silent gap from 2-6) and [1,7] (2s of actual speech). The denser one wins.
    cues = [
        _cue(0.0, 1.0, "a", "A"),
        _cue(1.0, 2.0, "b", "A"),
        _cue(6.0, 7.0, "c", "A"),
    ]
    span = qp.pick_speaker_ref_span(cues, "A")
    assert span == {"start": 0.0, "end": 7.0}


def test_unknown_speaker_returns_none():
    cues = [_cue(0.0, 5.0, "hi", "A")]
    assert qp.pick_speaker_ref_span(cues, "B") is None


def test_a_reference_does_not_run_to_where_the_video_cuts_the_speaker_off():
    """Trump (2026-10-04): the most speech was the last line, cut off by the
    end of the clip ("...and it always will"), and the clone said "will"
    before its next line. An earlier, slightly shorter window wins."""
    cues = [
        _cue(0.0, 5.0, "what I tell them you should put your country first", "A"),
        _cue(5.0, 11.3, "whatever the country may be but for us it's America first and it always will", "A"),
    ]
    assert qp.pick_speaker_ref_span(cues, "A") == {"start": 0.0, "end": 5.0}


def test_a_reference_that_ends_a_sentence_wins_over_more_speech():
    """The Shuka lecture (2026-10-04): "...노태우 여권인데 제1기 신도시가" stops
    mid-sentence, and the clone began lines with "가" or "아"."""
    cues = [
        _cue(0.0, 2.0, "사건이 1990년대에 펼쳐지거든요.", "A"),
        _cue(2.0, 4.5, "그때 당시에 대통령이 누구였죠?", "A"),
        _cue(4.5, 7.0, "노태우 여권인데 제1기 신도시가", "A"),
        _cue(7.0, 9.0, "건설이 돼요.", "A"),
    ]
    assert qp.pick_speaker_ref_span(cues, "A") == {"start": 0.0, "end": 4.5}


# --- speakers_in / map_segments_to_speakers --------------------------------

def test_speakers_in_sorted_unique():
    cues = [_cue(0, 1, "x", "B"), _cue(1, 2, "y", "A"), _cue(2, 3, "z", "B")]
    assert qp.speakers_in(cues) == ["A", "B"]


def test_speakers_in_empty_when_no_labels():
    cues = [{"start": 0, "end": 1, "text": "x"}]
    assert qp.speakers_in(cues) == []


def test_map_segments_to_speakers_by_overlap():
    ref_cues = [_cue(0.0, 2.0, "a", "A"), _cue(2.0, 4.0, "b", "B")]
    segments = [{"start": 0.1, "end": 1.9}, {"start": 2.1, "end": 3.9}]
    assert qp.map_segments_to_speakers(segments, ref_cues, ["A", "B"]) == ["A", "B"]


def test_map_segments_to_speakers_falls_back_to_first_speaker():
    ref_cues = [_cue(0.0, 2.0, "a", "A")]
    segments = [{"start": 50.0, "end": 51.0}]  # no overlapping ref cue at all
    assert qp.map_segments_to_speakers(segments, ref_cues, ["A", "B"]) == ["A"]


# --- build_speaker_refs (local vocals wav, cut_vocals_span_local mocked) ---

def test_build_speaker_refs_icl_mode_uses_cut_vocals_span_local_and_ref_text(monkeypatch):
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking now", "A")]
    captured = {}

    def fake_cut_local(vocals_path, spans):
        captured["vocals_path"] = vocals_path
        captured["spans"] = spans
        return b"WAVBYTES" * 200  # >1000 bytes

    monkeypatch.setattr(qp, "cut_vocals_span_local", fake_cut_local)
    refs = qp.build_speaker_refs(ref_cues, ["A"], "/local/vocals.wav", mode="icl")
    assert "A" in refs
    assert refs["A"]["wav_bytes"] == b"WAVBYTES" * 200
    assert "speaker A talking" in refs["A"]["ref_text"]
    assert captured["vocals_path"] == "/local/vocals.wav"
    assert captured["spans"] == [[0.0, 5.0]]


def test_build_speaker_refs_timbre_mode_skips_ref_text(monkeypatch):
    # Timbre mode: the audio span still gets cut, but no transcript is
    # assembled -- ref_text is None. (The default is icl since 2026-10-03:
    # tests/test_voice_reference.py.)
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking now", "A")]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"WAVBYTES" * 200)
    refs = qp.build_speaker_refs(ref_cues, ["A"], "/local/vocals.wav", mode="timbre")
    assert "A" in refs
    assert refs["A"]["wav_bytes"] == b"WAVBYTES" * 200
    assert refs["A"]["ref_text"] is None


def test_build_speaker_refs_skips_speaker_with_no_span(monkeypatch):
    # "B" never speaks -> no cues -> pick_speaker_ref_span returns None -> skipped.
    # "A" does speak, so its cut is stubbed the way the sibling test below stubs it.
    # Unstubbed, that cut shells out to ffmpeg: without the binary the call raises,
    # and with it the (nonexistent) vocals path makes ffmpeg return nothing, so "A"
    # was dropped too and "B" not in refs held vacuously. Asserting "A" is present
    # is what pins the skip to B's missing span.
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"\0" * 2000)
    ref_cues = [_cue(0.0, 5.0, "hello there", "A")]
    refs = qp.build_speaker_refs(ref_cues, ["A", "B"], "/local/vocals.wav")
    assert "A" in refs
    assert "B" not in refs


def test_build_speaker_refs_skips_empty_wav(monkeypatch):
    ref_cues = [_cue(0.0, 5.0, "hello there speaker", "A")]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"")
    refs = qp.build_speaker_refs(ref_cues, ["A"], "/local/vocals.wav")
    assert refs == {}


# --- assign_voices / synth_lines (mocked engine) ---------------------------

class _FakeEngine(TTSEngine):
    def __init__(self):
        self.cloned = []
        self.synth_calls = []

    def is_available(self):
        return True

    def clone(self, ref_audio_path, ref_text, mode=None):
        self.cloned.append((ref_audio_path, ref_text, mode))
        return "voice-" + (ref_text or "")[:4]

    def synthesize(self, req):
        self.synth_calls.append(req)
        class _Res:
            audio_bytes = b"WAV" + req.text.encode()
        return _Res()


def test_assign_voices_writes_ref_file_and_clones(tmp_path):
    engine = _FakeEngine()
    refs = {"A": {"wav_bytes": b"RIFFxxxx", "ref_text": "hi there", "span": {"start": 0, "end": 5}}}
    voice_ids = engine.assign_voices(refs, ["A"], str(tmp_path), lambda m: None)
    assert voice_ids == {"A": "voice-hi t"}
    assert len(engine.cloned) == 1
    path, ref_text, mode = engine.cloned[0]
    assert ref_text == "hi there"
    with open(path, "rb") as f:
        assert f.read() == b"RIFFxxxx"


def test_synth_lines_seeds_are_deterministic_per_line(tmp_path):
    engine = _FakeEngine()
    segments = [{"text": "line zero"}, {"text": "line one"}]
    seg_speakers = ["A", "A"]
    voice_ids = {"A": "vidA"}
    paths = qp.synth_lines(engine, segments, seg_speakers, voice_ids, "Korean", str(tmp_path))
    assert len(paths) == 2
    assert engine.synth_calls[0].seed == 0
    assert engine.synth_calls[1].seed == 1000
    assert engine.synth_calls[0].voice_id == "vidA"
    with open(paths[0], "rb") as f:
        assert f.read() == b"WAVline zero"


def test_synth_lines_keeps_none_for_failed_line(tmp_path):
    class _BoomEngine(_FakeEngine):
        def synthesize(self, req):
            if "boom" in req.text:
                raise RuntimeError("sidecar down")
            return super().synthesize(req)

    engine = _BoomEngine()
    segments = [{"text": "ok line"}, {"text": "boom line"}]
    logs = []
    paths = qp.synth_lines(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean", str(tmp_path), log=logs.append)
    assert paths[0] is not None
    assert paths[1] is None
    assert any("failed" in m for m in logs)


# --- synth_lines with n_takes > 1 (best-of-N selection) ---------------------

class _KAwareEngine:
    """Fake engine whose synthesize() output encodes the (line, take) it was asked
    for, so tests can tell exactly which take ended up on disk."""
    def __init__(self):
        self.synth_calls = []

    def synthesize(self, req):
        self.synth_calls.append(req)
        seed = req.seed
        i, k = seed // 1000, seed % 1000
        class _Res:
            audio_bytes = ("TAKE_%d_%d" % (i, k)).encode()
        return _Res()


def test_synth_lines_n_takes_generates_seed_1000i_plus_k(tmp_path):
    engine = _KAwareEngine()
    segments = [{"text": "line zero"}, {"text": "line one"}]
    qp.synth_lines(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean", str(tmp_path),
                   n_takes=3, speaker_ref_paths=None)  # scoring unavailable -> falls back, but takes are still generated with the right seeds
    seeds = sorted(c.seed for c in engine.synth_calls)
    assert seeds == [0, 1, 2, 1000, 1001, 1002]


def test_synth_lines_n_takes_without_scoring_falls_back_to_take_0(tmp_path):
    # No speaker_ref_paths -> scoring is skipped entirely (graceful degradation).
    engine = _KAwareEngine()
    segments = [{"text": "line zero"}]
    logs = []
    paths = qp.synth_lines(engine, segments, ["A"], {"A": "vidA"}, "Korean", str(tmp_path),
                           n_takes=3, speaker_ref_paths=None, log=logs.append)
    assert len(paths) == 1
    with open(paths[0], "rb") as f:
        assert f.read() == b"TAKE_0_0"  # take 0 kept
    # v3: losing takes are KEPT on disk until cleanup_takes() (reassembly passes)
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t1.wav"))
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t2.wav"))
    assert any("scoring unavailable" in m.lower() for m in logs)


def test_synth_lines_n_takes_scorer_unavailable_still_completes(tmp_path, monkeypatch):
    # score_takes raising/being unreachable is exactly what qwen_scoring.score_takes
    # already turns into None -- simulate that directly here (unit-level degradation test).
    monkeypatch.setattr(qp, "score_takes", lambda *a, **k: None)
    engine = _KAwareEngine()
    segments = [{"text": "a"}, {"text": "b"}]
    paths = qp.synth_lines(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean", str(tmp_path),
                           n_takes=2, speaker_ref_paths={"A": "/fake/ref_A.wav"})
    assert len(paths) == 2
    assert all(p is not None and os.path.exists(p) for p in paths)


def test_synth_lines_n_takes_selection_picks_scored_winner(tmp_path, monkeypatch):
    # Wire a fake score_takes that scores take 1 as clearly better than take 0 for
    # line 0, and confirm the winner (not take 0) survives on disk.
    def fake_score_takes(speaker_ref_paths, lines_payload, language, work_dir, log=None, timeout=900):
        assert speaker_ref_paths == {"A": "/fake/ref_A.wav"}
        out = {}
        for line in lines_payload:
            i = line["i"]
            out[i] = [
                {"k": t["k"], "sim": 0.5 if t["k"] == 0 else 0.95, "sim_other": 0.1,
                 "asr": 0.9, "dur": 1.0, "usable": line["usable"], "spk": line["spk"],
                 "emb": [1.0, 0.0]}
                for t in line["takes"]
            ]
        return out

    monkeypatch.setattr(qp, "score_takes", fake_score_takes)
    engine = _KAwareEngine()
    segments = [{"text": "only line"}]
    paths = qp.synth_lines(engine, segments, ["A"], {"A": "vidA"}, "Korean", str(tmp_path),
                           n_takes=2, speaker_ref_paths={"A": "/fake/ref_A.wav"},
                           usable_slots=[2.0])
    assert len(paths) == 1
    with open(paths[0], "rb") as f:
        assert f.read() == b"TAKE_0_1"  # take 1 (higher sim) won, not take 0
    # v3: take files are kept on disk (winner is a COPY) until cleanup_takes()
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t0.wav"))
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t1.wav"))


# --- synth_lines: ultra-short-line merge wiring (app/audio/merge.py) -------

def test_synth_lines_merges_ultra_short_line_into_one_engine_call(tmp_path, monkeypatch):
    # line 1 is ultra-short (0.3s), same speaker, adjacent to line 0 -> must
    # merge into ONE synthesize() call instead of two.
    engine = _FakeEngine()
    segments = [
        {"start": 0.0, "end": 2.0, "text": "line zero"},
        {"start": 2.0, "end": 2.3, "text": "line one"},
    ]
    seg_speakers = ["A", "A"]

    captured = {}

    def fake_split(wav_path, member_texts, out_paths):
        captured["member_texts"] = member_texts
        captured["out_paths"] = out_paths
        for p, t in zip(out_paths, member_texts):
            with open(p, "wb") as f:
                f.write(("SPLIT:" + t).encode())
        return True

    monkeypatch.setattr(qp, "split_unit_audio", fake_split)
    paths = qp.synth_lines(engine, segments, seg_speakers, {"A": "vidA"}, "Korean", str(tmp_path))

    assert len(engine.synth_calls) == 1  # one merged call, not two
    assert engine.synth_calls[0].text == "line zero line one"
    assert captured["member_texts"] == ["line zero", "line one"]
    assert len(paths) == 2
    for p in paths:
        assert p is not None and os.path.exists(p)
    with open(paths[0], "rb") as f:
        assert f.read() == b"SPLIT:line zero"
    with open(paths[1], "rb") as f:
        assert f.read() == b"SPLIT:line one"


def test_synth_lines_merge_falls_back_to_per_line_when_split_fails(tmp_path, monkeypatch):
    engine = _FakeEngine()
    segments = [
        {"start": 0.0, "end": 2.0, "text": "line zero"},
        {"start": 2.0, "end": 2.3, "text": "line one"},
    ]
    seg_speakers = ["A", "A"]
    monkeypatch.setattr(qp, "split_unit_audio", lambda wav_path, texts, out_paths: False)

    paths = qp.synth_lines(engine, segments, seg_speakers, {"A": "vidA"}, "Korean", str(tmp_path))

    # 1 merged attempt (failed) + 2 individual fallback calls
    assert len(engine.synth_calls) == 3
    assert engine.synth_calls[0].text == "line zero line one"
    assert sorted(c.text for c in engine.synth_calls[1:]) == ["line one", "line zero"]
    assert len(paths) == 2
    with open(paths[0], "rb") as f:
        assert f.read() == b"WAVline zero"
    with open(paths[1], "rb") as f:
        assert f.read() == b"WAVline one"


def test_synth_lines_no_merge_when_slot_not_ultra_short(tmp_path):
    engine = _FakeEngine()
    segments = [
        {"start": 0.0, "end": 2.0, "text": "line zero"},
        {"start": 2.0, "end": 3.0, "text": "line one"},  # 1.0s slot, not short
    ]
    paths = qp.synth_lines(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean", str(tmp_path))
    assert len(engine.synth_calls) == 2  # two separate calls, no merge
    assert {c.text for c in engine.synth_calls} == {"line zero", "line one"}
    assert len(paths) == 2


def test_synth_lines_n_takes_merge_wiring_one_merged_call_per_take(tmp_path, monkeypatch):
    # n_takes=2 with a merge candidate: each take should be ONE merged
    # synthesize() call (not one per line), i.e. 2 total calls, not 4.
    engine = _FakeEngine()
    segments = [
        {"start": 0.0, "end": 2.0, "text": "line zero"},
        {"start": 2.0, "end": 2.3, "text": "line one"},
    ]

    def fake_split(wav_path, member_texts, out_paths):
        for p, t in zip(out_paths, member_texts):
            with open(p, "wb") as f:
                f.write(("SPLIT:" + t).encode())
        return True

    monkeypatch.setattr(qp, "split_unit_audio", fake_split)
    paths = qp.synth_lines(engine, segments, ["A", "A"], {"A": "vidA"}, "Korean", str(tmp_path),
                           n_takes=2, speaker_ref_paths=None)
    assert len(engine.synth_calls) == 2  # one merged call per take, not per line
    assert len(paths) == 2
    for p in paths:
        assert p is not None and os.path.exists(p)


# --- run_qwen_dub end-to-end (all engine calls mocked; vocals/background are
# local paths supplied directly by the caller, as app/pipeline.py always does) --

def test_run_qwen_dub_orchestrates_full_flow(monkeypatch, tmp_path):
    ref_cues = [
        _cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A"),
    ]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]

    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)
    placed = {}

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        placed["background"] = background
        placed["line_paths"] = line_paths
        placed["starts"] = starts
        placed["gains"] = gains
        placed["vocals_path"] = vocals_path
        placed["speech_regions"] = speech_regions
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    whitelisted = []
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist",
                        lambda *a, **k: whitelisted.append((a, k)) or {})

    captured_gain_args = {}

    def fake_match_line_gains(vocals_wav, cues, line_wavs):
        captured_gain_args["vocals_wav"] = vocals_wav
        captured_gain_args["cues"] = cues
        captured_gain_args["line_wavs"] = line_wavs
        return [2.5]

    monkeypatch.setattr(qp, "match_line_gains", fake_match_line_gains)

    engine = _FakeEngine()
    logs = []
    out = qp.run_qwen_dub(engine, segments, ref_cues, str(tmp_path),
                          vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                          language="Korean", log=logs.append)

    assert out == str(tmp_path / "qwen_dub_48k.wav")
    assert placed["background"] == "/local/background.wav"
    assert placed["starts"] == [0.5]
    assert placed["gains"] == [2.5]  # per-line loudness-matching gains reach place_lines
    assert captured_gain_args["vocals_wav"] == "/local/vocals.wav"
    assert captured_gain_args["cues"] == segments  # gain measured against each line's own cue span
    # QWEN_GATE_MODE default is "safe": the original vocals track must NOT
    # reach place_lines at all -- leakage is structurally impossible because
    # there's nothing original to leak (see app/config.QWEN_GATE_MODE).
    assert placed["vocals_path"] is None
    assert placed["speech_regions"] is None
    # QWEN_KEEP_NONVERBAL default is on: the laughter whitelist runs over the
    # finished safe-mode mix, fed the ORIGINAL speech cue spans (ref_cues).
    assert len(whitelisted) == 1
    wl_args, wl_kwargs = whitelisted[0]
    assert wl_args[0] == out                       # the assembled mix, in place
    assert wl_args[1] == "/local/vocals.wav"       # candidates come from the stem
    assert wl_args[2] == [(0.0, 5.0)]              # original speech spans
    assert len(engine.cloned) == 1
    assert len(engine.synth_calls) == 1
    assert engine.synth_calls[0].text == "translated line"


def test_run_qwen_dub_safe_mode_flag_off_skips_whitelist(monkeypatch, tmp_path):
    # QWEN_KEEP_NONVERBAL=0: plain safe mode, byte-for-byte the old behavior --
    # the whitelist must not even be invoked.
    monkeypatch.setattr(qp, "QWEN_KEEP_NONVERBAL", 0)
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [2.5])
    whitelisted = []
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist",
                        lambda *a, **k: whitelisted.append(a) or {})

    qp.run_qwen_dub(_FakeEngine(), segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    assert whitelisted == []


def test_run_qwen_dub_writes_no_clips_when_place_lines_cut_nothing(monkeypatch, tmp_path):
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [2.5])
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist", lambda *a, **k: {})

    qp.run_qwen_dub(_FakeEngine(), segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    with open(os.path.join(str(tmp_path), "clipped_lines.json"), encoding="utf-8") as f:
        assert json.load(f) == {"clipped": [], "clipped_count": 0}


def test_run_qwen_dub_carries_place_lines_clips_into_the_sidecar_file(monkeypatch, tmp_path):
    # What the UI will later read: line 0 cut short by 0.4s, recorded by
    # place_lines (app/qwen_assemble.py) into the shared `clipped` list this
    # function passes it, then saved here so app/pipeline.py's run_dub can
    # fold it into the job's result data.
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        if clipped is not None:
            clipped.append({"line": 0, "cut_s": 0.4})
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [2.5])
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist", lambda *a, **k: {})

    qp.run_qwen_dub(_FakeEngine(), segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    with open(os.path.join(str(tmp_path), "clipped_lines.json"), encoding="utf-8") as f:
        assert json.load(f) == {"clipped": [{"line": 0, "cut_s": 0.4}], "clipped_count": 1}


def test_run_qwen_dub_preserve_mode_passes_vocals_path_for_gating(monkeypatch, tmp_path):
    # Opt-in QWEN_GATE_MODE="preserve": the original vocals track DOES reach
    # place_lines (for the gated laughter/breaths-preserving path).
    monkeypatch.setattr(qp, "QWEN_GATE_MODE", "preserve")
    ref_cues = [
        _cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A"),
    ]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]

    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)
    placed = {}

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        placed["vocals_path"] = vocals_path
        placed["speech_regions"] = speech_regions
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [2.5])

    engine = _FakeEngine()
    qp.run_qwen_dub(engine, segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    assert placed["vocals_path"] == "/local/vocals.wav"
    assert placed["speech_regions"] == [(0.0, 5.0)]  # source-language cue span


def test_run_qwen_dub_company_mode_layers_ambience_and_disables_whitelist(monkeypatch, tmp_path):
    # QWEN_GATE_MODE="company": safe-style assembly (vocals never reach
    # place_lines) + the company ambience layer on top; the safe-mode
    # whitelist overlay must be AUTO-DISABLED even with QWEN_KEEP_NONVERBAL=1
    # (the layer already carries the verified nonverbal content -- adding the
    # overlay too would double the audio: clipping/echo).
    monkeypatch.setattr(qp, "QWEN_GATE_MODE", "company")
    monkeypatch.setattr(qp, "QWEN_KEEP_NONVERBAL", 1)
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    placed = {}

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        placed["vocals_path"] = vocals_path
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [2.5])
    whitelisted = []
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist",
                        lambda *a, **k: whitelisted.append(a) or {})
    layered = []
    monkeypatch.setattr(qp, "apply_company_ambience",
                        lambda *a, **k: layered.append((a, k)) or {})

    out = qp.run_qwen_dub(_FakeEngine(), segments, ref_cues, str(tmp_path),
                          vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                          language="Korean")

    assert placed["vocals_path"] is None       # bed itself stays safe-mode
    assert whitelisted == []                    # whitelist overlay auto-off
    assert len(layered) == 1
    la, lk = layered[0]
    assert la[0] == out                         # the assembled mix, in place
    assert la[1] == "/local/vocals.wav"
    assert la[2] == [(0.0, 5.0)]                # original speech cue spans
    assert len(la[3]) == 1 and la[3][0][0] == 0.5  # placed dub-line span starts at the cue
    assert lk.get("manifest_path") == str(tmp_path / "gate_exclusion_manifest.json")


def test_run_qwen_dub_company_mode_uses_trimmed_placed_spans(monkeypatch, tmp_path):
    # Company mode's dub-span exclusion must reflect the line's ACTUAL placed
    # playback (lead/tail silence trimmed -- what place_lines really plays),
    # not the raw wav length: over-wide spans needlessly mute the ambience
    # right after a line (e.g. the first 0.3s of a laugh).
    import math
    import struct
    import wave as wave_mod
    monkeypatch.setattr(qp, "QWEN_GATE_MODE", "company")
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    def fake_synth_lines(*a, **k):
        # 0.3s silence + 0.5s tone + 0.4s silence @24kHz mono -- placed audio
        # after trimming is ~0.5s, raw file is 1.2s
        p = str(tmp_path / "qwen_line_0.wav")
        sr = 24000
        frames = bytearray()
        for i in range(int(1.2 * sr)):
            t = i / sr
            v = int(9000 * math.sin(2 * math.pi * 440 * t)) if 0.3 <= t < 0.8 else 0
            frames += struct.pack("<h", v)
        with wave_mod.open(p, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(bytes(frames))
        return [p]

    monkeypatch.setattr(qp, "synth_lines", fake_synth_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda *a: [1.0])

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    layered = []
    monkeypatch.setattr(qp, "apply_company_ambience",
                        lambda *a, **k: layered.append((a, k)) or {})

    qp.run_qwen_dub(_FakeEngine(), segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    (start, end), = layered[0][0][3]
    assert start == 0.5
    # trimmed playback is ~0.5s (20ms envelope-hop granularity), NOT the raw 1.2s
    assert 0.9 <= end <= 1.1, end


def test_run_qwen_dub_falls_back_to_single_speaker_when_unlabeled(monkeypatch, tmp_path):
    # No speaker_id anywhere -> DEFAULT_SPEAKER bucket, one clone, all lines use it
    ref_cues = [{"start": 0.0, "end": 5.0, "text": "an unlabeled line of dialogue here"}]
    segments = [{"start": 0.0, "end": 1.0, "text": "line a"}, {"start": 1.0, "end": 2.0, "text": "line b"}]

    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)

    def fake_place_lines(background, line_paths, starts, out_path, gains=None,
                         vocals_path=None, speech_regions=None, log=None, clipped=None):
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [1.0] * len(line_wavs))
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist", lambda *a, **k: {})

    engine = _FakeEngine()
    qp.run_qwen_dub(engine, segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean")

    assert len(engine.cloned) == 1  # a single default-speaker voice
    assert len(engine.synth_calls) == 2
    assert engine.synth_calls[0].voice_id == engine.synth_calls[1].voice_id


def test_synth_lines_scoring_unavailable_raises_loud_notice(tmp_path, monkeypatch):
    # v3: silently degrading to take 0 hid a real quality regression (v2 rebuild).
    # When n_takes>1 and scoring is unavailable, a structured on_notice event must
    # fire so the job status JSON carries it (not just a log line).
    monkeypatch.setattr(qp, "score_takes", lambda *a, **k: None)
    engine = _KAwareEngine()
    notices = []
    qp.synth_lines(engine, [{"text": "a"}], ["A"], {"A": "v"}, "Korean", str(tmp_path),
                   n_takes=2, speaker_ref_paths={"A": "/fake/ref.wav"},
                   on_notice=notices.append)
    assert len(notices) == 1
    assert notices[0]["type"] == "take_scoring_unavailable"
    assert "first take" in notices[0]["message"]
    assert "QWEN_SCORER_PYTHON" not in notices[0]["message"]


def test_synth_lines_scoring_ok_fires_no_notice(tmp_path, monkeypatch):
    def fake_score_takes(refs, lines_payload, language, work_dir, log=None, timeout=900):
        return {l["i"]: [{"k": t["k"], "sim": 0.9, "sim_other": 0.1, "asr": 0.9,
                          "dur": 1.0, "usable": l["usable"], "spk": l["spk"], "emb": [1.0, 0.0]}
                         for t in l["takes"]] for l in lines_payload}
    monkeypatch.setattr(qp, "score_takes", fake_score_takes)
    engine = _KAwareEngine()
    notices = []
    qp.synth_lines(engine, [{"text": "a"}], ["A"], {"A": "v"}, "Korean", str(tmp_path),
                   n_takes=2, speaker_ref_paths={"A": "/fake/ref.wav"},
                   usable_slots=[2.0], on_notice=notices.append)
    assert notices == []


def test_synth_lines_keeps_losing_takes_on_disk(tmp_path, monkeypatch):
    # v3: losing takes survive until the job's final assembly+gates pass, so a
    # reassembly pass can re-pick without re-synthesis (disk tradeoff documented
    # in synth_lines' docstring).
    def fake_score_takes(refs, lines_payload, language, work_dir, log=None, timeout=900):
        return {l["i"]: [{"k": t["k"], "sim": 0.95 if t["k"] == 1 else 0.5, "sim_other": 0.1,
                          "asr": 0.9, "dur": 1.0, "usable": l["usable"], "spk": l["spk"],
                          "emb": [1.0, 0.0]}
                         for t in l["takes"]] for l in lines_payload}
    monkeypatch.setattr(qp, "score_takes", fake_score_takes)
    engine = _KAwareEngine()
    paths = qp.synth_lines(engine, [{"text": "only"}], ["A"], {"A": "v"}, "Korean", str(tmp_path),
                           n_takes=2, speaker_ref_paths={"A": "/fake/ref.wav"}, usable_slots=[2.0])
    with open(paths[0], "rb") as f:
        assert f.read() == b"TAKE_0_1"  # winner still take 1
    # both take files remain on disk for possible reassembly
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t0.wav"))
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t1.wav"))


def test_cleanup_takes_removes_only_take_candidates(tmp_path):
    for name in ("qwen_line_0_t0.wav", "qwen_line_0_t1.wav", "qwen_line_12_t3.wav",
                 "qwen_line_0.wav", "vocals.wav"):
        with open(os.path.join(str(tmp_path), name), "wb") as f:
            f.write(b"x")
    removed = qp.cleanup_takes(str(tmp_path))
    assert removed == 3
    assert not os.path.exists(os.path.join(str(tmp_path), "qwen_line_0_t0.wav"))
    assert os.path.exists(os.path.join(str(tmp_path), "qwen_line_0.wav"))  # winners stay
    assert os.path.exists(os.path.join(str(tmp_path), "vocals.wav"))


# --- speaker reference provenance ------------------------------------------

def test_speaker_refs_manifest_records_span_and_source_lines(tmp_path):
    """build_speaker_refs picks a span per speaker but nothing persisted it, so a
    cloned voice that sounds wrong could not be traced to its source audio."""
    import json

    ref_cues = [
        _cue(0.0, 2.0, "joker line one", "Joker"),
        _cue(2.0, 4.0, "joker line two", "Joker"),
        _cue(20.0, 22.0, "joker much later", "Joker"),
        _cue(4.0, 6.0, "batman line one", "Batman"),
    ]
    refs = {
        "Joker": {"wav_bytes": b"x", "ref_text": None, "span": {"start": 0.0, "end": 4.0}},
        "Batman": {"wav_bytes": b"y", "ref_text": None, "span": {"start": 4.0, "end": 6.0}},
    }

    path = qp.write_speaker_refs_manifest(refs, ref_cues, str(tmp_path))

    assert os.path.basename(path) == "speaker_refs.json"
    manifest = json.load(open(path, encoding="utf-8"))
    assert set(manifest) == {"Joker", "Batman"}

    joker = manifest["Joker"]
    assert joker["span"] == {"start": 0.0, "end": 4.0}
    assert joker["ref_wav"] == "qwen_ref_Joker.wav"
    # only Joker's lines inside the span -- not his 20s line, not Batman's
    assert [l["text"] for l in joker["lines"]] == ["joker line one", "joker line two"]
    assert [l["text"] for l in manifest["Batman"]["lines"]] == ["batman line one"]


# --- run_qwen_dub zero-synthesis guard --------------------------------------

def test_run_qwen_dub_fails_when_no_line_synthesizes(monkeypatch, tmp_path):
    # All-lines-failed (e.g. the TTS sidecar is down) used to continue into
    # assembly and ship a speech-less video marked "done" (review HIGH-1).
    import pytest

    monkeypatch.setattr(qp, "build_speaker_refs", lambda *a, **k: {})
    monkeypatch.setattr(qp, "write_speaker_refs_manifest", lambda *a, **k: None)
    monkeypatch.setattr(qp, "synth_lines", lambda *a, **k: [None, None])
    segments = [_cue(0.0, 1.0, "a", "A"), _cue(1.0, 2.0, "b", "A")]
    with pytest.raises(RuntimeError, match="synthesized"):
        qp.run_qwen_dub(_FakeEngine(), segments, segments, str(tmp_path), "/v.wav", "/b.wav")


# --- a line left untranslated stays silent ------------------------------------
# The translator leaves a line it could not translate empty (app/translate.py
# UNTRANSLATED). The user decided such a line keeps no voice -- not the source
# language read out, not whatever the engine makes of nothing.

def _wav_bytes(seconds, rate=24000, amp=6000):
    """A real mono 16-bit wav: a 220Hz tone, or silence at amp=0."""
    import io
    import math
    import struct
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(amp * math.sin(2 * math.pi * 220 * i / rate)))
                               for i in range(int(rate * seconds))))
    return buf.getvalue()


class _WavEngine(_FakeEngine):
    """_FakeEngine that answers with real audio, so the real assembly can run."""
    def synthesize(self, req):
        self.synth_calls.append(req)
        class _Res:
            audio_bytes = _wav_bytes(0.8)
        return _Res()


def test_an_untranslated_line_is_not_synthesized_and_the_dub_still_assembles(monkeypatch, tmp_path):
    import json
    import wave
    (tmp_path / "vocals.wav").write_bytes(_wav_bytes(7.0, amp=3000))
    (tmp_path / "background.wav").write_bytes(_wav_bytes(7.0, amp=0))
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"REF" * 500)
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist", lambda *a, **k: {})
    ref_cues = [_cue(0.0, 6.0, "hello this is speaker A talking a lot right now", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "first"},
                {"start": 2.5, "end": 4.0, "text": ""},
                {"start": 4.5, "end": 6.0, "text": "third"}]
    engine = _WavEngine()
    logs = []

    out = qp.run_qwen_dub(engine, segments, ref_cues, str(tmp_path),
                          vocals_path=str(tmp_path / "vocals.wav"),
                          background_path=str(tmp_path / "background.wav"),
                          language="Korean", log=logs.append)

    assert [c.text for c in engine.synth_calls] == ["first", "third"]
    assert not (tmp_path / "qwen_line_1.wav").exists()
    # The real assembly ran over the gap: the full-length mix is there.
    with wave.open(out, "rb") as w:
        assert abs(w.getnframes() / w.getframerate() - 7.0) < 0.05
    # The silent line keeps its place in the manifest, so writing it in later
    # and remaking that one voice lands it at the right moment.
    manifest = json.loads((tmp_path / "lines.json").read_text(encoding="utf-8"))
    assert [e["text"] for e in manifest["lines"]] == ["first", "", "third"]
    assert manifest["lines"][1]["start"] == 2.5
    assert any("1 line(s) have no words - left silent" in m for m in logs)


def test_an_untranslated_line_is_skipped_when_several_takes_are_made(tmp_path):
    engine = _KAwareEngine()
    paths = qp.synth_lines(engine, [{"text": "a"}, {"text": " "}, {"text": "b"}],
                           ["A", "A", "A"], {"A": "vidA"}, "Korean", str(tmp_path),
                           n_takes=2, speaker_ref_paths=None)
    assert paths[1] is None and paths[0] and paths[2]
    assert sorted(c.seed for c in engine.synth_calls) == [0, 1, 2000, 2001]


def test_ultra_short_lines_do_not_merge_across_an_untranslated_one(tmp_path):
    # Line 2 is ultra-short and would join the line before it. That line is
    # empty, so it stays alone -- it does not reach back past the gap to line 0.
    engine = _FakeEngine()
    segments = [{"start": 0.0, "end": 1.0, "text": "zero"},
                {"start": 1.0, "end": 1.3, "text": ""},
                {"start": 1.3, "end": 1.6, "text": "two"}]
    paths = qp.synth_lines(engine, segments, ["A", "A", "A"], {"A": "vidA"}, "Korean",
                           str(tmp_path), usable_slots=[1.0, 0.3, 0.3])
    assert [c.text for c in engine.synth_calls] == ["zero", "two"]
    assert paths[1] is None and paths[0] and paths[2]


def test_rebuild_dub_rewrites_which_lines_were_cut_short(monkeypatch, tmp_path):
    """A remade voice has a new length; the record of cut lines must follow it."""
    (tmp_path / "background.wav").write_bytes(b"")
    (tmp_path / "clipped_lines.json").write_text(
        json.dumps({"clipped": [{"line": 1, "cut_s": 0.9}], "clipped_count": 1}))

    def place(bg, paths, starts, out, gains=None, log=None, clipped=None):
        clipped.append({"line": 2, "cut_s": 0.3})   # line 1 fits now, line 2 does not

    class Ok:
        returncode = 0
    monkeypatch.setattr(qp, "place_lines", place)
    monkeypatch.setattr(qp.media, "mux", lambda *a: Ok())
    monkeypatch.setattr(qp.media, "video_duration", lambda p: 1.0)
    monkeypatch.setattr(qp.media, "ensure_video_length", lambda *a: None)

    qp.rebuild_dub(str(tmp_path), {"lines": [{"i": 0, "start": 0}, {"i": 1, "start": 2}]},
                   str(tmp_path / "in.mp4"), str(tmp_path / "out.mp4"))

    assert json.loads((tmp_path / "clipped_lines.json").read_text()) == {
        "clipped": [{"line": 2, "cut_s": 0.3}], "clipped_count": 1}



def test_a_qwen_line_loses_the_stray_sound_before_its_sentence(tmp_path):
    # Qwen3-TTS opened 6.5% of lines with a short sound in the cloned voice,
    # a pause, then the sentence (2026-10-01): the file starts at the sentence.
    import wave

    from tests.test_lead_burst import _wav

    class _BurstEngine(_FakeEngine):
        needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

        def synthesize(self, req):
            self.synth_calls.append(req)
            class _Res:
                audio_bytes = _wav([(0.2, 4000), (0.6, 0), (1.5, 9000)])
            return _Res()

    logs = []
    paths = qp.synth_lines(_BurstEngine(), [{"text": "Me siento orgulloso."}], ["A"], {"A": "v"},
                           "Spanish", str(tmp_path), log=logs.append)
    with wave.open(paths[0]) as w:
        assert abs(w.getnframes() / w.getframerate() - 1.55) < 0.05
    assert any("cut a stray sound before the sentence" in m for m in logs)


# --- Fast mode hears every line back (2026-10-01) ---------------------------

class _QwenWavEngine(_FakeEngine):
    """Answers with 1s of tone and records each seed asked for."""
    needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

    def synthesize(self, req):
        from tests.test_lead_burst import _wav
        self.synth_calls.append(req)
        class _Res:
            audio_bytes = _wav([(1.0, 9000 if req.seed < 100000 else 5000)])
        return _Res()


def _fake_heard(answers):
    """transcribe_batch stand-in: what was 'heard' in each file, by its name."""
    def run(paths, language=None, timeout=None):
        run.languages.append(language)
        return {p: answers(os.path.basename(p)) for p in paths}
    run.languages = []
    return run


def test_fast_line_with_added_words_is_made_again_and_the_clean_try_kept(monkeypatch, tmp_path):
    heard = _fake_heard(lambda name: "get get get get get going hurry" if name == "qwen_line_0.wav"
                        else "get going hurry")
    monkeypatch.setattr(qp, "transcribe_batch", heard)
    engine = _QwenWavEngine()
    logs = []
    segments = [{"start": 0.0, "end": 1.0, "text": "get going. Hurry"}]
    paths = qp.synth_lines(engine, segments, ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[2.5], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert paths == [str(tmp_path / "qwen_line_0.wav")]
    assert heard.languages == ["en", "en"]
    assert any("line 0: heard" in m and "made again" in m for m in logs)
    assert sorted(f for f in os.listdir(tmp_path) if f.startswith("qwen_")) == ["qwen_line_0.wav"]


def test_fast_line_that_never_comes_out_right_keeps_the_closest_try(monkeypatch, tmp_path):
    words = {"qwen_line_0.wav": "G G G G G hear my call", "qwen_line_0_r1.wav": "zzz",
             "qwen_line_0_r2.wav": "Ginu Ginu can"}
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: words[name]))
    engine = _QwenWavEngine()
    logs = []
    qp.synth_lines(engine, [{"text": "Ginu! Ginu! Can you hear my call?"}], ["A"], {"A": "v"},
                           "English", str(tmp_path), usable_slots=[3.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100, 200]
    assert any("no try came out right, kept the closest" in m for m in logs)
    assert [f for f in os.listdir(tmp_path) if f.startswith("qwen_")] == ["qwen_line_0.wav"]


def test_fast_check_without_whisper_leaves_the_lines_as_made(monkeypatch, tmp_path):
    monkeypatch.setattr(qp, "transcribe_batch", lambda paths, language=None, timeout=None: None)
    engine = _QwenWavEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "hello"}], ["A"], {"A": "v"}, "Korean", str(tmp_path),
                           usable_slots=[3.0], log=logs.append)
    assert len(engine.synth_calls) == 1 and os.path.exists(paths[0])
    assert any("line check skipped" in m for m in logs)


def test_fast_check_is_for_qwen_only(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("a line from an engine without free retakes is not heard back")
    monkeypatch.setattr(qp, "transcribe_batch", boom)
    qp.synth_lines(_FakeEngine(), [{"text": "hello"}], ["A"], {"A": "v"}, "Korean", str(tmp_path))


# --- Fast mode: a short line is made three times (2026-10-02) ----------------

class _TakesEngine(_FakeEngine):
    """Answers each seed with a tone of the length given for it."""
    needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

    def __init__(self, secs_by_seed):
        super().__init__()
        self.secs_by_seed = secs_by_seed

    def synthesize(self, req):
        from tests.test_lead_burst import _wav
        self.synth_calls.append(req)
        secs = self.secs_by_seed[req.seed]
        class _Res:
            audio_bytes = _wav([(secs, 9000)])
        return _Res()


def _secs(path):
    import wave
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())


def test_short_line_keeps_the_take_that_says_its_text_and_fits(monkeypatch, tmp_path):
    words = {"qwen_line_0.wav": "come here", "qwen_line_0_s1.wav": "come come come here",
             "qwen_line_0_s2.wav": "come here"}
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: words[name]))
    engine = _TakesEngine({0: 1.8, 1: 1.1, 2: 1.2})
    paths = qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[1.2])
    assert [c.seed for c in engine.synth_calls] == [0, 1, 2]
    assert abs(_secs(paths[0]) - 1.2) < 0.03          # 1.8s runs past 1.1x, take 2 stutters
    assert [f for f in os.listdir(tmp_path) if f.startswith("qwen_")] == ["qwen_line_0.wav"]


def test_short_line_keeps_the_fitting_take_closest_to_its_slot(monkeypatch, tmp_path):
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "come here"))
    engine = _TakesEngine({0: 0.6, 1: 1.5, 2: 1.0})
    paths = qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[1.2])
    assert abs(_secs(paths[0]) - 1.0) < 0.03


def test_a_line_with_a_longer_slot_is_made_once(monkeypatch, tmp_path):
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "come here"))
    engine = _TakesEngine({0: 1.0})
    qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                   usable_slots=[2.0])
    assert [c.seed for c in engine.synth_calls] == [0]


# --- Fast mode: a sound right before or after the sentence (2026-10-02) ------

class _StrayEngine(_FakeEngine):
    """Seed 0 opens with a short quiet sound and a 0.24s dip; others do not."""
    needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

    def synthesize(self, req):
        from tests.test_lead_burst import _wav
        self.synth_calls.append(req)
        parts = [(0.12, 2000), (0.24, 0), (1.5, 9000)] if req.seed == 0 else [(1.5, 9000)]
        class _Res:
            audio_bytes = _wav(parts)
        return _Res()


def test_fast_line_loses_a_stray_sound_whisper_does_not_miss(monkeypatch, tmp_path):
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "come here"))
    engine = _StrayEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[3.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0]
    assert abs(_secs(paths[0]) - 1.55) < 0.03
    assert any("cut a stray sound next to the sentence" in m for m in logs)
    assert [f for f in os.listdir(tmp_path) if f.startswith("qwen_")] == ["qwen_line_0.wav"]


def test_fast_line_whose_edge_sound_sits_too_close_to_cut_is_made_again(monkeypatch, tmp_path):
    # "Com-paring" (2026-10-07): the sound is a syllable's shape away from the
    # sentence, so no cut is tried; the line is made again and the clean try kept.
    class _CloseEngine(_StrayEngine):
        def synthesize(self, req):
            from tests.test_lead_burst import _wav
            self.synth_calls.append(req)
            parts = [(0.12, 2000), (0.12, 0), (1.5, 9000)] if req.seed == 0 else [(1.5, 9000)]
            class _Res:
                audio_bytes = _wav(parts)
            return _Res()

    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "come here"))
    engine = _CloseEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[3.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert abs(_secs(paths[0]) - 1.5) < 0.03
    assert any("set apart at its start or end - made again" in m for m in logs)
    assert not any("cut a stray sound next to the sentence" in m for m in logs)


def test_fast_line_whose_edge_sound_is_part_of_a_word_is_made_again(monkeypatch, tmp_path):
    # Without the sound Whisper hears less: it was a word said with a gap in
    # it ("있 ... 어요"), so the line is made again and the clean try kept.
    words = {"qwen_line_0.wav": "come here", "qwen_line_0_e.wav": "come",
             "qwen_line_0_r1.wav": "come here"}
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: words[name]))
    engine = _StrayEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "Come here!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[3.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert abs(_secs(paths[0]) - 1.5) < 0.03
    assert any("set apart at its start or end - made again" in m for m in logs)
    assert [f for f in os.listdir(tmp_path) if f.startswith("qwen_")] == ["qwen_line_0.wav"]


def test_fast_line_heard_without_its_first_word_is_made_again(monkeypatch, tmp_path):
    # The lead cut took "We'll" with it and Whisper still matched 0.97 (2026-10-07).
    words = {"qwen_line_0.wav": "start with the brain", "qwen_line_0_r1.wav": "we will start with the brain"}
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: words[name]))
    engine = _QwenWavEngine()
    logs = []
    qp.synth_lines(engine, [{"text": "We'll start with the brain."}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[4.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert any("its first or last word was not heard - made again" in m for m in logs)
    assert [f for f in os.listdir(tmp_path) if f.startswith("qwen_")] == ["qwen_line_0.wav"]


def test_an_edge_cut_that_loses_the_first_word_is_not_kept(monkeypatch, tmp_path):
    # Heard better without the edge sound only because the stutter went too: the
    # cut copy no longer says "come", so it is not kept and the line is made again.
    words = {"qwen_line_0.wav": "come here now now now now now", "qwen_line_0_e.wav": "here now",
             "qwen_line_0_r1.wav": "come here now"}
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: words[name]))
    engine = _StrayEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "Come here now!"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                           usable_slots=[3.0], log=logs.append)
    assert not any("cut a stray sound next to the sentence" in m for m in logs)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert abs(_secs(paths[0]) - 1.5) < 0.03


def test_voice_samples_are_cut_from_the_sample_cues_when_given(monkeypatch, tmp_path):
    """The Shuka lecture (2026-10-04): merged into lines of 9, 9 and 7 s, its
    only line short enough for a sample was the last, cut off by the end of
    the video mid-sentence. The transcript's own lines give a sample that
    ends a sentence before that."""
    ref_cues = [_cue(0.0, 9.0, "그때 당시에 대통령이 누구였죠? 노태우 여권인데 제1기 신도시가", "A")]
    sample_cues = [_cue(0.0, 4.5, "그때 당시에 대통령이 누구였죠?", "A"),
                   _cue(4.5, 9.0, "노태우 여권인데 제1기 신도시가", "A")]
    segments = [{"start": 0.5, "end": 2.0, "text": "translated line"}]
    cut = []
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: cut.append(spans) or b"REF" * 500)

    def fake_place_lines(background, line_paths, starts, out_path, **k):
        with open(out_path, "wb") as f:
            f.write(b"MIXED")
        return out_path

    monkeypatch.setattr(qp, "place_lines", fake_place_lines)
    monkeypatch.setattr(qp, "match_line_gains", lambda vocals_wav, cues, line_wavs: [1.0])
    monkeypatch.setattr(qp, "apply_nonverbal_whitelist", lambda *a, **k: {})
    engine = _FakeEngine()
    qp.run_qwen_dub(engine, segments, ref_cues, str(tmp_path),
                    vocals_path="/local/vocals.wav", background_path="/local/background.wav",
                    language="Korean", sample_cues=sample_cues)
    assert cut == [[[0.0, 4.5]]]
    refs = json.load(open(tmp_path / "speaker_refs.json", encoding="utf-8"))
    assert refs["A"]["ref_text"] == "그때 당시에 대통령이 누구였죠?"


# --- A line in another voice is made again (2026-10-06) ----------------------

def _fake_embedder(vectors):
    """_embed_files stand-in: a fixed unit vector per file name."""
    def run(paths):
        run.calls.append(list(paths))
        return [vectors(os.path.basename(p)) for p in paths], [1.0] * len(paths)
    run.calls = []
    return run


def test_fast_line_in_another_voice_is_made_again_and_the_speakers_voice_kept(monkeypatch, tmp_path):
    # The anchor briefing came out as different people line by line, though
    # every line said its words (2026-10-06): the check heard the words and
    # never the voice. Against the speaker's reference, lines that drifted
    # measured 0.07-0.49 and lines that did not 0.52-0.81 (160 lines).
    from tests.test_lead_burst import _wav
    (tmp_path / "qwen_ref_A.wav").write_bytes(_wav([(1.0, 9000)]))
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "get going hurry"))
    embed = _fake_embedder(lambda name: [0.3, 0.954] if name == "qwen_line_0.wav" else [1.0, 0.0])
    monkeypatch.setattr(qp, "_embed_files", embed)
    engine = _QwenWavEngine()
    logs = []
    paths = qp.synth_lines(engine, [{"text": "get going. Hurry"}], ["A"], {"A": "v"}, "English",
                           str(tmp_path), usable_slots=[2.5], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert any("line 0: its voice is unlike the speaker's (0.30) - made again" in m for m in logs)
    assert embed.calls[0][0].endswith("qwen_ref_A.wav")
    assert paths == [str(tmp_path / "qwen_line_0.wav")]
    assert sorted(f for f in os.listdir(tmp_path) if f.startswith("qwen_line")) == ["qwen_line_0.wav"]


def test_fast_line_in_another_voice_every_time_keeps_the_closest_voice(monkeypatch, tmp_path):
    from tests.test_lead_burst import _wav
    (tmp_path / "qwen_ref_A.wav").write_bytes(_wav([(1.0, 9000)]))
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "get going hurry"))
    near = {"qwen_line_0.wav": [0.1, 0.995], "qwen_line_0_r1.wav": [0.45, 0.893], "qwen_line_0_r2.wav": [0.2, 0.98]}
    monkeypatch.setattr(qp, "_embed_files", _fake_embedder(lambda name: near.get(name, [1.0, 0.0])))
    made = {}
    real_replace = qp.shutil.copyfile
    monkeypatch.setattr(qp.shutil, "copyfile", lambda a, b: made.setdefault("kept", os.path.basename(a)) and real_replace(a, b))
    logs = []
    qp.synth_lines(_QwenWavEngine(), [{"text": "get going. Hurry"}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[2.5], log=logs.append)
    assert made["kept"] == "qwen_line_0_r1.wav"
    assert any("no try came out right" in m and "voice 0.45" in m for m in logs)


def test_fast_check_without_cam_keeps_the_lines_the_words_check_passed(monkeypatch, tmp_path):
    from tests.test_lead_burst import _wav
    (tmp_path / "qwen_ref_A.wav").write_bytes(_wav([(1.0, 9000)]))
    monkeypatch.setattr(qp, "transcribe_batch", _fake_heard(lambda name: "get going hurry"))
    engine = _QwenWavEngine()
    logs = []
    qp.synth_lines(engine, [{"text": "get going. Hurry"}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[2.5], log=logs.append)
    assert len(engine.synth_calls) == 1
    assert any("voice check skipped" in m for m in logs)


def test_a_made_line_never_starts_with_a_click(tmp_path):
    import struct

    from tests.test_lead_burst import _first_ms_peak

    class _LoudStartEngine(_FakeEngine):
        needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

        def synthesize(self, req):
            from tests.test_lead_burst import _wav
            w = _wav([(1.0, 0)])
            class _Res:
                audio_bytes = w[:44] + b"".join(struct.pack("<h", 9000) for _ in range(len(w[44:]) // 2))
            return _Res()

    paths = qp.synth_lines(_LoudStartEngine(), [{"text": "hello"}], ["A"], {"A": "v"}, "English",
                           str(tmp_path), log=lambda m: None)
    assert _first_ms_peak(open(paths[0], "rb").read(), 1) < 1000


# --- The voice sample's own words leaking in its language (2026-10-06) -------

def _refs_json(tmp_path, ref_text):
    import json
    with open(tmp_path / "speaker_refs.json", "w", encoding="utf-8") as f:
        json.dump({"A": {"ref_wav": "qwen_ref_A.wav", "ref_text": ref_text}}, f, ensure_ascii=False)


class _PieceEngine(_FakeEngine):
    """Answers with 0.6 s of sound, 0.5 s quiet, then the sentence; a remake
    (any seed past the first) with the sentence alone."""
    needs_spoken_numbers = adds_stray_sounds = free_retakes = True   # as Qwen3-TTS

    def synthesize(self, req):
        from tests.test_lead_burst import _wav
        self.synth_calls.append(req)
        audio = _wav([(0.6, 6000), (0.5, 0), (2.0, 9000)]) if req.seed == 0 else _wav([(2.0, 9000)])
        class _Res:
            audio_bytes = audio
        return _Res()


def test_a_line_opening_with_the_voice_samples_last_words_is_made_again(monkeypatch, tmp_path):
    # "…살아왔는지가 보입니다" was the Korean voice sample; English line 8
    # opened with "(보)입니다", which the English-only check could not hear.
    _refs_json(tmp_path, "뇌 MRI를 보면 그동안 이 사람이 어떻게 살아왔는지가 보입니다")
    heard = _fake_heard(lambda name: "손입니다" if "_p" in name else "this shows blockages")
    monkeypatch.setattr(qp, "transcribe_batch", heard)
    engine = _PieceEngine()
    logs = []
    qp.synth_lines(engine, [{"text": "This shows blockages."}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[4.0], log=logs.append)
    assert [c.seed for c in engine.synth_calls] == [0, 100]
    assert "ko" in heard.languages
    assert any("line 0: the voice sample's own words were heard (" in m for m in logs)
    # How much was heard, not what: the job log goes out with a failure report,
    # and docs/privacy.md says the logs never record what was said (2026-10-12).
    assert any("line 0: the voice sample's own words were heard (4 characters)" in m for m in logs)
    assert not any("손입니다" in m for m in logs)
    assert not [f for f in os.listdir(tmp_path) if "_p" in f]


def test_a_piece_that_is_not_the_voice_samples_words_is_left(monkeypatch, tmp_path):
    _refs_json(tmp_path, "뇌 MRI를 보면 그동안 이 사람이 어떻게 살아왔는지가 보입니다")
    monkeypatch.setattr(qp, "transcribe_batch",
                        _fake_heard(lambda name: "디스" if "_p" in name else "this shows blockages"))
    engine = _PieceEngine()
    qp.synth_lines(engine, [{"text": "This shows blockages."}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[4.0], log=lambda m: None)
    assert [c.seed for c in engine.synth_calls] == [0]


def test_a_sample_in_the_same_script_as_the_line_is_not_heard_twice(monkeypatch, tmp_path):
    _refs_json(tmp_path, "and that is how it always will be")
    heard = _fake_heard(lambda name: "will be" if "_p" in name else "esto muestra bloqueos")
    monkeypatch.setattr(qp, "transcribe_batch", heard)
    qp.synth_lines(_PieceEngine(), [{"text": "Esto muestra bloqueos."}], ["A"], {"A": "v"}, "Spanish",
                   str(tmp_path), usable_slots=[4.0], log=lambda m: None)
    assert heard.languages == ["es"]


def test_whisper_making_up_a_polite_ending_in_a_quiet_piece_is_not_a_leak(monkeypatch, tmp_path):
    # Whisper hears "감사합니다" or "다음 영상에서 만나요" in short quiet
    # pieces of many lines (2026-10-06). Two letters in common with the
    # sample's end ("니다" of "보입니다") is a made-up ending, not the sample.
    _refs_json(tmp_path, "뇌 MRI를 보면 그동안 이 사람이 어떻게 살아왔는지가 보입니다")
    monkeypatch.setattr(qp, "transcribe_batch",
                        _fake_heard(lambda name: "감사합니다." if "_p" in name else "this shows blockages"))
    engine = _PieceEngine()
    qp.synth_lines(engine, [{"text": "This shows blockages."}], ["A"], {"A": "v"}, "English",
                   str(tmp_path), usable_slots=[4.0], log=lambda m: None)
    assert [c.seed for c in engine.synth_calls] == [0]


# --- A line starts where its cue starts (2026-10-06) ---------------------------

def test_a_line_longer_than_its_slot_still_starts_where_the_speaker_did(monkeypatch, tmp_path):
    # A line whose voice runs into the next line used to be started up to 0.8 s
    # before its cue to spare its last word (the leading-pause borrow). The
    # owner heard the dub speak before the mouth moved and ruled it out: a
    # line starts where the speaker started, and what does not fit is sped up
    # or cut, never moved.
    from tests.test_lead_burst import _wav

    class _LongVoice(TTSEngine):
        id = "cloud"

        def assign_voices(self, refs, speakers, work_dir, log, mode=None):
            return {s: "voice-" + s for s in speakers}

        def is_available(self):
            return True

        def synthesize(self, req):
            from app.engines.base import SynthesisResult
            return SynthesisResult(audio_bytes=_wav([(3.0, 9000)]), duration=3.0)

    segments = [{"start": 4.0, "end": 5.0, "text": "one"}, {"start": 10.0, "end": 11.5, "text": "two"},
                {"start": 12.0, "end": 13.0, "text": "three"}]
    cues = [dict(s, speaker_id="A") for s in segments]
    monkeypatch.setattr(qp, "build_speaker_refs", lambda *a, **k: {})
    monkeypatch.setattr(qp, "match_line_gains", lambda *a, **k: [1.0, 1.0, 1.0])
    placed = {}
    monkeypatch.setattr(qp, "place_lines", lambda bg, paths, starts, out, **k: placed.update(starts=starts))
    monkeypatch.setattr(qp, "QWEN_GATE_MODE", "preserve")
    qp.run_qwen_dub(_LongVoice(), segments, cues, str(tmp_path), "v.wav", "bg.wav", language="English",
                    log=lambda m: None)
    assert placed["starts"] == [4.0, 10.0, 12.0]


def test_synth_lines_restarts_a_bloated_engine_between_lines(tmp_path):
    # The engine's memory is read before every line; past ENGINE_RESTART_MB it
    # is started again (and its voices cloned again), then the line is made.
    class _BigEngine(_FakeEngine):
        def __init__(self):
            super().__init__()
            self.readings = [qp.ENGINE_RESTART_MB - 1, qp.ENGINE_RESTART_MB + 1, 100]
            self.restarts = 0
        def memory_mb(self):
            return self.readings.pop(0) if self.readings else 100
        def restart(self):
            self.restarts += 1

    engine = _BigEngine()
    logs = []
    segments = [{"text": "line zero"}, {"text": "line one"}, {"text": "line two"}]
    paths = qp.synth_lines(engine, segments, ["A"] * 3, {"A": "vidA"}, "Korean", str(tmp_path), log=logs.append)
    assert engine.restarts == 1
    assert all(paths)
    assert [req.text for req in engine.synth_calls] == ["line zero", "line one", "line two"]
    assert any("starting it again" in m for m in logs)
