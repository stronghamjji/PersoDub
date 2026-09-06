"""Shared test fixtures.

The suite had no conftest.py at all -- monkeypatching module globals inside each
test was the only isolation mechanism. That left one gap nothing covered: tests
which exercise the upload endpoint write a real job directory into the repo's
own workspace/ and never clean it up (one run of tests/test_dub_api.py leaves 10
behind). By 2026-08-02 that had accumulated 559 litter directories against 4
genuine jobs.
"""
import logging

import pytest

from app import jobs, logging_setup, state


@pytest.fixture(autouse=True)
def isolate_job_logs(tmp_path, monkeypatch):
    """Point the log files at a temp directory.

    app/jobs.py mirrors every progress line to PERSODUB_LOG_DIR/job-<id>.log.
    Without this, any test that starts a job drops a log file into the working
    tree -- the same silent, cumulative litter isolate_workspace exists to stop.

    app/logging_setup.py writes the app's own persodub.log into the same
    folder, and a test that enters the lifespan (which is what installs that
    handler) would otherwise start it in the working tree too.

    Tearing the handlers down again is the other half. configure_logging is
    idempotent -- it returns early when the logger already has handlers -- and
    "persodub" is one process-wide logger, so the first test to enter the
    lifespan would otherwise nail the file handler to ITS tmp_path for the
    whole session and every later redirect here would be a no-op. Removing
    them (closing the file ones, so no descriptor leaks over a thousand tests)
    puts the logger back the way this fixture found it.
    """
    monkeypatch.setattr(jobs, "PERSODUB_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setattr(logging_setup, "PERSODUB_LOG_DIR", str(tmp_path / "logs"))
    yield
    logger = logging.getLogger(logging_setup.LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        if isinstance(handler, logging.FileHandler):
            handler.close()


@pytest.fixture(autouse=True)
def isolate_workspace(tmp_path, monkeypatch):
    """Point the upload workspace at a per-test temp directory.

    app/main.py resolves WORKSPACE from __file__ at import time, so without this
    every TestClient upload lands in the working tree and stays there. Autouse
    because the cost of forgetting it is silent and cumulative -- a test that
    pollutes still passes.
    """
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr(state, "WORKSPACE", str(ws))


@pytest.fixture
def wav_factory():
    """Write a silent 48kHz stereo PCM16 wav of the given length, return its path."""
    import wave

    def make(path, seconds=1.0, rate=48000):
        with wave.open(str(path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"\x00\x00\x00\x00" * int(seconds * rate))
        return str(path)

    return make
