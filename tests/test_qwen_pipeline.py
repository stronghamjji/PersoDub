"""Pure-function selection logic + mocked orchestration for the Qwen3-TTS dub path."""
import os

from app import qwen_pipeline as qp


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


def test_build_speaker_refs_timbre_mode_skips_ref_text_by_default(monkeypatch):
    # Default mode (config.QWEN_VOICE_MODE == "timbre"): audio span still gets cut,
    # but no transcript is assembled -- ref_text is None.
    ref_cues = [_cue(0.0, 5.0, "hello this is speaker A talking now", "A")]
    monkeypatch.setattr(qp, "cut_vocals_span_local", lambda vocals_path, spans: b"WAVBYTES" * 200)
    refs = qp.build_speaker_refs(ref_cues, ["A"], "/local/vocals.wav")
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


# --- register_speaker_voices / synth_lines (mocked engine) -----------------

class _FakeEngine:
    def __init__(self):
        self.cloned = []
        self.synth_calls = []

    def clone(self, ref_audio_path, ref_text, mode=None):
        self.cloned.append((ref_audio_path, ref_text, mode))
        return "voice-" + (ref_text or "")[:4]

    def synthesize(self, req):
        self.synth_calls.append(req)
        class _Res:
            audio_bytes = b"WAV" + req.text.encode()
        return _Res()


def test_register_speaker_voices_writes_ref_file_and_clones(tmp_path):
    engine = _FakeEngine()
    refs = {"A": {"wav_bytes": b"RIFFxxxx", "ref_text": "hi there", "span": {"start": 0, "end": 5}}}
    voice_ids = qp.register_speaker_voices(engine, refs, str(tmp_path))
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


# --- synth_lines: ultra-short-line merge wiring (app/qwen_merge.py) --------

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
                         vocals_path=None, speech_regions=None, log=None):
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
                         vocals_path=None, speech_regions=None, log=None):
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
                         vocals_path=None, speech_regions=None, log=None):
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
                         vocals_path=None, speech_regions=None, log=None):
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
                         vocals_path=None, speech_regions=None, log=None):
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
                         vocals_path=None, speech_regions=None, log=None):
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
    assert "take 0" in notices[0]["message"]


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
    monkeypatch.setattr(qp, "register_speaker_voices", lambda *a, **k: {})
    monkeypatch.setattr(qp, "write_speaker_refs_manifest", lambda *a, **k: None)
    monkeypatch.setattr(qp, "synth_lines", lambda *a, **k: [None, None])
    segments = [_cue(0.0, 1.0, "a", "A"), _cue(1.0, 2.0, "b", "A")]
    with pytest.raises(RuntimeError, match="synthesized"):
        qp.run_qwen_dub(None, segments, segments, str(tmp_path), "/v.wav", "/b.wav")
