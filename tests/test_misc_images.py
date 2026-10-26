"""The pictures the page shows that ship inside the app (static/) and are
served by app/api/misc.py, so they are there with no network at all."""
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")
STATIC = Path(__file__).resolve().parent.parent / "static"


def test_misc_serves_perso_wordmark_as_svg():
    r = client.get("/perso-dubbing.svg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/svg+xml"
    assert r.content == (STATIC / "perso-dubbing.svg").read_bytes()


def test_misc_serves_the_white_lettered_wordmark_as_svg():
    # The production edition's sidebar shows it on its dark (2026-10-27).
    r = client.get("/perso-dubbing-white.svg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/svg+xml"
    body = (STATIC / "perso-dubbing-white.svg").read_bytes()
    assert r.content == body
    assert b'fill="black"' not in body


def test_misc_serves_the_mascot_as_png():
    # The Home screen's Dub Agent card heads with the mascot (2026-10-21).
    r = client.get("/mascot.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == (STATIC / "mascot.png").read_bytes()
    assert r.content.startswith(b"\x89PNG\r\n\x1a\n")
