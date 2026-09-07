"""The page's ES modules and the page itself are served with a per-launch token
on every module URL and Cache-Control: no-cache -- the first launch after an
update must never run the new page against a module a browser cached from the
version before (2026-09-07: a cached modelsUi.mjs lacked a new export, and every
button on the page was dead)."""
from fastapi.testclient import TestClient

from app import main as main_module
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def test_the_page_stamps_every_module_import_with_the_launch_token():
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    token = main_module.ASSET_TOKEN
    assert f'from "/js/dubApi.mjs?v={token}"' in r.text
    assert 'from "/js/' not in r.text.replace(f"?v={token}", "")  or all(
        f"?v={token}" in line for line in r.text.splitlines() if 'from "/js/' in line)


def test_a_module_is_served_uncacheable_with_its_own_imports_stamped():
    token = main_module.ASSET_TOKEN
    r = client.get(f"/js/modelsDialog.mjs?v={token}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"
    assert f'from "./modelsUi.mjs?v={token}"' in r.text
    # The token holds for the life of the process: one page, one set of URLs.
    assert client.get("/").text.count(f"?v={token}") >= 10


def test_only_named_modules_in_ui_src_are_served():
    assert client.get("/js/nope.mjs").status_code == 404
    assert client.get("/js/..%2Fdub_api.py").status_code == 404
    assert client.get("/js/modelsUi.mjs.bak").status_code == 404
