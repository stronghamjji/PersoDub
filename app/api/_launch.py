"""The start every job router shares: the free-space floor, a folder named
after the project and the day, the missing-model 409, the Perso workspace a
job pays from, and launch_job to make the record and set the work going.

A dub (app/api/dub.py), a subtitle erase (app/api/erase.py) and a separation
(app/api/separate.py) all start this way. These lived in app/api/dub.py, and
the other two routers reached into it for them; here they are one module the
three import, and app/api/dub.py keeps what is the dub's own.

missing_models and today are read off this module where they are called, not
imported by name, because this is where the tests replace them: a patched
attribute of the one module object reaches every router that asks it.
"""
import os
import uuid
from datetime import date
from typing import Optional

from fastapi import HTTPException

from app import models as model_store
from app import room, state
from app.i18n import t
from app.jobs import JobKind, kind_of
from app.perso_client import list_dubbing_spaces
from app.settings_env import current_value
from app.text.naming import next_free, safe_name

# ---------------------------------------------------------------------------
# Room on disk
# ---------------------------------------------------------------------------

# What a job needs, and the 3 GB floor below, are app/room.py's: the pipeline
# asks the same question again before each stage.


def free_bytes(path: str) -> Optional[int]:
    """Free space on the disk holding path, or None when the disk will not say.

    A name on this module because a test fakes a nearly full disk through it.
    The measurement itself is app/models.py's, the one the model downloader's
    own preflight uses -- there is no reason for two answers to one question.
    """
    return model_store.free_bytes_at(path)


def check_space(path: str) -> None:
    """Refuse to start when there is not enough room, and say what to do.

    Failing here beats failing three stages in: a dub that runs out of disk
    halfway leaves a half-written folder and no dub. A disk that will not
    answer is not a reason to refuse, though -- the same rule the download
    preflight follows.
    """
    free = free_bytes(path)
    if free is None or free >= room.FLOOR:
        return
    raise HTTPException(status_code=507, detail=room.space_message(room.FLOOR, free, shown=True))


# ---------------------------------------------------------------------------
# Naming a job's folder
# ---------------------------------------------------------------------------

def today():
    # type: () -> str
    """Today as YYYY-MM-DD. Split out so tests can pin the date."""
    return date.today().isoformat()


def job_dir(title, lang_code):
    # type: (str, str) -> str
    """Create and return this job's workspace folder.

    Named <date>/<title>_<lang> so the folder says what it holds -- the old
    random hex said nothing. The language is part of the name because each
    language is a separate job with its own video, script and voice pieces;
    sharing one folder would overwrite them.

    Falls back to the old random name whenever a usable title cannot be built
    (unusable characters, empty title, or 999 runs of the same name today).
    """
    day = os.path.join(state.WORKSPACE, today())
    os.makedirs(day, exist_ok=True)

    base = safe_name(title)
    # The language half is caller-supplied too, and went in unchecked while the
    # title half was sanitized -- so "../.." in it walked the job out of the
    # workspace and wrote input.mp4 over whatever lived there. dub_start
    # rejects a malformed code outright; this keeps every other caller safe.
    lang = safe_name(lang_code) or "out"
    name = next_free("%s_%s" % (base, lang), os.listdir(day)) if base else None
    if name is None:
        name = uuid.uuid4().hex[:8]

    work = os.path.join(day, name)
    os.makedirs(work, exist_ok=True)
    return work


# ---------------------------------------------------------------------------
# The models a job still needs, and the Perso workspace that pays
# ---------------------------------------------------------------------------

def engine_hint(separation_local: bool, stt_local: bool) -> str:
    """What the AI engine will do for THIS dub. The catalog's line named all
    three jobs, and a user who had moved separation and transcription to Perso
    asked what it was for (Mac tester, 2026-09-28): it is still the voice."""
    if separation_local and stt_local:
        return t("Separates the sound, transcribes and makes the voices on this computer.")
    if separation_local:
        return t("Separates the sound and makes the voices on this computer.")
    if stt_local:
        return t("Transcribes and makes the voices on this computer.")
    return t("Makes the voices on this computer.")


def missing_models(need_whisper: bool, translate_missing_id, need_tts: bool = True, *,
                   need_engine: bool = False, need_ollama: bool = False,
                   separation_local: bool = True, need_roformer: bool = False):
    """Catalog entries this job still needs: the packs first (the desktop app
    installs those, kind "pack"), then the models in catalog order (kind
    "model", downloaded by this process).

    Pure lookups (disk markers via the catalog; the caller already resolved
    the Ollama-side statuses) so tests can drive it without a network. The
    409 built from it is what the screen's "Download N GB to dub?" dialog
    renders.
    """
    kit = model_store.kit_dir()
    wanted_packs = []
    if kit and need_engine:       # no kit, no packs (see app/api/dub.py _pack_ready)
        wanted_packs.append("engine")
    if kit and need_ollama:
        wanted_packs.append("ollama-runtime")
    wanted = []
    if need_whisper:
        wanted.append("whisper")
    if need_tts:
        wanted.append("qwen3-tts")
    if need_roformer:
        wanted.append("vocal-separator")
    packs, models = [], []
    for m in model_store.load_catalog():
        if m["role"] == "pack":
            if m["id"] in wanted_packs and model_store.model_state(m, kit) != "ready":
                hint = (engine_hint(separation_local, need_whisper) if m["id"] == "engine"
                        else model_store.shown_words(m.get("hint", "")))
                packs.append({"id": m["id"], "kind": "pack", "name": model_store.shown_words(m["name"]),
                              "bytes": model_store._pack_bytes(m), "hint": hint})
            continue
        if m["id"] in wanted and model_store.model_state(m, kit) != "ready":
            models.append({"id": m["id"], "kind": "model", "name": model_store.shown_words(m["name"]),
                           "bytes": m["bytes"], "hint": model_store.shown_words(m.get("hint", ""))})
        if translate_missing_id and m["id"] == translate_missing_id:
            models.append({"id": m["id"], "kind": "model", "name": model_store.shown_words(m["name"]),
                           "bytes": m["bytes"], "hint": model_store.shown_words(m.get("hint", ""))})
    return packs + models


def raise_models_needed(missing):
    free = model_store.free_bytes_at(model_store.kit_dir())
    raise HTTPException(409, {
        "missing": missing,
        "total_bytes": sum(m["bytes"] for m in missing),
        "free_bytes": int(free or 0),
    })


def require_perso_workspace() -> None:
    """A job that goes through Perso knows which workspace pays, or 422.

    No workspace pinned: a single-workspace account resolves silently in the
    pipeline, but several would fail AFTER minutes of work. Caught here,
    before the upload is accepted.
    """
    if current_value("PERSO_SPACE_SEQ"):
        return
    key = current_value("PERSO_API_KEY")
    try:
        spaces = list_dubbing_spaces(key)
    except Exception:
        return  # can't tell right now -- let the pipeline decide
    if len(spaces) != 1:
        raise HTTPException(
            422,
            # The second stays in English: the page asks for a workspace when
            # it reads these words (ui/src/app.mjs submitDubStart).
            t("This Perso key has no dubbing workspace.") if not spaces else
            "Select a Perso workspace in Settings.",
        )


# ---------------------------------------------------------------------------
# The tail of every start
# ---------------------------------------------------------------------------

def launch_job(work, fields, log_line, target, parallel=False):
    """Register a new job and set it running. Returns the new job's id.

    The tail of the start ritual, the same one for every job started here (a
    new dub, a redub, a "Try again", an erase and a separation): make the record, stamp `fields` on it, write job.json into
    the job's folder, log the first line, and hand the work to the store.

    The file is written now, not just at the end: a job the user quits the app
    in the middle of still has a folder, and without a file in it that folder
    is nameless -- Projects would have nothing to show for it.

    `target` is called as target(jid, log). The id only exists once the record
    is made here, and the work needs it for its cancel_check and on_notice.
    """
    jid = state.job_store.create()
    state.job_store.update(jid, **fields)
    state.job_store.persist(jid, work)
    state.job_store.append_log(jid, log_line)
    state.job_store.start(jid, lambda log: target(jid, log), parallel=parallel)
    return jid


def goes_beside_the_line(job: dict) -> bool:
    """Work Perso does wholly on its side starts at once, beside whatever is
    on air here: a cloud dubbing, or a separation sent to Perso."""
    return (job.get("dub_mode") == "perso"
            or (kind_of(job) == JobKind.SEPARATE and job.get("separation") == "perso"))
