"""What a route says when something goes wrong.

Three separate promises, one file because they are the same promise seen from
three sides: an exception's own text never reaches the client.

  * app/main.py's Exception handler -- an unplanned failure anywhere becomes
    one fixed sentence and a 500, and the traceback goes to the app log.
  * The deliberate HTTPExceptions in app/api/*.py are untouched by that
    handler: FastAPI keeps its own, so every 404/409/422 detail still says
    exactly what it said before.
  * /api/translate and /api/tts/say, the two routes that used to hand an
    engine's raw exception text (and, on the cloud path, whatever the request
    it echoed contained) straight back.

raise_server_exceptions=False on the client below is not a workaround: with it
set to the default, Starlette re-raises a handled server error into the test so
the test itself can see it, and the response never comes back. The desktop app
is not a test -- it gets the response.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app import engines_status
from app.api import misc as misc_api
from app.engines.base import get_engine
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")
# The client that sees what a browser would see, rather than the exception.
quiet_client = TestClient(app, base_url="http://127.0.0.1", raise_server_exceptions=False)

# A string with no business anywhere near a response body: it stands in for the
# file path, request or API key a real exception message can be carrying.
SECRET = "sk-do-not-echo-me"


def test_unplanned_failure_returns_the_generic_500(monkeypatch):
    def boom():
        raise KeyError(SECRET)

    monkeypatch.setattr(engines_status, "gemma_available", boom)
    r = quiet_client.get("/api/engines")
    assert r.status_code == 500
    assert r.json() == {"detail": "An internal error occurred. Details are in the app log."}
    assert SECRET not in r.text
    assert "KeyError" not in r.text


def test_http_exceptions_are_left_alone():
    """The deliberate 404s still carry their own wording."""
    r = client.get("/api/dub/jobs/no-such-job")
    assert r.status_code == 404
    assert r.json()["detail"] == "Unknown job: no-such-job"


def test_translate_failure_names_the_type_not_the_message(monkeypatch):
    class Broken:
        def translate(self, *a, **kw):
            raise RuntimeError("upstream said: " + SECRET)

    monkeypatch.setattr(misc_api, "translator", Broken())
    r = client.post("/api/translate", json={"texts": ["hi"], "target_lang": "Korean"})
    assert r.status_code == 500
    assert SECRET not in r.text
    assert "RuntimeError" in r.json()["detail"]


# --- /api/tts/say: the three ways speaking one line is known to fail --------

@pytest.fixture
def engine():
    return get_engine("qwen3_tts")


def _say(**kw):
    body = {"text": "hello"}
    body.update(kw)
    return client.post("/api/tts/say", json=body)


def test_say_missing_reference_audio_is_a_404_without_the_path(monkeypatch, engine):
    def boom(req):
        raise FileNotFoundError("Sample voice file not found: " + SECRET)

    monkeypatch.setattr(engine, "synthesize", boom)
    r = _say(ref_audio="/tmp/" + SECRET + ".wav")
    assert r.status_code == 404
    assert SECRET not in r.text


def test_say_bad_request_for_the_engine_is_a_422(monkeypatch, engine):
    def boom(req):
        raise ValueError("Qwen3-TTS ICL voice clone requires ref_text")

    monkeypatch.setattr(engine, "synthesize", boom)
    r = _say()
    assert r.status_code == 422
    assert "ref_text" in r.json()["detail"]


def test_say_unreachable_sidecar_is_a_503(monkeypatch, engine):
    def boom(req):
        raise httpx.ConnectError("connection refused to " + SECRET)

    monkeypatch.setattr(engine, "synthesize", boom)
    r = _say()
    assert r.status_code == 503
    assert SECRET not in r.text
