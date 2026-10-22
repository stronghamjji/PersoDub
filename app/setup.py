"""The dub's per-stage defaults -- what a dub gets when nobody chose -- and one
report of the whole setup (defaults, downloaded models, saved keys).

Defaults live in kit.env beside the API keys and are read at use time
(settings_env.current_value), so a change made by the Settings screen or by
the Dub Agent's set_default is in force for the very next dub, no restart.
One table below names every stage, its kit.env key, its choices and its
fallback; the screen, the API and the agent's tools all read it.
"""
import os
from typing import Dict, Optional

from app import config
from app.engines_status import TRANSLATORS
from app.i18n import t
from app.settings_env import current_value, write_values

# stage -> (kit.env key, allowed choices, fallback when kit.env says nothing).
# A None fallback means "computed": see _fallback below. The translators are
# the ones app/engines_status.py's TRANSLATORS offers, in its order.
STAGES = {
    "dub_mode": ("DUB_MODE", ("local", "perso"), None),
    # "local" is Demucs and "roformer" Mel-Band RoFormer, both on this
    # computer; the screen lists each with its own download state.
    "separation": ("SEP_ENGINE", ("local", "roformer", "perso"), None),
    # Local Whisper even with a Perso key saved: every stage starts on the free
    # local choice, and Perso speech-to-text runs only when chosen
    # (owner, 2026-10-20).
    "stt": ("STT_ENGINE", ("local", "perso"), "local"),
    "translator": ("TRANSLATE_ENGINE", tuple(t.name for t in TRANSLATORS.values() if t.offered), None),
    "voice_quality": ("VOICE_QUALITY", ("fast", "high"), "fast"),
    "voice": ("TTS_ENGINE", ("qwen3",), "qwen3"),
}

# What the voice engine's best-of-N count is for each quality word (the same
# mapping ui/src/dubApi.mjs uses for the screen's Fast / High quality).
N_TAKES = {"fast": 1, "high": 4}


def _hunyuan_installed() -> bool:
    from app import models as model_store
    entry = model_store.find("hunyuan")
    kit = model_store.kit_dir()
    return bool(entry and kit) and model_store.model_state(entry, kit) == "ready"


def _roformer_installed() -> bool:
    from app import models as model_store
    entry = model_store.find("vocal-separator")
    kit = model_store.kit_dir()
    return bool(entry and kit) and model_store.model_state(entry, kit) == "ready"


def _fallback(stage: str) -> str:
    if stage == "dub_mode":
        # One build, two defaults. The production edition, the company's
        # build, dubs on Perso, key or no key: without one, Start says to save
        # a key first (app/api/dub.py), which is how a new user is led to get
        # one (owner, 2026-10-07). The open-source edition, and a plain server
        # run, dub on this computer, which needs no key (owner, 2026-10-12).
        # The desktop shell passes the edition (desktop/src/orchestrator.js).
        return "perso" if os.environ.get("PERSODUB_EDITION") == "production" else "local"
    if stage == "translator":
        # ChatGPT for a new install; a machine that already has the local
        # Hunyuan model keeps translating locally after the update, so no
        # script starts going to OpenAI without anyone choosing it
        # (user, 2026-09-24).
        return "hunyuan" if _hunyuan_installed() else config.TRANSLATE_ENGINE_DEFAULT
    if stage == "separation":
        # A machine with the RoFormer downloaded keeps separating with it, the
        # way "local" did while it meant "the RoFormer when it is here".
        return "roformer" if _roformer_installed() else "local"
    return STAGES[stage][2]


def default_for(stage: str) -> str:
    """The choice in force for one stage: kit.env's, or the fallback."""
    key, choices, _ = STAGES[stage]
    value = (current_value(key) or "").strip().lower()
    return value if value in choices else _fallback(stage)


def defaults() -> Dict[str, str]:
    return {stage: default_for(stage) for stage in STAGES}


def default_n_takes() -> Optional[int]:
    """The best-of-N count the voice quality in force asks for.

    Until 2026-09-17 an unsaved quality answered None and the engine's own
    QWEN_N_TAKES (4) ran, while the Settings screen and /api/setup both said
    "fast": a dub the agent started as Fast made four takes per line (0.6.2
    full test, F10). The fallback is the quality the screen shows, so it is
    the count that runs."""
    return N_TAKES[default_for("voice_quality")]


def checked_choice(stage: str, choice) -> str:
    """One stage's choice the way it is saved: trimmed and lowercased, and one
    the stage offers (ValueError otherwise, as for an unknown stage). The Dub
    Agent's set_default reads a choice through here before it asks about a
    paid one, so what it asks about is what is saved: it checked "Gemini" as
    written, found nothing paid, and gemini was saved unasked (2026-10-10)."""
    if stage not in STAGES:
        raise ValueError(t("Unknown stage: {stage} (one of {stages})", stage=stage, stages=", ".join(STAGES)))
    choices = STAGES[stage][1]
    value = str(choice).strip().lower()
    if value not in choices:
        raise ValueError(t("{stage} must be one of: {choices}", stage=stage, choices=", ".join(choices)))
    return value


def set_defaults(changes: Dict[str, Optional[str]]) -> Dict[str, str]:
    """Save new choices for one or more stages. Unknown stages and choices
    are refused (ValueError) before anything is written; a None value leaves
    that stage alone. Returns the defaults now in force."""
    to_write = {}
    for stage, choice in changes.items():
        if choice is None:
            continue
        value = checked_choice(stage, choice)
        to_write[STAGES[stage][0]] = value
    write_values(to_write)
    return defaults()
