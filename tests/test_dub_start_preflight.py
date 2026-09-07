"""dub_start's missing-model preflight: a 409 whose body is exactly what the
screen needs to draw the "Download N GB of AI models to dub?" dialog."""
import os

import pytest
from fastapi.testclient import TestClient

from app import engines_status, perso_client, state
from app.api import dub as dub_api
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


# The two packs the desktop app installs on demand. The fixture below lays
# them down, as every 0.5.2 kit has them; the tests about a fresh install
# take them away again.
def _put_packs(kit):
    _mk(kit, ".install", "venv-engines.ok")
    _mk(kit, "models", "demucs", "HTDemucs", "955717e8.safetensors")
    _mk(kit, "ollama", "ollama")


def _remove_packs(kit):
    import shutil
    for rel in (".install", os.path.join("models", "demucs"), "ollama"):
        shutil.rmtree(os.path.join(kit, rel), ignore_errors=True)


@pytest.fixture(autouse=True)
def _kit(monkeypatch, tmp_path):
    kit = str(tmp_path / "kit")
    os.makedirs(kit)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)
    monkeypatch.setattr(engines_status, "gemini_available", lambda: True)
    monkeypatch.setattr(engines_status, "perso_available", lambda: True)
    _put_packs(kit)
    # ...and their processes are up: the desktop shell announces the voice
    # engine in runtime.json, and a local dub is refused without that.
    import json
    with open(os.path.join(kit, "runtime.json"), "w") as f:
        json.dump({"version": 1, "tts_url": "http://127.0.0.1:1", "ollama_url": "http://127.0.0.1:1"}, f)
    yield kit


def _start(data_extra=None):
    data = {"language": "Korean", "language_code": "ko", "translate_engine": "gemini"}
    data.update(data_extra or {})
    return client.post("/api/dub/start",
                       files={"video": ("v.mp4", b"vid", "video/mp4")}, data=data)


def test_409_lists_every_missing_model_and_no_job_is_created(monkeypatch, _kit):
    created = {"n": 0}
    monkeypatch.setattr(state.job_store, "create",
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
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    assert _start().status_code == 200


def test_perso_stt_does_not_need_whisper(monkeypatch, _kit):
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "current_value", lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    r = _start({"stt_engine": "perso"})
    assert r.status_code == 200


def test_gemma_model_missing_joins_the_409_list(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "model_missing")
    r = _start({"translate_engine": "gemma"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["gemma"]


def test_gemma_unreachable_is_still_a_422(monkeypatch, _kit):
    # A down Ollama is not a missing download -- no dialog can fix it.
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "unreachable")
    r = _start({"translate_engine": "gemma"})
    assert r.status_code == 422
    # Inside a kit the sentence is the desktop user's: the app owns the runtime.
    assert "translation runtime is not running" in r.json()["detail"]


def test_hunyuan_model_missing_joins_the_409_list(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(engines_status, "hunyuan_status", lambda: "model_missing")
    r = _start({"translate_engine": "hunyuan"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["hunyuan"]


def test_cloud_mode_needs_no_local_models(monkeypatch, _kit):
    # The whole point of the cloud path: an empty kit can still dub.
    class FakeClient:
        def __init__(self, *a, **kw):
            self.cancel_check = None

        def dub_video(self, video_path, out_path, *a, **kw):
            with open(out_path, "wb") as f:
                f.write(b"CLOUDMP4")
            return out_path

    monkeypatch.setattr(perso_client, "PersoClient", FakeClient)
    monkeypatch.setattr(dub_api, "current_value", lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
    r = _start({"dub_mode": "perso"})
    assert r.status_code == 200


def test_an_stt_engine_name_we_do_not_have_is_a_422(monkeypatch, _kit):
    """A saved STT_ENGINE nobody implements must be said out loud.

    app/config.py's default_stt_engine hands an unrecognized value back
    unchanged for exactly this: the alternative is dubbing with a different
    engine than the one the settings file asks for, without telling anyone.
    """
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setenv("STT_ENGINE", "whisperx")
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    r = _start()
    assert r.status_code == 422
    assert "Unknown stt_engine: whisperx" in r.json()["detail"]


# ── packs ──────────────────────────────────────────────────────────────────
# A fresh install has no packs: a local dub's 409 names the packs first, each
# marked kind "pack" so the screen sends them to the desktop app, and the
# models after, marked kind "model".
def test_a_fresh_install_is_asked_for_the_engine_pack_before_the_models(monkeypatch, _kit):
    _remove_packs(_kit)
    r = _start()
    assert r.status_code == 409
    missing = r.json()["detail"]["missing"]
    assert missing[0] == {"id": "engine", "kind": "pack", "name": "AI engine", "bytes": 2000000000}
    assert [m["id"] for m in missing[1:]] == ["qwen3-tts", "whisper"]
    assert all(m["kind"] == "model" for m in missing[1:])
    assert r.json()["detail"]["total_bytes"] == sum(m["bytes"] for m in missing)


def test_the_engine_pack_is_needed_even_when_perso_does_the_stt_and_separation(monkeypatch, _kit):
    # The voice is always made locally in a local dub.
    _remove_packs(_kit)
    _put_tts(_kit)
    r = _start({"stt_engine": "perso", "sep_engine": "perso"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["engine"]


def test_a_cloud_dub_needs_no_packs(monkeypatch, _kit):
    _remove_packs(_kit)
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: None)
    monkeypatch.setattr(perso_client, "PersoClient", lambda: type("C", (), {
        "dubbing_spaces": lambda self: [{"seq": 1}], "space_seq": 1})())
    r = _start({"dub_mode": "perso"})
    assert r.status_code == 200, r.json()


def test_a_local_translator_without_its_runtime_pack_asks_for_the_pack_and_the_model(monkeypatch, _kit):
    # Before: the reachability probe ran first and answered 422 "not running",
    # which no dialog can fix. Without the pack there is nothing to probe.
    import shutil
    shutil.rmtree(os.path.join(_kit, "ollama"))
    _put_whisper(_kit)
    _put_tts(_kit)
    def boom():
        raise AssertionError("no probe without the pack")
    monkeypatch.setattr(engines_status, "hunyuan_status", boom)
    r = _start({"translate_engine": "hunyuan"})
    assert r.status_code == 409
    missing = r.json()["detail"]["missing"]
    assert [(m["id"], m["kind"]) for m in missing] == [("ollama-runtime", "pack"), ("hunyuan", "model")]


def test_the_packs_ride_along_in_the_ordinary_409(monkeypatch, _kit):
    # With the packs on disk the list is the models alone, as before.
    r = _start()
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["qwen3-tts", "whisper"]
    assert all(m["kind"] == "model" for m in r.json()["detail"]["missing"])


def test_an_engine_pack_whose_process_is_not_running_is_told_plainly(monkeypatch, _kit):
    # Packs on disk, models on disk, but the kit's runtime.json names no voice
    # engine (its start failed): a 422 with a sentence, not a raw error from
    # the voice stage minutes later.
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    os.remove(os.path.join(_kit, "runtime.json"))   # the fixture's announced engine goes away
    r = _start()
    assert r.status_code == 422
    assert r.json()["detail"] == "The voice engine is not running. Quit and reopen PersoDub."
    import json
    with open(os.path.join(_kit, "runtime.json"), "w") as f:
        json.dump({"version": 1, "tts_url": "http://127.0.0.1:1"}, f)
    assert _start().status_code == 200
