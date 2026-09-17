# -*- coding: utf-8 -*-
"""After the voice is made: the lines that ran past their slot are rewritten
shorter and spoken again (app/refit.py).

The app's promise is a dub at a natural speaking rate with no time-stretch, so
the only honest way to make a line end when the mouth closes is to say less.
Until now the length was fitted to an ESTIMATE from the character count, and
nothing looked at the voice that came out: on the 0.6.2 tests real lines ran
+0.5s to +2.2s past 2-5s slots (2026-09-17).
"""
from app.refit import OVER_MIN_SEC, lines_over, measured_budget, refit


def test_only_lines_well_past_their_slot_are_picked():
    durs = [2.0, 3.6, 2.5, 0.0, 1.4]
    slots = [2.0, 2.4, 2.4, 2.0, 0.8]
    # line 1 is 1.2s over; line 2 is 0.1s over (assembly forgives it); line 3
    # was never spoken; line 4's slot is under a second, which no rewrite can fit.
    assert lines_over(durs, slots) == [(1, 1.2)]
    assert OVER_MIN_SEC > 0.1


def test_the_budget_comes_from_how_fast_this_voice_really_spoke():
    # 24 units took 3.6s, so this voice says 6.67/s here; a 2.4s slot holds 16,
    # less a little room: 15.
    assert measured_budget(24, 3.6, 2.4) == 15
    # Nothing to gain: the budget would not be shorter than the line already is.
    assert measured_budget(10, 2.0, 2.4) is None
    assert measured_budget(0, 3.0, 2.0) is None


def _fakes(answers, speeds):
    asked, spoken, committed = [], [], []

    def shorten(items):
        asked.append(items)
        return {i: answers[i].pop(0) for i, _s, _c, _b in items if answers.get(i)}

    def respeak(i, text):
        spoken.append((i, text))
        return (len(text) / speeds[i], lambda: committed.append((i, text)))

    return asked, spoken, committed, shorten, respeak


def test_a_long_line_is_rewritten_respoken_and_kept_when_it_fits():
    texts = ["short one", "x" * 24]
    asked, spoken, committed, shorten, respeak = _fakes({1: ["y" * 15]}, {1: 24 / 3.6})
    out = refit(texts, ["src0", "src1"], [1.0, 3.6], [2.0, 2.4], "en", shorten, respeak,
                count=len)
    assert out == {1: ("y" * 15, 15 / (24 / 3.6))}
    assert asked[0] == [(1, "src1", "x" * 24, 15)]
    assert committed == [(1, "y" * 15)]


def test_a_rewrite_that_is_no_shorter_aloud_is_thrown_away():
    # The model "shortened" it to something that takes just as long to say: the
    # old wav stays, the old words stay.
    texts = ["x" * 24]
    asked, spoken, committed, shorten, respeak = _fakes({0: ["z" * 24, "z" * 24]}, {0: 24 / 3.6})
    out = refit(texts, ["src"], [3.6], [2.4], "en", shorten, respeak, count=len)
    assert out == {} and committed == []


def test_a_second_round_asks_tighter_from_the_new_measurement():
    texts = ["x" * 30]
    # round 1: 30 -> 26 units, still 0.7s over; round 2: -> 20 units, fits.
    asked, spoken, committed, shorten, respeak = _fakes({0: ["a" * 26, "b" * 20]}, {0: 30 / 4.5})
    out = refit(texts, ["src"], [4.5], [3.2], "en", shorten, respeak, count=len)
    assert out[0][0] == "b" * 20
    assert len(asked) == 2 and asked[1][0][2] == "a" * 26
    assert committed == [(0, "a" * 26), (0, "b" * 20)]


def test_the_same_words_are_tried_again_before_any_are_changed():
    # The engine says the same sentence at very different lengths from one take
    # to the next ("You're not alone." came out at 4.0s, then 2.1s). A shorter
    # take of the SAME words costs no meaning, so it is tried first -- and when
    # it fits, the translator is never asked.
    takes = iter([4.1, 2.2])      # the first retake is no better and is thrown away
    committed, asked = [], []

    def respeak(i, text):
        return (next(takes), lambda: committed.append(text))

    out = refit(["same words"], ["src"], [4.0], [2.4], "en",
                lambda items: asked.append(items) or {}, respeak, count=len)
    assert out == {0: ("same words", 2.2)}
    assert committed == ["same words"] and asked == []


def test_a_line_that_would_have_to_lose_too_much_is_not_rewritten():
    # 3.78s of voice for a 2.21s slot means cutting over 40% of the words. A
    # small translator asked for that changed the meaning ("Though you're far
    # away" -> "You're still with me"). Retakes are tried; the words are left.
    asked = []
    out = refit(["x" * 20], ["src"], [3.78], [2.21], "en",
                lambda items: asked.append(items) or {}, lambda i, t: (3.78, lambda: None), count=len)
    assert asked == [] and out == {}


def test_a_translator_that_answers_nothing_or_fails_changes_nothing():
    texts = ["x" * 24]

    def shorten(items):
        raise RuntimeError("model is down")

    out = refit(texts, ["src"], [3.6], [2.4], "en", shorten, lambda i, t: None, count=len)
    assert out == {}
