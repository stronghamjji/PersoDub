# -*- coding: utf-8 -*-
"""After the voice is made: lines that ran past their slot are rewritten
shorter and spoken again.

The dub keeps a natural speaking rate -- nothing is time-stretched -- so the
only honest way to make a line end when the mouth closes is to say less. The
translation is fitted to its slot before synthesis (app/text/length_fit.py),
but against an ESTIMATE from the character count, and nothing looked at the
voice that came out: on the 0.6.2 tests real lines ran +0.5s to +2.2s past
2-5 second slots, which on screen is a closed mouth that keeps talking
(2026-09-17).

This module is the measuring half and the decision, and nothing else: it knows
no translator and no voice engine. The caller hands it two functions --
`shorten`, which asks for shorter wording, and `respeak`, which speaks a
candidate and says how long it ran -- so it is pure logic over numbers and
strings, and the tests hold it to a table (tests/test_refit.py).

What it will not do: stretch or cut audio, touch timings, or accept a rewrite
that is not actually shorter ALOUD. A line no rewrite could fit keeps the best
voice it got; the assembly's lead borrow and tail fade still apply to it.
"""
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from app.text.length_fit import NO_BUDGET_SLOT_S
from app.text.srt import count_units

# A line over its slot by less than this is left alone: the assembly forgives a
# hair, the lead borrow takes a little more, and a rewrite for a quarter of a
# second costs a translator call and a synthesis to save nothing anyone sees.
OVER_MIN_SEC = 0.25
# The measured rate is one sample from one line, so the budget leaves a little
# room rather than aiming at the slot's last millisecond.
SAFETY = 0.97
# A rewrite has to be this much shorter aloud to replace what is there.
MIN_GAIN_SEC = 0.05
ROUNDS = 2

# (line index, source text, current translation, budget in units)
ShortenItem = Tuple[int, str, str, int]


def lines_over(durs: Sequence[float], slots: Sequence[float],
               min_over: float = OVER_MIN_SEC) -> List[Tuple[int, float]]:
    """(index, seconds over) for every spoken line well past its slot.

    A line with no voice (0.0) is not over anything, and a slot under a second
    is exempt for the same reason length_fit exempts it: no real phrase fits
    there, and asking for one only produces broken grammar.
    """
    out = []
    for i, (dur, slot) in enumerate(zip(durs, slots)):
        if not dur or not slot or slot < NO_BUDGET_SLOT_S:
            continue
        over = round(dur - slot, 2)
        if over > min_over:
            out.append((i, over))
    return out


def measured_budget(units: int, dur: float, slot: float) -> Optional[int]:
    """How many units fit the slot at the rate THIS voice spoke this line, or
    None when that is no shorter than the line already is."""
    if units <= 0 or dur <= 0 or slot <= 0:
        return None
    budget = int(units * (slot / dur) * SAFETY)
    return budget if 1 <= budget < units else None


def refit(texts: Sequence[str], sources: Sequence[str], durs: Sequence[float],
          slots: Sequence[float], lang: str,
          shorten: Callable[[List[ShortenItem]], Dict[int, str]],
          respeak: Callable[[int, str], Optional[Tuple[float, Callable[[], None]]]],
          log: Optional[Callable[[str], None]] = None, rounds: int = ROUNDS,
          count: Optional[Callable[[str], int]] = None) -> Dict[int, Tuple[str, float]]:
    """Rewrite and respeak the lines that ran long. Returns {index: (new text,
    new seconds)} for the lines that were replaced -- and only those.

    `shorten` gets every long line of a round in one call (one prompt, not
    one per line) and answers {index: shorter text}; a line it leaves out, or
    an exception, changes nothing. `respeak(i, text)` speaks a candidate WITHOUT
    replacing the line's wav and answers (seconds, commit), or None if it could
    not; `commit()` is called only for a candidate that is kept, so a rewrite
    that is no shorter aloud costs a synthesis and nothing else.
    """
    log = log or (lambda m: None)
    count = count or (lambda t: count_units(t, lang))
    cur_text = list(texts)
    cur_dur = list(durs)
    kept = {}  # type: Dict[int, Tuple[str, float]]

    for round_no in range(1, rounds + 1):
        items = []  # type: List[ShortenItem]
        for i, _over in lines_over(cur_dur, slots):
            budget = measured_budget(count(cur_text[i]), cur_dur[i], slots[i])
            if budget is not None:
                items.append((i, sources[i] if i < len(sources) else "", cur_text[i], budget))
        if not items:
            break
        log("   Refit round %d: %d line(s) ran past their slot -- asking for shorter wording"
            % (round_no, len(items)))
        try:
            answers = shorten(items) or {}
        except Exception as e:  # a translator that is down changes nothing
            log("   Refit: the translator could not be asked (%s) -- keeping the lines as they are"
                % type(e).__name__)
            break
        progressed = False
        for i, _src, _cur, _budget in items:
            new_text = (answers.get(i) or "").strip()
            if not new_text or new_text == cur_text[i]:
                continue
            spoken = respeak(i, new_text)
            if not spoken:
                continue
            new_dur, commit = spoken
            if not new_dur or new_dur > cur_dur[i] - MIN_GAIN_SEC:
                log("   Refit line %d: the rewrite is no shorter aloud (%.2fs vs %.2fs) -- kept the old one"
                    % (i + 1, new_dur or 0.0, cur_dur[i]))
                continue
            commit()
            log("   Refit line %d: %.2fs -> %.2fs in a %.2fs slot" % (i + 1, cur_dur[i], new_dur, slots[i]))
            cur_text[i], cur_dur[i] = new_text, new_dur
            kept[i] = (new_text, new_dur)
            progressed = True
        if not progressed:
            break
    return kept
