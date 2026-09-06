"""The dubbing progress stages, and the "N/6" markers built from them.

A leaf module on purpose: it imports nothing from the app. The stage table is
needed both by the orchestrator (app/pipeline.py, which logs a marker at every
step) and by app/source_fetch.py, which only wants the "0/6" prefix for the
download it does before stage one. When the table lived in app/pipeline.py,
"download a video" pulled in the whole pipeline -- the TTS engine, the
diarizer, app/qwen_pipeline.py -- to obtain one short string, and inverted the
layering besides. Keeping it here means either side can have it for free.

This tuple is the ONLY place the "N/6" numbering lives: every stage log line is
built from a stage's position here, so inserting a stage renumbers all of them
at once instead of by hand in a dozen string literals.

The second field is the coarser label the UI shows for the stage. Neighbouring
stages that share a label are folded into one step of the progress bar there
(the last three all read as "Dubbing" to the user), so this field is the
contract with ui/src/dubApi.mjs's own STAGES table --
tests/test_stage_tables_match.py reads both and fails if the two drift apart.
"""

STAGES = (
    ("separate", "Separating audio"),
    ("transcribe", "Transcribing"),
    ("translate", "Translating"),
    ("synthesize", "Dubbing"),
    ("check", "Dubbing"),
    ("build", "Dubbing"),
)

_STAGE_NUMBER = {name: i + 1 for i, (name, _label) in enumerate(STAGES)}


def stage_marker(name: str) -> str:
    """The "N/6" prefix a stage's log lines start with, e.g. "3/6"."""
    return f"{_STAGE_NUMBER[name]}/{len(STAGES)}"


def pre_stage_marker() -> str:
    """The "0/6" prefix for progress logged before any stage above starts
    (e.g. fetching the source video)."""
    return f"0/{len(STAGES)}"
