"""Settings endpoint: the Settings modal's API keys actually land in kit.env.

Until now the modal stored keys in localStorage only -- the engines never saw
them (they read kit.env at startup), so users followed the UI and nothing
happened. The backend now owns reading/writing the file. Keys are NEVER
returned to the client -- only set/unset booleans.
"""
import os

from fastapi.testclient import TestClient

from app import main
from app import perso_client
from app.settings_env import update_env_text

client = TestClient(main.app, base_url="http://127.0.0.1")


def _kit(tmp_path, monkeypatch, envtext):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_text(envtext, encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    return kit


BASE = "PERSODUB_KIT_DIR=/x\n# TRANSLATE_ENGINE=gemini\n# GEMINI_API_KEY=\n# PERSO_API_KEY=\n"


# --- pure text update ------------------------------------------------------

def test_update_sets_and_uncomments_a_key():
    out = update_env_text(BASE, {"GEMINI_API_KEY": "abc"})
    assert "\nGEMINI_API_KEY=abc\n" in out
    assert "# GEMINI_API_KEY" not in out
    assert out.startswith("PERSODUB_KIT_DIR=/x")  # untouched lines preserved


def test_update_replaces_an_existing_value_in_place():
    text = "A=1\nGEMINI_API_KEY=old\nB=2\n"
    out = update_env_text(text, {"GEMINI_API_KEY": "new"})
    assert out == "A=1\nGEMINI_API_KEY=new\nB=2\n"


def test_update_appends_when_the_key_is_absent():
    out = update_env_text("A=1\n", {"PERSO_API_KEY": "p"})
    assert out.endswith("PERSO_API_KEY=p\n")


# --- GET -------------------------------------------------------------------

def test_get_reports_unset_keys(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE)
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    # Both are computed, not stored -- popped so the rest stays an exact shape check.
    assert body.pop("perso_signup_link").startswith(perso_client.PERSO_SIGNUP_URL)
    assert body.pop("app_version") == perso_client.APP_VERSION
    assert body == {"gemini_key_set": False, "perso_key_set": False,
                    "gemini_api_key": None, "perso_api_key": None,
                    "perso_space_seq": None}


def test_get_carries_the_utm_tagged_signup_link(tmp_path, monkeypatch):
    # The Settings modal shows a "get a key" link for users who have none -- the only path
    # from this app to a new Perso account. It must arrive UTM-tagged (the static page can't
    # build the tag itself: utm_source depends on the running platform), and tagged as the
    # signup link specifically, so signups are countable apart from recharge visits.
    _kit(tmp_path, monkeypatch, BASE)
    link = client.get("/api/settings").json()["perso_signup_link"]
    assert link.startswith(perso_client.PERSO_SIGNUP_URL)
    assert f"utm_source={perso_client.CLIENT_HOST}" in link
    assert "utm_content=signup" in link


def test_get_returns_saved_key_values(tmp_path, monkeypatch):
    # Single-user desktop app: the key lives in a file the user owns, so the
    # Settings screen shows it back to them (user decision 2026-08-06 -- the
    # hidden-once-saved field read as "empty" and caused more confusion than
    # the web-service-style secrecy was worth on localhost).
    _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=gvalue\nPERSO_API_KEY=pvalue\n")
    body = client.get("/api/settings").json()
    assert body["gemini_api_key"] == "gvalue"
    assert body["perso_api_key"] == "pvalue"
    assert body["gemini_key_set"] is True


def test_get_reports_pinned_space_seq(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_SPACE_SEQ=114\n")
    assert client.get("/api/settings").json()["perso_space_seq"] == "114"


def test_rejects_non_local_host_header(tmp_path, monkeypatch):
    # GET /api/settings now carries key values, so a DNS-rebinding page (a
    # hostile site whose domain re-resolves to 127.0.0.1, making the browser
    # treat our backend as same-origin) must be turned away by Host header.
    _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=gvalue\n")
    r = client.get("/api/settings", headers={"Host": "evil.example.com"})
    assert r.status_code == 400
    assert "gvalue" not in r.text


def test_rejects_cross_origin_writes(tmp_path, monkeypatch):
    # A hostile page POSTing to 127.0.0.1 passes the Host allowlist (Host is
    # ours, not theirs) and CORS only hides the response -- the write itself
    # would fire, e.g. swapping in an attacker's Perso key. Browsers always
    # attach Origin to cross-origin POSTs, so a foreign Origin is refused.
    kit = _kit(tmp_path, monkeypatch, BASE)
    r = client.post("/api/settings", json={"gemini_api_key": "evilkey"},
                    headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 403
    assert "evilkey" not in (kit / "kit.env").read_text(encoding="utf-8")
    # Our own UI (same-origin) keeps working.
    r = client.post("/api/settings", json={"gemini_api_key": "goodkey"},
                    headers={"Origin": "http://127.0.0.1"})
    assert r.status_code == 200


def test_get_without_kit_dir_says_unavailable(monkeypatch):
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    assert client.get("/api/settings").status_code == 503


# --- POST ------------------------------------------------------------------

def test_post_writes_keys_and_backs_up(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE)
    r = client.post("/api/settings", json={"gemini_api_key": "g123", "perso_api_key": "p456"})
    assert r.status_code == 200
    assert r.json() == {"gemini_key_set": True, "perso_key_set": True,
                        "perso_space_seq": None, "restart_required": True}
    text = (kit / "kit.env").read_text(encoding="utf-8")
    assert "GEMINI_API_KEY=g123" in text and "PERSO_API_KEY=p456" in text
    assert "PERSODUB_KIT_DIR=/x" in text  # other lines survive
    assert (kit / "kit.env.bak").exists()
    assert "g123" not in r.text.replace("gemini_key_set", "")  # value not echoed


def test_post_omitted_field_changes_nothing_but_empty_clears(tmp_path, monkeypatch):
    # None/omitted = leave alone; "" = clear the saved value. Without the
    # clear path, a mistyped key or stale workspace pin could never be
    # removed from the app (review 2026-08-07, HIGH-4).
    kit = _kit(tmp_path, monkeypatch,
               BASE + "GEMINI_API_KEY=keepme\nPERSO_API_KEY=keepme2\nPERSO_SPACE_SEQ=114\n")
    r = client.post("/api/settings", json={"gemini_api_key": "", "perso_api_key": None,
                                           "perso_space_seq": ""})
    assert r.status_code == 200
    body = r.json()
    assert body["gemini_key_set"] is False       # cleared
    assert body["perso_key_set"] is True         # untouched
    assert body["perso_space_seq"] is None       # cleared
    text = (kit / "kit.env").read_text(encoding="utf-8")
    assert "GEMINI_API_KEY=keepme" not in text
    assert "PERSO_API_KEY=keepme2" in text


def test_post_rejects_control_characters_in_keys(tmp_path, monkeypatch):
    # A newline in a posted value would inject arbitrary KEY=value lines into
    # kit.env, which the desktop shell feeds into the engine environment.
    kit = _kit(tmp_path, monkeypatch, BASE)
    r = client.post("/api/settings", json={"gemini_api_key": "abc\nEVIL=1"})
    assert r.status_code == 422
    assert "EVIL" not in (kit / "kit.env").read_text(encoding="utf-8")


def test_post_writes_space_seq(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE)
    r = client.post("/api/settings", json={"perso_space_seq": "114"})
    assert r.status_code == 200
    assert r.json()["perso_space_seq"] == "114"
    assert "PERSO_SPACE_SEQ=114" in (kit / "kit.env").read_text(encoding="utf-8")


def test_post_rejects_non_numeric_space_seq(tmp_path, monkeypatch):
    # The picker only ever posts a seq from /api/perso/spaces; anything else is
    # a hand-crafted request and must not reach the engine environment file.
    kit = _kit(tmp_path, monkeypatch, BASE)
    assert client.post("/api/settings", json={"perso_space_seq": "abc; rm -rf"}).status_code == 422
    assert "PERSO_SPACE_SEQ" not in (kit / "kit.env").read_text(encoding="utf-8").replace("# PERSO_API_KEY", "")


def test_post_rejects_unicode_digit_lookalikes_and_oversized_space_seq(tmp_path, monkeypatch):
    # "²" passes isdigit() but crashes int(); Arabic-Indic digits pass AND
    # silently convert to a different number -- billing the wrong workspace.
    _kit(tmp_path, monkeypatch, BASE)
    for bad in ["²", "١١٤", "1" * 11]:
        assert client.post("/api/settings", json={"perso_space_seq": bad}).status_code == 422, bad


# --- GET /api/perso/spaces (Settings workspace picker) ---------------------

def test_perso_spaces_requires_a_key(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE)
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    assert client.get("/api/perso/spaces").status_code == 409


def test_perso_spaces_lists_workspaces_for_the_saved_key(tmp_path, monkeypatch):
    # The key saved via Settings (kit.env) must work BEFORE a restart puts it
    # into the process env -- otherwise picking a workspace needs two restarts.
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=SECRETKEY\n")
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    seen = {}

    def fake_list(key):
        seen["key"] = key
        return [{"seq": 114, "name": "EST", "tier": "enterprise", "credits": 3400}]

    monkeypatch.setattr(main, "list_dubbing_spaces", fake_list)
    r = client.get("/api/perso/spaces")
    assert r.status_code == 200
    assert r.json() == {"spaces": [{"seq": 114, "name": "EST", "tier": "enterprise", "credits": 3400}]}
    assert seen["key"] == "SECRETKEY"
    assert "SECRETKEY" not in r.text


def test_perso_spaces_falls_back_to_process_env_key(monkeypatch):
    # Server deployments have no kit/kit.env at all -- the key lives in the
    # process env there, and the picker endpoint must still work.
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    monkeypatch.setenv("PERSO_API_KEY", "ENVKEY")
    monkeypatch.setattr(main, "list_dubbing_spaces",
                        lambda key: [{"seq": 1, "name": "solo", "tier": None, "credits": None}])
    r = client.get("/api/perso/spaces")
    assert r.status_code == 200
    assert r.json()["spaces"][0]["seq"] == 1


def test_perso_spaces_upstream_failure_is_502_without_key_leak(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=SECRETKEY\n")

    def boom(key):
        raise RuntimeError("connect timeout for SECRETKEY")

    monkeypatch.setattr(main, "list_dubbing_spaces", boom)
    r = client.get("/api/perso/spaces")
    assert r.status_code == 502
    assert "SECRETKEY" not in r.text


def test_update_replaces_every_matching_line():
    # Old docs told users to hand-add the key below the commented placeholder;
    # kitEnv.js parses last-wins, so replacing only the first match silently
    # kept the old key in force.
    text = "# GEMINI_API_KEY=\nGEMINI_API_KEY=old\n"
    out = update_env_text(text, {"GEMINI_API_KEY": "new"})
    assert "old" not in out
    assert out.count("GEMINI_API_KEY=new") == 2
