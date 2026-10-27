"""GET /api/whats-new: the bundled release notes the update popup shows."""
import re

from fastapi.testclient import TestClient

from app.api import misc as misc_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def test_whats_new_returns_version_and_notes():
    r = client.get("/api/whats-new")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["version"], str)
    assert isinstance(body["notes"], list) and body["notes"]
    assert all(isinstance(n, str) for n in body["notes"])


def test_whats_new_speaks_the_engines_language():
    """A Korean engine reads the Korean notes, an English one the English; both
    lists are the same length, so a release cannot forget one language's notes."""
    from app import i18n
    before = i18n.current_language()
    try:
        i18n.set_language("ko")
        ko = client.get("/api/whats-new").json()["notes"]
        i18n.set_language("en")
        en = client.get("/api/whats-new").json()["notes"]
    finally:
        i18n.set_language(before)
    assert ko and en and ko != en
    assert len(ko) == len(en)
    assert all(re.search("[가-힣]", n) for n in ko), "the Korean notes are Korean"
    assert not any(re.search("[가-힣]", n) for n in en), "the English notes are English"


def test_whats_new_survives_a_missing_file(monkeypatch, tmp_path):
    import os
    real_join = os.path.join

    def fake_join(*parts):
        p = real_join(*parts)
        return str(tmp_path / "gone.json") if p.endswith("whats_new.json") else p

    monkeypatch.setattr(misc_api.os.path, "join", fake_join)
    r = client.get("/api/whats-new")
    assert r.status_code == 200
    assert r.json()["notes"] == []


def _notes_from(monkeypatch, tmp_path, data, edition, language):
    """GET /api/whats-new's notes for a file holding `data`, in an app file of
    `edition` (PERSODUB_BUILD_EDITION, the page's edition) speaking `language`."""
    import json
    import os

    from app import i18n
    (tmp_path / "notes.json").write_text(json.dumps(data), encoding="utf-8")
    real_join = os.path.join

    def fake_join(*parts):
        p = real_join(*parts)
        return str(tmp_path / "notes.json") if p.endswith("whats_new.json") else p

    monkeypatch.setattr(misc_api.os.path, "join", fake_join)
    monkeypatch.setenv("PERSODUB_BUILD_EDITION", edition)
    before = i18n.current_language()
    try:
        i18n.set_language(language)
        return client.get("/api/whats-new").json()["notes"]
    finally:
        i18n.set_language(before)


def test_whats_new_reads_the_production_editions_own_lists_there(monkeypatch, tmp_path):
    """Where the editions' words differ, the production edition reads its own
    lists, in its language; the open-source edition the shared ones, as before.
    A file with no production lists is the same in both."""
    data = {"notes": ["Shared."], "notes_ko": ["공용."],
            "notes_production": ["Production."], "notes_production_ko": ["운영."]}
    assert _notes_from(monkeypatch, tmp_path, data, "opensource", "en") == ["Shared."]
    assert _notes_from(monkeypatch, tmp_path, data, "opensource", "ko") == ["공용."]
    assert _notes_from(monkeypatch, tmp_path, data, "production", "en") == ["Production."]
    assert _notes_from(monkeypatch, tmp_path, data, "production", "ko") == ["운영."]
    shared = {"notes": ["Shared."], "notes_ko": ["공용."]}
    assert _notes_from(monkeypatch, tmp_path, shared, "production", "ko") == ["공용."]


def test_the_production_editions_notes_never_name_the_open_source_edition():
    """Its update window said "off in the open-source edition" (re-test,
    2026-10-27): what it reads, its own lists or else the shared ones, never
    names that edition, and its own two lists are as long as each other."""
    import json
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(misc_api.__file__)), "whats_new.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    own = data.get("notes_production", []), data.get("notes_production_ko", [])
    assert len(own[0]) == len(own[1])
    for n in (own[0] + own[1]) or (data["notes"] + data["notes_ko"]):
        assert "open-source" not in n and "오픈소스" not in n, n
