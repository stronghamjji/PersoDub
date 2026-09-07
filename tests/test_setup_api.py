"""GET/POST /api/setup: the per-stage defaults the screen and the Dub Agent
share, saved in kit.env and read at use time (app/setup.py)."""
from fastapi.testclient import TestClient

from app import engines_status, main
from app import setup as dub_setup
from app.api import dub as dub_api
from app.api import models as models_api

client = TestClient(main.app, base_url="http://127.0.0.1")


def _kit(tmp_path, monkeypatch, text="PERSODUB_KIT_DIR=/x\n# PERSO_API_KEY=\n"):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_text(text, encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    monkeypatch.delenv("TRANSLATE_ENGINE", raising=False)
    monkeypatch.delenv("STT_ENGINE", raising=False)
    # The report reads the keys the way the stage defaults do (kit.env first,
    # then the process env), so a key exported on the developer's own machine
    # would otherwise decide these tests.
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(models_api.model_store, "status_rows", lambda: [])
    return kit


def test_get_reports_hunyuan_and_local_as_the_untouched_defaults(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch)
    r = client.get("/api/setup")
    assert r.status_code == 200
    d = r.json()["defaults"]
    assert d == {"dub_mode": "local", "separation": "local", "stt": "local",
                 "translator": "hunyuan", "voice_quality": "fast"}
    assert r.json()["keys"] == {"perso": False, "gemini": False}
    assert "translator" in r.json()["choices"]


def test_the_keys_and_the_stt_default_read_the_same_source(tmp_path, monkeypatch):
    # A key that lives in the process env only (a server deployment, or a kit
    # that never mentions the key): the stt default has always seen it, so the
    # report must not say stt "perso" beside keys.perso false.
    _kit(tmp_path, monkeypatch)
    monkeypatch.setenv("PERSO_API_KEY", "ENVKEY")
    body = client.get("/api/setup").json()
    assert body["defaults"]["stt"] == "perso"
    assert body["keys"]["perso"] is True


def test_a_key_cleared_in_kit_env_reads_as_no_key(tmp_path, monkeypatch):
    # ...and the other way round: cleared in Settings beats the key the app
    # happened to start with, for the report exactly as for the default.
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\nPERSO_API_KEY=\n")
    monkeypatch.setenv("PERSO_API_KEY", "STARTUPKEY")
    body = client.get("/api/setup").json()
    assert body["defaults"]["stt"] == "local"
    assert body["keys"]["perso"] is False


def test_post_saves_a_default_and_the_next_read_sees_it(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch)
    r = client.post("/api/setup", json={"translator": "gemma", "voice_quality": "high"})
    assert r.status_code == 200
    assert r.json()["defaults"]["translator"] == "gemma"
    text = (kit / "kit.env").read_text(encoding="utf-8")
    assert "TRANSLATE_ENGINE=gemma" in text and "VOICE_QUALITY=high" in text
    assert client.get("/api/setup").json()["defaults"]["voice_quality"] == "high"
    assert dub_setup.default_n_takes() == 4


def test_post_refuses_a_choice_the_stage_does_not_offer(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch)
    r = client.post("/api/setup", json={"translator": "llama"})
    assert r.status_code == 422 and "one of" in r.json()["detail"]
    assert "TRANSLATE_ENGINE" not in (kit / "kit.env").read_text(encoding="utf-8")


def test_a_saved_default_drives_the_dub_without_a_restart(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch)
    client.post("/api/setup", json={"translator": "gemma", "separation": "perso"})
    used = dub_api._engines_used()
    assert used["translator"] == "gemma" and used["separation"] == "perso"


def test_no_kit_means_503(monkeypatch, tmp_path):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path / "nowhere"))
    r = client.post("/api/setup", json={"translator": "gemma"})
    assert r.status_code == 503


def test_a_saved_perso_stt_still_needs_the_key(tmp_path, monkeypatch):
    # STT_ENGINE=perso saved by the agent, key gone since: the preflight must
    # refuse, not let run_dub resolve to Perso behind the guards' back.
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\nSTT_ENGINE=perso\nPERSO_API_KEY=\n")
    monkeypatch.setattr(engines_status, "perso_available", lambda: False)
    # The translator preflight runs first; on a machine without Ollama (CI) it
    # would answer for Hunyuan before the STT check is reached.
    monkeypatch.setattr(engines_status, "hunyuan_status", lambda: "available")
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                    data={"language": "Korean", "language_code": "ko"})
    assert r.status_code == 422 and "Perso" in r.json()["detail"]
