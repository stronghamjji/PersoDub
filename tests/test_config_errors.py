"""A wrong number in the environment (app/config.py, app/main.py's lifespan).

`QWEN_N_TAKES=abc` used to raise ValueError inside app/config.py -- which every
module imports, so the app died on `import app.main` with a traceback whose
last line was `int(os.environ.get(...))`. Nothing named the setting, and the
desktop shell showed the user a window that never opened.

Now the value is recorded and the default used, and startup is where that gets
reported and refused. The reload below is what proves "recorded, not raised":
importlib.reload re-runs the module body under the patched environment, which
is exactly what a fresh process does.
"""
import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient

from app import config as config_module
from app import main


@pytest.fixture
def reloaded(monkeypatch):
    """Re-import app/config.py under a changed environment, then put it back.

    The restore matters: app.config is a live module every other test's imports
    already point at, so leaving it holding a made-up QWEN_N_TAKES would be a
    change that outlives this file.
    """
    def load(**env):
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        return importlib.reload(config_module)

    yield load
    monkeypatch.undo()
    importlib.reload(config_module)


def test_a_bad_integer_falls_back_and_is_recorded(reloaded):
    config = reloaded(QWEN_N_TAKES="abc")
    assert config.QWEN_N_TAKES == 4          # the documented default
    assert config.CONFIG_ERRORS == ["QWEN_N_TAKES: got 'abc', expected an integer (default 4)"]


def test_a_bad_float_falls_back_and_is_recorded(reloaded):
    config = reloaded(QWEN_GATE_PAD_SEC="soon")
    assert config.QWEN_GATE_PAD_SEC == 0.25
    assert config.CONFIG_ERRORS == ["QWEN_GATE_PAD_SEC: got 'soon', expected a number (default 0.25)"]


def test_a_value_below_the_floor_falls_back_too(reloaded):
    config = reloaded(QWEN_TRIM_LEAD_SEC="-2")
    assert config.QWEN_TRIM_LEAD_SEC == 1.0
    assert "expected a number >= 0.0" in config.CONFIG_ERRORS[0]


def test_a_good_value_is_used_and_records_nothing(reloaded):
    config = reloaded(QWEN_N_TAKES="2")
    assert config.QWEN_N_TAKES == 2
    assert config.CONFIG_ERRORS == []


def test_a_clean_environment_records_nothing(reloaded):
    assert reloaded().CONFIG_ERRORS == []


# --- and what startup does about it ----------------------------------------

def test_startup_refuses_to_run_on_a_bad_setting(monkeypatch):
    """Better a clear stop than a dub made with numbers nobody asked for.

    The lifespan is entered directly rather than through TestClient: the ASGI
    server runs it inside a task group, which repackages anything raised there
    into an ExceptionGroup, and this test is about what OUR code raises."""
    monkeypatch.setattr(config_module, "CONFIG_ERRORS",
                        ["QWEN_N_TAKES: got 'abc', expected an integer (default 4)"])
    monkeypatch.delenv("PERSODUB_IGNORE_BAD_CONFIG", raising=False)

    async def start():
        async with main.lifespan(main.app):
            pass

    with pytest.raises(SystemExit):
        asyncio.run(start())


def test_the_escape_hatch_starts_anyway(monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_ERRORS",
                        ["QWEN_N_TAKES: got 'abc', expected an integer (default 4)"])
    monkeypatch.setenv("PERSODUB_IGNORE_BAD_CONFIG", "1")
    with TestClient(main.app, base_url="http://127.0.0.1") as c:
        assert c.get("/health").json() == {"status": "ok"}
