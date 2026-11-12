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


def test_the_notes_are_this_versions():
    """1.0.1 went out with 1.0.0's three lines under "1.0.1" (2026-11-02): the
    file names the version its lines are for, and it is the app's version, so
    a release that does not write its own notes fails here."""
    import json
    import os
    root = os.path.dirname(os.path.dirname(misc_api.__file__))
    with open(os.path.join(root, "whats_new.json"), encoding="utf-8") as f:
        notes_for = json.load(f).get("version")
    with open(os.path.join(os.path.dirname(root), "desktop", "package.json"), encoding="utf-8") as f:
        app_version = json.load(f)["version"]
    assert notes_for == app_version, f"app/whats_new.json is for {notes_for}, the app is {app_version}"
