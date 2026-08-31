"""Model download/cancel/remove endpoints (app/models.py + app/main.py).

The real downloaders are subprocess/network work -- these tests swap them for
fakes that block on an event, so state transitions (queue, cancel, resume)
can be exercised deterministically.
"""
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import models as models_module
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
            raise RuntimeError(fail)
        if cancelled():
            return
        for m in entry["markers"]:
            p = os.path.join(kit, *entry["dir"].split("/"), *m.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "wb").close()
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
    assert "network died" in (row.get("error") or "")


def test_remove_deletes_and_refuses_while_dubbing(monkeypatch, tmp_path):
    kit = os.environ["PERSODUB_KIT_DIR"]
    p = os.path.join(kit, "models", "whisper", "faster-whisper-large-v3", "model.bin")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").close()
    # A running dub must block removal.
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: True)
    assert client.delete("/api/models/whisper").status_code == 409
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: False)
    assert client.delete("/api/models/whisper").status_code == 200
    assert _wait_state("whisper", ("not_downloaded",))["state"] == "not_downloaded"


def test_download_refuses_when_disk_is_short(monkeypatch):
    monkeypatch.setattr(models_module, "free_bytes_at", lambda path: 10)
    r = client.post("/api/models/whisper/download")
    assert r.status_code == 409
    assert "space" in r.json()["detail"].lower()


def test_unknown_model_is_404():
    assert client.post("/api/models/nope/download").status_code == 404
