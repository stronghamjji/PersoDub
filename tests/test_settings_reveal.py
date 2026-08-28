"""POST /api/settings/reveal-output opens the finished-videos folder in the
desktop's own file browser. The Settings screen offers a "Show in Finder"
button in place of the raw path (2026-08-28), and this is what it presses."""
from fastapi.testclient import TestClient

from app import main

client = TestClient(main.app, base_url="http://127.0.0.1")


def test_reveal_output_opens_the_workspace_folder(monkeypatch):
    opened = []
    monkeypatch.setattr(main, "_open_folder", lambda path: opened.append(path))
    r = client.post("/api/settings/reveal-output")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert opened == [main.WORKSPACE]


def test_reveal_output_reports_a_folder_that_cannot_open(monkeypatch):
    def boom(path):
        raise OSError("no file browser")
    monkeypatch.setattr(main, "_open_folder", boom)
    r = client.post("/api/settings/reveal-output")
    assert r.status_code == 500
    assert "no file browser" in r.json()["detail"]
