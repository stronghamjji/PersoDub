"""Model catalog + download-state detection (app/models.py).

The 4-state model (ready / downloading / paused / not_downloaded) is what
keeps the 2026-08-14 "install died halfway = broken forever" bug from coming
back: a half-downloaded model shows Resume instead of being skipped.
"""
import os

from fastapi.testclient import TestClient

from app import models as models_module
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _mk(kit, *rel, content=b""):
    p = os.path.join(kit, *rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(content)


# ── catalog ────────────────────────────────────────────────────────────────
def test_catalog_has_the_first_models_and_required_fields():
    cat = models_module.load_catalog()
    ids = [m["id"] for m in cat]
    for want in ("qwen3-tts", "whisper", "gemma", "hunyuan", "demucs"):
        assert want in ids, ids
    for m in cat:
        for key in ("id", "role", "name", "bytes", "dir", "markers"):
            assert key in m, (m.get("id"), key)
        # A pack has no source -- the desktop app installs it, not this process.
        assert ("source" in m) == (m["role"] != "pack"), m["id"]


def test_broken_catalog_falls_back_to_always_only(monkeypatch, tmp_path):
    bad = tmp_path / "cat.json"
    bad.write_text("{not json")
    monkeypatch.setattr(models_module, "CATALOG_PATH", str(bad))
    cat = models_module.load_catalog()
    # Never crash the server over a broken file: serve the always-installed
    # minimum so dubbing with API engines still works.
    assert cat
    assert all(m["role"] == "always" for m in cat)


# ── state detection (HF kind: whisper / qwen3-tts) ─────────────────────────
def _entry(cat, mid):
    return next(m for m in cat if m["id"] == mid)


def test_hf_model_ready_when_all_markers_exist(tmp_path):
    cat = models_module.load_catalog()
    kit = str(tmp_path)
    _mk(kit, "models", "qwen3-tts", "model.safetensors")
    _mk(kit, "models", "qwen3-tts", "speech_tokenizer", "model.safetensors")
    assert models_module.model_state(_entry(cat, "qwen3-tts"), kit) == "ready"


def test_hf_model_paused_when_dir_exists_without_all_markers(tmp_path):
    # config.json lands seconds into a 4.3GB download -- that kit is "paused",
    # never "done" (the old bug) and never "not downloaded" (pieces exist).
    cat = models_module.load_catalog()
    kit = str(tmp_path)
    _mk(kit, "models", "qwen3-tts", "config.json")
    assert models_module.model_state(_entry(cat, "qwen3-tts"), kit) == "paused"


def test_hf_model_not_downloaded_when_dir_missing(tmp_path):
    cat = models_module.load_catalog()
    assert models_module.model_state(_entry(cat, "whisper"), str(tmp_path)) == "not_downloaded"


# ── state detection (Ollama kind: gemma / hunyuan) ─────────────────────────
def test_ollama_model_ready_on_manifest(tmp_path):
    cat = models_module.load_catalog()
    kit = str(tmp_path)
    _mk(kit, "models", "ollama", "manifests", "registry.ollama.ai", "library", "gemma3", "12b")
    assert models_module.model_state(_entry(cat, "gemma"), kit) == "ready"
    # The manifest belongs to gemma alone -- hunyuan stays not_downloaded.
    assert models_module.model_state(_entry(cat, "hunyuan"), kit) == "not_downloaded"


def test_ollama_model_not_downloaded_without_manifest(tmp_path):
    # No "paused" from disk for Ollama models: partial blobs are shared across
    # models and cannot be attributed; ollama pull resumes from its own cache
    # anyway, so nothing is lost by calling it not_downloaded.
    cat = models_module.load_catalog()
    assert models_module.model_state(_entry(cat, "gemma"), str(tmp_path)) == "not_downloaded"


# ── GET /api/models ────────────────────────────────────────────────────────
def test_api_models_lists_optional_models_with_states(monkeypatch, tmp_path):
    kit = str(tmp_path)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)
    _mk(kit, "models", "whisper", "faster-whisper-large-v3", "model.bin")
    r = client.get("/api/models")
    assert r.status_code == 200
    rows = r.json()["models"]
    by_id = {m["id"]: m for m in rows}
    # always-installed models never show in the catalog screen
    assert "demucs" not in by_id
    assert by_id["whisper"]["state"] == "ready"
    assert by_id["qwen3-tts"]["state"] == "not_downloaded"
    for m in rows:
        for key in ("id", "role", "name", "bytes", "state"):
            assert key in m


# ── free space ─────────────────────────────────────────────────────────────
def test_free_space_measures_a_folder_that_does_not_exist_yet(tmp_path):
    """Both callers ask before the folder is there: the kit before a download,
    and a job's workspace before the job exists. Asking about a path that is
    not on disk says nothing, so this walks up to the nearest parent that is."""
    on_disk = models_module.free_bytes_at(str(tmp_path))
    assert on_disk and on_disk > 0
    assert models_module.free_bytes_at(str(tmp_path / "not" / "made" / "yet")) == on_disk


def test_free_space_is_none_when_the_disk_will_not_say(monkeypatch, tmp_path):
    """A preflight that cannot read the disk must not become the reason a
    download -- or a dub -- is refused."""
    def boom(_path):
        raise OSError("no")

    monkeypatch.setattr(models_module.shutil, "disk_usage", boom)
    assert models_module.free_bytes_at(str(tmp_path)) is None


# ── packs ──────────────────────────────────────────────────────────────────
# The two heavy bundles the desktop app installs on demand (engines venv +
# Demucs, the Ollama runtime). They sit in the catalog so the screen's
# "Download N GB to dub?" dialog and Settings > Models can show them next to
# the models, but the shell installs them, not this process.
def _put_engine_pack(kit):
    _mk(kit, ".install", "venv-engines.ok")
    _mk(kit, "models", "demucs", "HTDemucs", "955717e8.safetensors")


def test_catalog_lists_the_two_packs_without_a_source():
    by_id = {m["id"]: m for m in models_module.load_catalog()}
    assert by_id["engine"]["role"] == "pack" and by_id["engine"]["name"] == "AI engine"
    assert by_id["ollama-runtime"]["role"] == "pack"
    assert set(by_id["engine"]["bytes"]) == {"mac", "win-gpu", "win-cpu"}
    assert "source" not in by_id["engine"]


def test_platform_key_reads_the_torch_variant_on_windows(monkeypatch):
    monkeypatch.setattr(models_module._sys, "platform", "darwin")
    assert models_module.platform_key() == "mac"
    monkeypatch.setattr(models_module._sys, "platform", "win32")
    monkeypatch.setenv("PERSODUB_TORCH_VARIANT", "cpu")
    assert models_module.platform_key() == "win-cpu"
    monkeypatch.setenv("PERSODUB_TORCH_VARIANT", "cu128")
    assert models_module.platform_key() == "win-gpu"
    monkeypatch.delenv("PERSODUB_TORCH_VARIANT")
    assert models_module.platform_key() == "win-gpu"   # the shell's default variant


def test_a_pack_is_ready_paused_or_missing_by_its_root_markers(tmp_path):
    kit = str(tmp_path)
    engine = models_module.find("engine")
    assert models_module.model_state(engine, kit) == "not_downloaded"
    os.makedirs(os.path.join(kit, "engines_venv"))
    assert models_module.model_state(engine, kit) == "paused"     # folder there, not finished
    _put_engine_pack(kit)
    assert models_module.model_state(engine, kit) == "ready"


def test_api_models_shows_the_packs_with_this_platforms_size(monkeypatch, tmp_path):
    kit = str(tmp_path)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)
    monkeypatch.setattr(models_module._sys, "platform", "darwin")
    _put_engine_pack(kit)
    rows = {m["id"]: m for m in client.get("/api/models").json()["models"]}
    assert rows["engine"]["role"] == "pack"
    assert rows["engine"]["bytes"] == 2000000000
    assert rows["engine"]["state"] == "ready"
    assert rows["ollama-runtime"]["state"] == "not_downloaded"


def test_packs_are_not_downloaded_or_removed_through_the_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: False)   # other tests leave jobs behind
    r = client.post("/api/models/engine/download")
    assert r.status_code == 409 and r.json()["detail"] == "Packs are installed by the desktop app"
    r = client.delete("/api/models/ollama-runtime")
    assert r.status_code == 409 and r.json()["detail"] == "Packs are installed by the desktop app"


def test_removing_an_ollama_model_without_its_runtime_is_refused_with_a_sentence(monkeypatch, tmp_path):
    # The runtime owns the blob store; without it the API used to answer
    # "removed" and remove nothing.
    kit = str(tmp_path)
    monkeypatch.setenv("PERSODUB_KIT_DIR", kit)   # a kit with no runtime.json: no runtime up
    _mk(kit, "models", "ollama", "manifests", "registry.ollama.ai", "library", "hy-mt2", "1.8b")
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: False)
    r = client.delete("/api/models/hunyuan")
    assert r.status_code == 409
    assert r.json()["detail"] == "Install the Translation runtime first, then remove this model."
    assert os.path.exists(os.path.join(kit, "models", "ollama", "manifests"))


def test_a_pack_cannot_be_removed_while_a_dub_runs_even_by_the_desktop_app(monkeypatch, tmp_path):
    # The page asks this route before handing a pack's removal to the shell.
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    monkeypatch.setattr(models_module, "dub_in_progress", lambda: True)
    r = client.delete("/api/models/engine")
    assert r.status_code == 409 and r.json()["detail"].startswith("A dub is running")


def test_the_catalog_lists_the_packs_first():
    # Settings and the dub dialog read the catalog in order: what has to come
    # first (the packs) is listed first, so the order is the guidance.
    ids = [m["id"] for m in models_module.load_catalog()]
    assert ids[:2] == ["engine", "ollama-runtime"], ids


def test_an_ollama_model_asked_for_without_its_runtime_is_refused_with_a_sentence(monkeypatch, tmp_path):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))   # no runtime.json: no runtime up
    monkeypatch.setattr(models_module, "free_bytes_at", lambda path: 10**12)
    r = client.post("/api/models/hunyuan/download")
    assert r.status_code == 409
    assert r.json()["detail"] == "Install the Translation runtime first, then download this model."


def test_every_downloadable_row_says_what_it_is_for():
    for m in models_module.load_catalog():
        if m["role"] == "always":
            continue
        assert m.get("hint"), m["id"]
    rows = {m["id"]: m for m in models_module.status_rows()}
    assert rows["engine"]["hint"].startswith("Runs local dubbing")


def test_a_pack_the_desktop_app_is_installing_reads_as_downloading(tmp_path):
    # The shell leaves .install/<pack>.installing while it works; without it
    # the half-made folder read as "paused" (2026-09-08).
    kit = str(tmp_path)
    engine = models_module.find("engine")
    os.makedirs(os.path.join(kit, "engines_venv"))
    assert models_module.model_state(engine, kit) == "paused"
    _mk(kit, ".install", "engine.installing")
    assert models_module.model_state(engine, kit) == "downloading"
