"""The small routes that belong to no one screen: the TTS engine list and the
one-line speak, what this machine's engines can actually do, the release notes,
a link's title before anything is downloaded, and a bare translate call.

One module rather than five: each is a single route with no helper of its own
and no state shared with its neighbours, so a file apiece would be five
docstrings guarding one function each. They are together because none of them
is big enough to be alone -- not because they are related.

Lifted out of app/main.py unchanged (2026-09-06), with the TTS engine
registration that /api/tts/* needs. It reads nothing back off main.

engines_status is imported as a module, not as its five loose functions, on
purpose: dub_start (app/api/dub.py) and the result routes judge the same
answers, and the tests fake them by setting attributes ON that module object,
which every importer sees because there is only ever one module object.
"""
import json
import logging
import os
from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import engines_status, languages
from app.engines.base import (
    SynthesisRequest,
    get_engine,
    list_engines,
    register_engine,
)
from app.engines.qwen_tts import QwenTTSEngine
from app.perso_client import APP_VERSION
from app.source_fetch import FetchError
from app.source_fetch import probe as probe_source
from app.translate import get_translator

logger = logging.getLogger("persodub.api.misc")

router = APIRouter()

# Register the installed TTS engine (Qwen3-TTS). Here rather than in
# app/main.py because this is the module whose routes read the registry back;
# the registry itself is app/engines/base.py's, one per process.
register_engine(QwenTTSEngine())

# Translator (selects Ollama/Gemini based on the TRANSLATE_ENGINE setting)
translator = get_translator()


# --- Speaking one line, and what can speak it -------------------------------

@router.get("/api/tts/engines")
def tts_engines():
    """List of installed TTS engines."""
    return {
        "engines": [
            {
                "id": e.id,
                "display_name": e.display_name,
                "supports_cloning": e.supports_cloning,
                "available": e.is_available(),
            }
            for e in list_engines()
        ]
    }


class SayRequest(BaseModel):
    text: str
    engine: str = "qwen3_tts"
    ref_audio: Optional[str] = None
    ref_text: Optional[str] = None
    language: Optional[str] = None
    duration: Optional[float] = None
    num_step: int = 32
    guidance_scale: float = 2.0
    speed: float = 1.0
    seed: Optional[int] = None


@router.post("/api/tts/say")
def tts_say(body: SayRequest):
    """One line of text → speech (wav). Choose which engine to use via body.engine."""
    engine = get_engine(body.engine)
    if engine is None:
        raise HTTPException(status_code=404, detail=f"Unknown engine: {body.engine}")

    req = SynthesisRequest(
        text=body.text,
        ref_audio=body.ref_audio,
        ref_text=body.ref_text,
        language=body.language,
        duration=body.duration,
        num_step=body.num_step,
        guidance_scale=body.guidance_scale,
        speed=body.speed,
        seed=body.seed,
    )
    # The three ways speaking one line is known to fail, each with its own
    # answer -- without them any of the three left the caller a bare 500 and
    # the UI nothing to say. The engine's own text is never passed on: its
    # FileNotFoundError quotes body.ref_audio, and echoing a path the caller
    # supplied back at them is how a probe learns what exists on this disk.
    # Same vocabulary as app/api/dub.py's preflight: name the stage, then say
    # what to do about it.
    try:
        result = engine.synthesize(req)
    except FileNotFoundError as e:
        raise HTTPException(404, "Sample voice file not found. Check the path and try again.") from e
    except ValueError as e:
        # The engine's own written-out sentence (e.g. Qwen's ICL clone needs a
        # transcript). It carries no caller-supplied text, so it can go through.
        raise HTTPException(422, str(e)) from e
    except httpx.HTTPError as e:
        raise HTTPException(
            503,
            "The local speech engine is not answering. Wait for the app to finish "
            "starting up, then try again.",
        ) from e
    headers = {"x-engine-id": result.engine_id}
    if result.duration is not None:
        headers["x-audio-duration"] = str(result.duration)
    if result.seed is not None:
        headers["x-seed"] = str(result.seed)
    return Response(content=result.audio_bytes, media_type="audio/wav", headers=headers)


# --- What this machine can do, and what changed in this release -------------

@router.get("/logo.png")
def logo():
    """The app's logo tile (static/logo.png), for the rail and Settings > About."""
    return FileResponse(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "static", "logo.png"),
                        media_type="image/png")


@router.get("/api/languages")
def api_languages():
    """The languages each dubbing path offers: local = the model's ten,
    perso = Perso's list (asked daily, kept locally). One id per entry is
    what the New project dropdown sends as language_code."""
    return {"local": languages.local_languages(), "perso": languages.perso_languages()}


@router.get("/api/whats-new")
def whats_new():
    """The bundled release notes + the running version. The screen shows them
    once after an update (never on a fresh install) and again on demand from
    Settings; the file ships with each release."""
    # app/whats_new.json, one folder up from this one.
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "whats_new.json")
    notes = []
    try:
        with open(path, encoding="utf-8") as f:
            notes = [str(n) for n in (json.load(f).get("notes") or [])]
    except Exception as e:
        # No notes is fine; the popup simply never shows. Worth a line all the
        # same -- the file ships with the release, so an unreadable one is a
        # packaging fault nobody would otherwise hear about.
        logger.warning("Could not read the release notes (%s)", type(e).__name__)
    return {"version": APP_VERSION, "notes": notes}


@router.get("/api/engines")
def engines_status_route():
    """Which translation/transcription engines actually work on this machine right now.

    No caching -- always live. Each check is exception-safe (a down Ollama server
    can never turn this into a 500); used by the UI to grey out unusable engines
    and by dub_start's preflight (app/api/dub.py).
    """
    return {
        "gemma_available": engines_status.gemma_available(),
        "qwen_available": engines_status.qwen_available(),
        "hunyuan_available": engines_status.hunyuan_available(),
        "gemini_available": engines_status.gemini_available(),
        "perso_available": engines_status.perso_available(),
    }


# --- A link, and a bare translate call --------------------------------------

class ProbeRequest(BaseModel):
    url: str


@router.post("/api/source/probe")
def source_probe(body: ProbeRequest):
    """Read a link's title/duration/thumbnail without downloading it.

    Answers in seconds, which is what lets the UI show a confirm card before
    committing the user to an hours-long dub.
    """
    try:
        return probe_source(body.url)
    except FetchError as e:
        raise HTTPException(422, {"reason": e.reason, "message": e.message})


class TranslateRequest(BaseModel):
    texts: List[str]
    target_lang: str
    source_lang: Optional[str] = None
    durations: Optional[List[float]] = None


@router.post("/api/translate")
def translate_api(body: TranslateRequest):
    """Translate multiple dialogue lines into the target language (Gemini)."""
    try:
        out = translator.translate(
            body.texts, body.target_lang, body.source_lang, body.durations
        )
    except Exception as e:
        # The type name, never str(e) -- the same rule the Perso key routes
        # follow (app/api/settings.py): a translation engine's error can echo
        # the request, and a cloud request carries the API key.
        logger.warning("Translation failed (%s)", type(e).__name__)
        raise HTTPException(
            status_code=500,
            detail=(f"Translation failed ({type(e).__name__}). Check the translation "
                    f"engine in Settings, or the app log for the details."),
        ) from e
    return {"translations": out}
