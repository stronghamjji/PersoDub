# -*- coding: utf-8 -*-
"""Turning a video's title into a folder name. Pure string work, no filesystem."""
import unicodedata

from app.text.naming import next_free, safe_name


def test_keeps_a_plain_name_as_is():
    assert safe_name("참교육1화") == "참교육1화"
    assert safe_name("Breaking Bad S01E01") == "Breaking Bad S01E01"


def test_normalizes_korean_to_nfc():
    # macOS hands back decomposed Korean (NFD). Storing it that way makes the
    # folder unfindable later by a name built the normal (NFC) way.
    decomposed = unicodedata.normalize("NFD", "참교육")
    assert decomposed != "참교육"  # the two really are different strings
    assert safe_name(decomposed) == "참교육"


def test_strips_characters_a_path_cannot_hold():
    assert safe_name('a/b:c*d?e"f<g>h|i') == "abcdefghi"


def test_trims_leading_and_trailing_junk():
    assert safe_name("  . 참교육 . ") == "참교육"


def test_truncates_a_very_long_name():
    assert len(safe_name("가" * 300, max_len=80)) == 80


def test_falls_back_to_empty_when_nothing_survives():
    # The caller treats "" as "could not build a name" and uses a random one.
    assert safe_name("///") == ""
    assert safe_name("   ") == ""


def test_next_free_returns_the_base_when_nothing_taken():
    assert next_free("참교육1화_en", []) == "참교육1화_en"


def test_next_free_counts_up_from_001():
    assert next_free("참교육1화_en", ["참교육1화_en"]) == "참교육1화_en_001"


def test_next_free_skips_over_what_is_already_there():
    taken = ["참교육1화_en", "참교육1화_en_001", "참교육1화_en_002"]
    assert next_free("참교육1화_en", taken) == "참교육1화_en_003"


def test_next_free_gives_up_after_three_digits():
    # 999 of the same name on one day means something is wrong; fall back to
    # the caller's random-name path rather than growing a fourth digit.
    taken = ["x"] + ["x_%03d" % i for i in range(1, 1000)]
    assert next_free("x", taken) is None
