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
    # Model files live in a kit these tests never build -- the missing-model
    # preflight (409) is exercised in tests/test_dub_start_preflight.py.
    monkeypatch.setattr(main, "_missing_models", lambda *a, **kw: [])


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


def test_dub_start_translate_engine_blank_means_the_saved_default(monkeypatch):
    # Omitting translate_engine hands run_dub the SAVED default (kit.env via
    # app/setup.py), not None -- run_dub's own fallback is the process env,
    # frozen at launch, so None would let the preflight judge one engine and
    # the job run another (2026-09-04 review).
    monkeypatch.setattr(main.dub_setup, "default_for",
                        lambda stage, _real=main.dub_setup.default_for: "gemma" if stage == "translator" else _real(stage))
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
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
    assert captured["translate_engine"] == "gemma"


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


# --- POST /api/dub/jobs/{id}/retry -----------------------------------------
# "Try again" used to mean downloading the original and uploading it back --
# for a link job, fetching the whole video a second time. The copy in the job's
# folder is right there.

def test_dub_retry_unknown_job_404():
    r = client.post("/api/dub/jobs/nope/retry")
    assert r.status_code == 404


def test_dub_retry_starts_a_new_job_from_the_saved_video(monkeypatch):
    calls = []

    def fake_run_dub(**kw):
        calls.append(kw)
        raise RuntimeError("no dub today")

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "project": "again"},
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    assert client.get(f"/api/dub/jobs/{jid}").json()["status"] == "error"

    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    new_jid = r.json()["job_id"]
    assert r.json()["status"] == "running"
    assert new_jid != jid

    new = client.get(f"/api/dub/jobs/{new_jid}").json()
    assert new["language_code"] == "ko" and new["project"] == "again"
    assert new["from_link"] is False
    # Its own folder, holding its own copy of the video -- the first job's
    # folder is left alone.
    assert new["work_dir"] != client.get(f"/api/dub/jobs/{jid}").json()["work_dir"]
    assert open(os.path.join(new["work_dir"], "input.mp4"), "rb").read() == b"vid"
    # A full re-run, not a redub: nothing is handed in as a ready-made script.
    for _ in range(100):
        if len(calls) > 1:
            break
        time.sleep(0.02)
    assert calls[-1].get("srt_path") is None
    assert calls[-1]["video_path"] == os.path.join(new["work_dir"], "input.mp4")


def test_dub_retry_refuses_a_running_job(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def fake_run_dub(**kw):
        started.set()
        release.wait(5)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    ).json()["job_id"]
    assert started.wait(2), "fake job never started"
    try:
        r = client.post(f"/api/dub/jobs/{jid}/retry")
        assert r.status_code == 409
        assert r.json()["detail"] == "This job is still running."
    finally:
        release.set()


def test_dub_retry_says_so_when_the_video_is_gone(monkeypatch):
    monkeypatch.setattr(main, "run_dub",
                        lambda **kw: {"job_id": "x", "out_path": kw["out_path"]})
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)

    os.remove(os.path.join(client.get(f"/api/dub/jobs/{jid}").json()["work_dir"], "input.mp4"))
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 409
    assert r.json()["detail"] == "This job's video is no longer on disk."


def test_deleting_a_cancelling_job_is_refused(monkeypatch):
    # The thread only stops at the next stage boundary, so until it does it is
    # still writing into the folder this would pull out from under it.
    started = threading.Event()
    release = threading.Event()

    def fake_run_dub(**kw):
        started.set()
        release.wait(5)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    jid = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    ).json()["job_id"]
    assert started.wait(2), "fake job never started"
    try:
        assert client.post(f"/api/dub/jobs/{jid}/cancel").json()["status"] == "cancelling"
        r = client.delete(f"/api/dub/jobs/{jid}/workspace")
        assert r.status_code == 409
    finally:
        release.set()


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
    # job.json is written atomically at the end of the job thread; on a slow
    # runner the in-memory status can flip to done a beat before the file lands.
    saved = None
    for _ in range(100):
        try:
            with open(os.path.join(work, "job.json"), encoding="utf-8") as f:
                saved = json.load(f)
            if saved["status"] == "done":
                break
        # PermissionError: Windows refuses to open the file while the atomic
        # replace that writes it is still holding it.
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            pass
        time.sleep(0.02)
    assert saved["id"] == jid and saved["status"] == "done"
    assert saved["result"]["out_path"].endswith("dubbed.mp4")


def test_starting_the_app_restores_yesterdays_jobs(monkeypatch):
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
    monkeypatch.setattr(main, "job_store", jobs.JobStore())

    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        rows = c.get("/api/dub/jobs").json()["jobs"]

    assert [r["id"] for r in rows] == ["restored-1"]
    assert rows[0]["project"] == "yesterday" and rows[0]["status"] == "done"


# --- what a retry runs ON --------------------------------------------------
# Pressing "Try again" has to mean the same run the user would get by starting
# the job by hand: the app's own speech-to-text setting, the target language by
# name, and the same seconds of video.

def _restored_job(tmp_path, **fields):
    """A job as it comes back from job.json after a restart: its folder with the
    video still in it, and only the fields job.json keeps."""
    work = tmp_path / "restored"
    work.mkdir(exist_ok=True)
    (work / "input.mp4").write_bytes(b"vid")
    jid = main.job_store.create()
    main.job_store._update(jid, status="error", work_dir=str(work),
                           project="restored", **fields)
    return jid


def _wait_for(calls, n=1, secs=4):
    for _ in range(int(secs / 0.02)):
        if len(calls) >= n:
            return calls
        time.sleep(0.02)
    raise AssertionError("run_dub was never called")


def test_dub_retry_of_a_restored_job_sends_the_language_name_not_its_code(monkeypatch, tmp_path):
    # A job saved before the name was kept in job.json has only "ko" left, and
    # run_dub's language goes into the translation prompt and to the voice
    # sidecar -- both of which want "Korean".
    calls = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: calls.append(kw))
    jid = _restored_job(tmp_path, language_code="ko")

    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 200
    assert _wait_for(calls)[0]["language"] == "Korean"


def test_dub_retry_keeps_the_language_name_the_job_was_saved_with(monkeypatch, tmp_path):
    # And a name that was saved wins over the one the code maps to.
    calls = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: calls.append(kw))
    jid = _restored_job(tmp_path, language_code="pt", language="Brazilian Portuguese")

    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 200
    assert _wait_for(calls)[0]["language"] == "Brazilian Portuguese"


def test_dub_retry_uses_the_apps_own_speech_to_text_setting(monkeypatch, tmp_path):
    # Left out, run_dub falls back to local Whisper -- so a Perso job came back
    # transcribed by something else, with nothing on screen to say so.
    calls = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: calls.append(kw))
    monkeypatch.setattr(main, "default_stt_engine", lambda: "perso")
    jid = _restored_job(tmp_path, language_code="ko")

    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 200
    assert _wait_for(calls)[0]["stt_engine"] == "perso"


def test_dub_retry_cuts_a_link_job_whose_video_was_never_cut(monkeypatch, tmp_path):
    # A link is downloaded and cut inside the job thread, so a job that died at
    # the cut still holds the whole video -- and its second run would dub every
    # minute the user cut away.
    cuts = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: None)
    monkeypatch.setattr(main, "_cut_video", lambda p, s, e: cuts.append((s, e)))
    jid = _restored_job(tmp_path, language_code="ko", from_link=True,
                        trim={"start": 5, "end": 20}, trim_pending=True)

    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    assert cuts == [(5, 20)]
    # And the new job owes no cut, so retrying IT does not cut a second time.
    assert client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()["trim_pending"] is False


def test_dub_retry_does_not_cut_a_video_that_was_already_cut(monkeypatch, tmp_path):
    cuts = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: None)
    monkeypatch.setattr(main, "_cut_video", lambda p, s, e: cuts.append((s, e)))
    jid = _restored_job(tmp_path, language_code="ko",
                        trim={"start": 5, "end": 20}, trim_pending=False)

    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 200
    assert cuts == []


def test_dub_retry_of_a_job_saved_before_the_marker_existed_does_not_cut(monkeypatch, tmp_path):
    # Those job.json files have a trim and nothing to say whether it was made.
    # Every one of them was cut (an upload is cut before its record exists, and
    # a link job's cut is the same second as its download), and cutting a cut
    # video again gives the user the wrong seconds -- worse than not cutting.
    cuts = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: None)
    monkeypatch.setattr(main, "_cut_video", lambda p, s, e: cuts.append((s, e)))
    jid = _restored_job(tmp_path, language_code="ko", from_link=True,
                        trim={"start": 5, "end": 20})   # no trim_pending at all

    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 200
    assert cuts == []


def _dubbed_job(tmp_path, texts, edits=None, stale=()):
    """A finished job whose script, line manifest and per-line voices are on disk.

    texts are the lines the translation wrote; edits maps a 1-based line number
    to what the user rewrote it as, and stale names the lines whose voice is to
    look older than the script (which is what load_lines reads as "the words
    moved on without it").
    """
    from app.text.srt import build_srt

    work = tmp_path / "dubbed"
    work.mkdir(exist_ok=True)
    (work / "input.mp4").write_bytes(b"vid")
    cues = [{"start": i * 2.0, "end": i * 2.0 + 1.8, "text": t}
            for i, t in enumerate(texts)]
    (work / "translated.srt").write_text(build_srt(cues), encoding="utf-8")
    if edits:
        edited = [dict(c) for c in cues]
        for line, text in edits.items():
            edited[line - 1]["text"] = text
        (work / "edited.srt").write_text(build_srt(edited), encoding="utf-8")
    (work / "lines.json").write_text(json.dumps({
        "language": "Korean",
        "lines": [{"i": i, "speaker": "SPEAKER_00", "start": c["start"], "gain": 1.0}
                  for i, c in enumerate(cues)],
    }), encoding="utf-8")

    script = os.path.getmtime(main.script_path(str(work)))
    for i in range(len(texts)):
        wav = work / ("qwen_line_%d.wav" % i)
        wav.write_bytes(b"")
        # Older than the script means stale; newer means this line's voice was
        # made after the last edit and has nothing to catch up on.
        os.utime(wav, (script, script + (-10 if (i + 1) in stale else 10)))

    jid = main.job_store.create()
    main.job_store._update(jid, status="done", work_dir=str(work), project="dubbed",
                           language_code="ko", language="Korean",
                           result={"out_path": str(work / "dubbed.mp4")})
    return jid


def test_stale_voices_remakes_nothing_when_every_voice_is_current(monkeypatch, tmp_path):
    said, built = [], []
    monkeypatch.setattr(main, "resynth_one_line",
                        lambda *a: said.append(a) or "made.wav")
    monkeypatch.setattr(main, "rebuild_dub", lambda *a: built.append(a))
    jid = _dubbed_job(tmp_path, ["one", "two", "three"])

    r = client.post(f"/api/dub/jobs/{jid}/voices/stale")
    assert r.status_code == 200
    assert r.json() == {"remade": [], "skipped": 3}
    # Nothing was spoken, so there is nothing to rebuild around either.
    assert said == [] and built == []


def test_stale_voices_remakes_only_the_rewritten_lines_and_rebuilds_once(monkeypatch, tmp_path):
    said, built = [], []
    monkeypatch.setattr(main, "resynth_one_line",
                        lambda *a: said.append(a) or "made.wav")
    monkeypatch.setattr(main, "rebuild_dub", lambda *a: built.append(a))
    # Lines 1 and 3 were rewritten and their voices have not caught up; line 2
    # is untouched, and line 4 was rewritten but already respoken since.
    jid = _dubbed_job(tmp_path, ["one", "two", "three", "four"],
                      edits={1: "ONE", 3: "THREE", 4: "FOUR"}, stale=(1, 3))

    r = client.post(f"/api/dub/jobs/{jid}/voices/stale")
    assert r.status_code == 200
    assert r.json() == {"remade": [1, 3], "skipped": 2}
    # The words handed to the synthesizer are the rewritten ones, not the old.
    assert [a[2] for a in said] == ["ONE", "THREE"]
    assert [a[1]["i"] for a in said] == [0, 2]
    assert len(built) == 1


def test_stale_voices_refuses_a_job_that_is_still_running(tmp_path):
    jid = _dubbed_job(tmp_path, ["one"], edits={1: "ONE"}, stale=(1,))
    main.job_store._update(jid, status="running")

    r = client.post(f"/api/dub/jobs/{jid}/voices/stale")
    assert r.status_code == 409


def test_one_line_voice_still_speaks_that_line_and_rebuilds(monkeypatch, tmp_path):
    # The sweep above and this share a helper now -- one line still goes
    # through, words and all.
    said, built = [], []
    monkeypatch.setattr(main, "resynth_one_line",
                        lambda *a: said.append(a) or "made.wav")
    monkeypatch.setattr(main, "rebuild_dub", lambda *a: built.append(a))
    jid = _dubbed_job(tmp_path, ["one", "two"], edits={2: "TWO"})

    r = client.post(f"/api/dub/jobs/{jid}/script/2/voice")
    assert r.status_code == 200 and r.json() == {"line": 2, "ok": True}
    assert [a[2] for a in said] == ["TWO"]
    assert len(built) == 1


# --- what a job was made with ----------------------------------------------
# The four engine choices are saved on the job (app/jobs.py SAVED_FIELDS) so a
# finished job can say what made it months later, and so "Try again" repeats
# the same choices instead of whatever the app's defaults are that day.

def _start_and_settle(monkeypatch, **form):
    # A pinned Perso workspace, so asking for Perso gets past the preflight.
    monkeypatch.setenv("PERSO_SPACE_SEQ", "1")
    monkeypatch.setattr(main, "run_dub",
                        lambda **kw: {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1})
    data = {"language": "Korean", "language_code": "ko"}
    data.update(form)
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")}, data=data)
    assert r.status_code == 200
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    return jid


def test_dub_start_records_the_engines_the_job_was_made_with(monkeypatch, tmp_path):
    jid = _start_and_settle(monkeypatch, stt_engine="perso", translate_engine="gemini", n_takes="4")

    job = client.get(f"/api/dub/jobs/{jid}").json()
    assert job["stt_engine"] == "perso"
    assert job["translator"] == "gemini"
    assert job["tts"] == "qwen3"
    assert job["quality"] == 4

    # And they are in the file beside the video, so a restart still knows them.
    with open(os.path.join(main.job_store.get(jid)["work_dir"], "job.json"), encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["stt_engine"] == "perso" and saved["translator"] == "gemini"
    assert saved["tts"] == "qwen3" and saved["quality"] == 4


def test_dub_start_records_what_the_defaults_resolved_to_not_the_blank(monkeypatch):
    # The form left every choice out, so what is saved has to be the answer the
    # app gave -- otherwise the finished screen has nothing to show.
    monkeypatch.setattr(main, "default_stt_engine", lambda: "")
    jid = _start_and_settle(monkeypatch)

    job = client.get(f"/api/dub/jobs/{jid}").json()
    assert job["stt_engine"] == "whisper"          # local Whisper, named
    assert job["translator"] == main.dub_setup.default_for("translator")
    assert job["quality"] == main.QWEN_N_TAKES


def test_dub_start_names_the_local_engine_whisper_however_it_was_asked_for(monkeypatch):
    jid = _start_and_settle(monkeypatch, stt_engine="local")
    assert client.get(f"/api/dub/jobs/{jid}").json()["stt_engine"] == "whisper"


def test_the_jobs_list_carries_the_engines_too(monkeypatch):
    # The Projects rows show them, and none of the four is a secret.
    jid = _start_and_settle(monkeypatch, stt_engine="perso", n_takes="1")
    row = next(r for r in client.get("/api/dub/jobs").json()["jobs"] if r["id"] == jid)
    assert row["stt_engine"] == "perso" and row["tts"] == "qwen3" and row["quality"] == 1
    assert "work_dir" not in row


def test_dub_retry_repeats_the_first_runs_engines(monkeypatch, tmp_path):
    # Not today's defaults: a Perso job that failed used to come back
    # transcribed by local Whisper with nothing on screen to say the choice
    # had changed.
    calls = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: calls.append(kw))
    monkeypatch.setattr(main, "default_stt_engine", lambda: "")
    jid = _restored_job(tmp_path, language_code="ko", stt_engine="perso",
                        translator="gemini", tts="qwen3", quality=4)

    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    kw = _wait_for(calls)[0]
    assert kw["stt_engine"] == "perso"
    assert kw["translate_engine"] == "gemini"
    assert kw["n_takes"] == 4
    # ...and the new job carries them, so its own finished screen says the same.
    new = client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()
    assert new["stt_engine"] == "perso" and new["translator"] == "gemini" and new["quality"] == 4


def test_dub_retry_of_a_job_saved_before_the_engines_were_kept(monkeypatch, tmp_path):
    # Nothing to inherit, so the app's own setting decides -- and the new job
    # records what that turned out to be.
    calls = []
    monkeypatch.setattr(main, "run_dub", lambda **kw: calls.append(kw))
    monkeypatch.setattr(main, "default_stt_engine", lambda: "perso")
    jid = _restored_job(tmp_path, language_code="ko")

    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    assert _wait_for(calls)[0]["stt_engine"] == "perso"
    assert client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()["stt_engine"] == "perso"


def test_dub_start_sep_engine_perso_forwarded(monkeypatch):
    # The sep_engine form field must reach the pipeline and the job record
    # (the record is what "Try again" replays months later).
    captured = {}

    def fake_run_dub(**kw):
        captured.update(kw)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "sep_engine": "perso"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    for _ in range(100):
        job = client.get(f"/api/dub/jobs/{jid}").json()
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert captured["sep_engine"] == "perso"
    assert job["separation"] == "perso"


def test_dub_start_sep_engine_defaults_to_demucs(monkeypatch):
    def fake_run_dub(**kw):
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
    job = client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()
    assert job["separation"] == "demucs"


def test_dub_start_sep_engine_unknown_is_422():
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "sep_engine": "container"},
    )
    assert r.status_code == 422


def test_dub_start_sep_perso_without_key_is_422(monkeypatch):
    monkeypatch.setattr(main, "perso_available", lambda: False)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "sep_engine": "perso"},
    )
    assert r.status_code == 422
    assert "Perso separation" in r.json()["detail"]


class _FakeCloudClient:
    """Stands in for PersoClient in cloud-dub tests: writes the "dubbed" file
    the way the real dub_video does, and records what it was asked."""
    calls = []

    def __init__(self, *a, **kw):
        self.cancel_check = None

    def dub_video(self, video_path, out_path, source_code, target_code, num_speakers=None, space_seq=None, log=None):
        _FakeCloudClient.calls.append({
            "video": video_path, "out": out_path, "source": source_code,
            "target": target_code, "speakers": num_speakers,
        })
        with open(out_path, "wb") as f:
            f.write(b"CLOUDMP4")
        return out_path


def _wait_done(jid):
    for _ in range(200):
        j = client.get(f"/api/dub/jobs/{jid}").json()
        if j["status"] != "running":
            return j
        time.sleep(0.02)
    return j


def test_dub_start_cloud_mode_skips_local_pipeline(monkeypatch):
    _FakeCloudClient.calls = []
    monkeypatch.setattr(main, "PersoClient", _FakeCloudClient)

    def never(**kw):
        raise AssertionError("run_dub must not run in cloud mode")

    monkeypatch.setattr(main, "run_dub", never)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en",
              "source_language_code": "ko", "dub_mode": "perso", "num_speakers": "2"},
    )
    assert r.status_code == 200
    j = _wait_done(r.json()["job_id"])
    assert j["status"] == "done"
    assert j["dub_mode"] == "perso"
    call = _FakeCloudClient.calls[0]
    assert call["target"] == "en" and call["source"] == "ko" and call["speakers"] == 2
    # and the finished file is the cloud one
    rr = client.get(f"/api/dub/result/{j['id']}")
    assert rr.content == b"CLOUDMP4"


def test_dub_start_cloud_mode_unknown_value_is_422():
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "dub_mode": "banana"},
    )
    assert r.status_code == 422


def test_dub_start_cloud_mode_without_key_is_422(monkeypatch):
    monkeypatch.setattr(main, "perso_available", lambda: False)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "dub_mode": "perso"},
    )
    assert r.status_code == 422
    assert "Perso" in r.json()["detail"]


def test_dub_start_cloud_mode_credit_exhaustion_fails_with_notice(monkeypatch):
    from app.perso_client import PersoCreditExhaustedError

    class BrokeClient(_FakeCloudClient):
        def dub_video(self, *a, **kw):
            raise PersoCreditExhaustedError()

    monkeypatch.setattr(main, "PersoClient", BrokeClient)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en", "dub_mode": "perso"},
    )
    assert r.status_code == 200
    j = _wait_done(r.json()["job_id"])
    assert j["status"] == "error"
    notices = client.get(f"/api/dub/jobs/{j['id']}").json().get("notices") or []
    assert any(n.get("type") == "perso_credit_exhausted" for n in notices)


class _ScriptedCloudClient(_FakeCloudClient):
    """Cloud fake that also carries a project seq and serves its script."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.last_dub_project_seq = 409873

    def get_project_script(self, project_seq, space_seq=None):
        assert project_seq == 409873
        return {"sentences": [
            {"seq": 1, "originalText": "안녕", "translatedText": "Hi there",
             "offsetMs": 270, "durationMs": 5940, "speakerOrderIndex": 1,
             "audioUrl": "/perso-storage/a1.wav"},
            {"seq": 2, "originalText": "잘 가", "translatedText": "Bye now",
             "offsetMs": 6500, "durationMs": 900, "speakerOrderIndex": 2,
             "audioUrl": "/perso-storage/a2.wav"},
        ], "speakers": [{"speakerOrderIndex": 1}, {"speakerOrderIndex": 2}]}


def test_cloud_job_keeps_its_project_and_serves_the_perso_script(monkeypatch):
    monkeypatch.setattr(main, "PersoClient", _ScriptedCloudClient)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en", "dub_mode": "perso"},
    )
    assert r.status_code == 200
    j = _wait_done(r.json()["job_id"])
    assert j["status"] == "done"
    assert j["perso_project_seq"] == 409873

    rs = client.get(f"/api/dub/jobs/{j['id']}/script")
    assert rs.status_code == 200
    body = rs.json()
    # Read-only for now: editing Perso lines is the next stage's work.
    assert body["readonly"] is True
    lines = body["lines"]
    assert [l["text"] for l in lines] == ["Hi there", "Bye now"]
    assert lines[0]["source"] == "안녕"
    assert lines[0]["start"] == 0.27 and lines[0]["end"] == 6.21
    assert lines[0]["line"] == 1 and lines[1]["speaker"] == 2


def test_cloud_job_without_a_recorded_project_404s_the_script(monkeypatch):
    monkeypatch.setattr(main, "PersoClient", _FakeCloudClient)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en", "dub_mode": "perso"},
    )
    j = _wait_done(r.json()["job_id"])
    assert client.get(f"/api/dub/jobs/{j['id']}/script").status_code == 404


def test_perso_speaker_change_maps_the_line_and_verifies(monkeypatch):
    class SpeakerClient(_ScriptedCloudClient):
        added = []

        def add_speaker_from_sentence(self, project_seq, sentence_seq, space_seq=None):
            SpeakerClient.added.append((project_seq, sentence_seq))
            return {"ok": True}

        def get_project_script(self, project_seq, space_seq=None):
            script = super().get_project_script(project_seq, space_seq)
            if SpeakerClient.added:
                # after the write, the second line carries a fresh speaker
                script["sentences"][1]["speakerOrderIndex"] = 9
            return script

    SpeakerClient.added = []
    monkeypatch.setattr(main, "PersoClient", SpeakerClient)
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en", "dub_mode": "perso"},
    )
    j = _wait_done(r.json()["job_id"])

    rs = client.post(f"/api/dub/jobs/{j['id']}/perso/speaker", json={"line": 2})
    assert rs.status_code == 200
    assert rs.json() == {"line": 2, "old_speaker": 2, "new_speaker": 9}
    # the write targeted line 2's own sentence seq
    assert SpeakerClient.added == [(409873, 2)]

    # a local job refuses: only Perso dubs have server-side speakers
    r2 = client.post("/api/dub/jobs/nope/perso/speaker", json={"line": 1})
    assert r2.status_code == 404


def test_materialize_turns_a_perso_dub_editable(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "PersoClient", _ScriptedCloudClient)

    def fake_materialize(pc, seq, work_dir, language, **kw):
        assert seq == 409873
        with open(os.path.join(work_dir, "translated.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,270 --> 00:00:06,210\nHi there\n")
        with open(os.path.join(work_dir, "original.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,270 --> 00:00:06,210\n안녕\n")
        return {"lines": 1, "speakers": 1}

    monkeypatch.setattr(main.perso_materialize, "materialize", fake_materialize)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "English", "language_code": "en", "dub_mode": "perso"},
    )
    j = _wait_done(r.json()["job_id"])
    # before: the live, read-only mirror
    assert client.get(f"/api/dub/jobs/{j['id']}/script").json()["readonly"] is True

    rm = client.post(f"/api/dub/jobs/{j['id']}/perso/materialize")
    assert rm.status_code == 200
    assert rm.json()["lines"] == 1

    # after: served from the local files, editable like any other job
    body = client.get(f"/api/dub/jobs/{j['id']}/script").json()
    assert body.get("readonly") is None
    assert body["lines"][0]["text"] == "Hi there"
    assert body["lines"][0]["source"] == "안녕"
