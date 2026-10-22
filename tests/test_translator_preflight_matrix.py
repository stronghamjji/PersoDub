"""Every answer app/api/dub.py's _translator_preflight gives, translator by state.

The preflight runs before a dub starts (or resumes, or translates again) and
either says no with a 422 and a sentence for the screen, or hands back
(need_ollama, the catalog id of a local model still to download) for the 409
download dialog. This file is the whole table as it stands, so a refactor that
moves a branch shows here as one changed row.

The world is set the way the neighbouring suites set it
(tests/test_dub_start_preflight.py, tests/test_engines_api.py): the engines_status
probes replaced, and a kit folder laid down on disk -- or none, the way a
developer runs the backend on its own.
"""
import json
import os
import sys
from typing import NamedTuple, Optional

import pytest
from fastapi import HTTPException

from app import engines_status
from app.api import dub as dub_api


class Returns(NamedTuple):
    need_ollama: bool
    missing_model: Optional[str]


class Refused(NamedTuple):
    status_code: int
    detail: str


# ── the world ───────────────────────────────────────────────────────────────

OLLAMA_BINARY = ("ollama", "ollama.exe" if sys.platform.startswith("win") else "ollama")
MODEL_ON_DISK = {   # the catalog's markers (app/models_catalog.json), under the kit
    "gemma": ("models", "ollama", "manifests", "registry.ollama.ai", "library", "gemma3", "12b"),
    "hunyuan": ("models", "ollama", "manifests", "registry.ollama.ai", "library", "hy-mt2", "1.8b"),
}


def _touch(root, *parts):
    path = os.path.join(root, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"x")


def _make_world(monkeypatch, tmp_path, kit=None, status="available", runtime=None, on_disk=False,
                signed_in=True, gemini_key=True):
    """kit: None (no kit: a backend run on its own), "pack" (a desktop kit with
    the Ollama runtime pack) or "no pack" (a kit still without it).
    status: what Ollama says about every local model. runtime: what the
    desktop shell last wrote about the Ollama process ("failed", "starting")."""
    for probe in ("gemma_status", "hunyuan_status", "qwen_status"):
        monkeypatch.setattr(engines_status, probe, lambda: status)
    monkeypatch.setattr(engines_status, "chatgpt_available", lambda: signed_in)
    monkeypatch.setattr(engines_status, "gemini_available", lambda: gemini_key)
    if kit is None:
        monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
        return
    root = str(tmp_path / "kit")
    os.makedirs(root)
    monkeypatch.setenv("PERSODUB_KIT_DIR", root)
    if kit == "pack":
        _touch(root, *OLLAMA_BINARY)
    if on_disk:
        for parts in MODEL_ON_DISK.values():
            _touch(root, *parts)
    if runtime:
        with open(os.path.join(root, "runtime.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "ollama_state": runtime}, f)


DEV = {}                                   # no kit: the developer's own Ollama, if any
KIT = {"kit": "pack"}
KIT_NO_PACK = {"kit": "no pack"}
NOTHING_WORKS = dict(KIT_NO_PACK, status="unreachable", signed_in=False, gemini_key=False)


# ── the sentences ───────────────────────────────────────────────────────────

CHATGPT_SIGN_IN = ("ChatGPT translation needs a ChatGPT sign-in. Open Settings and press Sign in "
                   "with ChatGPT first.")
GEMINI_KEY = "Gemini translation needs an API key. Open Settings and save your Gemini API key first."
# The desktop shell's own words for the Ollama process (app/engines_status.py).
RUNTIME_FAILED = ("The translation runtime is not running because it could not start. "
                  "Quit and reopen PersoDub, or choose another translator.")
RUNTIME_STARTING = "The translation runtime is still starting. Try again in a minute."


def _ollama_unreachable(engine):
    """No kit: the developer is told to start Ollama."""
    return (f"Local {engine} translation is not available on this machine (Ollama is not running or "
            "not reachable). Choose Gemini in the Translation dropdown, or make sure Ollama is running.")


def _runtime_not_running(engine):
    """In a kit, with nothing better from the shell: the app owns the runtime."""
    return (f"Local {engine} translation is not available right now: the translation runtime is not "
            "running. Quit and reopen PersoDub, or choose Gemini in the Translation dropdown.")


def _not_pulled(engine):
    return f"The {engine} translation model is not downloaded yet. Choose another translator."


# ── the table ───────────────────────────────────────────────────────────────

def _local_model_rows(t, engine):
    """gemma and hunyuan: two local models with one runtime and the same rules.
    A model Ollama lacks is a download (409), not a refusal."""
    return [
        pytest.param(t, DEV, False, Returns(True, None), id=f"{t}-no-kit-ready"),
        pytest.param(t, dict(DEV, status="model_missing"), False, Returns(True, t),
                     id=f"{t}-no-kit-model-not-pulled"),
        pytest.param(t, dict(DEV, status="unreachable"), False, Refused(422, _ollama_unreachable(engine)),
                     id=f"{t}-no-kit-ollama-unreachable"),
        pytest.param(t, KIT, False, Returns(True, None), id=f"{t}-kit-ready"),
        pytest.param(t, dict(KIT, status="model_missing"), False, Returns(True, t), id=f"{t}-kit-model-missing"),
        pytest.param(t, dict(KIT, status="unreachable"), False, Refused(422, _runtime_not_running(engine)),
                     id=f"{t}-kit-runtime-not-running"),
        pytest.param(t, dict(KIT, status="unreachable", runtime="failed"), False, Refused(422, RUNTIME_FAILED),
                     id=f"{t}-kit-runtime-failed-to-start"),
        pytest.param(t, dict(KIT, status="unreachable", runtime="starting"), False,
                     Refused(422, RUNTIME_STARTING), id=f"{t}-kit-runtime-still-starting"),
        # No runtime pack: Ollama is never asked (its "unreachable" here would
        # be a 422), the model's own files on disk decide.
        pytest.param(t, dict(KIT_NO_PACK, status="unreachable", on_disk=True), False, Returns(True, None),
                     id=f"{t}-pack-not-installed-model-on-disk"),
        pytest.param(t, dict(KIT_NO_PACK, status="unreachable"), False, Returns(True, t),
                     id=f"{t}-pack-not-installed-model-not-on-disk"),
    ]


QWEN_NOT_PULLED = Refused(422, _not_pulled("Qwen"))

CASES = [
    # ChatGPT: the sign-in, unless a ready-made script means nothing is translated.
    pytest.param("chatgpt", DEV, False, Returns(False, None), id="chatgpt-signed-in"),
    pytest.param("chatgpt", dict(DEV, signed_in=False), False, Refused(422, CHATGPT_SIGN_IN),
                 id="chatgpt-not-signed-in"),
    pytest.param("chatgpt", dict(DEV, signed_in=False), True, Returns(False, None),
                 id="chatgpt-not-signed-in-but-a-script-is-given"),
    # Gemini: the key, unless a ready-made script means nothing is translated.
    pytest.param("gemini", DEV, False, Returns(False, None), id="gemini-key-saved"),
    pytest.param("gemini", dict(DEV, gemini_key=False), False, Refused(422, GEMINI_KEY), id="gemini-no-key"),
    pytest.param("gemini", dict(DEV, gemini_key=False), True, Returns(False, None),
                 id="gemini-no-key-but-a-script-is-given"),
    *_local_model_rows("gemma", "Gemma"),
    *_local_model_rows("hunyuan", "Hunyuan"),
    # Qwen: no download dialog and no runtime pack -- every status but
    # "available" is a 422, with or without the pack.
    pytest.param("qwen", DEV, False, Returns(False, None), id="qwen-no-kit-ready"),
    pytest.param("qwen", dict(DEV, status="model_missing"), False, QWEN_NOT_PULLED, id="qwen-no-kit-model-not-pulled"),
    pytest.param("qwen", dict(DEV, status="unreachable"), False, Refused(422, _ollama_unreachable("Qwen")),
                 id="qwen-no-kit-ollama-unreachable"),
    pytest.param("qwen", dict(KIT, status="model_missing"), False, QWEN_NOT_PULLED, id="qwen-kit-model-missing"),
    pytest.param("qwen", dict(KIT, status="unreachable"), False, Refused(422, _runtime_not_running("Qwen")),
                 id="qwen-kit-runtime-not-running"),
    pytest.param("qwen", dict(KIT, status="unreachable", runtime="failed"), False, Refused(422, RUNTIME_FAILED),
                 id="qwen-kit-runtime-failed-to-start"),
    pytest.param("qwen", KIT_NO_PACK, False, Returns(False, None), id="qwen-pack-not-installed-still-asks-ollama"),
    pytest.param("qwen", dict(KIT_NO_PACK, status="unreachable"), False,
                 Refused(422, _runtime_not_running("Qwen")), id="qwen-pack-not-installed-unreachable"),
    # A ready-made script: nothing is translated, so a local model is neither
    # asked about nor downloaded, whatever state it is in.
    pytest.param("gemma", dict(KIT, status="model_missing"), True, Returns(False, None),
                 id="gemma-kit-model-missing-but-a-script-is-given"),
    pytest.param("hunyuan", dict(KIT, status="unreachable"), True, Returns(False, None),
                 id="hunyuan-kit-runtime-not-running-but-a-script-is-given"),
    pytest.param("hunyuan", dict(KIT_NO_PACK, status="unreachable"), True, Returns(False, None),
                 id="hunyuan-pack-not-installed-but-a-script-is-given"),
    pytest.param("qwen", dict(DEV, status="model_missing"), True, Returns(False, None),
                 id="qwen-not-pulled-but-a-script-is-given"),
    # Names with no checks at all: nothing is refused and nothing is needed,
    # in a world where every check above would say no.
    pytest.param("vertex", NOTHING_WORKS, False, Returns(False, None), id="vertex-even-when-nothing-works"),
    pytest.param("deepl", NOTHING_WORKS, False, Returns(False, None), id="unknown-name-even-when-nothing-works"),
    pytest.param("", NOTHING_WORKS, False, Returns(False, None), id="no-name-a-perso-dub"),
]


@pytest.mark.parametrize("translator,world,has_script,expected", CASES)
def test_translator_preflight(monkeypatch, tmp_path, translator, world, has_script, expected):
    _make_world(monkeypatch, tmp_path, **world)
    try:
        got = Returns(*dub_api._translator_preflight(translator, has_script=has_script))
    except HTTPException as e:
        got = Refused(e.status_code, e.detail)
    assert got == expected
