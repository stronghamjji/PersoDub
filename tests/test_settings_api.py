"""Settings endpoint: the Settings modal's API keys actually land in kit.env.

Until now the modal stored keys in localStorage only -- the engines never saw
them (they read kit.env at startup), so users followed the UI and nothing
happened. The backend now owns reading/writing the file. GET /api/settings
returns the saved key VALUES (user decision 2026-08-06 -- see settings_get in
app/api/settings.py): this is a single-user desktop app bound to 127.0.0.1, and hiding
a saved key behind a set/unset boolean only made it look like an empty field.
"""

import pytest
from fastapi.testclient import TestClient

from app import config, engines_status, main, perso_client, settings_env, state, translate
from app import setup as dub_setup
from app.api import settings as settings_api
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
    # These are computed, not stored -- popped so the rest stays an exact shape check.
    assert body.pop("perso_signup_link").startswith(perso_client.PERSO_SIGNUP_URL)
    assert body.pop("perso_recharge_link").startswith(perso_client.PERSO_RECHARGE_URL)
    assert body.pop("perso_workspace_link").startswith(perso_client.PERSO_WORKSPACE_URL)
    assert body.pop("perso_utm").startswith("utm_source=") and "utm_content" not in body
    assert body.pop("app_version") == perso_client.APP_VERSION
    # Where the finished videos actually are. The screen used to guess at this
    # path; it comes from the server now, so a moved workspace still reads true.
    assert body.pop("workspace") == state.WORKSPACE
    assert body == {"gemini_key_set": False, "perso_key_set": False,
                    "gemini_api_key": None, "perso_api_key": None,
                    "perso_space_seq": None, "share_usage": True, "ui_language": "auto"}


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


def test_get_carries_the_utm_tagged_workspace_link(tmp_path, monkeypatch):
    # The Home sidebar's perso.ai button opens Perso's workspace, tagged like the signup link
    # but as the home link, so visits from that button are countable on their own.
    _kit(tmp_path, monkeypatch, BASE)
    link = client.get("/api/settings").json()["perso_workspace_link"]
    assert link.startswith(perso_client.PERSO_WORKSPACE_URL)
    assert f"utm_source={perso_client.CLIENT_HOST}" in link
    assert "utm_content=home" in link


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
    # Another program on this computer, on a port of its own, is not us.
    r = client.post("/api/settings", json={"gemini_api_key": "otherport"},
                    headers={"Origin": "http://127.0.0.1:5173"})
    assert r.status_code == 403
    assert "otherport" not in (kit / "kit.env").read_text(encoding="utf-8")


def test_get_without_kit_dir_says_unavailable(monkeypatch):
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    assert client.get("/api/settings").status_code == 503


# --- POST ------------------------------------------------------------------

def test_post_writes_keys_and_backs_up(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE)
    r = client.post("/api/settings", json={"gemini_api_key": "g123", "perso_api_key": "p456"})
    assert r.status_code == 200
    assert r.json() == {"gemini_key_set": True, "perso_key_set": True,
                        "perso_space_seq": None, "restart_required": False}
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

    monkeypatch.setattr(settings_api, "list_dubbing_spaces", fake_list)
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
    monkeypatch.setattr(settings_api, "list_dubbing_spaces",
                        lambda key: [{"seq": 1, "name": "solo", "tier": None, "credits": None}])
    r = client.get("/api/perso/spaces")
    assert r.status_code == 200
    assert r.json()["spaces"][0]["seq"] == 1


def test_perso_spaces_upstream_failure_is_502_without_key_leak(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=SECRETKEY\n")

    def boom(key):
        raise RuntimeError("connect timeout for SECRETKEY")

    monkeypatch.setattr(settings_api, "list_dubbing_spaces", boom)
    r = client.get("/api/perso/spaces")
    assert r.status_code == 502
    assert "SECRETKEY" not in r.text
    # What to check, not the program's name for the failure.
    assert r.json()["detail"] == ("Could not load the Perso workspace list. "
                                  "Check your internet connection and the API key.")


def test_update_replaces_every_matching_line():
    # Old docs told users to hand-add the key below the commented placeholder;
    # kitEnv.js parses last-wins, so replacing only the first match silently
    # kept the old key in force.
    text = "# GEMINI_API_KEY=\nGEMINI_API_KEY=old\n"
    out = update_env_text(text, {"GEMINI_API_KEY": "new"})
    assert "old" not in out
    assert out.count("GEMINI_API_KEY=new") == 2


# --- the Share usage data switch --------------------------------------------
# One switch on the screen, three lines in kit.env: the desktop shell reads
# PERSODUB_NO_ANALYTICS, PERSODUB_NO_REPORTS and PERSODUB_EVENTS, each before
# its own send, and it is not changing.

ALL_ON = "PERSODUB_NO_ANALYTICS=0\nPERSODUB_NO_REPORTS=0\nPERSODUB_EVENTS=1\n"
ALL_OFF = "PERSODUB_NO_ANALYTICS=1\nPERSODUB_NO_REPORTS=1\nPERSODUB_EVENTS=0\n"


@pytest.mark.parametrize("counts, reports, shared", [
    ("0", "0", True),
    ("1", "0", True),
    ("0", "1", True),
    ("1", "1", False),
])
def test_sharing_is_off_only_when_counts_and_reports_are_both_off(tmp_path, monkeypatch, counts, reports, shared):
    _kit(tmp_path, monkeypatch, BASE + f"PERSODUB_NO_ANALYTICS={counts}\nPERSODUB_NO_REPORTS={reports}\n")
    assert settings_env.read_share_usage() is shared
    assert client.get("/api/settings").json()["share_usage"] is shared


@pytest.mark.parametrize("events_line", ["", "PERSODUB_EVENTS=1\n", "PERSODUB_EVENTS=0\n"])
def test_the_events_line_does_not_decide_the_switch(tmp_path, monkeypatch, events_line):
    # The shell holds the button events back whenever the counts are off
    # (desktop/src/events.js), so counts and reports off is everything off
    # whatever the events line says -- and events off alone is not.
    kit = _kit(tmp_path, monkeypatch,
               BASE + "PERSODUB_NO_ANALYTICS=1\nPERSODUB_NO_REPORTS=1\n" + events_line)
    assert settings_env.read_share_usage() is False
    (kit / "kit.env").write_text(BASE + events_line, encoding="utf-8")
    assert settings_env.read_share_usage() is True


def test_turning_the_switch_off_writes_all_three_lines(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE)
    assert client.post("/api/settings", json={"share_usage": False}).status_code == 200
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + ALL_OFF
    assert client.get("/api/settings").json()["share_usage"] is False


def test_turning_the_switch_on_writes_all_three_lines(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE + ALL_OFF)
    assert client.post("/api/settings", json={"share_usage": True}).status_code == 200
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + ALL_ON
    assert client.get("/api/settings").json()["share_usage"] is True


def test_a_save_without_the_switch_leaves_its_lines_alone(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE + ALL_OFF)
    client.post("/api/settings", json={"gemini_api_key": "gvalue"})
    assert ALL_OFF in (kit / "kit.env").read_text(encoding="utf-8")


def test_saving_only_the_switch_leaves_the_saved_keys_alone(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=gvalue\n")
    client.post("/api/settings", json={"share_usage": False})
    assert "GEMINI_API_KEY=gvalue" in (kit / "kit.env").read_text(encoding="utf-8")


# --- settling a kit.env from the three-switch versions -----------------------

@pytest.mark.parametrize("lines", [
    "PERSODUB_NO_ANALYTICS=1\n",
    "PERSODUB_NO_REPORTS=1\n",
    "PERSODUB_EVENTS=0\n",
    "PERSODUB_NO_ANALYTICS=1\nPERSODUB_EVENTS=0\n",
    "PERSODUB_NO_ANALYTICS=0\nPERSODUB_NO_REPORTS=1\nPERSODUB_EVENTS=0\n",
])
def test_a_partly_off_computer_is_settled_as_all_on(tmp_path, monkeypatch, lines):
    kit = _kit(tmp_path, monkeypatch, BASE + lines)
    settings_env.settle_share_usage()
    text = (kit / "kit.env").read_text(encoding="utf-8")
    assert text.startswith(BASE)
    assert sorted(text[len(BASE):].splitlines()) == sorted(ALL_ON.splitlines())
    assert settings_env.read_share_usage() is True


@pytest.mark.parametrize("lines", [
    "",                                                     # a new install: no line at all
    ALL_ON,
    ALL_OFF,
    "PERSODUB_NO_ANALYTICS=1\nPERSODUB_NO_REPORTS=1\n",     # everything off, no events line
    "PERSODUB_NO_ANALYTICS=1\nPERSODUB_NO_REPORTS=1\nPERSODUB_EVENTS=1\n",
])
def test_all_on_and_all_off_are_left_untouched(tmp_path, monkeypatch, lines):
    kit = _kit(tmp_path, monkeypatch, BASE + lines)
    shared = settings_env.read_share_usage()
    settings_env.settle_share_usage()
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + lines
    # Not rewritten with the same text either: a write leaves a backup behind.
    assert not (kit / "kit.env.bak").exists()
    assert settings_env.read_share_usage() is shared


def test_settling_without_a_kit_does_nothing(tmp_path, monkeypatch):
    # A run from source has no kit at all (tests/conftest.py)...
    settings_env.settle_share_usage()
    # ...and a kit folder whose kit.env is not there yet is no different.
    kit = tmp_path / "kit"
    kit.mkdir()
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    settings_env.settle_share_usage()
    assert list(kit.iterdir()) == []


def test_startup_settles_a_partly_off_computer(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE + "PERSODUB_NO_ANALYTICS=1\n")
    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        assert c.get("/api/settings").json()["share_usage"] is True
    assert "PERSODUB_NO_ANALYTICS=0" in (kit / "kit.env").read_text(encoding="utf-8")


def test_the_app_still_starts_when_kit_env_cannot_be_written(tmp_path, monkeypatch):
    # A window that never opens is a worse failure than three lines not merged.
    _kit(tmp_path, monkeypatch, BASE + "PERSODUB_NO_ANALYTICS=1\n")

    def refuse(_values):
        raise PermissionError("kit.env is read-only")
    monkeypatch.setattr(settings_env, "_write_env", refuse)
    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        assert c.get("/health").json() == {"status": "ok"}


def test_the_app_still_starts_when_kit_env_is_not_utf8(tmp_path, monkeypatch):
    # A kit.env saved in the computer's own encoding (cp949, with a Korean
    # folder name in it) does not read as UTF-8, and that is a
    # UnicodeDecodeError, which is no OSError.
    kit = tmp_path / "kit"
    kit.mkdir()
    saved = "PERSODUB_KIT_DIR=C:\\사용자\\킷\nPERSODUB_NO_ANALYTICS=1\n".encode("cp949")
    (kit / "kit.env").write_bytes(saved)
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    with pytest.raises(UnicodeDecodeError):
        settings_env.settle_share_usage()
    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        assert c.get("/health").json() == {"status": "ok"}
    assert (kit / "kit.env").read_bytes() == saved


# --- kit.env read the way the desktop shell reads it -------------------------
# desktop/src/kitEnv.js parseEnvFile is what decides whether anything is sent:
# a byte-order mark before the first key, `export ` before a key and quotes
# round a value all still say "off" there, so they must say it here too.

BOM = b"\xef\xbb\xbf"


@pytest.mark.parametrize("saved", [
    BOM + b"PERSODUB_NO_ANALYTICS=1\nPERSODUB_NO_REPORTS=1\n",
    BOM + b"PERSODUB_NO_ANALYTICS=1\r\nPERSODUB_NO_REPORTS=1\r\nPERSODUB_EVENTS=0\r\n",
    b"PERSODUB_NO_ANALYTICS=\"1\"\nPERSODUB_NO_REPORTS='1'\n",
    b"export PERSODUB_NO_ANALYTICS=1\nexport PERSODUB_NO_REPORTS=1\n",
    BOM + b"export PERSODUB_NO_ANALYTICS=\"1\"\n  export  PERSODUB_NO_REPORTS = '1' \n",
])
def test_everything_off_is_still_off_with_a_mark_quotes_or_export(tmp_path, monkeypatch, saved):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_bytes(saved)
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    assert settings_env.read_share_usage() is False
    settings_env.settle_share_usage()
    # Not turned on, and not written at all.
    assert (kit / "kit.env").read_bytes() == saved
    assert not (kit / "kit.env.bak").exists()
    assert client.get("/api/settings").json()["share_usage"] is False


@pytest.mark.parametrize("line, value", [
    ("GEMINI_API_KEY=abc", "abc"),
    ('GEMINI_API_KEY="abc"', "abc"),
    ("GEMINI_API_KEY='abc'", "abc"),
    ("export GEMINI_API_KEY=abc", "abc"),
    ("  export   GEMINI_API_KEY = \"a b\"  ", "a b"),
    # One pair of quotes comes off, and only a matching pair.
    ("GEMINI_API_KEY=\"'abc'\"", "'abc'"),
    ("GEMINI_API_KEY=\"abc'", "\"abc'"),
    ("GEMINI_API_KEY=\"", "\""),
    # Empty, quoted or not, is no value.
    ("GEMINI_API_KEY=", None),
    ('GEMINI_API_KEY=""', None),
    ("# GEMINI_API_KEY=abc", None),
])
def test_a_line_reads_as_the_shell_reads_it(tmp_path, monkeypatch, line, value):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_bytes(BOM + line.encode("utf-8") + b"\n")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    assert settings_env.read_value("GEMINI_API_KEY") == value
    assert settings_env.read_key_status()["GEMINI_API_KEY"] is bool(value)
    # An empty line is still a line: it outranks the process environment.
    monkeypatch.setenv("GEMINI_API_KEY", "from-the-environment")
    commented = line.startswith("#")
    assert settings_env.current_value("GEMINI_API_KEY") == ("from-the-environment" if commented else value or "")


# --- kit.env is written beside itself and moved into place -------------------

def test_a_write_goes_to_a_file_beside_kit_env_and_is_moved_over_it(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE)
    moves = []
    real_replace = settings_env.os.replace

    def replace(src, dst):
        # At the move the new text is whole in the other file and kit.env is
        # still the old one, whole.
        moves.append((src, dst, open(src, encoding="utf-8").read(), open(dst, encoding="utf-8").read()))
        real_replace(src, dst)
    monkeypatch.setattr(settings_env.os, "replace", replace)
    settings_env.write_share_usage(False)
    assert moves == [(str(kit / "kit.env.tmp"), str(kit / "kit.env"), BASE + ALL_OFF, BASE)]
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + ALL_OFF
    assert (kit / "kit.env.bak").read_text(encoding="utf-8") == BASE
    assert sorted(p.name for p in kit.iterdir()) == ["kit.env", "kit.env.bak"]


def test_a_write_that_stops_part_way_leaves_kit_env_as_it_was(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=gvalue\n")

    class HalfWritten:
        def __init__(self, f):
            self.f = f

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.f.close()

        def write(self, text):
            self.f.write(text[:len(text) // 2])
            raise OSError(28, "No space left on device")

    def full_disk(path, mode="r", **kw):
        f = open(path, mode, **kw)
        return HalfWritten(f) if "w" in mode else f
    monkeypatch.setattr(settings_env, "open", full_disk, raising=False)
    with pytest.raises(OSError):
        settings_env.write_share_usage(False)
    monkeypatch.undo()
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + "GEMINI_API_KEY=gvalue\n"
    # The half-written copy, which has the keys in it, is not left behind.
    assert sorted(p.name for p in kit.iterdir()) == ["kit.env", "kit.env.bak"]


def test_a_kit_env_that_cannot_be_replaced_is_written_in_place(tmp_path, monkeypatch):
    # Windows refuses the move while another program has kit.env open.
    kit = _kit(tmp_path, monkeypatch, BASE)

    def refuse(_src, _dst):
        raise PermissionError(13, "The process cannot access the file")
    monkeypatch.setattr(settings_env.os, "replace", refuse)
    settings_env.write_share_usage(False)
    assert (kit / "kit.env").read_text(encoding="utf-8") == BASE + ALL_OFF
    assert (kit / "kit.env.bak").read_text(encoding="utf-8") == BASE
    assert sorted(p.name for p in kit.iterdir()) == ["kit.env", "kit.env.bak"]


# --- POST /api/perso/spaces/preview (workspaces for a TYPED, unsaved key) ---
# This is what removes the second restart: the picker can list workspaces for a
# key the user has only pasted, so key + workspace are saved in one go.

def test_preview_rejects_an_empty_key():
    r = client.post("/api/perso/spaces/preview", json={"api_key": "   "})
    assert r.status_code == 400


def test_preview_lists_workspaces_for_the_typed_key_without_saving_it(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE)          # nothing saved in kit.env
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    settings_api._preview_last.update(key="", at=0.0, spaces=None)
    seen = {}

    def fake_list(key):
        seen["key"] = key
        return [{"seq": 7, "name": "EST", "tier": "pro", "credits": 10}]

    monkeypatch.setattr(settings_api, "list_dubbing_spaces", fake_list)
    r = client.post("/api/perso/spaces/preview", json={"api_key": "TYPEDKEY"})
    assert r.status_code == 200
    assert r.json() == {"spaces": [{"seq": 7, "name": "EST", "tier": "pro", "credits": 10}]}
    assert seen["key"] == "TYPEDKEY"
    # The key is used server-side only -- it must never come back out.
    assert "TYPEDKEY" not in r.text
    # ...and it must not have been written to kit.env behind the user's back.
    assert "TYPEDKEY" not in (tmp_path / "kit" / "kit.env").read_text(encoding="utf-8")


def test_preview_upstream_failure_is_502_without_key_leak(monkeypatch):
    settings_api._preview_last.update(key="", at=0.0, spaces=None)

    def boom(key):
        raise RuntimeError("connect timeout for TYPEDKEY")

    monkeypatch.setattr(settings_api, "list_dubbing_spaces", boom)
    r = client.post("/api/perso/spaces/preview", json={"api_key": "TYPEDKEY"})
    assert r.status_code == 502
    assert "TYPEDKEY" not in r.text


def test_preview_reuses_the_last_answer_for_the_same_key(monkeypatch):
    # Paste, debounced typing and blur can all fire for one key -- Perso is
    # asked once, not three times.
    settings_api._preview_last.update(key="", at=0.0, spaces=None)
    calls = []

    def fake_list(key):
        calls.append(key)
        return [{"seq": 7, "name": "EST", "tier": None, "credits": None}]

    monkeypatch.setattr(settings_api, "list_dubbing_spaces", fake_list)
    for _ in range(3):
        assert client.post("/api/perso/spaces/preview", json={"api_key": "SAME"}).status_code == 200
    assert calls == ["SAME"]
    # A different key is a different question, so it does go out.
    client.post("/api/perso/spaces/preview", json={"api_key": "OTHER"})
    assert calls == ["SAME", "OTHER"]


# --- a saved key applies to the next dub, with no restart ------------------

def test_default_stt_engine_stays_local_with_a_key_saved_after_startup(tmp_path, monkeypatch):
    # The process env is empty (the key did not exist when the app started) and
    # kit.env has it -- exactly the state right after Settings saves a key. A
    # key alone does not pick Perso speech-to-text (owner, 2026-10-20).
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=SAVEDKEY\n")
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)
    assert config.default_stt_engine() == ""


def test_default_stt_engine_stays_local_without_any_key(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE)
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)
    assert config.default_stt_engine() == ""


@pytest.mark.parametrize("envtext, expected_setup, expected_config", [
    (BASE, "local", ""),                                    # no key at all
    (BASE + "PERSO_API_KEY=SAVEDKEY\n", "local", ""),      # key saved, nothing chosen
    (BASE + "STT_ENGINE=local\n", "local", ""),             # local chosen and saved
    (BASE + "STT_ENGINE=perso\n", "perso", "perso"),        # perso chosen and saved
])
def test_the_stt_default_has_one_owner(tmp_path, monkeypatch, envtext,
                                       expected_setup, expected_config):
    # setup.default_for("stt") is the rule; config.default_stt_engine only
    # renames its "local" to the "" its callers read. Two vocabularies for one
    # rule is how they drifted apart before -- this pins them together.
    _kit(tmp_path, monkeypatch, envtext)
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)
    assert dub_setup.default_for("stt") == expected_setup
    assert config.default_stt_engine() == expected_config


def test_perso_client_uses_a_key_and_workspace_saved_after_startup(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch,
         BASE + "PERSO_API_KEY=SAVEDKEY\nPERSO_SPACE_SEQ=42\n")
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    pc = perso_client.PersoClient()
    assert pc.api_key == "SAVEDKEY"
    assert pc.space_seq == 42


def test_gemini_translator_uses_a_key_saved_after_import(tmp_path, monkeypatch):
    # translate.py froze GEMINI_API_KEY at import time, so a key saved in
    # Settings could never reach it without restarting the whole app.
    _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=SAVEDGEM\n")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert translate.GeminiTranslator().api_key == "SAVEDGEM"


# --- a DELETED key means no key, even when the process started with one -----
# The user cleared the Perso field and saved; kit.env then holds "PERSO_API_KEY="
# and the process env still holds the key the app launched with. kit.env wins.

def test_cleared_key_in_kit_env_beats_the_process_env(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    assert settings_env.current_value("PERSO_API_KEY") == ""


def test_perso_spaces_is_409_after_the_key_is_cleared(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    # The picker must not keep listing the deleted key's workspaces.
    assert client.get("/api/perso/spaces").status_code == 409


def test_default_stt_engine_falls_back_to_whisper_after_the_key_is_cleared(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    monkeypatch.delenv("STT_ENGINE", raising=False)
    assert config.default_stt_engine() == ""


def test_perso_unavailable_after_the_key_is_cleared(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    assert engines_status.perso_available() is False


def test_cleared_gemini_key_in_kit_env_beats_the_process_env(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "GEMINI_API_KEY=\n")
    monkeypatch.setenv("GEMINI_API_KEY", "STARTUPGEM")
    assert engines_status.gemini_available() is False
    assert translate.GeminiTranslator().api_key == ""


def test_perso_client_refuses_a_key_cleared_in_settings(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    with pytest.raises(ValueError):
        perso_client.PersoClient()


# --- ...but a kit.env that never mentions the key still defers to the env ---
# Server deployments (and any kit.env predating a setting) keep working.

def test_key_absent_from_kit_env_falls_back_to_the_process_env(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, BASE)       # only a COMMENTED placeholder line
    monkeypatch.setenv("PERSO_API_KEY", "ENVKEY")
    monkeypatch.delenv("STT_ENGINE", raising=False)
    assert settings_env.current_value("PERSO_API_KEY") == "ENVKEY"
    assert engines_status.perso_available() is True
    monkeypatch.setattr(settings_api, "list_dubbing_spaces",
                        lambda key: [{"seq": 1, "name": "solo", "tier": None, "credits": None}])
    assert client.get("/api/perso/spaces").status_code == 200


def test_cleared_workspace_pin_does_not_fall_back_to_the_process_env(tmp_path, monkeypatch):
    # Same rule for the workspace: clearing the pin must not resurrect the one
    # the app started with, which could bill a workspace the user moved off.
    _kit(tmp_path, monkeypatch, BASE + "PERSO_API_KEY=SAVEDKEY\nPERSO_SPACE_SEQ=\n")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "999")
    monkeypatch.setattr(perso_client, "_resolve_space_seq", lambda key, base: 42)
    assert perso_client.PersoClient().space_seq == 42
