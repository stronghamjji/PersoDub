# -*- coding: utf-8 -*-
"""Length-fitting translation (len_fit) — verifies logic only, with a fake translator and no API calls."""
import json

import pytest

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


def test_candidates_flat_list_when_only_one_line_was_asked_for():
    """The last-resort path asks for one line and the model hands back that
    line's three candidates bare, without the list holding them. It raised,
    the fitting was abandoned for the whole run, and four of six lines
    overran their slot on a real dub (Windows, 2026-09-11). At n == 1 there is
    nothing else a flat list of strings could mean."""
    raw = json.dumps(["다섯을 죽게 뒀어", "다섯 명이 죽게 뒀어",
                      "다섯 명이나 죽게 내버려 뒀잖아"], ensure_ascii=False)
    parsed = parse_candidates_array(raw, 1)
    assert len(parsed) == 1
    assert len(parsed[0]) == 3
    assert pick_candidate(parsed[0], "ko", 1.5) == "다섯을 죽게 뒀어"


def test_a_flat_list_is_only_forgiven_when_one_line_was_asked_for():
    """With more than one line asked for, a flat list is what it has always
    been: one candidate per line. Nothing about that reading changes."""
    raw = json.dumps(["첫 줄", "둘째 줄", "셋째 줄"], ensure_ascii=False)
    parsed = parse_candidates_array(raw, 3)
    assert parsed == [["첫 줄"], ["둘째 줄"], ["셋째 줄"]]


def test_an_empty_array_still_fails_rather_than_becoming_an_empty_line():
    """The forgiveness above must not turn "the model said nothing" into "this
    line translates to nothing" -- that would ship a blank line silently."""
    with pytest.raises(ValueError):
        parse_candidates_array("[]", 1)


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


# --- a line's candidates handed back as an object ----------------------------

def test_an_object_holding_the_candidates_is_read_not_spoken():
    # Hunyuan answered one line of a Japanese dub with an object instead of a
    # list: {"candidates": ["...", "...", "..."]}. str() of that went into
    # translated.srt and the voice read the braces and quotes aloud, 6.6s into
    # a 4.8s slot (Windows full test, job f3fb54f1, 2026-09-17).
    from app.text.length_fit import parse_candidates_array
    raw = '[{"candidates": ["公平な目で見るよ", "ちょっと不公平だけどね", "判断は公平に行う"]}, ["全部学生のせいじゃないのか？"]]'
    out = parse_candidates_array(raw, 2)
    assert out[0] == ["公平な目で見るよ", "ちょっと不公平だけどね", "判断は公平に行う"]
    assert out[1] == ["全部学生のせいじゃないのか？"]


def test_an_object_with_one_string_is_one_candidate():
    from app.text.length_fit import parse_candidates_array
    assert parse_candidates_array('[{"text": "短い文"}]', 1) == [["短い文"]]


def test_what_cannot_be_read_as_text_is_no_candidate_at_all():
    # Never the repr of a structure: an empty list makes the caller keep the
    # line it already had, which is a sentence a voice can say.
    from app.text.length_fit import parse_candidates_array
    out = parse_candidates_array('[{"candidates": {"a": 1}}, 7, null, [["nested"], {"x": "y"}, "ok"]]', 4)
    assert out[0] == [] and out[1] == [] and out[2] == []
    assert out[3] == ["ok"]
    for line in out:
        for cand in line:
            assert "{" not in cand and "[" not in cand


class _OneBadLineEngine:
    """Answers every chunk with the wrong count, so each line is asked alone;
    the line "bad" never comes back readable (issue #88's answer cut off
    mid-string), every other line gets three candidates."""
    max_budget_retries = 0

    def __init__(self):
        self.prompts = []

    def _ask(self, prompt):
        self.prompts.append(prompt)
        asked = [ln for ln in prompt.splitlines() if ln[:1].isdigit() and ". " in ln]
        if len(asked) > 1:
            return j([["x"]])
        if asked[0].endswith(" bad"):
            return '[["cut off mid-str'
        if "candidate" not in prompt:
            return j(["네 좋아요"])
        return j([["네 좋아요", "좋아요", "네"]])


@pytest.mark.parametrize("durations", [[2.0, 2.0, 2.0], None])
def test_a_line_that_keeps_failing_is_left_untranslated_not_fatal(durations):
    # Issue #82: one line that fails its last-resort single-line ask used to
    # raise out of the loop and end a 969-line job. Now it is left empty
    # (untranslated: silent, and marked on the script) and the rest go on --
    # on both the candidates path (with slots) and the plain one (without).
    from app.translate import UNTRANSLATED
    eng = _OneBadLineEngine()
    out = fit_translate(eng, ["good one", "bad", "good two"], "ko", "en", durations)
    assert out[1] == UNTRANSLATED
    assert out[0] and out[2]


@pytest.mark.parametrize("durations", [[2.0] * 40, None])
def test_a_translator_that_answers_nothing_is_given_up_on_early(durations):
    # Every line failing is not a line's trouble but a broken translator. Going
    # on would ask about all 40 lines a few times each before failing anyway.
    from app.text.length_fit import GIVE_UP_AFTER
    eng = _OneBadLineEngine()
    with pytest.raises(RuntimeError, match="no usable answer for the first %d lines" % GIVE_UP_AFTER):
        fit_translate(eng, ["bad"] * 40, "ko", "en", durations)
    # Two chunks' worth of asks (a chunk: 3 tries, then 1 + 3 per line alone).
    assert len(eng.prompts) == 2 * (3 + 6 * 3)


def test_a_bad_opening_is_not_taken_for_a_broken_translator():
    # The first chunk all fails, the second answers: that is lines failing,
    # not the translator -- keep going.
    eng = _OneBadLineEngine()
    out = fit_translate(eng, ["bad"] * 6 + ["fine"] * 6 + ["bad"] * 6, "ko", "en", [2.0] * 18)
    assert out[:6] == [""] * 6 and all(out[6:12]) and out[12:] == [""] * 6


# --- the scene beside each request is the lines around it, not the whole job ----
# The whole job went into every request; on a long video the prompt ran past the
# model's 4096-token window (the bundled Ollama's -c 4096) and was cut (#82, #88).

_CTX_HEAD = "for context only (do NOT translate these — just read them for flow and tone):\n"


def _context_of(prompt):
    """The context lines a prompt carries, or [] when it has none."""
    if _CTX_HEAD not in prompt:
        return []
    block = prompt.split(_CTX_HEAD, 1)[1].split("\n\n", 1)[0]
    return [ln[2:] for ln in block.splitlines()]


class _RecordingEngine:
    """Answers every request well, and keeps every prompt it was sent."""

    def __init__(self, max_budget_retries=0, fit=True):
        self.max_budget_retries = max_budget_retries
        self.fit = fit
        self.prompts = []

    def _ask(self, prompt):
        self.prompts.append(prompt)
        n = len([ln for ln in prompt.splitlines() if ln[:1].isdigit() and ". " in ln])
        # A line that fits an 8s Korean slot, or one far too short for it.
        text = "그러니까 내가 말했잖아, 이건 혼자서는 절대 안 된다고" if self.fit else "네"
        if "candidate" in prompt:
            return j([[text, text, text]] * n)
        return j([text] * n)


# One long CJK line, the costliest per byte: 40 characters, ~120 bytes.
_JA = "だから言ったでしょう、この問題は絶対に一人で解決できるものじゃないって。本当に。"


@pytest.mark.parametrize("durations,retries", [([8.0] * 969, 0), (None, 0), ([8.0] * 969, 1)])
def test_a_long_job_keeps_every_request_inside_the_models_window(durations, retries):
    from app.text.length_fit import CONTEXT_BYTES, CONTEXT_LINES, DRAFT_CHUNK
    texts = ["%d %s" % (i, _JA) for i in range(969)]
    eng = _RecordingEngine(max_budget_retries=retries, fit=retries == 0)
    fit_translate(eng, texts, "ko", "ja", durations)

    assert len(eng.prompts) >= 969 // DRAFT_CHUNK
    for p in eng.prompts:
        ctx = _context_of(p)
        assert sum(len(c.encode("utf-8")) + 3 for c in ctx) <= CONTEXT_BYTES
        assert len(ctx) <= DRAFT_CHUNK + 2 * CONTEXT_LINES
        # 7500 bytes is ~1950 tokens at the hungriest rate measured here (0.26 a
        # byte, hy-mt2 on Japanese); with the 2048-token answer, under 4096.
        # (The largest real one measured 1380-1649 tokens on three local models.)
        assert len(p.encode("utf-8")) <= 7500
    # And a chunk deep in the job sees its own neighbours on both sides.
    draft = [p for p in eng.prompts
             if "You are a professional dubbing translator" in p and ") 600 " + _JA in p][0]
    ctx = _context_of(draft)
    assert "599 " + _JA in ctx and "606 " + _JA in ctx
    assert "0 " + _JA not in ctx


def test_a_short_job_still_sees_the_whole_scene():
    texts = ["line %d, a short one." % i for i in range(9)]
    eng = _RecordingEngine()
    fit_translate(eng, texts, "ko", "en", [8.0] * 9)
    for p in eng.prompts:
        assert _context_of(p) == texts


def test_one_huge_line_is_asked_without_a_context_block():
    # The lines asked for are in the request itself; when they alone are over
    # the context's bytes there is no room to repeat them.
    eng = _RecordingEngine()
    fit_translate(eng, ["あ" * 900, "short"], "ko", "ja", [8.0, 8.0])
    assert _context_of(eng.prompts[0]) == []


def test_the_instructions_and_the_json_rule_always_come_after_the_context():
    # If a prompt ever runs past the window it is cut from the front: that must
    # cost context, never the instructions or the answer's format.
    texts = ["%d %s" % (i, _JA) for i in range(60)]
    eng = _RecordingEngine(max_budget_retries=1, fit=False)
    fit_translate(eng, texts, "ko", "ja", [8.0] * 60)
    fit_translate(eng, texts, "ko", "ja", None)
    for p in eng.prompts:
        assert "Output only a JSON array" in p
        assert "You are a professional dubbing translator" in p or "don't fit their time slot" in p
        if _context_of(p):
            assert p.index(_CTX_HEAD) < p.index("Output only a JSON array")
            assert p.index(_CTX_HEAD) < p.find("You are a professional dubbing translator")


def test_the_length_retry_is_asked_in_chunks_too():
    # Every out-of-window line of a long video went into one retry request.
    from app.text.length_fit import DRAFT_CHUNK
    texts = ["%d %s" % (i, _JA) for i in range(20)]
    eng = _RecordingEngine(max_budget_retries=1, fit=False)
    fit_translate(eng, texts, "ko", "ja", [8.0] * 20)
    retries = [p for p in eng.prompts if "don't fit their time slot" in p]
    assert [len([ln for ln in p.splitlines() if ln[:1].isdigit() and ". " in ln]) for p in retries] \
        == [DRAFT_CHUNK, DRAFT_CHUNK, DRAFT_CHUNK, 20 - 3 * DRAFT_CHUNK]


def test_a_malformed_candidates_answer_is_described_by_its_length_never_quoted():
    secret = "그러니까 내가 말했잖아, 이건 비밀이라고"
    with pytest.raises(ValueError) as e:
        parse_candidates_array(secret, 1)
    assert secret[:6] not in str(e.value)
    assert "response length %d" % len(secret) in str(e.value)
