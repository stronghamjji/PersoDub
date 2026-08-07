"""Pure-logic tests for app/qwen_select.py (eligibility, baseline pick, coherence
rounds, and the fit-first amendment). No subprocess, no numpy/torch -- plain dicts.
"""
from app import qwen_select as qs


def _cand(k, spk="A", usable=2.0, sim=0.8, sim_other=0.1, asr=0.9, dur=1.8, emb=(1.0, 0.0)):
    return {"k": k, "spk": spk, "usable": usable, "sim": sim, "sim_other": sim_other,
            "asr": asr, "dur": dur, "emb": list(emb)}


# --- cosine ------------------------------------------------------------

def test_cosine_identical_vectors_is_one():
    assert abs(qs.cosine([1.0, 0.0], [1.0, 0.0]) - 1.0) < 1e-6


def test_cosine_orthogonal_vectors_is_zero():
    assert abs(qs.cosine([1.0, 0.0], [0.0, 1.0])) < 1e-6


# --- eligible_takes ------------------------------------------------------

def test_eligible_takes_filters_by_asr_margin_and_duration():
    cands = [
        _cand(0, asr=0.5),                       # fails asr floor
        _cand(1, sim=0.5, sim_other=0.49),        # fails margin (0.01 <= 0.02)
        _cand(2, dur=2.5, usable=2.0),            # fails duration (over by 0.5 > 0.15 tol)
        _cand(3, sim=0.9, sim_other=0.5),         # passes everything
    ]
    ok = qs.eligible_takes(cands)
    assert [c["k"] for c in ok] == [3]


def test_eligible_takes_within_duration_tolerance_passes():
    cands = [_cand(0, dur=2.1, usable=2.0)]  # over by 0.1, within DUR_TOL=0.15
    assert qs.eligible_takes(cands) == cands


def test_eligible_takes_falls_back_to_best_margin_when_nothing_qualifies():
    cands = [
        _cand(0, asr=0.3, sim=0.6, sim_other=0.5),   # margin 0.1
        _cand(1, asr=0.2, sim=0.9, sim_other=0.5),   # margin 0.4 -- best margin, wins fallback
    ]
    ok = qs.eligible_takes(cands)
    assert len(ok) == 1
    assert ok[0]["k"] == 1


# --- baseline_pick ---------------------------------------------------------

def test_baseline_pick_maximizes_sim_minus_length_penalty():
    cands = [
        _cand(0, sim=0.95, dur=3.0, usable=2.0),   # 0.95 - 0.5*1.0 = 0.45
        _cand(1, sim=0.80, dur=2.0, usable=2.0),   # 0.80 - 0 = 0.80  <- wins
    ]
    assert qs.baseline_pick(cands)["k"] == 1


def test_baseline_pick_asr_floor_excludes_low_pronunciation_takes():
    cands = [
        _cand(0, asr=0.3, sim=0.99, dur=1.0, usable=2.0),  # would win on score but fails asr floor
        _cand(1, asr=0.9, sim=0.5, dur=2.0, usable=2.0),
    ]
    assert qs.baseline_pick(cands)["k"] == 1


def test_baseline_pick_falls_back_to_all_candidates_when_all_fail_asr():
    # A 2-3 char line where ASR is unreliable for every take -- the floor is
    # dropped and the best sim/length score decides instead of raising.
    cands = [
        _cand(0, asr=0.1, sim=0.4, dur=2.0, usable=2.0),
        _cand(1, asr=0.2, sim=0.9, dur=2.0, usable=2.0),  # best score among all
    ]
    assert qs.baseline_pick(cands)["k"] == 1


# --- pick_coherence ---------------------------------------------------------

def test_pick_coherence_empty_input():
    assert qs.pick_coherence({}) == {}


def test_pick_coherence_single_line_matches_baseline():
    cands = [_cand(0, sim=0.9, dur=1.8, usable=2.0), _cand(1, sim=0.6, dur=1.8, usable=2.0)]
    picks = qs.pick_coherence({0: cands})
    assert picks[0]["k"] == 0  # only one line -> centroid == its own pick, baseline holds


def test_pick_coherence_pulls_toward_speaker_centroid():
    # Speaker A has three lines. Lines 0 and 2 have only one candidate each,
    # both at emb=[1,0] -- they dominate the speaker centroid. Line 1's
    # baseline pick (by sim alone: 0.85 > 0.80, both fit their slot) is the
    # take at emb=[0,1], but once the centroid pulls toward [1,0] (2 votes vs
    # line 1's own 1 vote), the coherence re-pick should flip to the take
    # closer to the centroid, [1,0], even though its own sim is lower.
    line0 = [_cand(0, spk="A", sim=0.9, dur=1.5, usable=2.0, emb=(1.0, 0.0))]
    line2 = [_cand(0, spk="A", sim=0.9, dur=1.5, usable=2.0, emb=(1.0, 0.0))]
    line1 = [
        _cand(0, spk="A", sim=0.85, sim_other=0.1, dur=1.8, usable=2.0, emb=(0.0, 1.0)),
        _cand(1, spk="A", sim=0.80, sim_other=0.1, dur=1.8, usable=2.0, emb=(1.0, 0.0)),
    ]
    # Sanity check: line 1's baseline pick alone (ignoring the other lines) is take 0.
    assert qs.baseline_pick(line1)["k"] == 0

    picks = qs.pick_coherence({0: line0, 1: line1, 2: line2})
    assert picks[1]["k"] == 1


def test_pick_coherence_fit_first_amendment_prefers_slot_fitting_take():
    # Line 1's baseline pick (sim - 0.5*over) favors a take that overflows its
    # slot by 0.05s (within the 0.15s eligibility tolerance) because its raw
    # sim is highest. The fit-first amendment says: once inside the coherence
    # rounds, if ANY eligible take actually fits (dur<=usable), restrict the
    # re-pick pool to those -- so the over-slot take must lose even though it
    # would otherwise win on cos-to-centroid + sim.
    line0 = [_cand(0, spk="A", sim=0.9, dur=1.5, usable=2.0, emb=(1.0, 0.0))]
    over_slot_take = _cand(
        0, spk="A", sim=0.95, sim_other=0.1, asr=0.85, dur=2.05, usable=2.0, emb=(0.0, 1.0),
    )
    fitting_take = _cand(
        1, spk="A", sim=0.80, sim_other=0.1, asr=0.85, dur=1.9, usable=2.0, emb=(1.0, 0.0),
    )
    line1 = [over_slot_take, fitting_take]

    # Sanity check: the baseline pick alone (no amendment) picks the over-slot take.
    assert qs.baseline_pick(line1)["k"] == 0

    picks = qs.pick_coherence({0: line0, 1: line1})
    assert picks[1]["k"] == 1  # fit-first forces the slot-fitting take to win instead


# --- duration-fit final pass (v3: fill dead-air holes / avoid cuts without
# sacrificing meaningful quality) ---

def test_duration_fit_prefers_take_closest_to_usable_within_quality_band():
    # Both takes fit the slot and are quality-equal (identical emb, sim within the
    # FIT_QUALITY_BAND). The longer take (3.2s vs 5.5s usable) is closer to filling
    # the slot than the 2.0s one -> it must win, killing a 1.2s extra hole.
    short_take = _cand(0, spk="A", sim=0.90, sim_other=0.1, dur=2.0, usable=5.5, emb=(1.0, 0.0))
    long_take = _cand(1, spk="A", sim=0.89, sim_other=0.1, dur=3.2, usable=5.5, emb=(1.0, 0.0))
    picks = qs.pick_coherence({0: [short_take, long_take]})
    assert picks[0]["k"] == 1


def test_duration_fit_never_overrides_a_clear_quality_gap():
    # The longer take is far outside the quality band (sim 0.5 vs 0.9) -- fit must
    # NOT override a clear quality difference.
    good_short = _cand(0, spk="A", sim=0.90, sim_other=0.1, dur=2.0, usable=5.5, emb=(1.0, 0.0))
    bad_long = _cand(1, spk="A", sim=0.50, sim_other=0.1, dur=5.4, usable=5.5, emb=(1.0, 0.0))
    picks = qs.pick_coherence({0: [good_short, bad_long]})
    assert picks[0]["k"] == 0


def test_duration_fit_respects_fit_first_pool():
    # An over-slot take (dur>usable, within DUR_TOL) is quality-equal and nominally
    # "closest" to usable, but the fit-first pool already excludes it when a
    # fitting take exists -- duration-fit must operate inside that pool.
    fitting = _cand(0, spk="A", sim=0.90, sim_other=0.1, dur=1.8, usable=2.0, emb=(1.0, 0.0))
    over = _cand(1, spk="A", sim=0.90, sim_other=0.1, dur=2.1, usable=2.0, emb=(1.0, 0.0))
    picks = qs.pick_coherence({0: [fitting, over]})
    assert picks[0]["k"] == 0
