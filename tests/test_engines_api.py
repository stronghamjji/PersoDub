"""Engine capability discovery: app/engines_status.py, GET /api/engines, and
the dub_start preflight (app/main.py).

Why this exists: the desktop UI's default translate engine ("gemma", via local
Ollama) does not exist on a clean machine, so jobs used to die 10 minutes in.
These checks let the UI/backend fail fast instead.
"""
import requests
from fastapi.testclient import TestClient

from app import config, engines_status, main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


class _FakeResponse:
    def __init__(self, json_data, status_code=200):
        self._json_data = json_data
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code}")

    def json(self):
        return self._json_data


def _fake_run_dub(**kw):
    return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}


# --- ollama_model_available (unit, fake requests.get) -----------------------

def test_ollama_model_available_exact_match(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse({"models": [{"name": "gemma3:12b"}]}),
    )
    assert engines_status.ollama_model_available("http://x", "gemma3:12b") is True


def test_ollama_model_available_latest_suffix_match(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse({"models": [{"name": "gemma3:latest"}]}),
    )
    assert engines_status.ollama_model_available("http://x", "gemma3") is True


def test_ollama_model_available_bare_name_match(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse(
            {"models": [{"name": "qwen2.5:7b"}, {"name": "gemma3:12b"}]}
        ),
    )
    assert engines_status.ollama_model_available("http://x", "gemma3") is True


def test_ollama_model_available_wrong_name_false(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse({"models": [{"name": "qwen2.5:7b"}]}),
    )
    assert engines_status.ollama_model_available("http://x", "gemma3:12b") is False


def test_ollama_model_available_connection_error_false(monkeypatch):
    def raise_conn(*a, **kw):
        raise requests.exceptions.ConnectionError("no server")

    monkeypatch.setattr(requests, "get", raise_conn)
    assert engines_status.ollama_model_available("http://x", "gemma3:12b") is False


def test_ollama_model_available_timeout_false(monkeypatch):
    def raise_timeout(*a, **kw):
        raise requests.exceptions.Timeout("slow")

    monkeypatch.setattr(requests, "get", raise_timeout)
    assert engines_status.ollama_model_available("http://x", "gemma3:12b") is False


# --- ollama_model_status (I2: distinguishes unreachable from model-missing --
# a busy-but-valid Ollama must not be reported as "not running") ------------

def test_ollama_model_status_available_when_tag_present(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse({"models": [{"name": "gemma3:12b"}]}),
    )
    assert engines_status.ollama_model_status("http://x", "gemma3:12b") == "available"


def test_ollama_model_status_model_missing_when_reachable_but_not_pulled(monkeypatch):
    monkeypatch.setattr(
        requests, "get",
        lambda *a, **kw: _FakeResponse({"models": [{"name": "qwen2.5:7b"}]}),
    )
    assert engines_status.ollama_model_status("http://x", "gemma3:12b") == "model_missing"


def test_ollama_model_status_unreachable_on_connection_error(monkeypatch):
    def raise_conn(*a, **kw):
        raise requests.exceptions.ConnectionError("no server")

    monkeypatch.setattr(requests, "get", raise_conn)
    assert engines_status.ollama_model_status("http://x", "gemma3:12b") == "unreachable"


def test_ollama_model_status_unreachable_on_timeout(monkeypatch):
    def raise_timeout(*a, **kw):
        raise requests.exceptions.Timeout("slow")

    monkeypatch.setattr(requests, "get", raise_timeout)
    assert engines_status.ollama_model_status("http://x", "gemma3:12b") == "unreachable"


# --- gemma_available / qwen_available (delegate to ollama_model_available) --

def test_gemma_available_checks_the_configured_ollama_gemma_model(monkeypatch):
    calls = {}

    def fake(url, model, timeout=1.5):
        calls["args"] = (url, model)
        return True

    monkeypatch.setattr(engines_status, "ollama_model_available", fake)
    assert engines_status.gemma_available() is True
    assert calls["args"] == (config.OLLAMA_URL, config.OLLAMA_GEMMA_MODEL)


def test_qwen_available_checks_the_configured_ollama_qwen_model(monkeypatch):
    calls = {}

    def fake(url, model, timeout=1.5):
        calls["args"] = (url, model)
        return True

    monkeypatch.setattr(engines_status, "ollama_model_available", fake)
    assert engines_status.qwen_available() is True
    assert calls["args"] == (config.OLLAMA_URL, config.OLLAMA_QWEN_MODEL)


# --- gemma_status / qwen_status (delegate to ollama_model_status) -----------

def test_gemma_status_checks_the_configured_ollama_gemma_model(monkeypatch):
    calls = {}

    def fake(url, model, timeout=4.0):
        calls["args"] = (url, model)
        return "available"

    monkeypatch.setattr(engines_status, "ollama_model_status", fake)
    assert engines_status.gemma_status() == "available"
    assert calls["args"] == (config.OLLAMA_URL, config.OLLAMA_GEMMA_MODEL)


def test_qwen_status_checks_the_configured_ollama_qwen_model(monkeypatch):
    calls = {}

    def fake(url, model, timeout=4.0):
        calls["args"] = (url, model)
        return "available"

    monkeypatch.setattr(engines_status, "ollama_model_status", fake)
    assert engines_status.qwen_status() == "available"
    assert calls["args"] == (config.OLLAMA_URL, config.OLLAMA_QWEN_MODEL)


# --- gemini_available / perso_available (config/env, read at call time) -----

def test_gemini_available_true_when_key_configured(monkeypatch):
    # The saved key, not the import-time constant: engines_status reads
    # kit.env at use time so a key saved in Settings needs no restart.
    monkeypatch.setattr(engines_status, "current_value", lambda k: "some-key")
    assert engines_status.gemini_available() is True


def test_gemini_available_false_when_key_empty(monkeypatch):
    monkeypatch.setattr(engines_status, "current_value", lambda k: "")
    assert engines_status.gemini_available() is False


def test_perso_available_true_when_key_set(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "key")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    # The key alone is enough now: PersoClient resolves the workspace from the
    # key at dub time (GET /portal/api/v1/spaces), the way the official
    # perso-dubbing-plugin does -- requiring PERSO_SPACE_SEQ here kept the
    # engine greyed out for every user who only saved a key in Settings.
    assert engines_status.perso_available() is True


def test_perso_available_false_when_key_missing(monkeypatch):
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.setenv("PERSO_SPACE_SEQ", "123")
    assert engines_status.perso_available() is False


# --- GET /api/engines ---------------------------------------------------

def test_engines_endpoint_all_unavailable(monkeypatch):
    monkeypatch.setattr(main, "gemma_available", lambda: False)
    monkeypatch.setattr(main, "qwen_available", lambda: False)
    monkeypatch.setattr(main, "gemini_available", lambda: False)
    monkeypatch.setattr(main, "perso_available", lambda: False)

    r = client.get("/api/engines")
    assert r.status_code == 200
    assert r.json() == {
        "gemma_available": False,
        "qwen_available": False,
        "gemini_available": False,
        "perso_available": False,
    }


def test_engines_endpoint_all_available(monkeypatch):
    monkeypatch.setattr(main, "gemma_available", lambda: True)
    monkeypatch.setattr(main, "qwen_available", lambda: True)
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)

    r = client.get("/api/engines")
    assert r.status_code == 200
    assert r.json() == {
        "gemma_available": True,
        "qwen_available": True,
        "gemini_available": True,
        "perso_available": True,
    }


# --- POST /api/dub/start preflight ------------------------------------------
#
# I2: the preflight now probes gemma_status()/qwen_status() (not the plain
# gemma_available()/qwen_available() booleans) so the 422 detail can
# distinguish an unreachable Ollama from one that's reachable but hasn't
# pulled the model -- tests below patch the *_status functions accordingly.
# ("model_missing" is what the pre-I2 tests here meant by "unavailable".)

def test_dub_start_gemma_model_missing_422_no_job_created(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "model_missing")
    create_calls = {"n": 0}

    def spy_create(*a, **kw):
        create_calls["n"] += 1
        return "should-not-be-called"

    monkeypatch.setattr(main.job_store, "create", spy_create)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemma"},
    )
    assert r.status_code == 422
    assert "ollama pull" in r.json()["detail"]
    assert create_calls["n"] == 0


def test_dub_start_gemma_unreachable_422_message(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "unreachable")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemma"},
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "not running or not reachable" in detail
    # A down Ollama can't be fixed by pulling a model -- that instruction
    # belongs only to the model_missing case.
    assert "ollama pull" not in detail


def test_dub_start_gemma_available_job_starts(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemma"},
    )
    assert r.status_code == 200
    assert "job_id" in r.json()


def test_dub_start_gemma_message_interpolates_configured_tag(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "model_missing")
    monkeypatch.setattr(main, "OLLAMA_GEMMA_MODEL", "my-custom-tag:7b")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemma"},
    )
    assert r.status_code == 422
    assert "ollama pull my-custom-tag:7b" in r.json()["detail"]


def test_dub_start_qwen_model_missing_422(monkeypatch):
    monkeypatch.setattr(main, "qwen_status", lambda: "model_missing")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "qwen"},
    )
    assert r.status_code == 422
    assert "ollama pull" in r.json()["detail"]


def test_dub_start_qwen_unreachable_422_message(monkeypatch):
    monkeypatch.setattr(main, "qwen_status", lambda: "unreachable")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "qwen"},
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "not running or not reachable" in detail
    assert "ollama pull" not in detail


def test_dub_start_qwen_available_job_starts(monkeypatch):
    monkeypatch.setattr(main, "qwen_status", lambda: "available")
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "qwen"},
    )
    assert r.status_code == 200


def test_dub_start_gemini_unavailable_422_message(monkeypatch):
    monkeypatch.setattr(main, "gemini_available", lambda: False)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemini"},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == (
        "Gemini translation needs an API key. Open Settings and save your Gemini API key first."
    )


def test_dub_start_gemini_available_job_starts(monkeypatch):
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "gemini"},
    )
    assert r.status_code == 200


def test_dub_start_default_engine_path_is_preflighted(monkeypatch):
    # No translate_engine form field -> falls back to app.config.TRANSLATE_ENGINE,
    # which must still be preflighted (not silently skipped).
    monkeypatch.setattr(main, "TRANSLATE_ENGINE", "gemma")
    monkeypatch.setattr(main, "gemma_status", lambda: "model_missing")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 422
    assert "ollama pull" in r.json()["detail"]


def test_dub_start_translate_engine_case_insensitive(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "model_missing")

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "GEMMA"},
    )
    assert r.status_code == 422


def test_dub_start_vertex_engine_skips_preflight(monkeypatch):
    # vertex (and anything else not gemma/qwen/gemini) is out of scope for
    # preflight -- the job must start even when every check is False.
    monkeypatch.setattr(main, "gemma_available", lambda: False)
    monkeypatch.setattr(main, "qwen_available", lambda: False)
    monkeypatch.setattr(main, "gemini_available", lambda: False)
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "translate_engine": "vertex"},
    )
    assert r.status_code == 200


def test_dub_start_perso_stt_without_key_422_message(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "perso_available", lambda: False)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == (
        "Perso transcription needs an API key. Open Settings and save your Perso "
        "API key, or choose Local transcription."
    )


def test_dub_start_perso_stt_with_key_job_starts(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "perso_available", lambda: True)
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "stt_engine": "perso"},
    )
    assert r.status_code == 200


def test_dub_start_no_stt_engine_skips_perso_preflight(monkeypatch):
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "perso_available", lambda: False)
    monkeypatch.setattr(main, "run_dub", _fake_run_dub)

    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"vid", "video/mp4")},
        data={"language": "Korean", "language_code": "ko"},
    )
    assert r.status_code == 200
