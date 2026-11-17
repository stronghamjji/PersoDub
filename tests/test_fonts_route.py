"""The interface's fonts ship inside the app (static/fonts) and are served by
name, so the page looks the same with no network at all."""
import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")
FONTS = Path(__file__).resolve().parent.parent / "static" / "fonts"


def test_the_font_sheet_and_every_file_it_names_are_served():
    r = client.get("/fonts/fonts.css")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")
    names = set(re.findall(r"url\(\./([a-z0-9-]+\.woff2)\)", r.text))
    assert names, "the sheet names no font files"
    for name in names:
        assert (FONTS / name).is_file(), f"{name} is named but not shipped"
    one = client.get(f"/fonts/{sorted(names)[0]}")
    assert one.status_code == 200
    assert one.headers["content-type"] == "font/woff2"


def test_the_sheet_carries_both_families_at_the_three_weights():
    css = (FONTS / "fonts.css").read_text(encoding="utf-8")
    for family in ("Onest", "Noto Sans KR"):
        for weight in (400, 500, 600):
            assert f"font-family:'{family}';font-style:normal;font-display:swap;font-weight:{weight};" in css


def test_the_flag_font_is_shipped_and_sits_first_for_flags_only():
    # Windows draws no flag emoji of its own, so the language dropdown read
    # "KR 한국어" there: the bundled flag font fills that one range and
    # nothing else, and it leads the stack so the Onest symbols subset (which
    # claims the same range) cannot take the flags first.
    css = client.get("/css/app.css").text
    face = css[css.index('font-family: "Twemoji Country Flags"'):].split("}")[0]
    assert "url(/fonts/twemoji-country-flags.woff2)" in face
    assert "unicode-range: U+1F1E6-1F1FF" in face
    assert 'font-family: "Twemoji Country Flags", Onest, "Noto Sans KR"' in css
    r = client.get("/fonts/twemoji-country-flags.woff2")
    assert r.status_code == 200
    assert r.headers["content-type"] == "font/woff2"
    assert len(r.content) == (FONTS / "twemoji-country-flags.woff2").stat().st_size


def test_only_font_names_are_served():
    assert client.get("/fonts/nope.woff2").status_code == 404
    assert client.get("/fonts/..%2Findex.html").status_code == 404
    assert client.get("/fonts/OFL-Onest.txt").status_code == 404
