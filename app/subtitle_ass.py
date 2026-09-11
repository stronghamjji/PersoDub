# -*- coding: utf-8 -*-
"""Styled subtitles as an ASS file, ported from the official Perso plugin's
srt skill (skills/srt/lib/subtitle_style.mjs, presets.json). Ten presets drawn
the way the plugin draws them; our own two overrides -- vertical position and
size -- layered on top. Karaoke presets need per-word timings and are not
ported yet."""
import re

# The plugin's presets.json, minus the two karaoke ones. Fractions are of the
# video height, so every style scales to any resolution.
PRESETS = {
    "clean": {"name": "Clean", "bold": True, "uppercase": False, "fontFrac": 0.032,
        "outlineFrac": 0.0018, "shadowFrac": 0.0016, "position": "lower",
        "primary": "FFFFFF", "outline": "000000", "box": None, "fx": None},
    "bold-punch": {"name": "Bold Punch", "bold": True, "uppercase": True, "fontFrac": 0.052,
        "outlineFrac": 0.007, "shadowFrac": 0, "position": "center",
        "primary": "FFFFFF", "outline": "000000", "box": None, "fx": None},
    "sticker": {"name": "Sticker", "bold": True, "uppercase": False, "fontFrac": 0.029,
        "outlineFrac": 0, "shadowFrac": 0, "position": "lower",
        "primary": "FFFFFF", "outline": "000000",
        "box": {"color": "000000", "opacity": 0.6}, "fx": None},
    "neon-yellow": {"name": "Neon Yellow", "bold": True, "uppercase": False, "fontFrac": 0.049,
        "outlineFrac": 0.006, "shadowFrac": 0, "position": "lower",
        "primary": "FFE600", "outline": "000000", "box": None, "fx": None},
    "soft-card": {"name": "Soft Card", "bold": False, "uppercase": False, "fontFrac": 0.026,
        "outlineFrac": 0, "shadowFrac": 0, "position": "upper",
        "primary": "3A332C", "outline": "FFFFFF",
        "box": {"color": "FFFFFF", "opacity": 0.85}, "fx": None},
    "rainbow": {"name": "Rainbow", "bold": True, "uppercase": False, "fontFrac": 0.045,
        "outlineFrac": 0.005, "shadowFrac": 0, "position": "lower",
        "primary": "FFFFFF", "outline": "000000", "box": None, "fx": "rainbow"},
    "broadcast": {"name": "Broadcast", "bold": False, "uppercase": False, "fontFrac": 0.06,
        "outlineFrac": 0.003, "shadowFrac": 0.0033, "position": "bottom",
        "primary": "FFFFFF", "outline": "000000", "box": None, "fx": None},
    "streaming": {"name": "Streaming", "bold": False, "uppercase": False, "fontFrac": 0.06,
        "outlineFrac": 0, "shadowFrac": 0.004, "position": "bottom",
        "primary": "FFFFFF", "outline": "000000", "box": None, "fx": None},
    "lower-bar": {"name": "Lower Bar", "bold": False, "uppercase": False, "fontFrac": 0.06,
        "outlineFrac": 0, "shadowFrac": 0, "position": "bottom",
        "primary": "FFFFFF", "outline": "000000",
        "box": {"color": "000000", "opacity": 0.6}, "fx": None},
    "neon": {"name": "Neon", "bold": True, "uppercase": False, "fontFrac": 0.06,
        "outlineFrac": 0.004, "shadowFrac": 0, "position": "bottom",
        "primary": "00E5FF", "outline": "00E5FF", "box": None, "fx": "neon"},
    # Ours, not the plugin's: fully opaque grounds -- sticker and soft-card
    # are translucent, and nothing covered what sits under the text outright
    # (user, 2026-09-01).
    "black-box": {"name": "Black Box", "bold": True, "uppercase": False, "fontFrac": 0.032,
        "outlineFrac": 0, "shadowFrac": 0, "position": "lower",
        "primary": "FFFFFF", "outline": "000000",
        "box": {"color": "000000", "opacity": 1.0}, "fx": None},
    "white-box": {"name": "White Box", "bold": False, "uppercase": False, "fontFrac": 0.03,
        "outlineFrac": 0, "shadowFrac": 0, "position": "lower",
        "primary": "3A332C", "outline": "FFFFFF",
        "box": {"color": "FFFFFF", "opacity": 1.0}, "fx": None},
}

# Alignment (numpad) and how far up from the edge, per named position.
POSITIONS = {"center": (5, 0.0), "lower": (2, 0.28),
             "bottom": (2, 0.055), "upper": (8, 0.30)}

RAINBOW = ["0000FF", "1A8CFF", "00E0FF", "5CDC3D", "FF863A", "FF4DC0"]


def _color(rgb, opacity=1.0):
    """RRGGBB + opacity -> ASS &HAABBGGRR& (alpha 00 = opaque)."""
    r, g, b = rgb[0:2], rgb[2:4], rgb[4:6]
    return "&H%02X%s%s%s&" % (round((1 - opacity) * 255), b.upper(), g.upper(), r.upper())


def _time(t):
    h, rest = divmod(max(0.0, t), 3600)
    m, sec = divmod(rest, 60)
    return "%d:%02d:%05.2f" % (h, m, sec)


def _text_plain(s):
    """Injection-stripped but with real newlines kept, for our own wrapping."""
    return re.sub(r"[\\{}]", "", s or "")


def _text(s):
    """Strip what could smuggle ASS override tags; newlines become \\N."""
    return re.sub(r"\r?\n", r"\\N", re.sub(r"[\\{}]", "", s or ""))


def _char_w(ch, font_px):
    """A rough width for one glyph: CJK squares, thinner latin, thin spaces."""
    o = ord(ch)
    if 0x1100 <= o <= 0x11FF or 0x3000 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF \
            or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF:
        return font_px
    if ch == " ":
        return font_px * 0.3
    return font_px * 0.52


def _wrap(text, font_px, max_px):
    """Break text into lines no wider (by estimate) than max_px."""
    lines = []
    for raw in text.split("\n"):
        line, w = "", 0.0
        for word in raw.split(" "):
            ww = sum(_char_w(c, font_px) for c in word)
            sp = _char_w(" ", font_px) if line else 0
            if line and w + sp + ww > max_px:
                lines.append(line)
                line, w = word, ww
            else:
                line = (line + " " + word) if line else word
                w += sp + ww
        lines.append(line)
    return [l for l in lines if l] or [""]


def _layout_for(layout, n, text):
    """The page's measurement of cue n, if it was made for these very words.
    A line rewritten after the page last measured gets the estimate instead --
    the burn must never print words the script no longer says."""
    lay = (layout or {}).get(str(n))
    if not lay or lay.get("text") != text or not lay.get("lines"):
        return None
    return lay


def _rect(align, x, y, box, w_px, h_px):
    """A filled box w_px by h_px hanging off its anchor point, in the box's
    colour and opacity, drawn as ASS vector art on the layer under the words."""
    box_col = "&H%s%s%s&" % (box["color"][4:6], box["color"][2:4], box["color"][0:2])
    alpha = "&H%02X&" % round((1 - box["opacity"]) * 255)
    return ("{\\an%d\\pos(%d,%d)\\1c%s\\1a%s\\bord0\\shad0\\p1}"
            "m 0 0 l %d 0 l %d %d l 0 %d{\\p0}"
            % (align, x, y, box_col.upper(), alpha, w_px, w_px, h_px, h_px))


# libass reads a Style's Fontsize as the font's cell height (ascent + descent),
# the VSFilter way, so a font whose cell is taller than its em comes out that
# much smaller than the page drew it -- the page measures in true em. The
# burn fonts' cells, from their OS/2 metrics and confirmed by rendering ten
# capital H on 2026-09-08 (Chromium 668 px vs libass 542 px on Mac, 530 px on
# Windows at Fontsize 100). A font not listed here is drawn unscaled.
FONT_CELL = {"Apple SD Gothic Neo": 1.2, "Malgun Gothic": 1.33, "Noto Sans CJK KR": 1.448}

# Fonts that ship a regular and a bold face only: the browser gives weight 600
# the bold face, libass the regular one, so White Box came out thin on
# Windows. For these the layout's weight snaps to \b1 / \b0.
TWO_WEIGHT_FONTS = {"Malgun Gothic"}


def build_ass(cues, preset_id, *, width, height, pos=None, size=None,
              font="Arial", box_width=None, line_widths=None, layout=None):
    """The whole .ass document for one video's subtitles.

    cues: [{start, end, text}]. pos (0 top .. 100 bottom) and size (percent)
    are the user's own overrides; None keeps the preset's word. box_width
    (10..100, percent of the video's width) fixes the background box's width
    for presets that have one -- drawn as its own rectangle, since ASS's own
    box only ever hugs the text; line_widths ("1"-based) overrides it per
    line.

    layout ("1"-based) is what the player showed: {text, lines, w, h}, the
    words as they broke on screen and the box in em of the font size. Given,
    it is drawn verbatim -- the player draws with the same font, so the two
    match by construction. Without it the width and line breaks are estimated
    here, which is how the exported video came to break lines the screen did
    not (2026-09-07)."""
    p = PRESETS[preset_id]
    font_px = max(1, round(height * p["fontFrac"] * ((size or 100) / 100)))
    align, margin_frac = POSITIONS[p["position"]]
    margin_v = round(height * margin_frac)
    if pos is not None:
        # Dragged: anchored to the bottom edge, however the preset sat.
        align, margin_v = 2, round(height * (100 - pos) / 100)
    box = p["box"]
    fixed_width = bool(box) and (box_width is not None or line_widths or layout)
    border_style = 1 if fixed_width else (3 if box else 1)
    outline = (0 if fixed_width
               else max(3, round(font_px * 0.22)) if box
               else round(height * p["outlineFrac"]))
    shadow = 0 if box else round(height * (p["shadowFrac"] or 0))
    outline_color = (_color(p["outline"]) if fixed_width
                     else _color(box["color"], box["opacity"]) if box
                     else _color(p["outline"]))
    back = _color(box["color"], box["opacity"]) if box else _color("000000")
    safe_font = re.sub(r"[,\r\n{}]", " ", font).strip()
    # Only the Style's Fontsize takes the cell scale (FONT_CELL); boxes,
    # paddings and offsets stay in font_px, the em the page measured with.
    style_px = round(font_px * FONT_CELL.get(font, 1.0))
    style = ("Style: Base,%s,%d,%s,&H000000FF,%s,%s,%d,0,0,0,100,100,0,0,%d,%d,%d,%d,%d,%d,%d,1"
             % (safe_font, style_px, _color(p["primary"]), outline_color, back,
                1 if p["bold"] else 0, border_style, outline, shadow, align,
                round(width * 0.06), round(width * 0.06), margin_v))

    # Where the box's anchor point sits on screen, for the drawn rectangles.
    anchor_x = width / 2
    if align in (1, 2, 3):
        anchor_y = height - margin_v
    elif align in (7, 8, 9):
        anchor_y = margin_v
    else:
        anchor_y = height / 2

    events = []
    for n, c in enumerate(cues, start=1):
        text = (c.get("text") or "")
        lay = _layout_for(layout, n, text)
        # The page's lines, or one line the paths below may break themselves.
        lines = list(lay["lines"]) if lay else [text]
        # The weight the page drew at (\b<weight>, which libass honours); the
        # preset's bold flag alone left White Box thinner than on screen.
        if lay and lay.get("weight"):
            wt = ("\\b%d" % (1 if lay["weight"] >= 600 else 0) if font in TWO_WEIGHT_FONTS
                  else "\\b%d" % lay["weight"])
        else:
            wt = ""
        # The page's lines are final. libass wraps on its own at the Style's
        # margins (6% a side, 88% of the width) and the page lets a line run to
        # 92%: a line shown whole came out folded over a box drawn one line
        # tall (Windows, 2026-09-10). \q2 turns that wrapping off.
        if lay:
            wt = "\\q2" + wt
        if p["uppercase"]:
            text = text.upper()
            lines = [l.upper() for l in lines]
        st, en = _time(float(c["start"])), _time(float(c["end"]))
        if fixed_width and lay:
            w_px = round(float(lay["w"]) * font_px)
            h_px = round(float(lay["h"]) * font_px)
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s"
                          % (st, en, _rect(align, anchor_x, anchor_y, box, w_px, h_px)))
            # Centred in the box, as the page centres it: the box hangs off its
            # anchor edge, so its middle is half its height in from there.
            mid_y = (anchor_y - h_px / 2 if align in (1, 2, 3) else
                     anchor_y + h_px / 2 if align in (7, 8, 9) else anchor_y)
            events.append("Dialogue: 1,%s,%s,Base,,0,0,,{\\an5\\pos(%d,%d)%s}%s"
                          % (st, en, anchor_x, round(mid_y), wt,
                             "\\N".join(_text(l) for l in lines)))
            continue
        if fixed_width:
            pct = (line_widths or {}).get(str(n), box_width)
            pct = box_width if pct is None else pct
            w_px = round(width * float(pct if pct is not None else 60) / 100)
            pad_x = round(font_px * 0.55)
            lines = _wrap(_text_plain(text), font_px, max(font_px, w_px - 2 * pad_x))
            line_h = font_px * 1.42
            h_px = round(len(lines) * line_h + font_px * 0.55)
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s"
                          % (st, en, _rect(align, anchor_x, anchor_y, box, w_px, h_px)))
            body = "\\N".join(_text(l) for l in lines)
            events.append("Dialogue: 1,%s,%s,Base,,0,0,,{\\an%d\\pos(%d,%d)}%s"
                          % (st, en, align, anchor_x,
                             anchor_y - (round(font_px * 0.28)
                                         if align in (1, 2, 3) else
                                         -round(font_px * 0.28) if align in (7, 8, 9) else 0),
                             body))
            continue
        if p["fx"] == "rainbow":
            # The palette runs on across the page's line breaks.
            rows, i = [], 0
            for line in lines:
                words = []
                for w in line.split():
                    words.append("{\\1c&H%s&}%s" % (RAINBOW[i % len(RAINBOW)], _text(w)))
                    i += 1
                rows.append(" ".join(words))
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s%s"
                          % (st, en, "{%s}" % wt if wt else "", "\\N".join(rows)))
        elif p["fx"] == "neon":
            fill = _color(p["primary"])
            body = "\\N".join(_text(l) for l in lines)
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,{\\1a&HFF&\\3c%s\\bord5\\blur8\\shad0%s}%s"
                          % (st, en, fill, wt, body))
            events.append("Dialogue: 1,%s,%s,Base,,0,0,,{\\1c%s\\3c&H101010&\\bord1.6\\blur0\\shad0%s}%s"
                          % (st, en, fill, wt, body))
        else:
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s%s"
                          % (st, en, "{%s}" % wt if wt else "",
                             "\\N".join(_text(l) for l in lines)))

    return """[Script Info]
ScriptType: v4.00+
PlayResX: %d
PlayResY: %d
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
%s

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text
%s
""" % (width, height, style, "\n".join(events))
