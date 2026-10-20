"""Engine capability discovery -- can this machine actually run engine X right now?

Pure checks that GET /api/engines and dub_start's preflight (app/api/dub.py) use to
stop offering/starting translation and transcription engines that don't actually
work on this machine: gemma/qwen need a local Ollama server with the model
pulled, gemini/perso need an API key configured. Everything here reads
config/env/runtime.json live (not cached at import time) so tests can
monkeypatch, and the Ollama check is exception-safe -- a down/slow Ollama must
never crash the caller, so any network problem resolves to False rather than
raising. When no Ollama pack is installed, runtime.url("ollama") is "" and the
request itself fails, which ollama_model_status already reports as
"unreachable" rather than raising.
"""
import json
import os
import re
from dataclasses import dataclass
from typing import Callable

import requests

from app import config, eraser, i18n, runtime
from app import models as model_store
from app.settings_env import current_value


def _tag_matches(tags, model: str) -> bool:
    """True iff `model` is among `tags` -- exact tag, implicit ":latest", or
    (when `model` has no tag of its own) a bare name against any tagged
    version of it."""
    for t in tags:
        if t == model or t == model + ":latest":
            return True
        if ":" not in model and t.split(":")[0] == model:
            return True
    return False


def ollama_model_status(url: str, model: str, timeout: float = 4.0) -> str:
    """"unreachable" | "model_missing" | "available" for `model` on the local
    Ollama server at `url`.

    Kept distinct from a single available/unavailable bool so callers can
    report an accurate, actionable message instead of conflating "Ollama is
    down" with "Ollama is up but this model isn't pulled" -- a busy-but-valid
    Ollama must never be described as "not running". Any exception (down,
    timeout, bad response) resolves to "unreachable" rather than raising.
    timeout default raised from the original 1.5s: a slow-but-live Ollama
    (e.g. busy generating) was timing out and getting misreported as down.
    """
    try:
        r = requests.get(f"{url}/api/tags", timeout=timeout)
        r.raise_for_status()
        tags = [m.get("name", "") for m in r.json().get("models", [])]
    except Exception:
        return "unreachable"
    return "available" if _tag_matches(tags, model) else "model_missing"


def ollama_model_available(url: str, model: str, timeout: float = 4.0) -> bool:
    """True iff `model` is among the tags a local Ollama server reports as pulled.

    Matches an exact tag, the implicit ":latest" tag, or (when `model` has no tag
    of its own) a bare name against any tagged version of it. Any exception --
    Ollama not running, timeout, bad response -- resolves to False.
    """
    return ollama_model_status(url, model, timeout) == "available"


def gemma_available() -> bool:
    return ollama_model_available(runtime.url("ollama"), TRANSLATORS["gemma"].ollama_model)


def qwen_available() -> bool:
    return ollama_model_available(runtime.url("ollama"), TRANSLATORS["qwen"].ollama_model)


def hunyuan_available() -> bool:
    return ollama_model_available(runtime.url("ollama"), TRANSLATORS["hunyuan"].ollama_model)


def gemma_status() -> str:
    """"unreachable" | "model_missing" | "available" -- see ollama_model_status.
    Used by dub_start's preflight (app/api/dub.py) to give an accurate 422."""
    return ollama_model_status(runtime.url("ollama"), TRANSLATORS["gemma"].ollama_model)


def qwen_status() -> str:
    """"unreachable" | "model_missing" | "available" -- see ollama_model_status.
    Used by dub_start's preflight (app/api/dub.py) to give an accurate 422."""
    return ollama_model_status(runtime.url("ollama"), TRANSLATORS["qwen"].ollama_model)


def hunyuan_status() -> str:
    """"unreachable" | "model_missing" | "available" -- see ollama_model_status.
    Used by dub_start's preflight (app/api/dub.py) to give an accurate 422."""
    return ollama_model_status(runtime.url("ollama"), TRANSLATORS["hunyuan"].ollama_model)


def eraser_available() -> bool:
    """Whether the subtitle eraser can run here: its interpreter and the
    video-subtitle-remover checkout it runs out of are both really on disk.

    Where those are is app/eraser.py's answer, read out of kit.env every time
    it is asked -- that pack is installed while the app is open, so a snapshot
    taken at startup would keep the Erase subtitles screen refusing long after
    the download had finished."""
    py, vsr = eraser.paths_now()
    return bool(py and vsr and os.path.isfile(py) and os.path.isdir(vsr))


def gemini_available() -> bool:
    # current_value, not config.GEMINI_API_KEY: the constant froze at import
    # time, so a key saved in Settings kept Gemini greyed out until a restart.
    return bool(current_value("GEMINI_API_KEY"))


def voice_models() -> dict:
    """The model behind each voice engine, as the screens name it:
    {"qwen3": "1.7B"}, the size the downloaded model says it is in its own
    config.json ("tts_model_size": "1b7"), "" when that cannot be read (not
    downloaded yet, or a file without the field)."""
    size = ""
    entry = model_store.find("qwen3-tts")
    kit = model_store.kit_dir()
    if entry and kit:
        try:
            with open(os.path.join(kit, *entry["dir"].split("/"), "config.json"), encoding="utf-8") as f:
                m = re.fullmatch(r"(\d+)b(\d*)", str(json.load(f).get("tts_model_size") or "").lower())
            if m:
                size = f"{m[1]}.{m[2]}B" if m[2] else f"{m[1]}B"
        except (OSError, ValueError, AttributeError):
            pass
    return {"qwen3": size}


def chatgpt_available() -> bool:
    """A ChatGPT sign-in this machine can translate with: the sign-in program
    is here and says it is signed in. Asked once per dub start, like the
    Ollama probe -- a child process, not a cached guess."""
    from app.agents import base as agent_base

    binary = agent_base.find_cli("codex")
    if not binary:
        return False
    # "Cannot tell yet" (a cold start past the 8 s check, common on Windows)
    # lets the dub run: a real sign-out still stops it at translation with
    # its own notice, and a refusal on a guess stopped signed-in users.
    return agent_base.login_state("codex", binary, env=agent_base.chatgpt_env()).get("logged_in") is not False


def perso_available() -> bool:
    # The key alone: PersoClient resolves the workspace id from the key at dub
    # time (GET /portal/api/v1/spaces, as the official plugin does), and the
    # media host has a public default. Requiring PERSO_SPACE_SEQ here kept
    # Perso greyed out for everyone who only saved a key in Settings. No
    # network call in this check -- /api/engines runs on every page load.
    return bool(current_value("PERSO_API_KEY"))


@dataclass(frozen=True)
class TranslatorInfo:
    """What the app knows about one translator before a dub is made with it.

    `probe` asks this machine now, through this module's own function for the
    translator, looked up when it is called -- the name the tests replace. It
    answers True or False for an account or a key, and one of
    ollama_model_status's three words for a model on the local Ollama server.
    """
    name: str                  # its word in kit.env, a dub's form and job.json
    label: str                 # how a sentence names it
    kind: str                  # "account" (a sign-in), "key" (an API key) or "ollama"
    probe: Callable[[], object]
    # The refusal when an account or a key translator cannot run, said when
    # it is asked for: in the user's language, which can change at any time.
    unavailable: Callable[[], str] = lambda: ""
    model_setting: str = ""    # the app/config.py name of an Ollama model's tag
    catalog_id: str = ""       # its model's id in the catalog, when the app downloads it
    offered: bool = True       # a choice on the Settings screen (app/setup.py STAGES)
    big_model: bool = False    # wants more memory beside the voice engine (app/room.py)
    spends: str = ""           # the user's money it spends, said before it becomes a default

    @property
    def ollama_model(self) -> str:
        """Its Ollama model tag, read from app/config.py when asked."""
        return getattr(config, self.model_setting)

    @property
    def needs_ollama_pack(self) -> bool:
        """A model the app downloads runs in the app's own Ollama runtime
        pack; one pulled by hand (Qwen) is the developer's own Ollama."""
        return bool(self.catalog_id)


# Every translator a dub start knows, in the order the Settings screen offers
# them. A name not here ("vertex", or none for a Perso dub) is checked by
# nothing before the dub starts.
TRANSLATORS = {t.name: t for t in (
    # In English on purpose: the page opens the ChatGPT sign-in when it reads
    # "ChatGPT sign-in" in a refused start (ui/src/app.mjs submitDubStart).
    TranslatorInfo("chatgpt", "ChatGPT", "account", lambda: chatgpt_available(),
                   unavailable=lambda: ("ChatGPT translation needs a ChatGPT sign-in. Open Settings and "
                                        "press Sign in with ChatGPT first.")),
    TranslatorInfo("hunyuan", "Hunyuan", "ollama", lambda: hunyuan_status(),
                   model_setting="OLLAMA_HUNYUAN_MODEL", catalog_id="hunyuan"),
    TranslatorInfo("gemma", "Gemma", "ollama", lambda: gemma_status(),
                   model_setting="OLLAMA_GEMMA_MODEL", catalog_id="gemma", big_model=True),
    TranslatorInfo("gemini", "Gemini", "key", lambda: gemini_available(),
                   unavailable=lambda: i18n.t("Gemini translation needs an API key. Open Settings and save "
                                              "your Gemini API key first."),
                   spends="Gemini API quota"),
    # A dub's form may still name it; the Settings screen does not offer it.
    TranslatorInfo("qwen", "Qwen", "ollama", lambda: qwen_status(),
                   model_setting="OLLAMA_QWEN_MODEL", offered=False),
)}

# The offered translators by the names the log says them in.
TRANSLATOR_NAMES = {t.name: t.label for t in TRANSLATORS.values() if t.offered}


# The two engines the desktop shell starts and a local dub may need: the name
# the runtime announces it under, and its pack.
_LOCAL_ENGINES = {"voice": ("tts", "engine"), "translation": ("ollama", "ollama-runtime")}


def _engine_words(which: str, state: str, failure: str = "") -> str:
    """The words an engine's state is told in, said when they are asked for.
    GET /api/engines hands them to the page, and dub_start's preflight
    (app/api/dub.py) refuses a dub with the same sentence. The voice engine's
    "voice engine is not running" sentences stay in English: the page answers
    that phrase by asking the shell to start the engine again (ui/src/app.mjs).
    `failure` is why it failed, when the shell could tell (app/runtime.py)."""
    if which == "voice":
        # Out of memory: closing other apps and pressing Start again (which
        # restarts the engine once) is what works (issue #187).
        if state == "failed" and failure == "memory":
            return ("The voice engine is not running: this computer ran out of memory. "
                    "Close other apps and try again, or try the Perso API.")
        return {
            "starting": i18n.t("The voice engine is still starting. Try again in a minute."),
            "failed": "The voice engine is not running because it could not start. "
                      "Quit and reopen PersoDub, then try again, or try the Perso API.",
            "stopped": "The voice engine is not running. Quit and reopen PersoDub.",
        }[state]
    return {
        "starting": i18n.t("The translation runtime is still starting. Try again in a minute."),
        "failed": i18n.t("The translation runtime is not running because it could not start. "
                         "Quit and reopen PersoDub, or choose another translator."),
        "stopped": i18n.t("The translation runtime is not running. Quit and reopen PersoDub."),
    }[state]


def local_engine(which: str) -> dict:
    """{"state", "message"} for "voice" or "translation".

    state: "running" (it announced itself), "starting", "failed" (the shell
    gave up on it at start), "stopped" (installed, but nothing is running
    and nothing is on its way), or "not_installed" (its pack is not on this
    kit). message is one plain sentence, "" for running and not_installed.
    No network call: GET /api/engines runs on every page load."""
    name, pack = _LOCAL_ENGINES[which]
    if runtime.url(name):
        return {"state": "running", "message": ""}
    # Before the pack check: right after an install the pack still reads as
    # downloading while the shell is already starting its process.
    state = runtime.state(name)
    if state:
        return {"state": state, "message": _engine_words(which, state, runtime.failure(name))}
    entry = model_store.find(pack)
    kit = model_store.kit_dir()
    if not (kit and entry and model_store.model_state(entry, kit) == "ready"):
        return {"state": "not_installed", "message": ""}
    return {"state": "stopped", "message": _engine_words(which, "stopped")}
