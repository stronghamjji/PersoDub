import json

import pytest

from app import translate
from app.translate import (
    GEMINI_UPGRADE_URL,
    GeminiQuotaExhaustedError,
    GeminiTranslator,
    GeminiUnavailableError,
    OllamaTranslator,
    TranslationEngine,
    VertexTranslator,
    build_draft_prompt,
    build_dub_prompt,
    get_translator,
    parse_json_array,
    translate_scene,
)


class _FakeCreds:
    """Stand-in for google.oauth2.service_account.Credentials -- never touches a real key file."""

    def __init__(self, valid=True, token="FAKE_TOKEN", project_id="test-project"):
        self.valid = valid
        self.token = token
        self.project_id = project_id
        self.refreshed = False

    def refresh(self, request):
        self.refreshed = True
        self.valid = True
        self.token = "REFRESHED_TOKEN"


def test_build_prompt_lists_lines_and_target():
    prompt = build_dub_prompt(
        ["Hello", "How are you?"], "Korean", source_lang=None, durations=None
    )
    assert "Korean" in prompt
    assert "1." in prompt and "Hello" in prompt
    assert "2." in prompt and "How are you?" in prompt


def test_build_prompt_includes_duration_hint():
    prompt = build_dub_prompt(["Hi"], "Korean", None, durations=[1.4])
    assert "1.4" in prompt


def test_parse_plain_json_array():
    out = parse_json_array('["안녕", "잘 지내?"]', 2)
    assert out == ["안녕", "잘 지내?"]


def test_parse_strips_code_fence():
    raw = '```json\n["안녕", "반가워"]\n```'
    out = parse_json_array(raw, 2)
    assert out == ["안녕", "반가워"]


def test_parse_raises_on_count_mismatch():
    with pytest.raises(ValueError):
        parse_json_array('["하나"]', 2)


# --- Shared functions / Ollama translator ---
def test_shared_parse_extracts_array():
    assert parse_json_array('```json\n["가", "나"]\n```', 2) == ["가", "나"]


def test_ollama_translator_metadata():
    t = OllamaTranslator()
    assert t.id == "ollama"
    assert t.url.startswith("http")


def test_ollama_empty_returns_empty():
    assert OllamaTranslator().translate([], "Korean") == []


def test_get_translator_returns_engine():
    assert isinstance(get_translator(), TranslationEngine)


def test_build_prompt_fuller_asks_to_fill_slot():
    # When re-requesting a too-short translation: it must instruct to fill the time but not exceed it
    prompt = build_dub_prompt(["짧아"], "English", "Korean", [3.0], fuller=True)
    assert "fill" in prompt
    assert "exceed" in prompt  # "never exceed the given time"
    # must be a different prompt from the default (non-fuller) instruction
    assert prompt != build_dub_prompt(["짧아"], "English", "Korean", [3.0])




def test_ollama_translate_retries_on_count_mismatch(monkeypatch):
    # If the first response ignores the line count, re-ask with a correction and use the second success
    answers = ['["한 줄로 합침"]', '["첫 줄", "둘째 줄"]']
    asked = []

    t = OllamaTranslator()
    monkeypatch.setattr(t, "_ask", lambda p: (asked.append(p), answers.pop(0))[1])
    out = t.translate(["a", "b"], "Korean", durations=[1.0, 1.0])
    assert out == ["첫 줄", "둘째 줄"]
    assert len(asked) == 2 and "exactly 2" in asked[1]


def test_script_ok_korean_target():
    from app.translate import script_ok
    assert script_ok("덴트는 어딨어?", "Korean")
    assert not script_ok("dent đâu?", "Korean")   # real-world bad case
    assert not script_ok("?p", "Korean")


def test_script_ok_english_target_rejects_hangul():
    from app.translate import script_ok
    assert script_ok("Where is Dent?", "English")
    assert not script_ok("덴트 where?", "English")


def test_build_prompt_tiny_slot_uses_word_limit():
    # For sub-0.8s ultra-short lines, a "one or two words" instruction should go out instead of "within X seconds"
    prompt = build_dub_prompt(["Where's Dent?"], "Korean", None, [0.3])
    assert "one or two words" in prompt
    assert "0.3s" not in prompt


def test_translate_falls_back_to_per_line(monkeypatch):
    # If batch translation keeps breaking the line count, translate one line at a time to guarantee it
    calls = []

    def fake_ask(p):
        calls.append(p)
        if "1." in p and "2." in p:      # batch request → always merges and returns just 1 (bad)
            return '["합쳐진 한 줄"]'
        return '["한 줄 번역"]'          # single-line request → OK

    t = OllamaTranslator()
    monkeypatch.setattr(t, "_ask", fake_ask)
    out = t.translate(["a", "b"], "Korean", durations=[1.0, 1.0])
    assert out == ["한 줄 번역", "한 줄 번역"]
    assert len(calls) == 5  # 3 batch failures + 2 single-line


def test_script_ok_korean_rejects_mixed_latin():
    from app.translate import script_ok
    assert not script_ok("덴 đâu?", "Korean")        # Hangul + Vietnamese (real case)
    assert not script_ok("dent 자리에 들어가", "Korean")  # Hangul + English (real case)
    assert script_ok("덴트는 어딨어?", "Korean")


# --- Engine selection + Gemini consumer-key adapter + two-pass flow ---
def test_max_budget_retries_per_translator():
    # cost-driven policy: local/free (Ollama) keeps the full retry budget, paid Google
    # engines (Gemini/Vertex) get none -- exactly one translation attempt per line.
    assert OllamaTranslator().max_budget_retries == 3
    assert GeminiTranslator(api_key="x").max_budget_retries == 0


def test_get_translator_selects_engine():
    assert get_translator("qwen").model == "qwen2.5:7b"
    assert get_translator("gemma").model == "gemma3:12b"
    assert isinstance(get_translator("gemini"), GeminiTranslator)


def test_ollama_ask_pins_sampling_options(monkeypatch):
    # The server's gemma-dub carries no sampling parameters, so it ran on
    # Ollama's defaults. The public gemma3:12b bakes in top_k 64 / top_p 0.95,
    # which samples more loosely -- off-target languages and lines that miss the
    # +-15% length window. Sending them explicitly makes both hosts identical.
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": "안녕"}}

    def fake_post(url, json=None, timeout=None):
        captured["body"] = json
        return FakeResp()

    monkeypatch.setattr(translate.requests, "post", fake_post)
    assert OllamaTranslator(model="gemma3:12b")._ask("hi") == "안녕"
    opts = captured["body"]["options"]
    assert opts["top_k"] == 40
    assert opts["top_p"] == 0.9
    assert opts["temperature"] == 0.3
    assert opts["num_predict"] == 2048


def test_gemini_ask_builds_request(monkeypatch):
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "안녕"}]}}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        return FakeResp()

    monkeypatch.setattr(translate.requests, "post", fake_post)
    t = GeminiTranslator(api_key="TESTKEY", model="gemini-flash-latest")
    assert t._ask("hi") == "안녕"
    assert "gemini-flash-latest" in captured["url"]
    assert "generativelanguage.googleapis.com" in captured["url"]
    # The key travels in the header, NEVER in the URL: raise_for_status() puts
    # the URL in error messages, which reach job logs and the screen.
    assert "TESTKEY" not in captured["url"]
    assert captured["headers"]["x-goog-api-key"] == "TESTKEY"


def test_gemini_ask_without_key_raises():
    with pytest.raises(RuntimeError):
        GeminiTranslator(api_key="")._ask("hi")


def test_gemini_429_raises_quota_exhausted_with_upgrade_link(monkeypatch):
    # Still 429 after every backoff round -> the dedicated exception (not a bare
    # HTTPError), carrying the AI Studio upgrade link for the UI popup.
    calls = []

    class FakeResp:
        status_code = 429

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append(url)
        return FakeResp()

    monkeypatch.setattr(translate.requests, "post", fake_post)
    monkeypatch.setattr(translate.time, "sleep", lambda s: None)
    with pytest.raises(GeminiQuotaExhaustedError) as ei:
        GeminiTranslator(api_key="K")._ask("hi")
    assert ei.value.link == GEMINI_UPGRADE_URL
    assert len(calls) == 4  # kept the existing backoff rounds


def test_gemini_5xx_raises_unavailable_immediately(monkeypatch):
    # Server-side outage (503): fail fast with the dedicated exception -- same
    # no-retry behavior raise_for_status() had, but without the raw URL/error
    # text reaching the screen.
    calls = []

    class FakeResp:
        status_code = 503

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append(url)
        return FakeResp()

    monkeypatch.setattr(translate.requests, "post", fake_post)
    with pytest.raises(GeminiUnavailableError):
        GeminiTranslator(api_key="K")._ask("hi")
    assert len(calls) == 1


# --- Vertex AI Gemini adapter (service-account OAuth, no consumer key) ---
def _vertex(**kw):
    # dependency-injection seam -- never reads a real key file
    kw.setdefault("credentials", _FakeCreds())
    kw.setdefault("project", "test-project")
    return VertexTranslator(**kw)


def test_vertex_translator_metadata_and_no_retries():
    t = _vertex()
    assert t.id == "vertex"
    assert t.max_budget_retries == 0  # paid API, same cost-driven policy as GeminiTranslator
    assert isinstance(t, GeminiTranslator)  # reuses GeminiTranslator's .translate()/prompts


def test_vertex_ask_builds_oauth_request(monkeypatch):
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "안녕"}]}}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        return FakeResp()

    monkeypatch.setattr(translate.requests, "post", fake_post)
    t = _vertex(location="us-central1", model="gemini-2.5-flash")
    assert t._ask("hi") == "안녕"
    assert "us-central1-aiplatform.googleapis.com" in captured["url"]
    assert "test-project" in captured["url"]
    assert "gemini-2.5-flash" in captured["url"]
    assert captured["headers"]["Authorization"] == "Bearer FAKE_TOKEN"
    # OAuth bearer token, never a ?key= query param like the AI Studio adapter
    assert "key=" not in captured["url"]


def test_vertex_token_refreshes_when_invalid(monkeypatch):
    monkeypatch.setattr(translate.requests, "post", lambda *a, **k: type(
        "R", (), {"raise_for_status": lambda s: None,
                  "json": lambda s: {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}})())
    creds = _FakeCreds(valid=False)
    t = _vertex(credentials=creds)
    t._ask("hi")
    assert creds.refreshed
    assert creds.token == "REFRESHED_TOKEN"


def test_get_translator_selects_vertex(monkeypatch):
    # get_translator("vertex") must not read the real service-account key file in tests.
    monkeypatch.setattr(
        translate.service_account.Credentials, "from_service_account_file",
        lambda *a, **k: _FakeCreds()
    )
    t = get_translator("vertex")
    assert isinstance(t, VertexTranslator)


def test_build_draft_prompt_has_context():
    p = build_draft_prompt(
        ["Hi", "Bye"], "Korean", "English", speakers=["Joker", "Batman"]
    )
    assert "[Joker]" in p
    assert "[Batman]" in p
    assert "Korean" in p
    assert "JSON array" in p
    assert "exactly 2" in p


def test_translate_scene_two_pass():
    long_ko = "가" * 1005  # exceeds any real syllable budget -> forces the shorten pass
    calls = []

    class FakeEngine:
        def _ask(self, prompt):
            calls.append(prompt)
            if "too long" in prompt:  # keyword present only in build_shorten_prompt output
                return json.dumps(["짧아", "줄여"])
            return json.dumps([long_ko, long_ko])

    fake = FakeEngine()
    out = translate_scene(
        fake, ["a", "b"], "Korean", source_lang="English", durations=[0.5, 0.5]
    )
    assert len(out) == 2
    assert out == ["짧아", "줄여"]  # over-budget draft lines got shortened

    calls.clear()
    out2 = translate_scene(fake, ["a", "b"], "Korean")
    assert len(out2) == 2
    assert out2 == [long_ko, long_ko]  # draft returned as-is
    assert len(calls) == 1  # no shorten pass without durations
