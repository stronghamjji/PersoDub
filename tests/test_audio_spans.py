"""app/audio/spans.py -- pure span algebra, no audio bytes.

The important tests here are the two that pin the DIFFERENCE between pad_spans
and pad_and_merge on a reversed span. They look like the same function and were
merged-by-eye more than once; the difference is load-bearing in opposite
directions and each has a comment saying so.
"""
from app.audio.spans import merge_spans, pad_and_merge, pad_spans, subtract_spans

# --- the difference that must not be optimised away ------------------------

def test_pad_spans_repairs_a_reversed_span_instead_of_dropping_it():
    # Exclusion sets fail closed: losing a span could whitelist audio sitting
    # under a real cue, so a bad end<=start span is swapped into a valid one.
    assert pad_spans([(5.0, 3.0)], 0.0) == [(3.0, 5.0)]


def test_pad_and_merge_drops_a_reversed_span_instead_of_repairing_it():
    # Gate sets fail the other way: a repaired span would widen the mute over
    # audio that should have been kept, so it is discarded.
    assert pad_and_merge([(5.0, 3.0)], 0.0) == []


# --- pad_spans -------------------------------------------------------------

def test_pad_spans_widens_both_sides_and_never_goes_negative():
    assert pad_spans([(1.0, 2.0)], 0.5) == [(0.5, 2.5)]
    assert pad_spans([(0.1, 2.0)], 0.5) == [(0.0, 2.5)]


# --- pad_and_merge ---------------------------------------------------------

def test_pad_and_merge_joins_regions_that_overlap_after_padding():
    # 0.4s apart, padded 0.25 each side -> they touch and become one span.
    assert pad_and_merge([(0.0, 1.0), (1.4, 2.0)], 0.25) == [(0.0, 2.25)]


def test_pad_and_merge_keeps_regions_that_stay_apart():
    assert pad_and_merge([(0.0, 1.0), (5.0, 6.0)], 0.25) == [(0.0, 1.25), (4.75, 6.25)]


def test_pad_and_merge_clamps_a_negative_pad_to_zero():
    # Guards the caller from silently shrinking regions.
    assert pad_and_merge([(1.0, 2.0)], -3.0) == [(1.0, 2.0)]


def test_pad_and_merge_absorbs_a_fully_contained_region():
    assert pad_and_merge([(0.0, 10.0), (2.0, 3.0)], 0.0) == [(0.0, 10.0)]


def test_merge_spans_is_pad_and_merge_without_widening():
    regions = [(0.0, 1.0), (0.9, 2.0), (5.0, 6.0)]
    assert merge_spans(regions) == [(0.0, 2.0), (5.0, 6.0)]


# --- subtract_spans --------------------------------------------------------

def test_subtract_punches_a_hole_in_the_middle():
    assert subtract_spans([(0.0, 10.0)], [(4.0, 6.0)]) == [(0.0, 4.0), (6.0, 10.0)]


def test_subtract_trims_at_the_edges():
    assert subtract_spans([(0.0, 10.0)], [(0.0, 2.0), (9.0, 12.0)]) == [(2.0, 9.0)]


def test_subtract_removes_a_fully_covered_region():
    assert subtract_spans([(2.0, 3.0)], [(0.0, 10.0)]) == []


def test_subtract_ignores_holes_that_do_not_touch():
    assert subtract_spans([(0.0, 1.0)], [(5.0, 6.0)]) == [(0.0, 1.0)]


def test_subtract_handles_overlapping_and_unsorted_holes():
    # Holes are sorted and degenerate ones dropped before use.
    out = subtract_spans([(0.0, 10.0)], [(6.0, 8.0), (4.0, 7.0), (2.0, 2.0)])
    assert out == [(0.0, 4.0), (8.0, 10.0)]


def test_subtract_with_no_holes_returns_the_regions_unchanged():
    assert subtract_spans([(0.0, 1.0), (2.0, 3.0)], []) == [(0.0, 1.0), (2.0, 3.0)]
