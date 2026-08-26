import json
import os
import threading
import time

from fastapi.testclient import TestClient
import pytest

from app import jobs
import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    """This file predates dub_start's engine-availability preflight (app/main.py) --
    default every engine to "available" so its uploads (none of which are testing
    availability) don't all need to fake it individually. Tests that DO care about
    availability live in tests/test_engines_api.py and override per-test.

    gemma_status/qwen_status are what the preflight actually consults (I2: it
    needs to tell an unreachable Ollama apart from one that's just missing the
    model) -- gemma_available/qwen_available are also patched since GET
    /api/engines still reports those plain booleans.
    """
    monkeypatch.setattr(main, "gemma_available", lambda: True)
    monkeypatch.setattr(main, "qwen_available", lambda: True)
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "qwen_status", lambda: "available")
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)


def test_dub_run_endpoint_is_gone():
    # /api/dub/run took client-supplied filesystem paths with no validation
    # (arbitrary file overwrite via ffmpeg -y, SSRF via ffmpeg -i). Nothing
    # used it -- the UI posts uploads to /api/dub/start (review S1).
    r = client.post(
        "/api/dub/run",
        json={"video_path": "/v.mp4", "srt_path": "/s.srt", "out_path": "/o.mp4"},
    )
    assert r.status_code in (404, 405)


def test_dub_job_unknown():
    r = client.get("/api/dub/jobs/nope")
    assert r.status_code == 404


def test_index_page_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "PersoDub" in r.text


def test_dub_start_upload(monkeypatch, tmp_path):
    # Fake instead of the real pipeline: actually create one result file
    out_file = tmp_path / "dubbed.mp4"

    def fake_run_dub(**kw):
        out_file.write_bytes(b"FAKEMP4")
        return {"job_id": "x", "out_path": str(out_file), "num_segments": 2}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={
            "video": ("v.mp4", b"video-bytes", "video/mp4"),
            "srt": ("s.srt", b"1\n00:00:00,000 --> 00:00:01,000\nhi\n", "application/x-subrip"),
        },
        data={"language": "English", "language_code": "en"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]

    status = "running"
    for _ in range(100):
        status = client.get(f"/api/dub/jobs/{jid}").json()["status"]
        if status != "running":
            break
        time.sleep(0.02)
    assert status == "done"

    # Download the result file
    rr = client.get(f"/api/dub/result/{jid}")
    assert rr.status_code == 200
    assert rr.content == b"FAKEMP4"


def test_dub_start_with_n_takes(monkeypatch):
    # Verify the n_takes form field (Qwen best-of-N selection) reaches the pipeline
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "n_takes": "6"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    assert captured["n_takes"] == 6


def test_dub_start_n_takes_defaults_to_none(monkeypatch):
    # Omitting n_takes leaves it to run_dub's own QWEN_N_TAKES default
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
    assert captured["n_takes"] is None


def test_dub_start_with_stt_engine(monkeypatch):
    # Verify the stt_engine form field reaches the pipeline
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    assert captured["stt_engine"] == "perso"


def test_dub_start_perso_without_pin_rejects_multi_workspace_accounts(monkeypatch):
    # No pinned workspace + several to choose from -> the job would fail AFTER
    # minutes of separation work. The preflight must refuse up front and send
    # the user to Settings.
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    monkeypatch.setattr(main, "read_value", lambda k: "k-123" if k == "PERSO_API_KEY" else None)
    monkeypatch.setattr(main, "list_dubbing_spaces",
                        lambda key: [{"seq": 1, "name": "A"}, {"seq": 2, "name": "B"}])
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    assert r.status_code == 422
    assert "workspace" in r.json()["detail"]


def test_dub_start_perso_without_pin_allows_single_workspace_accounts(monkeypatch):
    # Exactly one workspace resolves silently in the pipeline -- no refusal.
    def fake_run_dub(**kw):
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    monkeypatch.setattr(main, "read_value", lambda k: "k-123" if k == "PERSO_API_KEY" else None)
    monkeypatch.setattr(main, "list_dubbing_spaces", lambda key: [{"seq": 1, "name": "A"}])
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    assert r.status_code == 200


def test_dub_start_normalizes_stt_engine_case(monkeypatch):
    # "Perso" (capital P) used to skip both the preflight and the Perso branch
    # and silently run the free local engine. Now it must hit the preflight.
    monkeypatch.setattr(main, "perso_available", lambda: False)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "Perso"},
    )
    assert r.status_code == 422
    assert "Perso" in r.json()["detail"]


def test_dub_start_rejects_unknown_stt_engine(monkeypatch):
    monkeypatch.setattr(main, "run_dub", lambda **kw: None)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "whisperx"},
    )
    assert r.status_code == 422


def test_dub_start_stt_engine_defaults_to_local_without_key(monkeypatch):
    # Omitting stt_engine with no PERSO_API_KEY configured -> local (None)
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
    assert captured["stt_engine"] is None


def test_dub_start_with_translate_engine(monkeypatch):
    # Verify the translate_engine form field (gemma|gemini|qwen) reaches the pipeline
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemini"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    assert captured["translate_engine"] == "gemini"


def test_dub_start_translate_engine_defaults_to_none(monkeypatch):
    # Omitting translate_engine leaves it to run_dub's own TRANSLATE_ENGINE default
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
    assert captured["translate_engine"] is None


def test_dub_start_stt_engine_defaults_to_perso_with_key(monkeypatch):
    # Omitting stt_engine while a PERSO_API_KEY IS configured -> auto-select perso
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    monkeypatch.setenv("PERSO_API_KEY", "dummy-for-test")
    monkeypatch.delenv("STT_ENGINE", raising=False)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
    assert captured["stt_engine"] == "perso"


def test_dub_result_srt_finds_auto_translated_file(monkeypatch, tmp_path):
    # run_dub's result dict has no srt_path field -- the endpoint must find
    # "translated.srt" by filename in the same folder as out_path (see
    # app/pipeline.py:_auto_translate_srt, which always writes it there).
    out_file = tmp_path / "dubbed.mp4"
    srt_file = tmp_path / "translated.srt"
    srt_file.write_text("1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n", encoding="utf-8")

    def fake_run_dub(**kw):
        out_file.write_bytes(b"FAKEMP4")
        return {"job_id": "x", "out_path": str(out_file), "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")})
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    rr = client.get(f"/api/dub/result/{jid}/srt")
    assert rr.status_code == 200
    assert "안녕하세요" in rr.text


def test_dub_result_srt_404_when_missing():
    r = client.get("/api/dub/result/nope/srt")
    assert r.status_code == 404


# --- GET /api/dub/result/{id}/original -------------------------------------

def _start_upload_job(monkeypatch):
    """Start a dub from an uploaded file and wait for it to settle.

    run_dub is faked so no real dubbing runs; it writes its result where the
    real pipeline does (the job's own workspace folder, beside the input.mp4
    dub_start has already saved the upload as).
    """
    def fake_run_dub(**kw):
        with open(kw["out_path"], "wb") as f:
            f.write(b"FAKEMP4")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")})
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    return jid


def test_original_video_is_served_for_upload_jobs(monkeypatch):
    # An uploaded job can show its original too (only link jobs could before).
    jid = _start_upload_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/original")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("video/")


def test_original_video_is_served_while_the_job_still_runs(monkeypatch):
    # The running screen plays the source video blurred behind the progress
    # card, so the original has to be reachable long before there is a result.
    started = threading.Event()
    release = threading.Event()

    def fake_run_dub(**kw):
        started.set()
        release.wait(5)
        with open(kw["out_path"], "wb") as f:
            f.write(b"FAKEMP4")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")})
    jid = r.json()["job_id"]
    assert started.wait(2), "fake job never started"
    try:
        assert client.get(f"/api/dub/jobs/{jid}").json()["status"] == "running"
        rr = client.get(f"/api/dub/result/{jid}/original")
        assert rr.status_code == 200
        assert rr.content == b"vid"
    finally:
        release.set()


def test_original_download_stays_link_only(monkeypatch):
    # The "Download original" button is only offered for link jobs -- a file
    # the user uploaded is already on their machine.
    jid = _start_upload_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/original?download=1")
    assert r.status_code == 404


# --- POST /api/dub/jobs/{id}/cancel ----------------------------------------

def test_dub_cancel_unknown_job_404():
    r = client.post("/api/dub/jobs/nope/cancel")
    assert r.status_code == 404


def test_dub_cancel_stops_a_running_job(monkeypatch):
    # Simulate run_dub's own cooperative-cancellation checkpoints (see
    # app/pipeline.py:_check_cancel): poll the cancel_check the endpoint wired
    # up (app/main.py) and raise JobCancelled once it flips true.
    from app.jobs import JobCancelled

    started = threading.Event()

    def fake_run_dub(**kw):
        cancel_check = kw["cancel_check"]
        started.set()
        for _ in range(500):
            if cancel_check():
                raise JobCancelled("cancelled by user")
            time.sleep(0.01)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en"},
    )
    jid = r.json()["job_id"]
    assert started.wait(2), "fake job never started"

    cr = client.post(f"/api/dub/jobs/{jid}/cancel")
    assert cr.status_code == 200
    assert cr.json() == {"job_id": jid, "status": "cancelling"}

    status = "cancelling"
    for _ in range(200):
        status = client.get(f"/api/dub/jobs/{jid}").json()["status"]
        if status not in ("running", "cancelling"):
            break
        time.sleep(0.02)
    assert status == "cancelled"


def test_dub_start_surfaces_perso_credit_notice_in_job_status(monkeypatch):
    # run_dub's on_notice callback must reach the job status JSON (GET /api/dub/jobs/{id})
    # so the UI can show the message + recharge link, even while the job is still running.
    def fake_run_dub(**kw):
        kw["on_notice"]({
            "type": "perso_credit_exhausted",
            "message": "Perso credits exhausted — recharge at https://perso.ai/x (falling back to local Whisper for this job)",
            "link": "https://perso.ai/x",
        })
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    body = client.get(f"/api/dub/jobs/{jid}").json()
    assert body["notices"] == [{
        "type": "perso_credit_exhausted",
        "message": "Perso credits exhausted — recharge at https://perso.ai/x (falling back to local Whisper for this job)",
        "link": "https://perso.ai/x",
    }]


def test_dub_cancel_finished_job_returns_409(monkeypatch):
    def fake_run_dub(**kw):
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en"},
    )
    jid = r.json()["job_id"]
    status = "running"
    for _ in range(100):
        status = client.get(f"/api/dub/jobs/{jid}").json()["status"]
        if status != "running":
            break
        time.sleep(0.02)
    assert status == "done"

    cr = client.post(f"/api/dub/jobs/{jid}/cancel")
    assert cr.status_code == 409


def test_dub_start_logs_the_video_filename(monkeypatch):
    # Job logs are named job-<id>.log, so without this first line there is no
    # way to tell which video a log file belongs to.
    monkeypatch.setattr(
        main, "run_dub",
        lambda **kw: {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1},
    )
    r = client.post(
        "/api/dub/start",
        files={"video": ("my_movie.mp4", b"video-bytes", "video/mp4")},
        data={"language": "English", "language_code": "en"},
    )
    jid = r.json()["job_id"]
    for _ in range(100):
        j = client.get(f"/api/dub/jobs/{jid}").json()
        if j["status"] != "running":
            break
        time.sleep(0.02)
    assert any("my_movie.mp4" in line for line in j["logs"])


def test_dub_start_passes_source_language_hint(monkeypatch):
    # The UI now has separate source/target language dropdowns; the source
    # code is forwarded to Whisper as a hint instead of relying on
    # auto-detection alone.
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"b", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "source_language_code": "en"},
    )
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    assert captured["source_language_code"] == "en"


def test_dub_start_source_language_hint_absent_is_none(monkeypatch):
    # No source_language_code field at all (Auto-detect) -- the pipeline must
    # receive an explicit None, not a missing kwarg or empty string.
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"b", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    assert captured["source_language_code"] is None


def test_dub_start_rejects_a_language_code_that_is_not_one():
    """language_code is pasted into the job's folder name (app/main.py _job_dir).
    It reached the path unchecked while every sibling field was validated, so a
    code carrying "../.." walked the job out of the workspace. Refuse it here,
    the way stt_engine is refused, rather than quietly renaming it.
    """
    for hostile in ["../../../../tmp/PWNED", "..", "a/b", "a\\b", "ko ko", "k" * 17]:
        r = client.post(
            "/api/dub/start",
            files={"video": ("v.mp4", b"vid", "video/mp4")},
            data={"language": "Korean", "language_code": hostile},
        )
        assert r.status_code == 422, f"{hostile!r} was accepted"


def test_dub_start_still_takes_the_language_codes_people_use():
    # The guard must not turn away real codes -- BCP-47 tags carry hyphens.
    from app.main import _valid_language_code

    for good in ["ko", "en", "ja", "zh-CN", "pt_BR", "es-419"]:
        assert _valid_language_code(good), good


def test_job_record_keeps_the_chosen_source_language(monkeypatch):
    # Only auto-detect leaves a language behind in the result, so a job that was
    # TOLD its source language has to remember what it was told -- the finished
    # screen names the source column from it.
    def fake_run_dub(**kw):
        open(kw["out_path"], "wb").write(b"FAKEMP4")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    told = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "source_language_code": "en"},
    ).json()["job_id"]
    auto = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    ).json()["job_id"]

    assert client.get(f"/api/dub/jobs/{told}").json()["source_lang"] == "en"
    assert client.get(f"/api/dub/jobs/{auto}").json()["source_lang"] is None


def test_result_srt_answers_head(monkeypatch, tmp_path):
    # The Export dialog asks whether this job has subtitles at all. It used to
    # GET the whole file and throw it away; HEAD answers the same question.
    work = tmp_path / "job"
    work.mkdir()
    (work / "translated.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n",
                                         encoding="utf-8")

    def fake_run_dub(**kw):
        open(kw["out_path"], "wb").write(b"FAKEMP4")
        return {"job_id": "x", "out_path": str(work / "dubbed.mp4"), "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    assert client.head(f"/api/dub/result/{jid}/srt").status_code == 200


def test_jobs_list_carries_the_finished_job_without_its_logs(monkeypatch):
    # What the Projects sidebar is built from: one row per job, newest first,
    # with just enough to name it -- never the log, which is thousands of lines.
    def fake_run_dub(**kw):
        open(kw["out_path"], "wb").write(b"FAKEMP4")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "project": "listme"},
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    rows = client.get("/api/dub/jobs").json()["jobs"]
    # Newest first, and this is the only job this test started.
    row = rows[0]
    assert row["id"] == jid
    assert row["status"] == "done"
    assert row["project"] == "listme"
    assert row["language_code"] == "ko"
    assert "logs" not in row
    # Nor the absolute paths: the sidebar addresses a job by id, so shipping
    # the user's home directory in every row would be for nothing.
    assert "work_dir" not in row and "result" not in row


def test_a_finished_job_writes_job_json_next_to_the_video(monkeypatch):
    def fake_run_dub(**kw):
        open(kw["out_path"], "wb").write(b"FAKEMP4")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "project": "onfile"},
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    work = client.get(f"/api/dub/jobs/{jid}").json()["work_dir"]
    with open(os.path.join(work, "job.json"), encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["id"] == jid and saved["status"] == "done"
    assert saved["result"]["out_path"].endswith("dubbed.mp4")


def test_starting_the_app_restores_yesterdays_jobs(monkeypatch, tmp_path):
    # The restore hangs off the FastAPI lifespan, not the import: "with
    # TestClient(app)" is the only thing that runs it. Reading job.json at
    # import time would scan whichever workspace was current when the module
    # loaded -- before a test (or the desktop shell) can point WORKSPACE
    # anywhere else -- and Projects would come up empty for the user.
    folder = os.path.join(main.WORKSPACE, "2026-08-26", "yesterday_ko")
    os.makedirs(folder)
    with open(os.path.join(folder, "job.json"), "w", encoding="utf-8") as f:
        json.dump({"id": "restored-1", "status": "done", "project": "yesterday",
                   "day": "2026-08-26", "language_code": "ko",
                   "created": "2026-08-26T10:00:00"}, f)
    # A store of its own, so this asserts on what startup read rather than on
    # jobs other tests in this file left in the shared one.
    monkeypatch.setattr(main, "job_store", jobs.JobStore(log_dir=str(tmp_path)))

    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        rows = c.get("/api/dub/jobs").json()["jobs"]

    assert [r["id"] for r in rows] == ["restored-1"]
    assert rows[0]["project"] == "yesterday" and rows[0]["status"] == "done"
