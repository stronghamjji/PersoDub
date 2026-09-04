"""The dub's per-stage defaults -- what a dub gets when nobody chose -- and one
report of the whole setup (defaults, downloaded models, saved keys).

Defaults live in kit.env beside the API keys and are read at use time
(settings_env.current_value), so a change made by the Settings screen or by
the Dub Agent's set_default is in force for the very next dub, no restart.
One table below names every stage, its kit.env key, its choices and its
fallback; the screen, the API and the agent's tools all read it.
"""
from typing import Dict, Optional

from app import config
from app.settings_env import current_value, write_values

# stage -> (kit.env key, allowed choices, fallback when kit.env says nothing).
# A None fallback means "computed": see _fallback below.
STAGES = {
    "dub_mode": ("DUB_MODE", ("local", "perso"), "local"),
    "separation": ("SEP_ENGINE", ("local", "perso"), "local"),
    "stt": ("STT_ENGINE", ("local", "perso"), None),
    "translator": ("TRANSLATE_ENGINE", ("hunyuan", "gemma", "gemini"), None),
    "voice_quality": ("VOICE_QUALITY", ("fast", "high"), "fast"),
}

# What the voice engine's best-of-N count is for each quality word (the same
# mapping ui/src/dubApi.mjs uses for the screen's Fast / High quality).
N_TAKES = {"fast": 1, "high": 4}


def _fallback(stage: str) -> str:
    if stage == "stt":
        # Perso when a key is saved, else the free local engine -- the rule
        # config.default_stt_engine has always applied.
        return "perso" if current_value("PERSO_API_KEY") else "local"
    if stage == "translator":
        return config.TRANSLATE_ENGINE_DEFAULT
    return STAGES[stage][2]


def default_for(stage: str) -> str:
    """The choice in force for one stage: kit.env's, or the fallback."""
    key, choices, _ = STAGES[stage]
    value = (current_value(key) or "").strip().lower()
    return value if value in choices else _fallback(stage)


def defaults() -> Dict[str, str]:
    return {stage: default_for(stage) for stage in STAGES}


def default_n_takes() -> Optional[int]:
    """The best-of-N count the saved voice quality asks for, or None when
    kit.env never chose one -- then the voice engine's own QWEN_N_TAKES
    default applies, as it always has."""
    key = STAGES["voice_quality"][0]
    if not (current_value(key) or "").strip():
        return None
    return N_TAKES[default_for("voice_quality")]


def set_defaults(changes: Dict[str, Optional[str]]) -> Dict[str, str]:
    """Save new choices for one or more stages. Unknown stages and choices
    are refused (ValueError) before anything is written; a None value leaves
    that stage alone. Returns the defaults now in force."""
    to_write = {}
    for stage, choice in changes.items():
        if choice is None:
            continue
        if stage not in STAGES:
            raise ValueError("Unknown stage: %s (one of %s)" % (stage, ", ".join(STAGES)))
        key, choices, _ = STAGES[stage]
        value = str(choice).strip().lower()
        if value not in choices:
            raise ValueError("%s must be one of: %s" % (stage, ", ".join(choices)))
        to_write[key] = value
    write_values(to_write)
    return defaults()
