"""The two stage tables -- Python's and the UI's -- must stay in step.

The pipeline logs its progress as "N/6 …" lines and the UI parses them back
into a progress bar, so the ordered list of stages is a contract spanning two
languages. It used to be spelled out twice by hand (a dozen numbered literals
in app/pipeline.py, a regex plus two lookup tables in ui/src/dubApi.mjs), and
nothing noticed when one side changed. Each side now has exactly one table;
this test is the pin that stops them drifting.

How it reads the JS side: a regex over ui/src/dubApi.mjs's source text, not a
JS runtime. That is enough because the table is a literal array of literal
objects written one per line, which is also the only shape the regex accepts --
if someone builds the array some other way the regex finds nothing and this
test fails loudly rather than passing on an empty list. It deliberately does
NOT check the fields only one side uses (weights, floors, kind): those are the
UI's own arithmetic, and pinning them here would just be a second copy.
"""
import re
from pathlib import Path

from app.pipeline import STAGES, stage_marker

_JS = Path(__file__).resolve().parent.parent / "ui" / "src" / "dubApi.mjs"

# One row of the JS table: { name: "separate", label: "Separating audio", ... }
_ROW = re.compile(r'\{\s*name:\s*"([^"]+)",\s*label:\s*"([^"]+)"')


def _js_stages():
    """The (name, label) pairs of ui/src/dubApi.mjs's exported STAGES array."""
    src = _JS.read_text(encoding="utf-8")
    m = re.search(r"export const STAGES = \[(.*?)\];", src, re.S)
    assert m, "ui/src/dubApi.mjs no longer exports a STAGES array literal"
    return _ROW.findall(m.group(1))


def test_stage_names_and_labels_match_the_ui_table():
    assert _js_stages() == [(name, label) for name, label in STAGES]


def test_the_two_tables_are_the_same_length():
    # The length is what the "N/6" markers count up to on both sides, so this
    # is the assertion that actually breaks a half-finished seventh stage.
    assert len(_js_stages()) == len(STAGES)


def test_stage_marker_numbers_the_stages_from_one():
    markers = [stage_marker(name) for name, _label in STAGES]
    assert markers == [f"{i + 1}/{len(STAGES)}" for i in range(len(STAGES))]
