"""Engine capability discovery -- can this machine actually run engine X right now?

Pure checks that GET /api/engines and dub_start's preflight (app/main.py) use to
stop offering/starting translation and transcription engines that don't actually
work on this machine: gemma/qwen need a local Ollama server with the model
pulled, gemini/perso need an API key configured. Everything here reads
config/env live (not cached at import time) so tests can monkeypatch, and the
Ollama check is exception-safe -- a down/slow Ollama must never crash the
caller, so any network problem resolves to False rather than raising.
"""
import os

import requests

from app import config


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
    return ollama_model_available(config.OLLAMA_URL, config.OLLAMA_GEMMA_MODEL)


def qwen_available() -> bool:
    return ollama_model_available(config.OLLAMA_URL, config.OLLAMA_QWEN_MODEL)


def gemma_status() -> str:
    """"unreachable" | "model_missing" | "available" -- see ollama_model_status.
    Used by dub_start's preflight (app/main.py) to give an accurate 422."""
    return ollama_model_status(config.OLLAMA_URL, config.OLLAMA_GEMMA_MODEL)


def qwen_status() -> str:
    """"unreachable" | "model_missing" | "available" -- see ollama_model_status.
    Used by dub_start's preflight (app/main.py) to give an accurate 422."""
    return ollama_model_status(config.OLLAMA_URL, config.OLLAMA_QWEN_MODEL)


def gemini_available() -> bool:
    return bool(config.GEMINI_API_KEY)


def perso_available() -> bool:
    # The key alone: PersoClient resolves the workspace id from the key at dub
    # time (GET /portal/api/v1/spaces, as the official plugin does), and the
    # media host has a public default. Requiring PERSO_SPACE_SEQ here kept
    # Perso greyed out for everyone who only saved a key in Settings. No
    # network call in this check -- /api/engines runs on every page load.
    return bool(os.environ.get("PERSO_API_KEY"))
