# -*- coding: utf-8 -*-
"""The backend's half of an automatic failure report: app/report_mask.py and
GET /api/report/bundle.

Two things are being pinned here. First, that nothing personal can leave: the
masker is held to the same four rules the desktop shell's own masker follows
(desktop/src/report.js maskText), input by input, including a home directory
with a Korean name in it -- the case a byte-counting implementation gets wrong.
Second, that the bundle is an answer about a FAILURE and not a dump of the job
record: the project name, the source link and the file paths are all in that
record, and none of them may appear in what this route returns.
"""
import os

import pytest
from fastapi.testclient import TestClient

from app import state
from app.api import report as report_api
from app.main import app
from app.report_mask import mask_tail, mask_text, read_masked
from app.stages import STAGES

client = TestClient(app, base_url="http://127.0.0.1")


# --- the masker ------------------------------------------------------------

def test_a_file_under_the_home_directory_keeps_only_its_extension():
    # The folder names and the file name under a home directory are the user's
    # own business -- a client, a project, what they were watching.
    assert mask_text("cannot open /Users/jane/Movies/clip.mp4", "/Users/jane") == \
        "cannot open ~/…/*.mp4"


def test_a_file_name_with_spaces_in_it_is_folded_in_too():
    assert mask_text("cannot open /Users/jane/Movies/Q3 board review.mp4", "/Users/jane") == \
        "cannot open ~/…/*.mp4"


def test_a_sentence_about_a_home_path_is_still_a_sentence():
    # Why a path stops at whitespace: without that the words after it would be
    # swallowed with the folder names.
    assert mask_text("could not open /Users/jane/kit because the disk is full", "/Users/jane") == \
        "could not open ~/… because the disk is full"


def test_a_home_path_with_no_file_on_the_end_is_just_the_home_mark():
    assert mask_text("at /Users/jane/Documents", "/Users/jane") == "at ~/…"
    assert mask_text("at /Users/jane", "/Users/jane") == "at ~"


def test_a_korean_home_directory_is_masked_like_any_other():
    home = "/Users/홍길동"
    assert mask_text("FileNotFoundError: /Users/홍길동/영상/제목.mp4", home) == \
        "FileNotFoundError: ~/…/*.mp4"


def test_a_windows_home_is_masked_with_either_separator_and_any_case():
    home = "C:\\Users\\Jane"
    assert mask_text("at C:\\Users\\Jane\\Videos\\clip.mov", home) == "at ~\\…\\*.mov"
    assert mask_text("at c:/users/jane/Videos/clip.mov", home) == "at ~/…/*.mov"


def test_the_kits_own_paths_stay_readable_they_are_the_diagnosis():
    home = "/Users/jane"
    kit = "/Users/jane/Library/Application Support/PersoDub/kit"
    assert mask_text("no such file: %s/models/qwen3-tts/model.safetensors" % kit, home, kit) == \
        "no such file: ~/Library/Application Support/PersoDub/kit/models/qwen3-tts/model.safetensors"


def test_a_kit_path_is_recognised_however_the_log_spelled_its_separators():
    home = "C:\\Users\\Jane"
    kit = "C:\\Users\\Jane\\AppData\\Local\\PersoDub\\kit"
    assert mask_text("at c:/users/jane/appdata/local/persodub/kit/engines_venv", home, kit) == \
        "at ~/AppData/Local/PersoDub/kit/engines_venv"


def test_a_kit_outside_the_home_directory_is_left_exactly_as_it_is():
    assert mask_text("no such file: /Volumes/Big/kit/models/x.bin", "/Users/jane", "/Volumes/Big/kit") == \
        "no such file: /Volumes/Big/kit/models/x.bin"


def test_a_long_name_inside_a_path_is_not_mistaken_for_a_secret():
    # The 32-character rule used to swallow model folders whole, which is how a
    # report lost the one line saying which model was missing.
    line = "no such file: /kit/models/Qwen3TTS12BInstructInt8Quantized/config.json"
    assert mask_text(line) == line


@pytest.mark.parametrize("text,expected", [
    ("key sk-abcd1234efgh5678", "key [REDACTED]"),
    ("AIzaSyA1b2C3d4E5f6G7h8", "[REDACTED]"),
    ("ghp_abcd1234efgh5678ijkl", "[REDACTED]"),
    ("hf_abcd1234efgh5678ijkl", "[REDACTED]"),
    ("token=" + "a" * 20 + "1" * 20 + " done", "token=[REDACTED] done"),
])
def test_keys_and_long_tokens_are_redacted(text, expected):
    assert mask_text(text) == expected


def test_ordinary_words_survive():
    assert mask_text("engine crashed after 30s") == "engine crashed after 30s"


def test_a_url_keeps_its_host_and_loses_everything_else():
    assert mask_text("GET https://cdn.example.com/models/x.bin?token=abc123") == \
        "GET https://cdn.example.com/..."


def test_the_two_maskers_agree_on_the_same_line():
    """The rule that matters: the shell masks shell.log, this masks the app's
    log, and the same line must come out the same way in both halves of one
    report. The desktop side pins the identical strings in report.test.mjs."""
    home = "/Users/jane"
    line = "ERROR /Users/jane/kit/x.log key sk-abcd1234efgh5678 at https://x.example.com/a/b"
    assert mask_text(line, home) == "ERROR ~/…/*.log key [REDACTED] at https://x.example.com/..."


def test_a_tail_is_the_last_lines_masked():
    text = "\n".join("line %d in /Users/jane/kit" % i for i in range(300))
    tail = mask_tail(text, "/Users/jane", max_lines=5)
    assert len(tail.splitlines()) == 5
    assert "/Users/jane" not in tail
    assert "~/…" in tail


def test_an_empty_log_is_an_empty_tail():
    assert mask_tail("  \n\n") == ""


def test_reading_a_missing_log_is_not_an_error():
    assert read_masked("/no/such/file.log") == ""


def test_a_long_log_is_read_from_its_end(tmp_path):
    path = tmp_path / "big.log"
    path.write_text("\n".join("line %d" % i for i in range(10000)), encoding="utf-8")
    out = read_masked(str(path), max_bytes=200)
    assert out.endswith("line 9999")
    assert "line 0\n" not in out
    assert len(out.encode("utf-8")) <= 200


# --- which stage a job died in ---------------------------------------------

def test_the_stage_comes_from_the_stage_table():
    marker, name = report_api.stage_of("0/6 fetching\n1/6 separating\n4/6 dubbing line 3")
    assert marker == "4/%d" % len(STAGES)
    assert name == STAGES[3][0]


def test_a_job_that_never_reached_a_stage_names_none():
    assert report_api.stage_of("starting up") == ("", "")
    assert report_api.stage_of("") == ("", "")


# --- GET /api/report/bundle ------------------------------------------------

@pytest.fixture
def failed_job(tmp_path, monkeypatch):
    """A failed job with a log, in an isolated store."""
    log_dir = state.job_store.log_dir
    jid = state.job_store.create()
    state.job_store.update(jid, kind="dub", project="Q3 results", language="Korean",
                           stt_engine="whisper", translator="gemma",
                           source_url="https://youtube.com/watch?v=secret",
                           status="error", error="The voice engine exited (exit 1)")
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, "job-%s.log" % jid), "w", encoding="utf-8") as f:
        f.write("0/6 fetching\n4/6 synthesize line 3\nERROR at %s/kit/x\n" % os.path.expanduser("~"))
    return jid


def test_the_bundle_names_the_stage_the_engines_and_the_error(failed_job):
    body = client.get("/api/report/bundle", params={"job": failed_job}).json()
    assert body["job"]["stage"] == "synthesize"
    assert body["job"]["stageMarker"] == "4/%d" % len(STAGES)
    assert body["job"]["kind"] == "dub"
    assert body["job"]["engines"] == {"stt_engine": "whisper", "translator": "gemma"}
    assert body["job"]["error"] == "The voice engine exited (exit 1)"


def test_the_bundle_carries_the_log_tails_and_the_whole_logs(failed_job):
    body = client.get("/api/report/bundle", params={"job": failed_job}).json()
    assert "4/6 synthesize line 3" in body["logTails"]["job"]
    assert "4/6 synthesize line 3" in body["logs"]["job"]
    # Masked on the way out, not on the way to the network.
    assert os.path.expanduser("~") not in body["logs"]["job"]
    assert "~/…" in body["logs"]["job"]


def test_the_bundle_never_carries_the_project_name_or_the_source_link(failed_job):
    text = client.get("/api/report/bundle", params={"job": failed_job}).text
    assert "Q3 results" not in text
    assert "youtube.com/watch" not in text
    assert "secret" not in text


def test_the_bundle_answers_without_a_job_at_all():
    body = client.get("/api/report/bundle").json()
    assert body["job"] == {}
    assert body["platformKey"] in ("mac", "win-gpu", "win-cpu")
    assert "logs" in body


def test_an_unknown_job_is_not_an_error_it_is_an_empty_record():
    # A boot failure reports with whatever id the page last had; a report must
    # never fail because the job it names is gone.
    body = client.get("/api/report/bundle", params={"job": "nope"}).json()
    assert body["job"] == {}


def test_the_bundle_never_reads_kit_env(tmp_path, monkeypatch):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_text("PERSO_API_KEY=sk-realsecretvalue0000\n", encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    assert "sk-realsecret" not in client.get("/api/report/bundle").text
