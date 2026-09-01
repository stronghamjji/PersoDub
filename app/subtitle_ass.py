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
    "clean": dict(name="Clean", bold=True, uppercase=False, fontFrac=0.032,
                  outlineFrac=0.0018, shadowFrac=0.0016, position="lower",
                  primary="FFFFFF", outline="000000", box=None, fx=None),
    "bold-punch": dict(name="Bold Punch", bold=True, uppercase=True, fontFrac=0.052,
                       outlineFrac=0.007, shadowFrac=0, position="center",
                       primary="FFFFFF", outline="000000", box=None, fx=None),
    "sticker": dict(name="Sticker", bold=True, uppercase=False, fontFrac=0.029,
                    outlineFrac=0, shadowFrac=0, position="lower",
                    primary="FFFFFF", outline="000000",
                    box=dict(color="000000", opacity=0.6), fx=None),
    "neon-yellow": dict(name="Neon Yellow", bold=True, uppercase=False, fontFrac=0.049,
                        outlineFrac=0.006, shadowFrac=0, position="lower",
                        primary="FFE600", outline="000000", box=None, fx=None),
    "soft-card": dict(name="Soft Card", bold=False, uppercase=False, fontFrac=0.026,
                      outlineFrac=0, shadowFrac=0, position="upper",
                      primary="3A332C", outline="FFFFFF",
                      box=dict(color="FFFFFF", opacity=0.85), fx=None),
    "rainbow": dict(name="Rainbow", bold=True, uppercase=False, fontFrac=0.045,
                    outlineFrac=0.005, shadowFrac=0, position="lower",
                    primary="FFFFFF", outline="000000", box=None, fx="rainbow"),
    "broadcast": dict(name="Broadcast", bold=False, uppercase=False, fontFrac=0.06,
                      outlineFrac=0.003, shadowFrac=0.0033, position="bottom",
                      primary="FFFFFF", outline="000000", box=None, fx=None),
    "streaming": dict(name="Streaming", bold=False, uppercase=False, fontFrac=0.06,
                      outlineFrac=0, shadowFrac=0.004, position="bottom",
                      primary="FFFFFF", outline="000000", box=None, fx=None),
    "lower-bar": dict(name="Lower Bar", bold=False, uppercase=False, fontFrac=0.06,
                      outlineFrac=0, shadowFrac=0, position="bottom",
                      primary="FFFFFF", outline="000000",
                      box=dict(color="000000", opacity=0.6), fx=None),
    "neon": dict(name="Neon", bold=True, uppercase=False, fontFrac=0.06,
                 outlineFrac=0.004, shadowFrac=0, position="bottom",
                 primary="00E5FF", outline="00E5FF", box=None, fx="neon"),
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


def _text(s):
    """Strip what could smuggle ASS override tags; newlines become \\N."""
    return re.sub(r"\r?\n", r"\\N", re.sub(r"[\\{}]", "", s or ""))


def build_ass(cues, preset_id, *, width, height, pos=None, size=None,
              font="Arial"):
    """The whole .ass document for one video's subtitles.

    cues: [{start, end, text}]. pos (0 top .. 100 bottom) and size (percent)
    are the user's own overrides; None keeps the preset's word."""
    p = PRESETS[preset_id]
    font_px = max(1, round(height * p["fontFrac"] * ((size or 100) / 100)))
    align, margin_frac = POSITIONS[p["position"]]
    margin_v = round(height * margin_frac)
    if pos is not None:
        # Dragged: anchored to the bottom edge, however the preset sat.
        align, margin_v = 2, round(height * (100 - pos) / 100)
    box = p["box"]
    border_style = 3 if box else 1
    outline = (max(3, round(font_px * 0.22)) if box
               else round(height * p["outlineFrac"]))
    shadow = 0 if box else round(height * (p["shadowFrac"] or 0))
    outline_color = _color(box["color"], box["opacity"]) if box else _color(p["outline"])
    back = _color(box["color"], box["opacity"]) if box else _color("000000")
    safe_font = re.sub(r"[,\r\n{}]", " ", font).strip()
    style = ("Style: Base,%s,%d,%s,&H000000FF,%s,%s,%d,0,0,0,100,100,0,0,%d,%d,%d,%d,%d,%d,%d,1"
             % (safe_font, font_px, _color(p["primary"]), outline_color, back,
                1 if p["bold"] else 0, border_style, outline, shadow, align,
                round(width * 0.06), round(width * 0.06), margin_v))

    events = []
    for c in cues:
        text = (c.get("text") or "")
        if p["uppercase"]:
            text = text.upper()
        st, en = _time(float(c["start"])), _time(float(c["end"]))
        if p["fx"] == "rainbow":
            i = 0
            words = []
            for w in text.split():
                words.append("{\\1c&H%s&}%s" % (RAINBOW[i % len(RAINBOW)], _text(w)))
                i += 1
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s" % (st, en, " ".join(words)))
        elif p["fx"] == "neon":
            fill = _color(p["primary"])
            body = _text(text)
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,{\\1a&HFF&\\3c%s\\bord5\\blur8\\shad0}%s"
                          % (st, en, fill, body))
            events.append("Dialogue: 1,%s,%s,Base,,0,0,,{\\1c%s\\3c&H101010&\\bord1.6\\blur0\\shad0}%s"
                          % (st, en, fill, body))
        else:
            events.append("Dialogue: 0,%s,%s,Base,,0,0,,%s" % (st, en, _text(text)))

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
