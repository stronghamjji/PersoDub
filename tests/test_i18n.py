"""The engine's sentences in the user's language (app/i18n.py).

A sentence with no entry reads as itself, {name} is filled, and the language
comes from kit.env's PERSODUB_LANG, with "auto" meaning what the desktop shell
passed as PERSODUB_LOCALE. Saving the setting in Settings switches the engine
without a restart. Then the tables (app/i18n/app.<code>.json): the same
sentences in every language, the English table the sentences themselves, and
every t("...") in app/ present in it -- checks with nothing to check while the
tables are empty, which hold every later change once the English one is filled.
"""
import ast
import json
import os
import pathlib
import time

import pytest
from fastapi.testclient import TestClient

from app import i18n, main

client = TestClient(main.app, base_url="http://127.0.0.1")
ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLES = ROOT / "app" / "i18n"


def _table(code):
    return json.loads((TABLES / f"app.{code}.json").read_text(encoding="utf-8"))


@pytest.fixture
def korean(monkeypatch):
    """The engine speaking Korean, from a table of the test's own."""
    monkeypatch.setattr(i18n, "_tables", {"ko": {"Unknown job: {jid}": "없는 작업: {jid}", "Done": "완료"}})
    i18n.set_language("ko")


@pytest.fixture
def undecided(monkeypatch):
    """The language not decided yet, as at the engine's start (conftest pins English)."""
    monkeypatch.setattr(i18n, "_language", None)
    monkeypatch.delenv("PERSODUB_LOCALE", raising=False)
    monkeypatch.delenv("PERSODUB_LANG", raising=False)


def _kit(tmp_path, monkeypatch, envtext):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_text(envtext, encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    return kit


# --- t() ----------------------------------------------------------------------

def test_english_is_the_sentence_itself():
    assert i18n.t("Done") == "Done"
    assert i18n.t("Unknown job: {jid}", jid="j1") == "Unknown job: j1"


def test_a_translation_is_used_and_filled(korean):
    assert i18n.t("Done") == "완료"
    assert i18n.t("Unknown job: {jid}", jid="j1") == "없는 작업: j1"


def test_a_sentence_with_no_entry_reads_in_english(korean):
    assert i18n.t("Not in the table") == "Not in the table"


def test_a_value_not_given_stays_as_written_and_other_braces_survive():
    assert i18n.t("{a} of {b}", a=1) == "1 of {b}"
    assert i18n.t('Expected {"key": 1}, got {n}', n=2) == 'Expected {"key": 1}, got 2'


def test_a_missing_or_broken_table_is_english(monkeypatch, tmp_path):
    (tmp_path / "app.ko.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(i18n, "_TABLE_DIR", str(tmp_path))
    monkeypatch.setattr(i18n, "_tables", {})
    i18n.set_language("ko")
    assert i18n.t("Done") == "Done"


# --- which language -------------------------------------------------------------

def test_without_a_kit_or_a_locale_the_engine_speaks_english(undecided):
    assert i18n.current_language() == "en"


def test_auto_follows_the_locale_the_shell_passed(undecided, monkeypatch):
    monkeypatch.setenv("PERSODUB_LOCALE", "ko")
    assert i18n.current_language() == "ko"


def test_kit_env_setting_wins_over_the_locale(undecided, tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, "PERSODUB_LANG=en\n")
    monkeypatch.setenv("PERSODUB_LOCALE", "ko")
    assert i18n.current_language() == "en"


def test_kit_env_auto_and_nonsense_both_mean_the_locale(undecided, tmp_path, monkeypatch):
    monkeypatch.setenv("PERSODUB_LOCALE", "ko")
    kit = _kit(tmp_path, monkeypatch, "PERSODUB_LANG=auto\n")
    assert i18n.current_language() == "ko"
    (kit / "kit.env").write_text("PERSODUB_LANG=klingon\n", encoding="utf-8")
    assert i18n.saved_setting() == "auto"
    assert i18n.resolve(i18n.saved_setting()) == "ko"


def test_an_unknown_locale_is_english(undecided, monkeypatch):
    monkeypatch.setenv("PERSODUB_LOCALE", "fr")
    assert i18n.current_language() == "en"


def test_set_language_takes_effect_at_once(undecided, monkeypatch):
    monkeypatch.setenv("PERSODUB_LOCALE", "ko")
    i18n.set_language("en")
    assert i18n.current_language() == "en"
    i18n.set_language("auto")
    assert i18n.current_language() == "ko"


# --- Settings --------------------------------------------------------------------

def test_settings_shows_auto_until_a_language_is_saved(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\n")
    assert client.get("/api/settings").json()["ui_language"] == "auto"


def test_saving_a_language_writes_kit_env_and_switches_the_engine(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\n")
    r = client.post("/api/settings", json={"ui_language": "ko"})
    assert r.status_code == 200
    assert "PERSODUB_LANG=ko" in (kit / "kit.env").read_text(encoding="utf-8")
    assert client.get("/api/settings").json()["ui_language"] == "ko"
    assert i18n.current_language() == "ko"


def test_a_language_settings_does_not_know_is_refused(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\n")
    assert client.post("/api/settings", json={"ui_language": "ko\nPERSO_API_KEY=x"}).status_code == 422
    assert "PERSODUB_LANG" not in (kit / "kit.env").read_text(encoding="utf-8")


# --- the page's tables, served ------------------------------------------------------

def test_the_page_tables_are_served_by_name_only():
    r = client.get("/i18n/ui.ko.json")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    assert isinstance(r.json(), dict)
    assert client.get("/i18n/app.ko.json").status_code == 404
    assert client.get("/i18n/..%2Fstatic%2Findex.html").status_code == 404


# --- the engine's tables -------------------------------------------------------------

def _keys_in_code():
    """Every t("...") in app/ whose first argument is a plain string, and every
    both("..."), which says the same sentence in English and in t()'s language."""
    keys = set()
    names = ("t", "both")
    for path in (ROOT / "app").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Call) and node.args):
                continue
            f = node.func
            named_t = (isinstance(f, ast.Name) and f.id in names) or (isinstance(f, ast.Attribute) and f.attr in names)
            first = node.args[0]
            if named_t and isinstance(first, ast.Constant) and isinstance(first.value, str):
                keys.add(first.value)
    return keys


def test_every_language_has_the_sentences_of_the_english_table():
    en = set(_table("en"))
    for code in i18n.LANGUAGES:
        if code == "en":
            continue
        other = set(_table(code))
        assert sorted(other - en) == [], f"in app.{code}.json but not in app.en.json"
        assert sorted(en - other) == [], f"in app.en.json but not in app.{code}.json"


def test_every_translation_fills_the_same_placeholders_as_its_english_sentence():
    def names(s):
        return sorted(i18n._PLACEHOLDER.findall(s))
    for code in i18n.LANGUAGES:
        if code == "en":
            continue
        wrong = {k: v for k, v in _table(code).items() if names(k) != names(v)}
        assert wrong == {}, f"app.{code}.json says other {{names}} than the English"


def test_the_english_table_is_the_sentences_themselves():
    assert {k: v for k, v in _table("en").items() if k != v} == {}


def test_every_sentence_the_engine_says_is_in_the_english_table_once_it_has_any():
    en = _table("en")
    if not en:
        return   # not filled yet: nothing to hold the code to
    assert sorted(_keys_in_code() - set(en)) == [], "said by app/, missing from app/i18n/app.en.json"


# --- a failed job, in two languages ----------------------------------------------------

@pytest.fixture
def korean_computer(undecided, monkeypatch):
    """A Korean computer with no language saved: "auto" means Korean, and the
    engine reads the real app.ko.json."""
    monkeypatch.setenv("PERSODUB_LOCALE", "ko")
    assert i18n.current_language() == "ko"


def _failed(store, jid):
    """The job once it has ended AND its job.json is on disk. The run wrapper
    flips the status first and writes the file after (app/jobs.py _wrap), so a
    reader that stops at the status can beat the file -- the Windows CI runner
    did (2026-10-13)."""
    for _ in range(200):
        job = store.get(jid)
        if job and job["status"] not in ("queued", "running"):
            work_dir = job.get("work_dir")
            if not work_dir or os.path.exists(os.path.join(work_dir, "job.json")):
                return job
        time.sleep(0.01)
    raise AssertionError("the job did not end")


def test_a_failed_job_keeps_its_error_in_english_and_shows_it_in_korean(korean_computer, tmp_path):
    """job.error is what the desktop app sorts failures by and what a failure
    report sends, so it stays English on a Korean computer; error_shown is the
    sentence the screens show, and job.json keeps both."""
    from app.jobs import JobStore, shown_error
    store = JobStore(log_dir=str(tmp_path / "logs"))
    jid = store.create()
    store.update(jid, work_dir=str(tmp_path))

    def target(log):
        raise shown_error(*i18n.both("No dialogue lines were found in this video."))

    store.start(jid, target)
    job = _failed(store, jid)
    assert job["status"] == "error"
    assert job["error"] == "No dialogue lines were found in this video."
    assert job["error_shown"] == _table("ko")["No dialogue lines were found in this video."]
    saved = json.loads((tmp_path / "job.json").read_text(encoding="utf-8"))
    assert (saved["error"], saved["error_shown"]) == (job["error"], job["error_shown"])
    listed = next(j for j in store.all() if j["id"] == jid)
    assert listed["error_shown"] == job["error_shown"]


def test_a_failure_with_no_twin_shows_its_english(korean_computer, tmp_path):
    from app.jobs import JobStore
    store = JobStore(log_dir=str(tmp_path / "logs"))
    jid = store.create()

    def target(log):
        raise RuntimeError("local STT reported an error (boom)")

    store.start(jid, target)
    job = _failed(store, jid)
    assert job["error"] == job["error_shown"] == "local STT reported an error (boom)"


def test_a_perso_refusal_is_english_in_the_error_and_the_notice_and_korean_beside_them(korean_computer):
    """raise_notice: the error, the log line and the notice's message stay
    English (the Dub Agent and the reports read them); message_shown and the
    exception's twin are the user's language, Perso's own words kept as they came."""
    from app import pipeline
    from app.perso_client import PersoProjectFailedError
    lines, notices = [], []
    with pytest.raises(RuntimeError) as caught:
        pipeline.raise_notice(PersoProjectFailedError("Perso STT", "Audio is too short", "VT5001"),
                              lines.append, notices.append)
    english = ("Perso could not finish this job. Try again, or check the project on Perso. "
               "Perso said: Audio is too short (VT5001) Ask Perso if it keeps happening.")
    ko = _table("ko")
    korean = " ".join([ko["Perso could not finish this job. Try again, or check the project on Perso."],
                       ko["Perso said: {said}"].replace("{said}", "Audio is too short"), "(VT5001)",
                       ko["Ask Perso if it keeps happening."]])
    assert str(caught.value) == english
    assert caught.value.shown == korean
    assert lines == ["   Error: " + english]
    assert notices == [{"type": "perso_project_failed", "message": english, "message_shown": korean}]


def test_the_advice_under_a_stage_that_stopped_is_said_in_both(korean_computer):
    from app.run_errors import advice_both, advice_for
    advice = advice_both("local STT timed out after 900 seconds", ("Check the video file.", "x"))
    assert advice[0] == "This computer needed more time than allowed. A shorter video will finish."
    assert advice[1] == _table("ko")[advice[0]]
    assert advice_for("local STT timed out after 900 seconds", "Check the video file.") == advice[0]
    assert advice_both("moov atom not found", ("Check the video file.", "x")) == ("Check the video file.", "x")
