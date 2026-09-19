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


def test_ollama_translator_metadata(monkeypatch):
    # No kit here (no PERSODUB_KIT_DIR/runtime.json), so runtime.url("ollama")
    # is config.OLLAMA_URL -- the dev-run-without-the-shell path.
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:11434")
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


def test_get_translator_gives_every_name_its_own_engine(monkeypatch):
    # One table now answers every name (translate.TRANSLATORS). Each name must
    # still hand back the same class and model it did as an if-chain, and a
    # name nobody knows must still fall back to the free local engine.
    monkeypatch.setattr(
        translate.service_account.Credentials, "from_service_account_file",
        lambda *a, **k: _FakeCreds()
    )
    expected = {
        "gemini": (GeminiTranslator, translate.GEMINI_MODEL),
        "vertex": (VertexTranslator, translate.VERTEX_MODEL),
        "qwen": (OllamaTranslator, translate.OLLAMA_QWEN_MODEL),
        "gemma": (OllamaTranslator, translate.OLLAMA_GEMMA_MODEL),
        "hunyuan": (OllamaTranslator, translate.OLLAMA_HUNYUAN_MODEL),
    }
    for name, (cls, model) in expected.items():
        t = get_translator(name)
        assert type(t) is cls, name
        assert t.model == model, name
        # Upper case reaches the same row -- the name is lowered before lookup.
        assert type(get_translator(name.upper())) is cls, name

    # With no setting either, an unknown or empty name lands on Ollama's own
    # default model.
    monkeypatch.setattr(translate, "TRANSLATE_ENGINE", "")
    for unknown in ("", "llama", None):
        t = get_translator(unknown)
        assert type(t) is OllamaTranslator, unknown
        assert t.model == translate.OLLAMA_MODEL, unknown


def test_get_translator_reads_the_class_at_call_time(monkeypatch):
    # The table holds lambdas, not classes captured at import: a test that swaps
    # a translator class on the module must get its own class back.
    class FakeOllama(OllamaTranslator):
        pass

    monkeypatch.setattr(translate, "OllamaTranslator", FakeOllama)
    assert type(get_translator("gemma")) is FakeOllama
    assert type(get_translator("nothing-like-this")) is FakeOllama


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


# --- a line that came back as something other than text ----------------------

def test_a_line_that_is_not_text_is_a_malformed_answer():
    # str() of a dict went into the script and the voice read the braces aloud
    # (Windows full test, 2026-09-17). Raising is what makes the caller ask again.
    with pytest.raises(ValueError, match="not text"):
        parse_json_array('[{"candidates": ["a", "b", "c"]}, "全部学生のせいじゃないのか？"]', 2)
    with pytest.raises(ValueError, match="not text"):
        parse_json_array('[["a", "b"], "c"]', 2)
    with pytest.raises(ValueError, match="not text"):
        parse_json_array('[7, "c"]', 2)


def test_an_object_holding_one_string_is_that_string():
    assert parse_json_array('[{"text": "안녕"}, "잘 지내?"]', 2) == ["안녕", "잘 지내?"]


# --- one line that cannot be translated does not end the job -----------------

def _numbered(prompt):
    """The lines a prompt asks for, as their text (the "N. ..." lines)."""
    return [ln.split(" ", 1)[1].split(") ", 1)[-1]
            for ln in prompt.splitlines() if ln[:1].isdigit() and ". " in ln]


def test_a_line_that_keeps_failing_is_left_untranslated_and_the_rest_are_translated(monkeypatch):
    # Issue #82: after the batch and its per-line fallback, one line still would
    # not come back as text -- and the whole 969-line job died with it.
    asked = []

    def fake_ask(p):
        asked.append(p)
        lines = _numbered(p)
        if len(lines) > 1:
            return '["merged into one"]'          # the batch always breaks the count
        if lines == ["bad"]:
            return '["cut off mid-str'            # issue #88's truncated answer
        return json.dumps(["번역 " + lines[0]], ensure_ascii=False)

    t = OllamaTranslator()
    monkeypatch.setattr(t, "_ask", fake_ask)
    out = t.translate(["a", "bad", "c"], "Korean", durations=[1.0, 1.0, 1.0])

    assert out == ["번역 a", translate.UNTRANSLATED, "번역 c"]
    assert translate.UNTRANSLATED == ""
    # 3 batch tries, then 1 + 3 + 1 single-line asks: the bad line had its retries.
    assert len(asked) == 3 + 5


def test_an_unreachable_translator_still_fails_the_job(monkeypatch):
    # Only a bad ANSWER is forgiven. A translator that cannot be reached would
    # leave every line empty, and a silent video is not a finished dub.
    def fake_ask(p):
        raise translate.requests.exceptions.ConnectionError("refused")

    t = OllamaTranslator()
    monkeypatch.setattr(t, "_ask", fake_ask)
    with pytest.raises(translate.requests.exceptions.ConnectionError):
        t.translate(["a", "b"], "Korean")


def test_the_plain_translate_is_asked_in_chunks(monkeypatch):
    # The pipeline's fallback hands translate() every line of the video. One
    # prompt holding 969 lines asks for an answer longer than the model writes.
    from app.text.length_fit import DRAFT_CHUNK
    sizes = []

    def fake_ask(p):
        lines = _numbered(p)
        sizes.append(len(lines))
        return json.dumps(["번역 " + x for x in lines], ensure_ascii=False)

    t = OllamaTranslator()
    monkeypatch.setattr(t, "_ask", fake_ask)
    texts = ["line%d" % i for i in range(2 * DRAFT_CHUNK + 1)]
    out = t.translate(texts, "Korean", durations=[1.0 + i for i in range(len(texts))])

    assert sizes == [DRAFT_CHUNK, DRAFT_CHUNK, 1]
    assert out == ["번역 " + x for x in texts]


# --- the Ollama request itself ------------------------------------------------

class _OllamaResp:
    def __init__(self, status, text="", content="안녕"):
        self.status_code = status
        self.text = text
        self._content = content

    def json(self):
        return {"message": {"content": self._content}}


def _ollama_posts(monkeypatch, answers):
    """Make requests.post answer from `answers` in order (a response, or an
    exception to raise), and record the calls and the waits between them."""
    log = {"calls": 0, "sleeps": [], "bodies": []}

    def fake_post(url, json=None, timeout=None):
        log["calls"] += 1
        log["bodies"].append(json)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    monkeypatch.setattr(translate.requests, "post", fake_post)
    monkeypatch.setattr(translate.time, "sleep", lambda s: log["sleeps"].append(s))
    return log


def test_ollama_ask_retries_a_server_error_then_succeeds(monkeypatch):
    # A 5xx from a local server is the model runner dying and being reloaded.
    log = _ollama_posts(monkeypatch, [
        _OllamaResp(500, '{"error":"llama runner process has terminated"}'),
        _OllamaResp(200),
    ])
    assert OllamaTranslator(url="http://127.0.0.1:1")._ask("hi") == "안녕"
    assert log["calls"] == 2
    assert log["sleeps"] == [translate.OLLAMA_BACKOFF_S]


def test_ollama_ask_retries_a_refused_connection_and_a_timeout(monkeypatch):
    # Refused while the desktop restarts the pack; a timeout while it is busy.
    log = _ollama_posts(monkeypatch, [
        translate.requests.exceptions.ConnectionError("refused"),
        translate.requests.exceptions.Timeout("slow"),
        _OllamaResp(200),
    ])
    assert OllamaTranslator(url="http://127.0.0.1:1")._ask("hi") == "안녕"
    assert log["calls"] == 3
    assert log["sleeps"] == [translate.OLLAMA_BACKOFF_S, 2 * translate.OLLAMA_BACKOFF_S]


def test_ollama_ask_gives_up_after_its_tries_with_ollamas_reason_in_the_message(monkeypatch):
    body = '{"error":"llama runner process has terminated: exit status 2"}'
    log = _ollama_posts(monkeypatch, [_OllamaResp(500, body)] * translate.OLLAMA_TRIES)
    with pytest.raises(translate.requests.exceptions.HTTPError) as ei:
        OllamaTranslator(url="http://127.0.0.1:1")._ask("hi")
    assert log["calls"] == translate.OLLAMA_TRIES == 3
    msg = str(ei.value)
    assert "HTTP 500" in msg and "llama runner process has terminated" in msg
    assert "127.0.0.1" not in msg   # the reason, not the address


def test_ollama_ask_does_not_retry_a_client_error(monkeypatch):
    # A 4xx is our own request (a model that is not installed) -- it would
    # fail the same way again.
    log = _ollama_posts(monkeypatch, [_OllamaResp(404, '{"error":"model \'gemma3:12b\' not found"}')])
    with pytest.raises(translate.requests.exceptions.HTTPError, match="not found"):
        OllamaTranslator(url="http://127.0.0.1:1")._ask("hi")
    assert log["calls"] == 1


def test_ollama_error_reason_does_not_carry_the_home_folder(monkeypatch):
    import os
    home = os.path.expanduser("~")
    body = '{"error":"open %s/.ollama/models/blobs/sha256-abc: no such file"}' % home
    _ollama_posts(monkeypatch, [_OllamaResp(404, body)])
    with pytest.raises(translate.requests.exceptions.HTTPError) as ei:
        OllamaTranslator(url="http://127.0.0.1:1")._ask("hi")
    assert home not in str(ei.value)
    assert "no such file" in str(ei.value)


def test_ollama_answer_cap_grows_with_the_lines_asked_for(monkeypatch):
    # A fixed 2048 cut a long answer off mid-string (issue #88). The cap follows
    # the numbered lines -- a full chunk keeps the old 2048 -- and the scene
    # context listed for flow ("- ...") does not count.
    from app.text.length_fit import DRAFT_CHUNK, build_candidates_draft_prompt
    log = _ollama_posts(monkeypatch, [_OllamaResp(200) for _ in range(5)])
    t = OllamaTranslator(url="http://127.0.0.1:1")
    scene = ["scene line %d." % i for i in range(300)]
    t._ask(build_dub_prompt(["a"], "Korean", None, [1.0]))
    t._ask(build_dub_prompt(["x"] * DRAFT_CHUNK, "Korean", None, [1.0] * DRAFT_CHUNK))
    t._ask(build_candidates_draft_prompt(["x"] * DRAFT_CHUNK, "Korean", None, [10] * DRAFT_CHUNK,
                                         scene_context=scene))
    t._ask(build_dub_prompt(["x"] * 100, "Korean", None, None))
    t._ask("hi")
    caps = [b["options"]["num_predict"] for b in log["bodies"]]
    assert caps == [1024, 2048, 2048, 8192, 2048]
    # No JSON mode: Ollama's forces an object at the top, and every prompt asks for an array.
    assert all("format" not in b for b in log["bodies"])
