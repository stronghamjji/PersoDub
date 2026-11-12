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
    monkeypatch.delenv("DUB_MODE", raising=False)
    # The report reads the keys the way the stage defaults do (kit.env first,
    # then the process env), so a key exported on the developer's own machine
    # would otherwise decide these tests.
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(models_api.model_store, "status_rows", lambda: [])
    return kit


def test_get_reports_chatgpt_and_local_as_the_untouched_defaults(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch)
    r = client.get("/api/setup")
    assert r.status_code == 200
    d = r.json()["defaults"]
    assert d == {"dub_mode": "local", "separation": "local", "stt": "local",
                 "translator": "chatgpt", "voice_quality": "fast", "voice": "qwen3"}
    assert r.json()["keys"] == {"perso": False, "gemini": False}
    assert "translator" in r.json()["choices"]


def test_separation_offers_the_roformer_and_a_kit_that_has_it_keeps_separating_with_it(tmp_path, monkeypatch):
    # Demucs and Mel-Band RoFormer are two choices on the screen now. A kit
    # with the RoFormer downloaded separated with it while "local" meant "the
    # RoFormer when it is here"; with nothing saved it still does.
    kit = _kit(tmp_path, monkeypatch)
    assert client.get("/api/setup").json()["choices"]["separation"] == ["local", "roformer", "perso"]
    assert dub_setup.default_for("separation") == "local"
    weights = kit / "models" / "melband-roformer" / "MelBandRoformer.ckpt"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"w")
    assert dub_setup.default_for("separation") == "roformer"
    client.post("/api/setup", json={"separation": "local"})
    assert dub_setup.default_for("separation") == "local"


def test_the_keys_and_the_stt_default_read_the_same_source(tmp_path, monkeypatch):
    # A key that lives in the process env only (a server deployment, or a kit
    # that never mentions the key): the report sees it as saved, and the stt
    # default stays local, key or no key (owner, 2026-10-20).
    _kit(tmp_path, monkeypatch)
    monkeypatch.setenv("PERSO_API_KEY", "ENVKEY")
    body = client.get("/api/setup").json()
    assert body["defaults"]["stt"] == "local"
    assert body["defaults"]["dub_mode"] == "local"  # this computer, key or no key
    assert body["keys"]["perso"] is True


def test_a_dub_runs_on_this_computer_by_default_key_or_no_key(tmp_path, monkeypatch):
    # This computer, key or no key (owner, 2026-10-12).
    _kit(tmp_path, monkeypatch)
    for key in (None, "ENVKEY"):
        if key is None:
            monkeypatch.delenv("PERSO_API_KEY", raising=False)
        else:
            monkeypatch.setenv("PERSO_API_KEY", key)
        assert dub_setup.default_for("dub_mode") == "local", key
        assert client.get("/api/setup").json()["defaults"]["dub_mode"] == "local", key


def test_an_edition_line_in_an_older_kit_changes_nothing(tmp_path, monkeypatch):
    # An older version's kit.env carries a PERSODUB_EDITION line. Nothing
    # reads it: the defaults and the choices are the same with it.
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\nPERSODUB_EDITION=production\n")
    monkeypatch.setenv("PERSODUB_EDITION", "production")
    monkeypatch.setenv("PERSODUB_BUILD_EDITION", "production")
    body = client.get("/api/setup").json()
    assert body["defaults"]["dub_mode"] == "local"
    assert body["choices"]["voice"] == ["qwen3", "omnivoice"]


def test_a_saved_dub_mode_beats_the_default(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\nDUB_MODE=perso\n")
    assert dub_setup.default_for("dub_mode") == "perso"
    client.post("/api/setup", json={"dub_mode": "local"})
    assert dub_setup.default_for("dub_mode") == "local"


def test_without_a_key_start_asks_for_the_models_not_a_key(tmp_path, monkeypatch):
    # A dub runs on this computer, so a new install is asked for the models
    # it needs, not a key; with Perso saved as where dubs run, Start says to
    # save a key first (app/api/dub.py).
    kit = _kit(tmp_path, monkeypatch)
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                    data={"language": "Korean", "language_code": "ko"})
    assert r.status_code == 409 and "missing" in r.json()["detail"]

    (kit / "kit.env").write_text("PERSODUB_KIT_DIR=/x\nDUB_MODE=perso\n# PERSO_API_KEY=\n", encoding="utf-8")
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                    data={"language": "Korean", "language_code": "ko"})
    assert r.status_code == 422
    assert r.json()["detail"].startswith("Perso API dubbing needs an API key")


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


def test_an_unsaved_quality_runs_as_the_fast_the_screen_shows(tmp_path, monkeypatch):
    # /api/setup answered "fast" while the count in force was the engine's
    # own 4: an agent's Fast dub made four takes per line (0.6.2 full test,
    # F10, 2026-09-16). What the screen shows is what runs.
    _kit(tmp_path, monkeypatch)
    assert client.get("/api/setup").json()["defaults"]["voice_quality"] == "fast"
    assert dub_setup.default_n_takes() == 1


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


# ElevenLabs left the app (fb838b5). A tester who had saved it as the voice
# default gets Qwen3-TTS on the screen and in the dub that starts, instead of a
# default no dub could be made with (final review, 2026-10-12).
def test_a_saved_elevenlabs_voice_default_reads_as_qwen3(tmp_path, monkeypatch):
    _kit(tmp_path, monkeypatch, "PERSODUB_KIT_DIR=/x\nTTS_ENGINE=elevenlabs\n")
    monkeypatch.delenv("TTS_ENGINE", raising=False)
    assert client.get("/api/setup").json()["defaults"]["voice"] == "qwen3"
    assert dub_api._engines_used()["tts"] == "qwen3"


def test_omnivoice_can_be_saved_as_the_voice_and_drives_the_dub(tmp_path, monkeypatch):
    kit = _kit(tmp_path, monkeypatch)
    monkeypatch.delenv("TTS_ENGINE", raising=False)
    r = client.post("/api/setup", json={"voice": "omnivoice"})
    assert r.status_code == 200 and r.json()["defaults"]["voice"] == "omnivoice"
    assert "TTS_ENGINE=omnivoice" in (kit / "kit.env").read_text(encoding="utf-8")
    assert dub_api._engines_used()["tts"] == "omnivoice"


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


def test_an_install_that_has_hunyuan_keeps_it_as_the_default(tmp_path, monkeypatch):
    """Updating must not quietly start sending scripts to OpenAI (2026-09-24)."""
    from app import setup as setup_mod
    _kit(tmp_path, monkeypatch)
    monkeypatch.setattr(setup_mod, "_hunyuan_installed", lambda: True)
    assert client.get("/api/setup").json()["defaults"]["translator"] == "hunyuan"
    monkeypatch.setattr(setup_mod, "_hunyuan_installed", lambda: False)
    assert client.get("/api/setup").json()["defaults"]["translator"] == "chatgpt"
