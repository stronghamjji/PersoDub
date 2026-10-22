"""dub_start's missing-model preflight: a 409 whose body is exactly what the
screen needs to draw the "Download N GB of AI models to dub?" dialog."""
import json
import logging
import os
import sys
import threading

import pytest
from fastapi.testclient import TestClient

from app import engines_status, models, perso_client, state
from app.api import _launch as launch_api
from app.api import dub as dub_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _fake_run_dub(**kw):
    return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}


def _mk(kit, *rel):
    p = os.path.join(kit, *rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(b"w")


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
    # The shell writes the binary with the platform's suffix, and app/models.py
    # looks for it that way.
    _mk(kit, "ollama", "ollama.exe" if sys.platform.startswith("win") else "ollama")


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
    monkeypatch.setattr(dub_api, "_voice_engine_answers", lambda url: True)
    yield kit


def _start(data_extra=None, files_extra=None):
    data = {"language": "Korean", "language_code": "ko", "translate_engine": "gemini"}
    data.update(data_extra or {})
    return client.post("/api/dub/start",
                       files={"video": ("v.mp4", b"vid", "video/mp4"), **(files_extra or {})}, data=data)


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
    monkeypatch.setattr(launch_api, "current_value", lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
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


def test_the_roformer_chosen_and_not_downloaded_joins_the_409_list(monkeypatch, _kit):
    # Advanced options lists Mel-Band RoFormer before it is downloaded
    # (feedback 2, 2026-10-20); starting with it asks for it like any model.
    _put_whisper(_kit)
    _put_tts(_kit)
    r = _start({"sep_engine": "roformer"})
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["vocal-separator"]
    _mk(_kit, "models", "melband-roformer", "MelBandRoformer.ckpt")
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    r = _start({"sep_engine": "roformer"})
    assert r.status_code == 200
    assert client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()["separation"] == "roformer"


def test_demucs_asks_for_no_roformer(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    r = _start({"sep_engine": "local"})
    assert r.status_code == 200
    assert client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()["separation"] == "demucs"


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
    monkeypatch.setattr(launch_api, "current_value", lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
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
    # The pack's size is per platform (2 GB on Mac, 9 GB for the CUDA build on
    # Windows): the catalog's figure for this one, as the screen would show.
    engine_bytes = models._pack_bytes(next(e for e in models.load_catalog() if e["id"] == "engine"))
    assert missing[0] == {"id": "engine", "kind": "pack", "name": "Python + PyTorch", "bytes": engine_bytes,
                          "hint": "Separates the sound, transcribes and makes the voices on this computer."}
    # Whisper and Qwen3-TTS have no hint in the catalog now (Settings' group
    # titles say what they are for): the field is still there, empty.
    assert [m["hint"] for m in missing[1:]] == ["", ""]
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


def test_a_cloud_dub_is_not_judged_by_the_local_pipeline_s_disk_need(monkeypatch, _kit):
    # The 2x-video-plus-per-minute need is the local pipeline's (stems, per-line
    # takes); a cloud dub only writes the returned video, which the floor covers.
    from app import room
    def boom(*a, **kw):
        raise AssertionError("a cloud dub is not judged by dub_need")
    monkeypatch.setattr(room, "short_of_room", boom)
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: None)
    monkeypatch.setattr(perso_client, "PersoClient", lambda: type("C", (), {
        "dubbing_spaces": lambda self: [{"seq": 1}], "space_seq": 1})())
    r = _start({"dub_mode": "perso"})
    assert r.status_code == 200, r.json()


def test_try_again_on_a_cloud_dub_needs_no_local_models(monkeypatch, _kit, tmp_path):
    # A cloud dub's record names no local engines, so Try again took today's
    # local defaults in their place and asked for their models: a 409 for a
    # voice model a dub made wholly on Perso never uses (2026-10-10).
    ran = threading.Event()
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: ran.set())
    first = tmp_path / "cloud"
    first.mkdir()
    (first / "input.mp4").write_bytes(b"vid")
    jid = state.job_store.create()
    state.job_store._update(jid, status="error", work_dir=str(first), project="cloud", language_code="ko",
                            dub_mode="perso", perso_model="ORIOLE")
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200, r.json()
    assert ran.wait(5), "the cloud dub never ran"


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
    # Announced but dead (the process was killed after it wrote its address):
    # the same sentence, from a 2-second health probe.
    monkeypatch.setattr(dub_api, "_voice_engine_answers", lambda url: False)
    r = _start()
    assert r.status_code == 422 and "voice engine is not running" in r.json()["detail"]


def _runtime(kit, **data):
    import json
    with open(os.path.join(kit, "runtime.json"), "w") as f:
        json.dump({"version": 1, **data}, f)


def test_a_voice_engine_that_failed_to_start_is_refused_with_the_shells_sentence(monkeypatch, _kit):
    # The shell opened the window without the voice engine (it could not
    # start) and said so in runtime.json: the dub is refused up front, in
    # words that keep "voice engine is not running" -- the phrase the page
    # answers by asking the shell to start it again.
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    _runtime(_kit, tts_state="failed")
    r = _start()
    assert r.status_code == 422
    assert r.json()["detail"] == engines_status.local_engine("voice")["message"]
    assert "voice engine is not running because it could not start" in r.json()["detail"]
    # Out of memory keeps the phrase the page restarts the engine on: closing
    # other apps and pressing Start again is what works (issue #187).
    _runtime(_kit, tts_state="failed", tts_failure="memory")
    said = _start().json()["detail"]
    assert "voice engine is not running" in said and "ran out of memory" in said
    _runtime(_kit, tts_state="starting")
    assert "still starting" in _start().json()["detail"]
    # A Perso dub needs no voice engine on this computer at all.
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: None)
    monkeypatch.setattr(perso_client, "PersoClient", lambda: type("C", (), {
        "dubbing_spaces": lambda self: [{"seq": 1}], "space_seq": 1})())
    _runtime(_kit, tts_state="failed")
    r = _start({"dub_mode": "perso"})
    assert r.status_code == 200, r.json()


def test_a_translation_runtime_that_failed_to_start_is_refused_with_the_shells_sentence(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "unreachable")
    _runtime(_kit, tts_url="http://127.0.0.1:1", ollama_state="failed")
    r = _start({"translate_engine": "gemma"})
    assert r.status_code == 422
    assert r.json()["detail"] == engines_status.local_engine("translation")["message"]
    assert "could not start" in r.json()["detail"]


def test_a_language_code_the_app_does_not_know_is_refused(monkeypatch, _kit):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    r = _start({"language_code": "xx"})
    assert r.status_code == 422 and "language_code" in r.json()["detail"]
    assert _start({"language_code": "pt-BR"}).status_code == 200, "a region variant of a known language"


def test_perso_dubbing_accepts_persos_languages_and_local_does_not(monkeypatch, _kit):
    # Hindi and British English exist on Perso's list only (app/languages.py).
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: None)
    monkeypatch.setattr(perso_client, "PersoClient", lambda: type("C", (), {
        "dubbing_spaces": lambda self: [{"seq": 1}], "space_seq": 1})())
    for code in ("hi", "en-GB"):
        r = _start({"language_code": code, "dub_mode": "perso"})
        assert r.status_code == 200, (code, r.text)
    assert _start({"language_code": "hi"}).status_code == 422


# ── a ready-made script ────────────────────────────────────────────────────
# A translated script handed in is dubbed as it is (app/pipeline.py
# _stage_translate), so the translator is never asked anything: it is not
# checked, and its model is not downloaded. Source subtitles are translated.

SCRIPT = ("sub.srt", b"1\n00:00:00,000 --> 00:00:01,000\nhola\n", "application/x-subrip")


def test_a_script_needs_no_translator_key_but_source_subtitles_still_do(monkeypatch, _kit):
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(engines_status, "gemini_available", lambda: False)
    r = _start(files_extra={"srt": SCRIPT})
    assert r.status_code == 200, r.json()
    r = _start(files_extra={"source_srt": SCRIPT})
    assert r.status_code == 422
    assert r.json()["detail"].startswith("Gemini translation needs an API key")


def test_a_script_needs_no_translator_model(monkeypatch, _kit):
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "model_missing")
    r = _start({"translate_engine": "gemma"}, files_extra={"srt": SCRIPT})
    assert r.status_code == 200, r.json()


def test_try_again_asks_for_the_translator_model_only_when_it_translates(monkeypatch, _kit, tmp_path):
    # Try again copies a ready-made script into the new folder too, and the
    # run then translates nothing again.
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "model_missing")
    first = tmp_path / "first"
    first.mkdir()
    (first / "input.mp4").write_bytes(b"vid")
    jid = state.job_store.create()
    state.job_store._update(jid, status="error", work_dir=str(first), project="first", language_code="ko",
                            dub_mode="local", stt_engine="whisper", translator="gemma", tts="qwen3",
                            separation="demucs")
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 409
    assert [m["id"] for m in r.json()["detail"]["missing"]] == ["gemma"]
    (first / "sub.srt").write_bytes(SCRIPT[1])
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200, r.json()


def test_a_refused_try_again_leaves_no_copy_of_the_video(monkeypatch, _kit, tmp_path):
    # The new folder and its copy of the video were made before the model
    # check, so every refused Try again left a whole video behind that no job
    # record pointed at (2026-10-10).
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "model_missing")
    first = tmp_path / "first"
    first.mkdir()
    (first / "input.mp4").write_bytes(b"vid")
    jid = state.job_store.create()
    state.job_store._update(jid, status="error", work_dir=str(first), project="first", language_code="ko",
                            dub_mode="local", stt_engine="whisper", translator="gemma", tts="qwen3",
                            separation="demucs")

    def copies():
        return sum(names.count("input.mp4") for _, _, names in os.walk(state.WORKSPACE))

    before = copies()
    assert client.post(f"/api/dub/jobs/{jid}/retry").status_code == 409
    assert copies() == before


# ── can this computer finish it (app/room.py) ──────────────────────────────

def _ready_for_a_local_dub(monkeypatch, kit):
    _put_whisper(kit)
    _put_tts(kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)


def test_a_video_too_big_for_the_disk_is_a_507_with_both_numbers(monkeypatch, _kit):
    from app import media
    _ready_for_a_local_dub(monkeypatch, _kit)
    # Over the 3 GB floor, short of what an hour of video needs (5.8 GB).
    monkeypatch.setattr(models, "free_bytes_at", lambda path: int(3.5 * 1024 ** 3))
    monkeypatch.setattr(media, "video_duration", lambda path: 3600.0)
    r = _start()
    assert r.status_code == 507
    assert r.json()["detail"] == "Not enough space. Needs 5.8 GB, 3.5 GB free."
    # Refused before a job existed, so its folder goes too.
    assert [f for _, _, files in os.walk(state.WORKSPACE) for f in files] == []


def test_a_disk_under_the_floor_is_a_507_with_the_floor(monkeypatch, _kit):
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(models, "free_bytes_at", lambda path: int(1.1 * 1024 ** 3))
    r = _start()
    assert r.status_code == 507
    assert r.json()["detail"] == "Not enough space. Needs 3.0 GB, 1.1 GB free."


def test_a_computer_under_7_gb_of_memory_cannot_dub_locally(monkeypatch, _kit):
    from app import room
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(room, "total_ram_bytes", lambda: 6 * room.GB)
    r = _start()
    assert r.status_code == 422
    assert r.json()["detail"] == "Dubbing needs 8 GB of memory on this computer."


def test_memory_never_refuses_or_warns_a_cloud_dub(monkeypatch, _kit):
    from app import room
    monkeypatch.setattr(dub_api, "_run_cloud_dub", lambda *a, **kw: None)
    monkeypatch.setattr(perso_client, "PersoClient", lambda: type("C", (), {
        "dubbing_spaces": lambda self: [{"seq": 1}], "space_seq": 1})())
    monkeypatch.setattr(room, "total_ram_bytes", lambda: 4 * room.GB)
    r = _start({"dub_mode": "perso"})
    assert r.status_code == 200, r.json()
    assert "warning" not in r.json()


def test_memory_under_12_gb_starts_the_dub_with_a_warning(monkeypatch, _kit):
    from app import room
    _ready_for_a_local_dub(monkeypatch, _kit)
    monkeypatch.setattr(room, "total_ram_bytes", lambda: 10 * room.GB)
    r = _start()
    assert r.status_code == 200
    assert r.json()["warning"] == "This may be slow on this computer."
    assert "This may be slow on this computer." in state.job_store.get(r.json()["job_id"])["logs"]


def test_plenty_of_memory_or_none_read_starts_without_a_warning(monkeypatch, _kit):
    from app import room
    _ready_for_a_local_dub(monkeypatch, _kit)
    for total in (24 * room.GB, None):
        monkeypatch.setattr(room, "total_ram_bytes", lambda: total)
        r = _start()
        assert r.status_code == 200
        assert "warning" not in r.json()


def test_the_engine_says_only_what_it_will_do_for_this_dub():
    """Separation and transcription on Perso: the engine is still the voice,
    and says so (Mac tester, 2026-09-28: "what is this for?")."""
    from app.api._launch import engine_hint
    assert engine_hint(False, False) == "Makes the voices on this computer."
    assert engine_hint(True, False) == "Separates the sound and makes the voices on this computer."
    assert engine_hint(False, True) == "Transcribes and makes the voices on this computer."


# A start the preflight refuses leaves no job, and so no job log: the app log
# gets one line, the screen's sentence and the settings the screen sent
# (Windows, 2026-10-16: the sentence on screen was all that was left).
def _refusals(caplog):
    return [r for r in caplog.records
            if r.name == "persodub.api.dub" and r.getMessage().startswith("JOB REFUSED (dub): ")]


@pytest.mark.parametrize("why", ["translator", "models", "trim", "perso_key"])
def test_a_refused_start_leaves_one_line_in_the_app_log(monkeypatch, _kit, caplog, why):
    data = {"project": "my wedding"}
    if why == "translator":     # the translation runtime is down
        monkeypatch.setattr(engines_status, "hunyuan_status", lambda: "unreachable")
        data["translate_engine"] = "hunyuan"
    if why == "trim":           # a 0-second video, trimmed to nothing
        data.update(trim_start="0", trim_end="0")
    if why == "perso_key":
        monkeypatch.setattr(engines_status, "perso_available", lambda: False)
        data["stt_engine"] = "perso"
    # "models": the kit as the fixture lays it has no voice or Whisper model.
    with caplog.at_level(logging.WARNING, logger="persodub.api.dub"):
        r = _start(data)
    assert r.status_code in (400, 409, 422)
    [record] = _refusals(caplog)
    assert record.levelname == "WARNING"
    said, settings = record.getMessage()[len("JOB REFUSED (dub): "):].rsplit(" | ", 1)
    detail = r.json()["detail"]
    if why == "models":
        assert said == "models needed: " + ", ".join(m["id"] for m in detail["missing"])
    else:
        assert said == " ".join(detail.split())
    settings = json.loads(settings)
    assert settings["language_code"] == "ko" and "translator" in settings
    # Settings only: never the title, the file or where it came from.
    assert not {"project", "title", "source_url", "video"} & set(settings)
    assert "wedding" not in record.getMessage()


def test_a_start_that_goes_through_leaves_no_refusal(monkeypatch, _kit, caplog):
    _put_whisper(_kit)
    _put_tts(_kit)
    monkeypatch.setattr(dub_api, "run_dub", _fake_run_dub)
    with caplog.at_level(logging.WARNING, logger="persodub.api.dub"):
        assert _start().status_code == 200
    assert _refusals(caplog) == []
