"""The languages a dub can be made in, per path.

Local dubbing knows the ten Qwen3-TTS speaks (config.LANGUAGE_NAMES). Perso's
cloud dubbing knows what Perso says it knows: 77 entries on 2026-09-08,
three of them regional variants told apart by a tag (en-GB, es-ES, pt-PT).
The screen sends one id per language -- the tag when there is one, else the
code -- and this module turns it back into what each path needs.

The Perso list is asked of the API once a day and kept beside the workspace;
when the API cannot be reached (no key, offline) the last answer is used,
and before any answer the copy shipped with the app (app/perso_languages.json,
taken from the same endpoint).
"""
import json
import os
import re
import time
from typing import Optional

from app import config

BUNDLED = os.path.join(os.path.dirname(__file__), "perso_languages.json")
CACHE_NAME = "perso_languages.json"
MAX_AGE = 24 * 3600
_CODE = re.compile(r"^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})?$")


def local_languages() -> list:
    """[{id, code, name, tag}] for the local path: the model's ten, in the
    product's order (English, Korean, then the rest as configured)."""
    return [{"id": c, "code": c, "name": n, "tag": None} for c, n in config.LANGUAGE_NAMES.items()]


def _with_ids(entries) -> list:
    return [{"id": (e.get("tag") or e["code"]), "code": e["code"], "name": e["name"], "tag": e.get("tag")}
            for e in entries if e.get("code") and e.get("name")]


def _cache_path() -> str:
    from app import state
    return os.path.join(state.WORKSPACE, CACHE_NAME)


def _read(path: str) -> Optional[list]:
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        langs = d.get("languages") if isinstance(d, dict) else d
        return _with_ids(langs) if isinstance(langs, list) and langs else None
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def _fetch() -> Optional[list]:
    """Perso's own list, only the AUDIO_ENGINE_V3 entries (the engine the app
    dubs with), without the "auto" pseudo-language. None when it cannot be had."""
    try:
        from app import perso_client
        from app.settings_env import current_value
        key = current_value("PERSO_API_KEY")
        if not key:
            return None
        import httpx
        r = httpx.get(perso_client.BASE_URL + "/video-translator/api/v1/languages",
                      headers=perso_client._key_headers(key), timeout=10)
        r.raise_for_status()
        raw = r.json().get("languages") or []
        langs = [{"code": x["code"], "name": x["name"],
                  "tag": None if x.get("languageTag") in (None, "", "default") else x["languageTag"]}
                 for x in raw if x.get("code") != "auto" and "AUDIO_ENGINE_V3" in (x.get("supportedTtsModels") or [])]
        return _with_ids(langs) or None
    except Exception:
        return None


def perso_languages(refresh: bool = True) -> list:
    """[{id, code, name, tag}] for Perso dubbing. Fresh from the API when the
    kept copy is older than a day (or missing) and the API answers; otherwise
    the kept copy; otherwise the bundled one."""
    path = _cache_path()
    fresh = os.path.exists(path) and (time.time() - os.path.getmtime(path)) < MAX_AGE
    if refresh and not fresh:
        langs = _fetch()
        if langs:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump({"fetched": time.strftime("%Y-%m-%d"), "languages": langs}, f, ensure_ascii=False)
            except OSError:
                pass
            return langs
    return _read(path) or _read(BUNDLED) or []


def languages_for(dub_mode: str) -> list:
    return perso_languages() if dub_mode == "perso" else local_languages()


def lookup(dub_mode: str, lang_id: str) -> Optional[dict]:
    """The entry an id names on this path, or None. Local ids may carry a
    region the model ignores ("pt-BR" is still Portuguese)."""
    lang_id = (lang_id or "").strip()
    if not _CODE.match(lang_id):
        return None
    if dub_mode == "perso":
        low = lang_id.lower()
        for e in perso_languages():
            if e["id"].lower() == low:
                return e
        return None
    base = re.split(r"[-_]", lang_id)[0].lower()
    for e in local_languages():
        if e["code"] == base:
            return {**e, "id": lang_id}
    return None
