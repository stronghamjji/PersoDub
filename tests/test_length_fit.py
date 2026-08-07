# -*- coding: utf-8 -*-
"""Length-fitting translation (len_fit) — verifies logic only, with a fake translator and no API calls."""
import json

from app.text.length_fit import (
    build_budget_prompt,
    build_candidates_prompt,
    fit_translate,
    parse_candidates_array,
    pick_candidate,
    syllable_budget,
)


class FakeEngine:
    """A fake translator that returns preset responses in order."""

    def __init__(self, responses, max_budget_retries=None):
        self.responses = list(responses)
        self.prompts = []
        if max_budget_retries is not None:
            self.max_budget_retries = max_budget_retries

    def _ask(self, prompt):
        self.prompts.append(prompt)
        return self.responses.pop(0)


def j(arr):
    return json.dumps(arr, ensure_ascii=False)


def test_budget_uses_cps_and_margin():
    # Korean CPS 4.4 (2026-07-30 measured median) x WINDOW_HIGH 1.15 (the ±15% budget window's
    # upper edge, replacing the old standalone MARGIN constant): 2.0s → 10 chars
    assert syllable_budget(2.0, "ko") == 10
    prompt = build_budget_prompt(["hello"], "Korean", "English", [10])
    assert "about 10 characters" in prompt
    assert "End every sentence with a predicate" in prompt   # the inviolable grammar rule is in the prompt


def test_short_slot_has_no_budget():
    # Sub-1-second slots budget only 3-5 chars, holding no real phrase → exempt from the constraint
    assert syllable_budget(0.6, "ko") == 999
    prompt = build_budget_prompt(["What?"], "Korean", "English", [999])
    assert "no length limit" in prompt


def test_only_out_of_window_lines_retried():
    # Korean CPS 4.4: window(1.5s) = [1.275, 1.725]s, window(2.0s) = [1.7, 2.3]s
    texts = ["You let five people die.", "Where's Dent?"]
    durations = [1.5, 2.0]
    eng = FakeEngine([
        j(["다섯 명이나 죽게 내버려 뒀잖아", "다섯 명이 죽게 뒀어"]),  # pass 1: line1 2.95s (over), line2 1.82s (in window)
        j(["다섯을 죽게 뒀어"]),                                        # re-request: line1 only → 1.59s in window
    ])
    out = fit_translate(eng, texts, "ko", "en", durations)
    assert out == ["다섯을 죽게 뒀어", "다섯 명이 죽게 뒀어"]
    assert len(eng.prompts) == 2  # converges in pass 1 + 1 re-request
    # only the out-of-window line should be in the re-request
    assert "Current translation (too long)" in eng.prompts[1]
    assert "Where's Dent?" not in eng.prompts[1]


def test_too_short_line_retried_to_fill():
    # unifies what used to be pipeline.py's separate FILL_RATIO pass: a too-short line goes
    # through the same window re-ask, asking to fill the slot instead of shortening it.
    eng = FakeEngine([
        j(["좋아"]),                              # pass 1: 0.45s, window(3.0s) = [2.55, 3.45]s -> too short
        j(["정말 좋아 이런 느낌 오랜만이야"]),      # retry: 2.95s -> in window
    ])
    out = fit_translate(eng, ["I really like this feeling."], "ko", "en", [3.0])
    assert out == ["정말 좋아 이런 느낌 오랜만이야"]
    assert len(eng.prompts) == 2
    assert "too short" in eng.prompts[1]


def test_rejects_longer_or_wrong_script_retry():
    eng = FakeEngine([
        j(["다섯 명이나 죽게 내버려 뒀잖아"]),      # pass 1: 2.95s (over window [1.275, 1.725])
        j(["다섯 명이나 죽게 내버려 두었잖아요"]),  # retry 1: even longer → rejected
        j(["Let five die"]),                        # retry 2: Latin letters → rejected
        j(["다섯을 죽였잖아"]),                     # retry 3: 1.59s, in window → accepted
    ])
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5])
    assert out == ["다섯을 죽였잖아"]
    assert len(eng.prompts) == 4


def test_gives_up_after_max_retry_keeps_best():
    logs = []
    eng = FakeEngine([
        j(["다섯 명이나 죽게 내버려 뒀잖아"]),  # pass 1: 2.95s (over window [0.85, 1.15] for a 1.0s slot)
        j(["다섯 명이 죽게 뒀어"]),             # retry 1: 1.82s, closer → accepted (still over)
        j(["다섯 명이 죽게 뒀어"]),             # retry 2: same → rejected (no improvement)
        j(["다섯 명이 죽게 뒀어"]),             # retry 3: same → rejected
    ])
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.0],
                        log=logs.append)
    assert out == ["다섯 명이 죽게 뒀어"]
    assert any("remained outside the budget window" in m for m in logs)
    assert len(eng.prompts) == 4  # pass 1 + retry cap of 3


def test_paid_translator_gets_exactly_one_call_with_three_candidates():
    # Paid translators (Gemini/Vertex, max_budget_retries=0) must never retry -- but their
    # ONE and only call already asks for 3 candidates per line (build_candidates_draft_prompt)
    # and picks the best fit immediately, instead of getting a single blind shot.
    eng = FakeEngine([
        json.dumps([[
            "다섯 명이나 죽게 내버려 뒀잖아",  # 2.95s -- over window [1.275, 1.725]
            "다섯 명이 죽게 뒀어",            # 1.82s -- still over
            "다섯을 죽게 뒀어",               # 1.59s -- in window
        ]], ensure_ascii=False),
    ], max_budget_retries=0)
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5])
    assert out == ["다섯을 죽게 뒀어"]  # best of 3 picked from the single call
    assert len(eng.prompts) == 1  # exactly one API call total, no retry round
    assert "3 DIFFERENT candidate" in eng.prompts[0]  # confirms the candidates-based draft prompt was used


def test_paid_translator_one_call_no_candidate_fits_picks_shortest_overshoot():
    # Even when none of the 3 candidates fit the window, a paid translator still gets no
    # retry -- pick_candidate's shortest-overshoot fallback is what saves the line.
    logs = []
    eng = FakeEngine([
        json.dumps([[
            "다섯 명이나 죽게 내버려 두었잖아요",  # 3.41s -- overshoot 1.91s
            "다섯 명이나 죽게 내버려 뒀잖아",      # 2.95s -- overshoot 1.45s (smallest)
        ]], ensure_ascii=False),
    ], max_budget_retries=0)
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5], log=logs.append)
    assert out == ["다섯 명이나 죽게 내버려 뒀잖아"]
    assert len(eng.prompts) == 1
    assert any("WARNING" in m for m in logs)


def test_explicit_max_retry_overrides_translator_default():
    # An explicit max_retry argument still wins over the translator's own attribute.
    eng = FakeEngine([
        j(["다섯 명이나 죽게 내버려 뒀잖아"]),
    ], max_budget_retries=3)
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5], max_retry=0)
    assert out == ["다섯 명이나 죽게 내버려 뒀잖아"]
    assert len(eng.prompts) == 1


def test_local_translator_uses_three_candidates_on_every_attempt():
    # Local/free translators (max_budget_retries=3) get the SAME 3-candidates-per-call
    # treatment on the first pass AND every retry round -- it's free, no reason not to.
    eng = FakeEngine([
        json.dumps([[  # pass 1 (draft): 3 candidates, none fit window [1.275, 1.725]
            "다섯 명이나 죽게 내버려 두었잖아요",  # 3.41s
            "다섯 명이나 죽게 내버려 뒀잖아",      # 2.95s -- closest of these two
            "다섯 명이 죽게 뒀어",                  # 1.82s -- closest overall, still over
        ]], ensure_ascii=False),
        json.dumps([[  # retry round 1: 3 more candidates, one now fits
            "다섯 명이나 죽게 내버려 뒀잖아",  # 2.95s -- still over
            "다섯을 죽게 뒀어",               # 1.59s -- in window
            "다섯을 죽였잖아",                # 1.59s -- in window
        ]], ensure_ascii=False),
    ], max_budget_retries=3)
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5])
    assert out == ["다섯을 죽게 뒀어"]
    assert len(eng.prompts) == 2  # draft (3 candidates, best still over) + 1 retry (fits, done)
    assert "3 DIFFERENT candidate" in eng.prompts[0]  # draft used the candidates prompt too
    assert "3 DIFFERENT candidate" in eng.prompts[1]  # retry also asked for 3 candidates


# --- 3-candidates-in-one-call: parsing + selection (task 4) ---

def test_candidates_prompt_states_hard_rule_and_example():
    prompt = build_candidates_prompt(
        ["You let five people die."], ["다섯 명이나 죽게 내버려 뒀잖아"], "ko", [9], ["long"]
    )
    assert "3 DIFFERENT candidate" in prompt
    assert "반드시" in prompt and "이내" in prompt  # hard rule stated in Korean for a Korean target
    assert "idiomatic" in prompt
    assert "Example of good compression" in prompt


def test_all_three_candidates_parsed_and_best_picked():
    # 3 candidates for one out-of-window line: two still outside the window, one inside --
    # pick_candidate must find the fitting one regardless of its position in the list.
    raw = json.dumps([[
        "다섯 명이나 죽게 내버려 뒀잖아",  # 2.95s -- way over
        "다섯 명이 죽게 뒀어",            # 1.82s -- still over window(1.5s)=[1.275,1.725]
        "다섯을 죽게 뒀어",               # 1.59s -- inside the window
    ]], ensure_ascii=False)
    parsed = parse_candidates_array(raw, 1)
    assert len(parsed[0]) == 3
    picked = pick_candidate(parsed[0], "ko", 1.5)
    assert picked == "다섯을 죽게 뒀어"


def test_candidates_one_candidate_fallback():
    # tolerate the model returning fewer than 3 -- a single plain string per line still works
    raw = json.dumps(["다섯을 죽게 뒀어"], ensure_ascii=False)
    parsed = parse_candidates_array(raw, 1)
    assert parsed[0] == ["다섯을 죽게 뒀어"]
    assert pick_candidate(parsed[0], "ko", 1.5) == "다섯을 죽게 뒀어"


def test_candidates_numbered_string_fallback():
    # tolerate a numbering variation -- one line's item is a single string with "1./2." embedded
    # instead of a real nested JSON array
    raw = json.dumps(["1. 다섯을 죽게 뒀어\n2. 다섯 명이 죽게 뒀어"], ensure_ascii=False)
    parsed = parse_candidates_array(raw, 1)
    assert parsed[0] == ["다섯을 죽게 뒀어", "다섯 명이 죽게 뒀어"]


def test_candidates_none_fit_picks_shortest_overshoot_and_warns():
    logs = []
    candidates = [
        "다섯 명이나 죽게 내버려 두었잖아요",  # 3.41s -- overshoot 3.41-1.5=1.91s
        "다섯 명이나 죽게 내버려 뒀잖아",      # 2.95s -- overshoot 1.45s (smallest)
    ]
    picked = pick_candidate(candidates, "ko", 1.5, index=3, log=logs.append)
    assert picked == "다섯 명이나 죽게 내버려 뒀잖아"
    assert any("WARNING" in m and "line 3" in m for m in logs)
    assert any("1.45" in m for m in logs)  # overshoot seconds logged


def test_fit_translate_uses_candidates_in_retry():
    # end-to-end: the retry round asks for 3 candidates in ONE call and picks the best.
    eng = FakeEngine([
        j(["다섯 명이나 죽게 내버려 뒀잖아"]),  # pass 1: 2.95s, over window [1.275, 1.725]
        json.dumps([[
            "다섯 명이나 죽게 내버려 두었잖아요",  # still over
            "다섯 명이 죽게 뒀어",                  # still over (1.82s)
            "다섯을 죽게 뒀어",                     # 1.59s -- in window
        ]], ensure_ascii=False),
    ])
    out = fit_translate(eng, ["You let five people die."], "ko", "en", [1.5])
    assert out == ["다섯을 죽게 뒀어"]
    assert len(eng.prompts) == 2  # one draft call + ONE candidates call (not 3 separate rounds)


def test_no_durations_single_call():
    eng = FakeEngine([j(["아무 번역"])])
    out = fit_translate(eng, ["anything"], "ko", "en", None)
    assert out == ["아무 번역"]
    assert len(eng.prompts) == 1


# --- v3: sub-1s budget-exempt slots still choose wisely (shortest candidate) ---

def test_sub_1s_slot_picks_shortest_candidate():
    # Budget-exempt (<1s) slots used to accept the FIRST candidate blindly --
    # the v2 vertex build shipped a long line into a 0.9s slot that way.
    cands = ["정말로 무슨 말인지 하나도 모르겠는데", "뭐?", "그게 무슨 소리야"]
    assert pick_candidate(cands, "ko", 0.9) == "뭐?"


def test_sub_1s_slot_single_candidate_still_returned():
    assert pick_candidate(["뭐라고?"], "ko", 0.5) == "뭐라고?"


# --- v3: lengthen re-ask states a MINIMUM, not an upper cap ---

def test_candidates_prompt_short_direction_states_minimum_not_cap():
    # v2 evidence (run_gemma_v2.log): the under-window re-ask DID trigger, but the
    # per-line target said "반드시 N자 이내" (an upper cap) even for TOO-SHORT lines,
    # so no candidate ever got longer. "short" lines must get a MINIMUM instead.
    prompt = build_candidates_prompt(
        ["You know what you did to that car."], ["네가 그랬잖아."], "ko", [30], ["short"]
    )
    assert "이상" in prompt      # minimum stated
    assert "이내" not in prompt  # no upper-cap phrasing for a too-short line


def test_candidates_prompt_mixed_directions_each_line_gets_its_own_phrasing():
    prompt = build_candidates_prompt(
        ["a long line", "a short line"], ["긴 번역이 너무 길다", "짧다"], "ko", [10, 30],
        ["long", "short"]
    )
    assert "이내" in prompt and "이상" in prompt
