"""app/runtime.py: the backend's read side of runtime.json, the file the
desktop shell writes when a pack process (Ollama runtime, TTS sidecar)
starts. See desktop/src/runtimeFile.js for the write side.
"""
import json

from app import config, runtime


def test_reads_the_url_the_shell_wrote(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    (tmp_path / "runtime.json").write_text(
        json.dumps({"version": 1, "ollama_url": "http://127.0.0.1:5555"}))
    assert runtime.url("ollama") == "http://127.0.0.1:5555"


def test_inside_a_kit_a_pack_without_an_address_is_absent_whatever_the_env_says(tmp_path, monkeypatch):
    # kit.env (which the shell passes into this process) carries a fixed
    # QWEN_TTS_URL line on kits from before packs existed; it must not make a
    # voice engine that is not running look present.
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    (tmp_path / "runtime.json").write_text(json.dumps({"version": 1}))
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9999")
    monkeypatch.setenv("QWEN_TTS_URL", "http://127.0.0.1:3901")
    assert runtime.url("ollama") == ""
    assert runtime.url("tts") == ""


def test_without_a_kit_the_config_constants_apply(monkeypatch):
    # A dev run of the backend alone: the stock ports, or the env override.
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    monkeypatch.setattr(config, "QWEN_TTS_URL", "http://127.0.0.1:3901")
    monkeypatch.setattr(config, "OLLAMA_URL", "http://127.0.0.1:11434")
    assert runtime.url("tts") == "http://127.0.0.1:3901"
    assert runtime.url("ollama") == "http://127.0.0.1:11434"


def test_tolerates_a_missing_runtime_file(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    assert runtime.url("ollama") == ""


def test_tolerates_a_malformed_runtime_file(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    (tmp_path / "runtime.json").write_text("{not json")
    assert runtime.url("ollama") == ""


def test_unknown_pack_name_is_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))
    assert runtime.url("something_else") == ""
