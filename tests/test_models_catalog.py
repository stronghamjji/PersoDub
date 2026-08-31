"""Model catalog + download-state detection (app/models.py).

The 4-state model (ready / downloading / paused / not_downloaded) is what
keeps the 2026-08-14 "install died halfway = broken forever" bug from coming
back: a half-downloaded model shows Resume instead of being skipped.
"""
import json
import os

import pytest
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
        for key in ("id", "role", "name", "bytes", "dir", "markers", "source"):
            assert key in m, (m.get("id"), key)


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
