"""Span algebra: lists of [start, end) pairs in seconds.

No audio bytes are touched here -- these are list-of-tuple algorithms that
happen to describe time ranges. They lived in three different modules, where
qwen_assemble.py had become a de-facto shared library for company_gate.py and
nonverbal.py (each importing ten underscore-prefixed names out of it). Pulling
the pure span math out is the first step in giving that shared code an honest
home; it also removes a copy-paste duplicate (see subtract_spans).

Two padding functions look alike and MUST NOT be merged. The difference is
load-bearing and is spelled out on each.
"""
from typing import List, Sequence, Tuple

Span = Tuple[float, float]


def pad_spans(spans: Sequence[Sequence[float]], pad: float) -> List[Span]:
    """Widen each span by `pad` on both sides. Reversed spans are SWAPPED, not dropped.

    Used to build exclusion sets, where losing a span is the dangerous direction:
    a dropped exclusion could whitelist audio sitting under a real cue. So a
    malformed end<=start span (bad STT timing) is repaired into a valid one
    rather than discarded. Contrast pad_and_merge, which drops them.
    """
    return [(max(0.0, min(s, e) - pad), max(s, e) + pad) for s, e in spans]


def pad_and_merge(regions: Sequence[Sequence[float]], pad_sec: float) -> List[Span]:
    """Widen each region by `pad_sec` on both sides, then merge any that now overlap.

    STT cue timestamps -- local Whisper's especially, which can round to the
    whole second -- are often a bit tighter than the real speech, so gating
    exactly at the cue boundary can leave a sliver of the original-language
    audio audible right at a line's edge. Padding first (then merging) closes
    that gap instead of gating two near-touching slivers of "silence" either
    side of what is really one continuous stretch of speech.

    Reversed regions are DROPPED. That is the opposite of pad_spans, and
    deliberately so: a malformed region here would widen the gate over audio
    that should have been kept, so discarding is the safe direction.
    """
    pad_sec = max(0.0, pad_sec)
    padded = sorted(
        (max(0.0, s - pad_sec), e + pad_sec) for s, e in regions if e > s
    )
    merged: List[Span] = []
    for s, e in padded:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def merge_spans(regions: Sequence[Sequence[float]]) -> List[Span]:
    """Merge overlapping regions without widening them.

    Named for the four call sites that were passing pad=0.0 purely to reach the
    merge half of pad_and_merge, which read as if padding were intended.
    """
    return pad_and_merge(regions, 0.0)


def subtract_spans(regions: Sequence[Span], holes: Sequence[Span]) -> List[Span]:
    """`regions` minus `holes`, both [start, end) second lists.

    This algorithm existed twice: once named in company_gate.py and once
    copy-pasted inline into nonverbal.extract_nonverbal_segments. Neither could
    import the other -- company_gate already depends on nonverbal, so the
    dependency could not be reversed. That is why it lives here.
    """
    holes = sorted((s, e) for s, e in holes if e > s)
    out: List[Span] = []
    for a, b in regions:
        cur = a
        for s, e in holes:
            if e <= cur:
                continue
            if s >= b:
                break
            if s > cur:
                out.append((cur, min(s, b)))
            cur = max(cur, e)
            if cur >= b:
                break
        if cur < b:
            out.append((cur, b))
    return out
