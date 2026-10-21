"""Model download/cancel/remove endpoints (app/models.py + app/main.py).

The real downloaders are subprocess/network work -- these tests swap them for
fakes that block on an event, so state transitions (queue, cancel, resume)
can be exercised deterministically.
"""
import os
import threading
import time

import pytest
import requests
from fastapi.testclient import TestClient

from app import models as models_module
from app import state
from app.jobs import JobStore
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    kit = str(tmp_path / "kit")
    os.makedirs(kit, exist_ok=True)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)
    models_module.reset_downloads_for_tests()
    # Plenty of disk unless a test says otherwise.
    monkeypatch.setattr(models_module, "free_bytes_at", lambda path: 10**12)
    yield


def _install_fake_downloader(monkeypatch, gate=None, fail=None):
    """Both kinds download via one fake that reports 50% then waits on gate."""
    def fake(entry, kit, progress, cancelled):
        # the downloader always creates the model dir first (hf --local-dir does)
        os.makedirs(os.path.join(kit, *entry["dir"].split("/")), exist_ok=True)
        progress(50)
        if gate is not None:
            gate.wait(5)
        if fail is not None:
            raise fail if isinstance(fail, BaseException) else RuntimeError(fail)
        if cancelled():
            return
        for m in entry["markers"]:
            p = os.path.join(kit, *entry["dir"].split("/"), *m.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "wb").write(b"w")
    monkeypatch.setattr(models_module, "_run_download", fake)


def _wait_state(mid, want, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = client.get("/api/models").json()["models"]
        got = next(m for m in rows if m["id"] == mid)
        if got["state"] in want:
            return got
        time.sleep(0.05)
    return next(m for m in client.get("/api/models").json()["models"] if m["id"] == mid)


def test_download_transitions_to_ready(monkeypatch):
    _install_fake_downloader(monkeypatch)
    r = client.post("/api/models/whisper/download")
    assert r.status_code == 202
    assert _wait_state("whisper", ("ready",))["state"] == "ready"


def test_download_reports_progress_and_double_post_is_200(monkeypatch):
    gate = threading.Event()
    _install_fake_downloader(monkeypatch, gate=gate)
    assert client.post("/api/models/whisper/download").status_code == 202
    # The state flips to downloading a moment before the fake reports 50%:
    # wait for the number too, or a slow runner reads the row before it has one (Windows CI).
    deadline = time.time() + 5.0
    row = _wait_state("whisper", ("downloading",))
    while row["progress"] != 50 and time.time() < deadline:
        time.sleep(0.05)
        row = _wait_state("whisper", ("downloading",))
    assert row["state"] == "downloading" and row["progress"] == 50
    assert client.post("/api/models/whisper/download").status_code == 200
    gate.set()
    _wait_state("whisper", ("ready",))


def test_one_at_a_time_queue(monkeypatch):
    gate = threading.Event()
    _install_fake_downloader(monkeypatch, gate=gate)
    client.post("/api/models/whisper/download")
    _wait_state("whisper", ("downloading",))
    assert client.post("/api/models/qwen3-tts/download").status_code == 202
    row = next(m for m in client.get("/api/models").json()["models"] if m["id"] == "qwen3-tts")
    # Queued shows as downloading-with-no-percent -- the screen says "waiting".
    assert row["state"] == "downloading" and row.get("progress") is None
    gate.set()
    _wait_state("qwen3-tts", ("ready",))


def test_a_started_download_has_no_figure_before_its_first_byte_and_a_queued_one_says_queued(monkeypatch):
    # Both read downloading with no figure: queued tells "Waiting to download"
    # from "Getting ready", and 0% is never shown before a byte (Windows C2, 2026-10-21).
    gate, began = threading.Event(), threading.Event()

    def fake(entry, kit, progress, cancelled):
        began.set()
        gate.wait(5)
    monkeypatch.setattr(models_module, "_run_download", fake)
    client.post("/api/models/whisper/download")
    assert began.wait(5)
    client.post("/api/models/qwen3-tts/download")
    rows = {m["id"]: m for m in client.get("/api/models").json()["models"]}
    assert [rows["whisper"].get(k) for k in ("state", "progress", "queued")] == ["downloading", None, False]
    assert [rows["qwen3-tts"].get(k) for k in ("state", "progress", "queued")] == ["downloading", None, True]
    gate.set()
    _wait_state("qwen3-tts", ("not_downloaded",))


def test_cancel_leaves_a_paused_model(monkeypatch):
    gate = threading.Event()
    _install_fake_downloader(monkeypatch, gate=gate)
    client.post("/api/models/whisper/download")
    _wait_state("whisper", ("downloading",))
    assert client.post("/api/models/whisper/cancel").status_code == 200
    gate.set()
    # The fake made the directory but no markers -> disk says paused.
    assert _wait_state("whisper", ("paused",))["state"] == "paused"


def test_failed_download_reports_error_then_paused_state(monkeypatch):
    gate = threading.Event(); gate.set()
    _install_fake_downloader(monkeypatch, gate=gate, fail="network died")
    client.post("/api/models/whisper/download")
    row = _wait_state("whisper", ("paused",))
    assert row["state"] == "paused"
    assert row.get("error") == "Connection lost."


# What the screen says when a download stops: the reason in plain words, never
# the exception (Windows H9/H10, 2026-10-06: "ChunkedEncodingError" was shown).
@pytest.mark.parametrize("fail, said", [
    (requests.exceptions.ChunkedEncodingError(
        "('Connection broken: IncompleteRead(1052 bytes read, 2048 more expected)')"), "Connection lost."),
    ("hf download exited 1: requests.exceptions.ChunkedEncodingError: ('Connection broken: "
     "IncompleteRead(0 bytes read)')", "Connection lost."),
    ("hf download exited 1: httpx.ReadTimeout: The read operation timed out", "Connection lost."),
    (OSError(28, "No space left on device"), "Not enough space on this computer."),
    ("hf download exited 1: Traceback (most recent call last): KeyError: 'sha'", "The download stopped."),
])
def test_a_stopped_download_says_why_in_plain_words(monkeypatch, fail, said):
    gate = threading.Event(); gate.set()
    _install_fake_downloader(monkeypatch, gate=gate, fail=fail)
    client.post("/api/models/whisper/download")
    assert _wait_state("whisper", ("paused",)).get("error") == said


def test_a_cancel_that_breaks_the_connection_is_still_a_cancel(monkeypatch):
    gate = threading.Event()
    _install_fake_downloader(monkeypatch, gate=gate,
                             fail=requests.exceptions.ChunkedEncodingError("Connection broken"))
    client.post("/api/models/whisper/download")
    _wait_state("whisper", ("downloading",))
    client.post("/api/models/whisper/cancel")
    gate.set()
    _wait_state("whisper", ("paused",))
    time.sleep(0.2)
    assert "error" not in next(m for m in client.get("/api/models").json()["models"] if m["id"] == "whisper")


def test_remove_deletes_and_refuses_while_dubbing(monkeypatch, tmp_path):
    kit = os.environ["PERSODUB_KIT_DIR"]
    p = os.path.join(kit, "models", "whisper", "faster-whisper-large-v3", "model.bin")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(b"w")
    # A running dub must block removal.
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: True)
    assert client.delete("/api/models/whisper").status_code == 409
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: False)
    assert client.delete("/api/models/whisper").status_code == 200
    assert _wait_state("whisper", ("not_downloaded",))["state"] == "not_downloaded"


@pytest.mark.parametrize("status, refused", [
    ("queued", True), ("running", True), ("cancelling", True),
    ("done", False), ("error", False), ("cancelled", False),
])
def test_a_job_still_using_the_models_blocks_removal(monkeypatch, status, refused):
    # A stopped job runs on until its next checkpoint, and a queued one loads
    # the models the moment its turn comes.
    store = JobStore()
    store.update(store.create(), status=status)
    monkeypatch.setattr(state, "job_store", store)
    p = os.path.join(os.environ["PERSODUB_KIT_DIR"], "models", "whisper", "faster-whisper-large-v3", "model.bin")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(b"w")
    assert client.delete("/api/models/whisper").status_code == (409 if refused else 200)
    assert os.path.exists(p) == refused


def test_download_refuses_when_disk_is_short(monkeypatch):
    monkeypatch.setattr(models_module, "free_bytes_at", lambda path: 10)
    r = client.post("/api/models/whisper/download")
    assert r.status_code == 409
    assert "space" in r.json()["detail"].lower()


def test_unknown_model_is_404():
    assert client.post("/api/models/nope/download").status_code == 404

def test_the_catalog_says_which_platform_its_sizes_are_for(monkeypatch):
    # The erase screen needs to know a Windows machine has no GPU: the same
    # key the pack sizes are picked by answers it (2026-09-10).
    from app import models as models_mod
    monkeypatch.setattr(models_mod, "platform_key", lambda: "win-cpu")
    assert client.get("/api/models").json()["platform"] == "win-cpu"
    monkeypatch.setattr(models_mod, "platform_key", lambda: "mac")
    assert client.get("/api/models").json()["platform"] == "mac"
