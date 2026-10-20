"""The per-path language lists (app/languages.py)."""
import json
import os
import time

import pytest

from app import languages, state


def test_local_is_the_models_ten_in_product_order():
    ids = [e["id"] for e in languages.local_languages()]
    assert ids[:2] == ["en", "ko"] and len(ids) == 10
    assert all(e["tag"] is None for e in languages.local_languages())


def test_bundled_perso_list_is_persos_offered_models_minus_auto_with_region_tags(monkeypatch):
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    langs = languages.perso_languages()
    ids = {e["id"] for e in langs}
    assert "auto" not in ids
    assert {"hi", "th", "ar", "en", "en-GB", "es-ES", "pt-PT"} <= ids
    assert len(langs) >= 100
    gb = next(e for e in langs if e["id"] == "en-GB")
    assert gb == {"id": "en-GB", "code": "en", "name": "English (UK)", "tag": "en-GB",
                  "models": ["ORIOLE", "NIGHTINGALE"]}
    # Every entry names the models it has, the known ones in the screen's order
    # (the list as Perso answered on 2026-10-19).
    assert all(e["models"] and all(languages.TTS_MODEL_RE.match(m) for m in e["models"]) for e in langs)
    assert next(e for e in langs if e["id"] == "ko")["models"] == [
        "ORIOLE", "LINNET_4", "LINNET_3", "WREN", "FINCH", "NIGHTINGALE"]
    assert next(e for e in langs if e["id"] == "en-AU")["models"] == ["NIGHTINGALE"]


def test_perso_list_is_fetched_once_a_day_then_kept(monkeypatch, tmp_path):
    monkeypatch.setattr(state, "WORKSPACE", str(tmp_path))
    calls = []
    fresh = [{"id": "zz", "code": "zz", "name": "Zed", "tag": None, "models": ["ORIOLE"]}]
    monkeypatch.setattr(languages, "_fetch", lambda: (calls.append(1), fresh)[1])
    assert languages.perso_languages() == fresh
    assert languages.perso_languages() == fresh            # kept copy, no second call
    assert len(calls) == 1
    kept = json.load(open(os.path.join(str(tmp_path), languages.CACHE_NAME), encoding="utf-8"))
    assert kept["languages"][0]["code"] == "zz"
    # A day later the API is asked again; if it fails the kept copy stands.
    os.utime(os.path.join(str(tmp_path), languages.CACHE_NAME), (time.time() - 2 * languages.MAX_AGE,) * 2)
    monkeypatch.setattr(languages, "_fetch", lambda: (calls.append(1), None)[1])
    assert languages.perso_languages() == fresh
    assert len(calls) == 2


def test_lookup_knows_each_path_apart(monkeypatch):
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    assert languages.lookup("local", "ko")["name"] == "Korean"
    assert languages.lookup("local", "pt-BR")["code"] == "pt"     # region ignored locally
    assert languages.lookup("local", "hi") is None                  # the model cannot speak it
    assert languages.lookup("perso", "hi")["name"] == "Hindi"
    assert languages.lookup("perso", "EN-gb")["tag"] == "en-GB"     # case-insensitive
    assert languages.lookup("perso", "xx") is None
    assert languages.lookup("perso", "../etc") is None


class _Answer:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def test_fetch_keeps_each_language_with_a_model_and_says_which(monkeypatch):
    # Perso's list as it answered on 2026-10-02: AUDIO_ENGINE_V3 is gone from
    # it, and filtering on that name kept no language at all. Since 2026-10-19
    # every model Perso names is offered, a name the app has never seen too.
    import httpx

    from app import settings_env
    raw = [
        {"code": "auto", "name": "Auto Detect", "languageTag": "default", "supportedTtsModels": []},
        {"code": "ko", "name": "Korean", "languageTag": "default",
         "supportedTtsModels": ["ORIOLE", "DODO", "NIGHTINGALE", "WREN"]},
        {"code": "en", "name": "English (Australia)", "languageTag": "en-AU",
         "supportedTtsModels": ["NIGHTINGALE"]},
        {"code": "xx", "name": "Dodo only", "languageTag": "default", "supportedTtsModels": ["DODO"]},
    ]
    monkeypatch.setattr(settings_env, "current_value", lambda k: "dummy-key")
    monkeypatch.setattr(httpx, "get", lambda url, headers=None, timeout=None: _Answer({"languages": raw}))
    assert languages._fetch() == [
        {"id": "ko", "code": "ko", "name": "Korean", "tag": None,
         "models": ["ORIOLE", "WREN", "NIGHTINGALE", "DODO"]},
        {"id": "en-AU", "code": "en", "name": "English (Australia)", "tag": "en-AU",
         "models": ["NIGHTINGALE"]},
        {"id": "xx", "code": "xx", "name": "Dodo only", "tag": None, "models": ["DODO"]},
    ]


def test_a_kept_list_from_before_models_were_kept_still_loads_as_oriole(monkeypatch, tmp_path):
    monkeypatch.setattr(state, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    with open(os.path.join(str(tmp_path), languages.CACHE_NAME), "w", encoding="utf-8") as f:
        json.dump({"fetched": "2026-09-08",
                   "languages": [{"id": "hi", "code": "hi", "name": "Hindi", "tag": None}]}, f)
    assert languages.perso_languages() == [
        {"id": "hi", "code": "hi", "name": "Hindi", "tag": None, "models": ["ORIOLE"]}]


def test_model_for_takes_the_one_asked_for_or_oriole_or_the_first_the_language_has():
    ko = {"name": "Korean", "models": ["NIGHTINGALE", "ORIOLE", "WREN"]}
    au = {"name": "English (Australia)", "models": ["NIGHTINGALE"]}
    assert languages.model_for(ko) == "ORIOLE"
    assert languages.model_for(au) == "NIGHTINGALE"
    assert languages.model_for(ko, "wren") == "WREN"             # case-insensitive
    assert languages.model_for({"name": "Old", "code": "zz"}) == "ORIOLE"   # no models kept
    with pytest.raises(ValueError, match="Wren.*English \\(Australia\\)") as refused:
        languages.model_for(au, "WREN")
    # No ": " before the list: the failed-job line cuts a sentence there.
    assert str(refused.value).endswith("This language can be dubbed with Nightingale.")
    assert ": " not in str(refused.value)
    with pytest.raises(ValueError, match="Linnet 4"):
        languages.model_for(ko, "LINNET_4")                       # not this language's
    assert languages.model_for({"name": "Korean", "models": ["ORIOLE", "LINNET_4"]}, "linnet_4") == "LINNET_4"
