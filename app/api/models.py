"""What the app is set up with: the per-stage defaults (GET/POST /api/setup)
and the optional-model catalog with its downloads (/api/models).

One module for both because they are one screen: the setup report already
carries the model rows, and a model finishing its download is what makes a new
stage default possible. Lifted out of app/main.py unchanged (2026-09-06).

model_store and dub_setup are imported as modules, not as loose functions, on
purpose: the tests fake them by setting attributes ON those module objects
(main.model_store.status_rows, main.dub_setup.default_for), which every
importer sees because there is only ever one module object.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import models
from app import models as model_store
from app import setup as dub_setup
from app.settings_env import current_value

router = APIRouter()


@router.get("/api/setup")
def setup_get():
    """One picture of the dub setup for the screen and the Dub Agent: the
    choice in force for every stage, every optional model's download state,
    and which cloud keys are saved. Defaults come from kit.env at call time.

    The keys are read with current_value (kit.env first, process env second) --
    the very same source the stage defaults use. read_key_status sees kit.env
    alone, so on a server deployment (key in the env, no kit) this report said
    stt: "perso" beside keys.perso: false and read as a contradiction."""
    return {
        "defaults": dub_setup.defaults(),
        "choices": {stage: list(spec[1]) for stage, spec in dub_setup.STAGES.items()},
        "models": model_store.status_rows(),
        "keys": {"perso": bool(current_value("PERSO_API_KEY")),
                 "gemini": bool(current_value("GEMINI_API_KEY"))},
    }


class SetupRequest(BaseModel):
    dub_mode: Optional[str] = None
    separation: Optional[str] = None
    stt: Optional[str] = None
    translator: Optional[str] = None
    voice_quality: Optional[str] = None


@router.post("/api/setup")
def setup_post(body: SetupRequest):
    """Save new per-stage defaults into kit.env. Fields left out stay as they
    are. In force for the next dub without a restart."""
    try:
        new = dub_setup.set_defaults(body.model_dump())
    except FileNotFoundError:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"defaults": new}


@router.get("/api/models")
def models_list():
    """The model catalog with each model's download state -- what the
    Settings catalog, the advanced-options status lines and the dub-start
    warning dialog all render from. Always-installed models stay out: the
    install itself guarantees them and there is nothing to manage.

    platform is the key the sizes were picked by ("mac", "win-gpu",
    "win-cpu") -- the erase screen reads it to warn a machine with no GPU
    that the work will take about five times as long (2026-09-10)."""
    return {"models": model_store.status_rows(), "platform": models.platform_key()}


def _model_or_404(mid: str):
    entry = model_store.find(mid)
    if entry is None or entry["role"] == "always":
        raise HTTPException(404, f"Unknown model: {mid}")
    return entry


@router.post("/api/models/{mid}/download")
def model_download(mid: str):
    entry = _model_or_404(mid)
    if entry["role"] == "pack":
        # The desktop shell installs packs (its install-pack IPC); this
        # process has neither the installer nor the right to run it.
        raise HTTPException(409, model_store.PACKS_ARE_THE_SHELLS)
    free = model_store.free_bytes_at(model_store.kit_dir())
    if free is not None and free < entry["bytes"] * 1.1:
        raise HTTPException(409, "Not enough space: needs %.1f GB, %.1f GB free"
                                 % (entry["bytes"] / 1024**3, free / 1024**3))
    try:
        started = model_store.request_download(entry)
    except ValueError as e:
        raise HTTPException(409, str(e))
    # 202 for a fresh start, 200 when it was already running -- a double-click
    # must never error or start a second download.
    return JSONResponse({"state": "downloading"}, status_code=202 if started == "started" else 200)


@router.post("/api/models/{mid}/cancel")
def model_cancel(mid: str):
    _model_or_404(mid)
    model_store.cancel_download(mid)
    # The pieces stay on disk -- the next GET shows "paused" with Resume.
    return {"state": "cancelling"}


@router.delete("/api/models/{mid}")
def model_remove(mid: str):
    entry = _model_or_404(mid)
    # The dub check first, packs included: the page asks this route before it
    # hands a pack's removal to the desktop app, so a pack cannot be pulled
    # out from under a running dub any more than a model can.
    if model_store.dub_in_progress():
        raise HTTPException(409, "A dub is running right now. Wait for it to finish, then remove the model.")
    if entry["role"] == "pack":
        raise HTTPException(409, model_store.PACKS_ARE_THE_SHELLS)
    model_store.cancel_download(mid)
    try:
        model_store.remove_model(entry)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"removed": mid}
