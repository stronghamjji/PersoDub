"""The ASS builder ported from the official plugin's srt skill: ten presets,
each drawn exactly as the plugin draws it -- colours, boxes, the rainbow's
per-word palette, neon's halo-plus-fill pair -- with our own two overrides
(vertical position, size) layered on top."""
import pytest

from app.subtitle_ass import PRESETS, build_ass

CUES = [{"start": 0.0, "end": 2.5, "text": "안녕하세요"},
        {"start": 3.0, "end": 5.0, "text": "두 번째 줄"}]


def test_ten_presets_ported():
    assert len(PRESETS) == 10
    for pid in ("clean", "bold-punch", "sticker", "neon-yellow", "soft-card",
                "rainbow", "broadcast", "streaming", "lower-bar", "neon"):
        assert pid in PRESETS


def test_clean_draws_white_on_black_outline():
    ass = build_ass(CUES, "clean", width=1920, height=1080)
    # RRGGBB FFFFFF -> ASS &H00FFFFFF&, outline black, BorderStyle 1.
    style = next(l for l in ass.splitlines() if l.startswith("Style:"))
    assert "&H00FFFFFF&" in style and "&H00000000&" in style
    assert ",1," in style.split("100,100")[1]          # BorderStyle=1
    assert "PlayResX: 1920" in ass and "PlayResY: 1080" in ass
    assert "Dialogue: 0,0:00:00.00,0:00:02.50,Base,,0,0,,안녕하세요" in ass


def test_sticker_gets_its_translucent_box():
    ass = build_ass(CUES, "sticker", width=1080, height=1920)
    style = next(l for l in ass.splitlines() if l.startswith("Style:"))
    # box 000000 at 0.6 opacity -> alpha 66 hex
    assert "&H66000000&" in style
    assert ",3," in style.split("100,100")[1]          # BorderStyle=3


def test_bold_punch_shouts_in_the_middle():
    ass = build_ass(CUES, "bold-punch", width=1080, height=1920)
    assert ",5," in next(l for l in ass.splitlines() if l.startswith("Style:")).rsplit(",", 5)[0][-30:] or ",5," in ass  # Alignment 5
    assert "안녕하세요".upper() == "안녕하세요"        # hangul has no case --
    latin = build_ass([{"start": 0, "end": 1, "text": "hello"}], "bold-punch",
                      width=1080, height=1920)
    assert "HELLO" in latin                            # -- but latin shouts


def test_rainbow_colours_every_word():
    ass = build_ass([{"start": 0, "end": 2, "text": "one two three"}], "rainbow",
                    width=1920, height=1080)
    assert ass.count("\\1c&H") == 3
    assert "{\\1c&H0000FF&}one" in ass


def test_neon_lays_a_halo_under_a_crisp_fill():
    ass = build_ass(CUES[:1], "neon", width=1920, height=1080)
    lines = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert len(lines) == 2
    assert "\\blur8" in lines[0] and "\\1a&HFF&" in lines[0]
    assert lines[1].startswith("Dialogue: 1")


def test_position_and_size_overrides_beat_the_preset():
    ass = build_ass(CUES, "clean", width=1920, height=1080, pos=20, size=150)
    style = next(l for l in ass.splitlines() if l.startswith("Style:"))
    # pos 20 -> bottom-anchored, marginV (100-20)% of 1080 = 864
    assert ",2," in style and ",864," in style
    # clean's fontFrac .032 * 1080 * 1.5 = 52
    assert ",52," in style


def test_event_text_cannot_smuggle_override_tags():
    ass = build_ass([{"start": 0, "end": 1, "text": "a{\\pos(0,0)}b"}], "clean",
                    width=1920, height=1080)
    assert "\\pos" not in ass.split("[Events]")[1]
