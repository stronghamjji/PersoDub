"""What a line looks like by the time the voice engine reads it.

A translator writes for the eye; the voice engine reads for the ear, and one
mark tripped it: a long dash inside a sentence ("bones jut out—they look…")
sent Qwen3-TTS running for 15 minutes on a Mac (2026-09-23). A dash spoken is
a pause, and a comma says that in a form every voice model knows.
"""
import re

# The long dashes (em, en, and the two-hyphen stand-in) with any space around
# them: ", " is what they sound like. The plain hyphen inside a word ("well-
# known") is not touched.
_DASH = re.compile(r"\s*(?:—|–|--)\s*")
_MANY_SPACES = re.compile(r"[ \t]+")
_DOUBLED = re.compile(r",\s*,")


def speech_text(text: str) -> str:
    """The line as the voice engine should read it."""
    t = _DASH.sub(", ", text or "")
    t = _DOUBLED.sub(",", t)
    t = _MANY_SPACES.sub(" ", t).strip()
    # A dash that opened or closed the line leaves a stray comma behind.
    return t.strip(", ").strip() if t.startswith(",") or t.endswith(",") else t
