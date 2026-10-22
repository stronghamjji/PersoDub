"""ChatGPT cannot answer mid-dub (the free plan's allowance ran out for weeks
after a dozen dubbings, 2026-10-02): the dubbing stops at translation with the
notice, and no other translator is asked, even one that is right here. The
user picks another one on the popup and resumes (owner, 2026-10-03)."""
import pytest

from app import engines_status, pipeline
from app.text.srt import build_srt
from app.translate import ChatGptLimitError, ChatGptNotSignedInError, TranslationEngine


class _Limited(TranslationEngine):
    display_name = "ChatGPT"
    error = ChatGptLimitError("ChatGPT usage limit reached")

    def translate(self, texts, *a, **k):
        raise self.error


class _Gemma(TranslationEngine):
    display_name = "Ollama (local LLM)"
    model = "gemma3:12b"

    def __init__(self):
        self.asked = []

    def translate(self, texts, *a, **k):
        self.asked.append(list(texts))
        return ["%s (ko)" % t for t in texts]


def _world(monkeypatch, tmp_path):
    """Every other stage replaced; the translate stage runs for real, with
    _auto_translate_srt reduced to one call of translator.translate. Gemma and
    Hunyuan are both here and ready."""
    def auto_translate(source_cues, language, translator, work_dir, log=None, **k):
        lines = translator.translate([c["text"] for c in source_cues])
        path = tmp_path / "translated.srt"
        path.write_text(build_srt([{**c, "text": t} for c, t in zip(source_cues, lines)]), encoding="utf-8")
        return str(path)

    cues = [{"start": 0.0, "end": 1.5, "text": "hola"}, {"start": 1.5, "end": 3.0, "text": "adios"}]
    monkeypatch.setattr(pipeline, "_video_duration", lambda p: 3.0)
    monkeypatch.setattr(pipeline, "_check_room", lambda *a: None)
    monkeypatch.setattr(pipeline, "_auto_translate_srt", auto_translate)
    monkeypatch.setattr(pipeline, "_stage_separate",
                        lambda *a, **k: (str(tmp_path / "vocals.wav"), str(tmp_path / "background.wav"), None, None))
    monkeypatch.setattr(pipeline, "_stage_transcribe_local", lambda *a, **k: (cues, "es", None))
    monkeypatch.setattr(pipeline, "_stage_diarize", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_stage_synthesize", lambda *a, **k: pytest.fail("voices made"))
    gemma = _Gemma()
    monkeypatch.setattr(pipeline, "get_translator", lambda engine=None: gemma)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "available")
    monkeypatch.setattr(engines_status, "hunyuan_status", lambda: "available")
    return gemma


def _run(tmp_path, translator, logs, notices):
    return pipeline.run_dub(video_path=str(tmp_path / "input.mp4"), out_path=str(tmp_path / "dubbed.mp4"),
                            language="Korean", language_code="ko", translate_engine="chatgpt",
                            translator=translator, log=logs.append, on_notice=notices.append)


def test_the_limit_stops_the_dubbing_with_its_notice_and_asks_no_other_translator(tmp_path, monkeypatch):
    gemma = _world(monkeypatch, tmp_path)
    logs, notices = [], []
    with pytest.raises(RuntimeError, match="ChatGPT usage limit reached"):
        _run(tmp_path, _Limited(), logs, notices)
    assert gemma.asked == []
    assert [n["type"] for n in notices] == ["chatgpt_limit"]
    assert not (tmp_path / "translated.srt").exists()


def test_the_limit_notice_says_when_it_resets_when_openai_said(tmp_path, monkeypatch):
    _world(monkeypatch, tmp_path)
    logs, notices = [], []
    limited = _Limited()
    limited.error = ChatGptLimitError("ChatGPT usage limit reached", "Oct 24, 1:07 PM")
    with pytest.raises(RuntimeError):
        _run(tmp_path, limited, logs, notices)
    assert notices[0]["message"] == ("ChatGPT usage limit reached. Resets Oct 24, 1:07 PM. "
                                     "Resume then, or continue with another translator.")


def test_the_limit_notice_on_a_korean_screen_writes_the_time_the_korean_way(tmp_path, monkeypatch):
    """The English keeps Codex's time for the page to read back; the line on
    the screen says it as Korean writes a time (A32)."""
    from app import i18n
    _world(monkeypatch, tmp_path)
    monkeypatch.setattr(i18n, "_language", "ko")
    logs, notices = [], []
    limited = _Limited()
    limited.error = ChatGptLimitError("ChatGPT usage limit reached", "Oct 24, 1:07 PM")
    with pytest.raises(RuntimeError):
        _run(tmp_path, limited, logs, notices)
    assert "Resets Oct 24, 1:07 PM." in notices[0]["message"]
    assert "10월 24일 오후 1:07에" in notices[0]["message_shown"]
    assert "Oct" not in notices[0]["message_shown"]


def test_a_signed_out_chatgpt_stops_the_same_way(tmp_path, monkeypatch):
    gemma = _world(monkeypatch, tmp_path)
    logs, notices = [], []
    out = _Limited()
    out.error = ChatGptNotSignedInError("ChatGPT is not signed in")
    with pytest.raises(RuntimeError, match="ChatGPT is not signed in"):
        _run(tmp_path, out, logs, notices)
    assert gemma.asked == []
    assert [n["type"] for n in notices] == ["chatgpt_signed_out"]


def test_pace_fit_keeps_the_first_translation_when_the_limit_hits(tmp_path):
    """The lines are voiced already; a limit here must not fail the job."""
    from app import qwen_pipeline as qp
    from tests.test_pace_fit import _first_voicing, _PacedEngine, _Translator
    segments = [{"start": 0.0, "end": 4.0, "text": "가나다라마바사아자차카타파하"}]
    engine = _PacedEngine()
    paths = _first_voicing(engine, segments, tmp_path)

    def limit(p):
        raise ChatGptLimitError("ChatGPT usage limit reached")
    logs = []
    qp.fit_to_pace(engine, _Translator(limit), segments, ["A"], {"A": "v"}, [], "Korean", str(tmp_path),
                   paths, [4.0], logs.append)
    assert segments[0]["text"] == "가나다라마바사아자차카타파하" and engine.said == []
    assert any("pace fit stopped" in m and "ChatGptLimitError" in m for m in logs)
