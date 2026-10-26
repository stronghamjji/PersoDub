"""The translator a dub gets when nobody chose one. User decision 2026-09-23:
ChatGPT, through the user's own (free) ChatGPT account, so a fresh machine
downloads no translation model at all. Before that (2026-09-04) it was
Hunyuan, the 1.1 GB model a light install has."""
import importlib


def test_default_translator_is_chatgpt(monkeypatch):
    monkeypatch.delenv("TRANSLATE_ENGINE", raising=False)
    import app.config as config
    importlib.reload(config)
    assert config.TRANSLATE_ENGINE == "chatgpt"


def test_kit_env_still_overrides_the_default(monkeypatch):
    monkeypatch.setenv("TRANSLATE_ENGINE", "gemma")
    import app.config as config
    importlib.reload(config)
    assert config.TRANSLATE_ENGINE == "gemma"
    monkeypatch.delenv("TRANSLATE_ENGINE")
    importlib.reload(config)


def test_translate_route_uses_the_saved_default_translator(tmp_path, monkeypatch):
    """POST /api/translate translates with the translator kit.env saves now,
    not the one TRANSLATE_ENGINE named at startup. A fresh Windows install with
    Hunyuan saved got a 500 from ChatGPT here while its dubs used Hunyuan
    (e2e, 2026-10-24)."""
    from fastapi.testclient import TestClient

    from app import main
    from app.api import misc as misc_api

    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.env").write_text("TRANSLATE_ENGINE=hunyuan\n", encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    monkeypatch.delenv("TRANSLATE_ENGINE", raising=False)
    asked = []

    class Fake:
        def translate(self, texts, *a):
            return ["ok"] * len(texts)

    def fake_get(engine=None):
        asked.append(engine)
        return Fake()

    monkeypatch.setattr(misc_api, "get_translator", fake_get)
    client = TestClient(main.app, base_url="http://127.0.0.1")
    r = client.post("/api/translate", json={"texts": ["hi"], "target_lang": "Korean"})
    assert r.status_code == 200
    assert asked == ["hunyuan"]

    (kit / "kit.env").write_text("TRANSLATE_ENGINE=gemma\n", encoding="utf-8")
    client.post("/api/translate", json={"texts": ["hi"], "target_lang": "Korean"})
    assert asked == ["hunyuan", "gemma"]
