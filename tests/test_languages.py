"""The per-path language lists (app/languages.py)."""
import json
import os
import time

from app import languages, state


def test_local_is_the_models_ten_in_product_order():
    ids = [e["id"] for e in languages.local_languages()]
    assert ids[:2] == ["en", "ko"] and len(ids) == 10
    assert all(e["tag"] is None for e in languages.local_languages())


def test_bundled_perso_list_is_perso_v3_minus_auto_with_region_tags(monkeypatch):
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    langs = languages.perso_languages()
    ids = {e["id"] for e in langs}
    assert "auto" not in ids
    assert {"hi", "th", "ar", "en", "en-GB", "es-ES", "pt-PT"} <= ids
    assert len(langs) >= 70
    gb = next(e for e in langs if e["id"] == "en-GB")
    assert gb == {"id": "en-GB", "code": "en", "name": "English (UK)", "tag": "en-GB"}


def test_perso_list_is_fetched_once_a_day_then_kept(monkeypatch, tmp_path):
    monkeypatch.setattr(state, "WORKSPACE", str(tmp_path))
    calls = []
    fresh = [{"id": "zz", "code": "zz", "name": "Zed", "tag": None}]
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
