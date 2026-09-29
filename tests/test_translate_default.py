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
