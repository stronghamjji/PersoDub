"""The ASS builder ported from the official plugin's srt skill: ten presets,
each drawn exactly as the plugin draws it -- colours, boxes, the rainbow's
per-word palette, neon's halo-plus-fill pair -- with our own two overrides
(vertical position, size) layered on top."""
import pytest

from app.subtitle_ass import PRESETS, build_ass

CUES = [{"start": 0.0, "end": 2.5, "text": "안녕하세요"},
        {"start": 3.0, "end": 5.0, "text": "두 번째 줄"}]


def test_the_presets_are_all_there():
    # The plugin's ten, plus our own two solid-box ones (user, 2026-09-01:
    # nothing had a fully opaque white or black ground).
    assert len(PRESETS) == 12
    for pid in ("clean", "bold-punch", "sticker", "neon-yellow", "soft-card",
                "rainbow", "broadcast", "streaming", "lower-bar", "neon",
                "black-box", "white-box"):
        assert pid in PRESETS


def test_the_solid_boxes_are_actually_solid():
    for pid, ink, ground in (("black-box", "&H00FFFFFF&", "&H00000000&"),
                             ("white-box", "&H002C333A&", "&H00FFFFFF&")):
        ass = build_ass(CUES, pid, width=1920, height=1080)
        style = next(l for l in ass.splitlines() if l.startswith("Style:"))
        assert ink in style and ground in style      # alpha 00 = fully opaque
        assert ",3," in style.split("100,100")[1]    # drawn as a box


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


# ---- The stretchable background box (B안, 2026-09-01 밤) ---------------------
# For presets with a box, the user can set the box's WIDTH -- one global value
# and per-line exceptions. A fixed-width box cannot come from BorderStyle=3
# (that box hugs the text), so these burns draw the box themselves: a drawn
# rectangle on layer 0, the plain text on layer 1.

def test_a_widened_box_becomes_a_drawn_rectangle():
    ass = build_ass(CUES, "black-box", width=1920, height=1080, box_width=50)
    style = next(l for l in ass.splitlines() if l.startswith("Style:"))
    assert ",1," in style.split("100,100")[1]      # text style: no ASS box
    assert "\\p1" in ass                            # the rectangle is drawn
    assert "l 960 " in ass                          # 50% of 1920 wide
    # two layers per cue: rect under, words over
    assert ass.count("Dialogue: 0,") == 2 and ass.count("Dialogue: 1,") == 2


def test_per_line_width_beats_the_global_one():
    ass = build_ass(CUES, "black-box", width=1920, height=1080,
                    box_width=50, line_widths={"2": 80})
    assert "l 960 " in ass and "l 1536 " in ass


def test_width_means_nothing_without_a_box():
    ass = build_ass(CUES, "clean", width=1920, height=1080, box_width=50)
    assert "\\p1" not in ass


def test_a_narrow_box_wraps_its_words():
    long = [{"start": 0, "end": 3,
             "text": "이 문장은 꽤 길어서 좁은 상자 안에서는 한 줄로 다 들어가지 않는다"}]
    ass = build_ass(long, "black-box", width=1920, height=1080, box_width=30)
    event = [l for l in ass.splitlines() if l.startswith("Dialogue: 1,")][0]
    assert "\\N" in event
