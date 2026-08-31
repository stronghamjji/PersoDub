"""dub_start's missing-model preflight: a 409 whose body is exactly what the
screen needs to draw the "Download N GB of AI models to dub?" dialog."""
import os

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _fake_run_dub(**kw):
    return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}


def _mk(kit, *rel):
    p = os.path.join(kit, *rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").close()


def _put_tts(kit):
    _mk(kit, "models", "qwen3-tts", "model.safetensors")
    _mk(kit, "models", "qwen3-tts", "speech_tokenizer", "model.safetensors")


def _put_whisper(kit):
    _mk(kit, "models", "whisper", "faster-whisper-large-v3", "model.bin")


@pytest.fixture(autouse=True)
def _kit(monkeypatch, tmp_path):
    kit = str(tmp_path / "kit")
    os.makedirs(kit)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)
    yield kit


def _start(data_extra=None):
    data = {"language": "Korean", "language_code": "ko", "translate_engine": "gemini"}
    data.update(data_extra or {})
    return client.post("/api/dub/start",
                       files={"video": ("v.mp4", b"vid", "video/mp4")}, data=data)


def test_409_lists_every_missing_model_and_no_job_is_created(monkeypatch, _kit):
    created = {"n": 0}
    monkeypatch.setattr(main.job_store, "create",
                        lambda *a, **kw: created.__setitem__("n", created["n"] + 1))
    r = _start()
    assert r.status_code == 409
    body = r.json()["detail"]
    ids = [m["id"] for m in body["missing"]]
    # Gemini translates in the cloud; the voice model and local whisper STT
    # are still needed and neither is downloaded. Catalog order.
    assert ids == ["qwen3-tts", "whisper"]
    for m in body["missing"]:
        assert m["name"] and m["bytes"] > 0
    assert body["total_bytes"] == sum(m["bytes"] for m in body["missing"])
    assert isinstance(body["free_bytes"], int)
    assert created["n"] == 0


def test_all_models_present_starts_the_job(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)
    assert _start().status_code == 200


def test_perso_stt_does_not_need_whisper(monkeypatch, _kit):
    _put_tts(_kit)
    monkeypatch.setattr(main, "current_value", lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)
    r = _start({"stt_engine": "perso"})
    assert r.status_code == 200


def test_gemma_model_missing_joins_the_409_list(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(main, "gemma_status", lambda: "model_missing")
    r = _start({"translate_engine": "gemma"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["gemma"]


def test_gemma_unreachable_is_still_a_422(monkeypatch, _kit):
    # A down Ollama is not a missing download -- no dialog can fix it.
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(main, "gemma_status", lambda: "unreachable")
    r = _start({"translate_engine": "gemma"})
    assert r.status_code == 422
    assert "not running or not reachable" in r.json()["detail"]


def test_hunyuan_model_missing_joins_the_409_list(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(main, "hunyuan_status", lambda: "model_missing")
    r = _start({"translate_engine": "hunyuan"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["hunyuan"]
