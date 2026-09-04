"""The translator a dub gets when nobody chose one. User decision 2026-09-04:
Hunyuan, the 1.1 GB model a light install actually has -- never the 7.6 GB
Gemma, which a fresh machine does not have and would be asked to download."""
import importlib


def test_default_translator_is_hunyuan(monkeypatch):
    monkeypatch.delenv("TRANSLATE_ENGINE", raising=False)
    import app.config as config
    importlib.reload(config)
    assert config.TRANSLATE_ENGINE == "hunyuan"


def test_kit_env_still_overrides_the_default(monkeypatch):
    monkeypatch.setenv("TRANSLATE_ENGINE", "gemma")
    import app.config as config
    importlib.reload(config)
    assert config.TRANSLATE_ENGINE == "gemma"
    monkeypatch.delenv("TRANSLATE_ENGINE")
    importlib.reload(config)
