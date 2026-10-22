"""Editing a Perso dub on Perso's side: the client's calls, the rule between
Perso's voices and this computer's, and the routes the screen and the agent
press (app/perso_client.py, app/perso_edit.py, app/api/script.py).

No test here reaches Perso. The calls that write had never been made for real
when these were written, so what Perso answers is the documented shape.
"""
import json
import os
import shutil
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import app.api.script as script_api
from app import perso_client as pcm
from app import perso_edit, perso_materialize, state
from app.main import app
from app.perso_client import (
    PersoClient,
    PersoCreditExhaustedError,
    PersoModelRefusedError,
    PersoUnavailableError,
)
from app.text.srt import build_srt

client = TestClient(app, base_url="http://127.0.0.1")
# The real one, kept from before any test puts a no-op in its place.
_sleep = time.sleep

SENTENCE = "https://api.perso.ai/video-translator/api/v1/project/77/audio-sentence/501"


# ── The client ─────────────────────────────────────────────────────────────

def _answer(status=200, body=None):
    return httpx.Response(status, json=body if body is not None else {},
                          request=httpx.Request("GET", "https://api.perso.ai/x"))


@pytest.fixture
def pc(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "9")
    monkeypatch.setattr(pcm.time, "sleep", lambda s: None)
    return PersoClient(poll_interval=0)


@pytest.fixture
def http(monkeypatch):
    """Every call the client makes, and the answer each one is given."""
    calls = []
    answers = {}

    def verb(name):
        def fake(url, **kw):
            calls.append((name, url, kw))
            got = answers.get((name, url), answers.get(name))
            if isinstance(got, list):
                got = got.pop(0)
            if isinstance(got, Exception):
                raise got
            return got if got is not None else _answer()
        return fake

    for name in ("get", "post", "put", "patch"):
        monkeypatch.setattr(pcm.httpx, name, verb(name))
    return type("Http", (), {"calls": calls, "answers": answers})


# (what the test calls it, the client's method, verb, address, what is sent)
WRITES = [
    ("edit", lambda c: c.edit_sentence(77, 501, "Hi"), "patch", SENTENCE, {"targetText": "Hi"}),
    ("voice", lambda c: c.regenerate_sentence_audio(77, 501, "Hi"), "patch",
     SENTENCE + "/generate-audio", {"targetText": "Hi"}),
    ("fit", lambda c: c.match_rewrite(77, 501, "Hi"), "post",
     SENTENCE + "/match-rewrite", {"targetText": "Hi"}),
    ("reset", lambda c: c.reset_sentence(77, 501), "put", SENTENCE + "/reset", None),
    ("status", lambda c: c.retranslation_status(77), "get",
     "https://api.perso.ai/video-translator/api/v1/projects/77/spaces/9/retranslation/status",
     None),
]
IDS = [w[0] for w in WRITES]


@pytest.mark.parametrize("_name,call,verb,url,body", WRITES, ids=IDS)
def test_each_call_goes_where_the_documents_say(pc, http, _name, call, verb, url, body):
    call(pc)
    name, asked, kw = http.calls[0]
    assert (name, asked) == (verb, url)
    assert kw.get("json") == body
    # The key and the app's name ride along, and no call waits for ever.
    assert kw["headers"]["XP-API-KEY"] == "dummy"
    assert kw["headers"]["X-Perso-Client-Host"] == pcm.CLIENT_HOST
    assert kw["timeout"] and kw["timeout"] <= 300


def test_what_perso_answers_is_handed_back(pc, http):
    http.answers["patch"] = _answer(body={"result": {
        "scriptSeq": 1, "generateAudioFilePath": "/audio/1.mp3",
        "matchingRate": {"level": 3, "levelType": "GOOD"}}})
    assert pc.regenerate_sentence_audio(77, 501, "Hi")["generateAudioFilePath"] == "/audio/1.mp3"
    http.answers["post"] = _answer(body={"result": {
        "matchingRate": {"level": 4, "levelType": "EXCELLENT"},
        "rewrite": {"speed": "normal", "current": 115}}})
    assert pc.match_rewrite(77, 501, "Hi")["matchingRate"]["level"] == 4
    http.answers["put"] = _answer(body={"result": {"proofreadTranslatedText": "Hello"}})
    assert pc.reset_sentence(77, 501) == {"proofreadTranslatedText": "Hello"}


def test_retranslation_status_reads_the_flag_where_perso_puts_it(pc, http):
    # Seen live 2026-09-29: no `result` around it.
    http.answers["get"] = _answer(body={"retranslateAvailable": True})
    assert pc.retranslation_status(77) is True
    http.answers["get"] = _answer(body={"retranslateAvailable": False})
    assert pc.retranslation_status(77) is False
    http.answers["get"] = _answer(body={})
    assert pc.retranslation_status(77) is False


def test_project_detail_names_the_voice_model(pc, http):
    http.answers["get"] = _answer(body={"seq": 77, "ttsModel": "NIGHTINGALE", "isEditable": True})
    assert pc.project_detail(77)["ttsModel"] == "NIGHTINGALE"
    assert http.calls[0][1].endswith("/projects/77/spaces/9")


QUOTA = "https://api.perso.ai/video-translator/api/v1/projects/spaces/9/media/quota"


def test_proofread_price_asks_the_estimate_for_this_project(pc, http):
    http.answers["get"] = _answer(body={"result": {
        "expectedUsedQuota": 720.0, "promotionExpectedUsedQuota": 540.0, "exportCount": 2}})
    assert pc.proofread_price(77, 120000, 1920, 1080, tts_model="NIGHTINGALE") == {
        "credits": 540.0, "export_count": 2}
    name, url, kw = http.calls[0]
    assert (name, url) == ("get", QUOTA)
    assert kw["params"] == {"mediaType": "video", "durationMs": 120000, "width": 1920,
                            "height": 1080, "projectSeq": 77,
                            "ttsModelCounts": "NIGHTINGALE:1"}
    assert kw["headers"]["XP-API-KEY"] == "dummy" and kw["timeout"] <= 60


@pytest.mark.parametrize("body,want", [
    ({"result": {"expectedUsedQuota": 12, "exportCount": None}}, {"credits": 12, "export_count": None}),
    ({"result": {"promotionExpectedUsedQuota": 0, "expectedUsedQuota": 12, "exportCount": 1}},
     {"credits": 0, "export_count": 1}),
    ({"expectedUsedQuota": 7}, {"credits": 7, "export_count": None}),
    ({"result": {"expectedUsedQuota": "soon", "exportCount": "1"}}, {"credits": None, "export_count": None}),
    ({"result": {"expectedUsedQuota": -1}}, {"credits": None, "export_count": None}),
    ({}, {"credits": None, "export_count": None}),
], ids=["list", "discount", "bare", "words", "negative", "empty"])
def test_proofread_price_is_unknown_rather_than_guessed(pc, http, body, want):
    http.answers["get"] = _answer(body=body)
    assert pc.proofread_price(77, 1000, 640, 360) == want
    assert "ttsModelCounts" not in http.calls[0][2]["params"]


def test_proofread_price_refused_is_an_error_for_the_caller(pc, http):
    http.answers["get"] = _answer(400, {"code": "VT4001", "message": "width required"})
    with pytest.raises(httpx.HTTPStatusError):
        pc.proofread_price(77, 1000, 640, 360)


@pytest.mark.parametrize("_name,call,verb,_url,_body", WRITES, ids=IDS)
def test_out_of_credits_is_its_own_error(pc, http, _name, call, verb, _url, _body):
    http.answers[verb] = _answer(402, {"code": "VT4021", "message": "Insufficient credits"})
    with pytest.raises(PersoCreditExhaustedError):
        call(pc)


@pytest.mark.parametrize("_name,call,verb,_url,_body", WRITES, ids=IDS)
def test_a_refusal_carries_persos_own_words_and_no_address(pc, http, _name, call, verb, _url, _body):
    http.answers[verb] = _answer(404, {"code": "VT4041", "message": "Project not found"})
    with pytest.raises(httpx.HTTPStatusError) as e:
        call(pc)
    assert "Project not found" in str(e.value) and "VT4041" in str(e.value)
    assert "api.perso.ai" not in str(e.value)


@pytest.mark.parametrize("_name,call,verb,_url,_body", WRITES, ids=IDS)
def test_a_server_error_is_persos_outage(pc, http, _name, call, verb, _url, _body):
    http.answers[verb] = _answer(503, {"code": "VT5034", "message": "Queue full"})
    with pytest.raises(PersoUnavailableError):
        call(pc)


@pytest.mark.parametrize("_name,call,verb,_url,_body", WRITES, ids=IDS)
def test_a_call_perso_never_answers_times_out(pc, http, _name, call, verb, _url, _body):
    http.answers[verb] = httpx.ReadTimeout("timed out")
    with pytest.raises(httpx.TimeoutException):
        call(pc)


def test_a_nightingale_project_refuses_a_single_line(pc, http):
    http.answers["patch"] = _answer(400, {"code": "VT40918",
                                          "message": "The TTS model does not support this option"})
    with pytest.raises(PersoModelRefusedError):
        pc.regenerate_sentence_audio(77, 501, "Hi")


PROOFREAD = "https://api.perso.ai/video-translator/api/v1/project/77/space/9/proofread"


def _progress(*reasons):
    return [_answer(body={"result": {"progressReason": r}}) for r in reasons]


def test_proofread_asks_then_waits_for_the_new_run(pc, http):
    http.answers["post"] = _answer(body={"result": {}})
    # Still "Completed" from the dub, then at work, then done again.
    http.answers["get"] = _progress("Completed", "Completed", "Processing", "Completed")
    asked = []
    pc.proofread(77, on_asked=lambda: asked.append(len(http.calls)))

    name, url, kw = http.calls[0]
    assert (name, url) == ("post", PROOFREAD)
    assert kw["json"] == {"preferredSpeedType": "GREEN"}
    assert kw["timeout"]
    # Noted the moment Perso took it, before any waiting.
    assert asked == [1]
    assert len([c for c in http.calls if c[0] == "get"]) == 4


def test_proofread_believes_completed_once_the_project_had_time_to_start(pc, http, monkeypatch):
    http.answers["post"] = _answer(body={"result": {}})
    http.answers["get"] = _progress("Completed", "Completed", "Completed")
    # Each wait between two askings is half the time the project is given.
    now = [0.0]
    monkeypatch.setattr(pcm.time, "time", lambda: now[0])
    monkeypatch.setattr(pcm.time, "sleep",
                        lambda s: now.__setitem__(0, now[0] + pcm.PROOFREAD_SETTLE_S / 2))
    pc.proofread(77)
    assert len([c for c in http.calls if c[0] == "get"]) == 3


def test_proofread_sends_lip_sync_only_when_asked(pc, http):
    http.answers["post"] = _answer(body={"result": {}})
    http.answers["get"] = _progress("Processing", "Completed")
    pc.proofread(77, lip_sync=True)
    assert http.calls[0][2]["json"] == {"preferredSpeedType": "GREEN", "isLipSync": True}


def test_proofread_refused_by_the_voice_model(pc, http):
    http.answers["post"] = _answer(400, {"code": "VT40918", "message": "RED is not supported"})
    asked = []
    with pytest.raises(PersoModelRefusedError):
        pc.proofread(77, speed="RED", on_asked=lambda: asked.append(1))
    assert asked == [] and len(http.calls) == 1


def test_proofread_out_of_credits(pc, http):
    http.answers["post"] = _answer(402, {"code": "VT4021"})
    with pytest.raises(PersoCreditExhaustedError):
        pc.proofread(77)


def test_proofread_that_perso_never_answers_times_out(pc, http):
    http.answers["post"] = httpx.ReadTimeout("timed out")
    with pytest.raises(httpx.TimeoutException):
        pc.proofread(77)


def test_a_proofread_perso_gave_up_on_says_so(pc, http):
    http.answers["post"] = _answer(body={"result": {}})
    http.answers["get"] = [_answer(body={"result": {"progressReason": "Failed", "hasFailed": True}})]
    with pytest.raises(pcm.PersoProjectFailedError):
        pc.proofread(77)


def test_the_finished_video_downloads_on_its_own(pc, http, tmp_path, monkeypatch):
    base = "https://api.perso.ai/video-translator/api/v1/projects/77/spaces/9"
    http.answers[("get", base + "/download-info")] = _answer(
        body={"result": {"hasTranslatedVideo": True}})
    http.answers[("get", base + "/download")] = _answer(
        body={"result": {"videoFile": {"videoDownloadLink": "/perso-storage/v.mp4"}}})
    got = []
    monkeypatch.setattr(PersoClient, "download_media",
                        lambda self, link, out, **kw: got.append((link, out)) or out)
    out = str(tmp_path / "dubbed.mp4")
    assert pc.download_dub(77, out) == out
    assert got == [("/perso-storage/v.mp4", out)]


# ── The rule, and the routes ───────────────────────────────────────────────

DUB = [(0.0, 2.0, "Hi there"), (3.0, 5.0, "Bye now")]
SOURCE = [(0.0, 2.0, "안녕"), (3.0, 5.0, "잘 가")]


class FakePerso:
    """Perso's side of one project: two sentences, and a record of every
    call that would have cost something."""
    poll_interval = 0
    space_seq = 9

    def __init__(self):
        self.sentences = [
            {"seq": 501, "originalText": "안녕", "translatedText": "Hi there",
             "offsetMs": 0, "durationMs": 2000, "speakerOrderIndex": 1,
             "audioUrl": "/perso-storage/a1.mp3"},
            {"seq": 502, "originalText": "잘 가", "translatedText": "Bye now",
             "offsetMs": 3000, "durationMs": 2000, "speakerOrderIndex": 1,
             "audioUrl": "/perso-storage/a2.mp3"},
        ]
        self.spent = []
        self.fetched = []
        self.credits = 100
        self.credits_used = 0
        self.tts_model = "ORIOLE"
        self.retranslate = True
        self.price = {"credits": 40, "export_count": None}
        self.priced = []
        self.reword = {}
        self.fail = {}
        self.voice_answer = lambda n: {"generateAudioFilePath": "/perso-storage/new%d.mp3" % n}

    def _maybe_fail(self, what):
        if what in self.fail:
            raise self.fail[what]

    def describe_workspace(self):
        return {"seq": 9, "name": "w", "credits": self.credits}

    def get_project_script(self, project_seq, space_seq=None):
        assert project_seq == 77
        return {"sentences": [dict(s) for s in self.sentences], "speakers": []}

    def _at(self, sentence_seq):
        return next(i for i, s in enumerate(self.sentences) if s["seq"] == sentence_seq)

    def edit_sentence(self, project_seq, sentence_seq, text):
        # As Perso does (seen live 2026-09-29): the words become the source,
        # are translated again (maybe reworded), and the voice is gone.
        self._maybe_fail("edit")
        self.spent.append(("edit", sentence_seq, text))
        s = self.sentences[self._at(sentence_seq)]
        s["originalText"] = text
        s["translatedText"] = self.reword.get(text, text)
        s["audioUrl"] = None
        return {"scriptSeq": sentence_seq, "translatedText": s["translatedText"]}

    def regenerate_sentence_audio(self, project_seq, sentence_seq, text):
        self._maybe_fail("voice")
        self.spent.append(("voice", sentence_seq, text))
        self.credits -= 3
        n = len(self.spent)
        self.sentences[self._at(sentence_seq)]["audioUrl"] = "/perso-storage/new%d.mp3" % n
        return self.voice_answer(n)

    def match_rewrite(self, project_seq, sentence_seq, text):
        self._maybe_fail("fit")
        return {"matchingRate": {"level": 2, "levelType": "LOW"},
                "rewrite": {"speed": "fast", "current": 180}}

    def reset_sentence(self, project_seq, sentence_seq):
        self._maybe_fail("reset")
        self.spent.append(("reset", sentence_seq))
        s = self.sentences[self._at(sentence_seq)]
        s["translatedText"] = "Hi there" if sentence_seq == 501 else "Bye now"
        s["audioUrl"] = "/perso-storage/reset.mp3"
        return {}

    def project_detail(self, project_seq, space_seq=None):
        return {"ttsModel": self.tts_model}

    def retranslation_status(self, project_seq, space_seq=None):
        self._maybe_fail("status")
        return self.retranslate

    def proofread_price(self, project_seq, duration_ms, width, height, space_seq=None,
                        tts_model=None):
        self._maybe_fail("price")
        self.priced.append((project_seq, duration_ms, width, height, space_seq, tts_model))
        return dict(self.price)

    def proofread(self, project_seq, space_seq=None, on_asked=None, **kw):
        self._maybe_fail("proofread")
        self.spent.append(("proofread",))
        self.credits -= 20
        if on_asked:
            on_asked()
        self._maybe_fail("proofread-wait")
        self.sentences[0]["translatedText"] = "Hello there"
        self.sentences[0]["audioUrl"] = "/perso-storage/p1.mp3"

    def wait_for_project(self, project_seq, space_seq=None, what=""):
        self.spent.append(("wait",))

    def download_media(self, url, out_path):
        self._maybe_fail("download")
        self.fetched.append(url)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(url)
        return out_path

    def download_target(self, project_seq, target, out_path, space_seq=None):
        return self.download_media(target, out_path)

    def download_dub(self, project_seq, out_path, space_seq=None):
        return self.download_media("video", out_path)


@pytest.fixture
def perso(monkeypatch):
    fake = FakePerso()
    monkeypatch.setattr(script_api.perso_client, "PersoClient", lambda: fake)
    monkeypatch.setattr(perso_materialize, "_ffmpeg_to_wav", shutil.copyfile)
    monkeypatch.setattr(perso_edit.time, "sleep", lambda s: None)
    fake.built = []
    monkeypatch.setattr(script_api, "rebuild_dub", lambda *a: fake.built.append(a))
    return fake


def _job(tmp_path, dub_mode="perso", status="done", fetched=True):
    work = tmp_path / "dubbed"
    work.mkdir(exist_ok=True)
    (work / "input.mp4").write_bytes(b"vid")
    (work / "dubbed.mp4").write_bytes(b"old video")
    if fetched:
        cues = [{"start": s, "end": e, "text": t} for s, e, t in DUB]
        (work / "translated.srt").write_text(build_srt(cues), encoding="utf-8")
        (work / "original.srt").write_text(build_srt(
            [{"start": s, "end": e, "text": t} for s, e, t in SOURCE]), encoding="utf-8")
        (work / "lines.json").write_text(json.dumps({
            "language": "English",
            "lines": [{"i": i, "speaker": "S1", "start": c["start"], "gain": None}
                      for i, c in enumerate(cues)]}), encoding="utf-8")
        (work / "background.wav").write_bytes(b"bed")
        # Made a minute ago, as a dub's voices always are before anyone edits
        # a line: an edited line with no remake record is told stale by file
        # times (app/dub_script.py _voice_is_older_than), and Windows' file
        # clock ticks every ~16 ms, so a voice written here and an edit made a
        # moment later often had the same time and read as fresh -- these tests
        # passed or failed at random there (Windows verification, 2026-10-03).
        made = time.time() - 60
        for i in range(len(cues)):
            wav = work / ("qwen_line_%d.wav" % i)
            wav.write_text("dub voice %d" % i, encoding="utf-8")
            os.utime(wav, (made, made))
    jid = state.job_store.create()
    state.job_store._update(
        jid, status=status, work_dir=str(work), project="dubbed",
        language_code="en", language="English",
        result={"out_path": str(work / "dubbed.mp4")},
        **({"dub_mode": "perso", "perso_project_seq": 77, "perso_space_seq": 9}
           if dub_mode == "perso" else {}))
    return jid, work


def _edit(jid, line, text):
    assert client.post(f"/api/dub/jobs/{jid}/script/{line}", json={"text": text}).status_code == 200


def _voice(jid, line, confirm=True):
    return client.post(f"/api/dub/jobs/{jid}/perso/script/{line}/voice", json={"confirm": confirm})


def _wait_idle(jid):
    for _ in range(200):
        with perso_edit._lock:
            if jid not in perso_edit._working:
                return
        _sleep(0.01)
    raise AssertionError("the proofread never ended")


def test_the_script_says_a_perso_dub_is_persos_to_edit(perso, tmp_path):
    jid, _ = _job(tmp_path)
    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert body["perso_edit"] == {
        "available": True, "reason": "", "nightingale": None,
        "retranslate_available": None, "working": None, "unfetched": False}
    # A dub made on this computer says nothing about Perso at all.
    (tmp_path / "b").mkdir()
    local, _ = _job(tmp_path / "b", dub_mode="local")
    assert "perso_edit" not in client.get(f"/api/dub/jobs/{local}/script").json()


def test_asking_perso_fills_in_what_only_perso_knows(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.tts_model = "NIGHTINGALE"
    perso.retranslate = False
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert live["nightingale"] is True and live["retranslate_available"] is False
    assert live["available"] is True and live["error"] is None
    # And the script remembers it, without asking again.
    known = client.get(f"/api/dub/jobs/{jid}/script").json()["perso_edit"]
    assert known["nightingale"] is True and known["retranslate_available"] is False


# --- NIGHTINGALE: no editing line by line (Windows C14, owner 2026-10-06) ---
# Perso makes no single line's voice on a NIGHTINGALE dub, and Make it
# editable ended in "Perso server error (HTTP 500)" on every press.

def test_a_nightingale_dub_says_so_from_its_own_record(perso, tmp_path):
    jid, _ = _job(tmp_path, fetched=False)
    state.job_store._update(jid, perso_model="NIGHTINGALE")
    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert body["readonly"] is True and body["perso_edit"]["nightingale"] is True
    (tmp_path / "b").mkdir()
    oriole, _ = _job(tmp_path / "b", fetched=False)
    state.job_store._update(oriole, perso_model="ORIOLE")
    assert client.get(f"/api/dub/jobs/{oriole}/script").json()["perso_edit"]["nightingale"] is None


def test_a_nightingale_dub_is_not_fetched_for_editing(perso, tmp_path, monkeypatch):
    fetched = []
    monkeypatch.setattr(perso_materialize, "materialize", lambda *a, **k: fetched.append(a))
    jid, _ = _job(tmp_path, fetched=False)
    state.job_store._update(jid, perso_model="NIGHTINGALE")
    r = client.post(f"/api/dub/jobs/{jid}/perso/materialize")
    assert r.status_code == 409 and r.json()["detail"] == perso_edit.nightingale_fixed()
    # Nor when only Perso said so (a record without the model).
    (tmp_path / "b").mkdir()
    told, _ = _job(tmp_path / "b", fetched=False)
    perso.tts_model = "NIGHTINGALE"
    client.get(f"/api/dub/jobs/{told}/perso/edit")
    assert client.post(f"/api/dub/jobs/{told}/perso/materialize").status_code == 409
    assert fetched == []


@pytest.fixture
def probed(monkeypatch):
    """The job's video is three bytes: ffprobe is not asked about it."""
    monkeypatch.setattr(perso_edit.media, "video_size", lambda p: (1280, 720))
    monkeypatch.setattr(perso_edit.media, "video_duration", lambda p: 5.5)


def test_the_price_is_asked_only_when_asked_for(perso, probed, tmp_path):
    jid, _ = _job(tmp_path)
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert "proofread_price" not in live and perso.priced == []
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit?price=1").json()
    assert live["proofread_price"] == 40
    assert live["retranslate_available"] is True and live["nightingale"] is False
    assert perso.priced == [(77, 5500, 1280, 720, 9, "ORIOLE")]


def test_a_nightingale_project_never_proofread_is_free(perso, probed, tmp_path):
    jid, _ = _job(tmp_path)
    perso.tts_model = "NIGHTINGALE"
    perso.price = {"credits": 33, "export_count": 1}
    assert client.get(f"/api/dub/jobs/{jid}/perso/edit?price=1").json()["proofread_price"] == 0
    perso.price = {"credits": 33, "export_count": 2}
    assert client.get(f"/api/dub/jobs/{jid}/perso/edit?price=1").json()["proofread_price"] == 33


def test_a_price_perso_would_not_give_is_none_and_the_rest_still_answers(perso, probed, tmp_path,
                                                                        monkeypatch):
    jid, _ = _job(tmp_path)
    perso.fail["price"] = httpx.ConnectError("dropped")
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit?price=1").json()
    assert live["proofread_price"] is None and live["available"] is True
    # A video whose size cannot be read is not priced, and Perso is not asked.
    perso.fail.clear()
    monkeypatch.setattr(perso_edit.media, "video_size", lambda p: (0, 0))
    assert client.get(f"/api/dub/jobs/{jid}/perso/edit?price=1").json()["proofread_price"] is None
    assert perso.priced == []


def test_an_edited_line_is_voiced_by_perso_and_the_video_rebuilt(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 2, "Goodbye")
    assert client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][1]["voice_stale"] is True

    r = _voice(jid, 2)
    assert r.status_code == 200
    assert r.json() == {"line": 2, "ok": True, "reworded": False, "credits": 3}
    # Line 2's own sentence, with the words the script now has.
    assert perso.spent == [("edit", 502, "Goodbye"), ("voice", 502, "Goodbye")]
    # The voice on disk is the one Perso made, and only that line's changed.
    assert (work / "qwen_line_1.wav").read_text(encoding="utf-8") == "/perso-storage/new2.mp3"
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "dub voice 0"
    assert len(perso.built) == 1
    assert not list(work.glob("perso_line_*"))

    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert body["lines"][1]["voice_stale"] is False
    assert body["lines"][1]["text"] == "Goodbye" and body["lines"][1]["was"] == "Bye now"
    # Still Perso's to edit: that voice was Perso's own.
    assert body["perso_edit"]["available"] is True


def _translate(jid, lines=None):
    return client.post(f"/api/dub/jobs/{jid}/retranslate", json={"lines": lines})


def test_translate_again_on_a_perso_dub_is_persos_and_makes_no_voice(perso, tmp_path):
    jid, work = _job(tmp_path)
    perso.reword = {"잘 가": "Farewell"}
    r = _translate(jid, [2])
    assert r.status_code == 200
    assert r.json() == {"changed": [{"line": 2, "was": "Bye now", "text": "Farewell"}]}
    # Perso was sent the line's SOURCE words, and no voice was asked for.
    assert perso.spent == [("edit", 502, "잘 가")]
    assert perso.built == [] and perso.credits == 100
    assert (work / "qwen_line_1.wav").read_text(encoding="utf-8") == "dub voice 1"
    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert body["lines"][1]["text"] == "Farewell" and body["lines"][1]["voice_stale"] is True
    assert body["perso_edit"]["available"] is True

    # Its voice, asked for next, speaks the words Perso already holds: they
    # are not sent (and translated) a second time.
    assert _voice(jid, 2).status_code == 200
    assert perso.spent[1:] == [("voice", 502, "Farewell")]
    assert client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][1]["voice_stale"] is False


def test_translate_again_with_no_lines_named_asks_perso_for_every_line(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.reword = {"안녕": "Hello", "잘 가": ""}
    # An empty answer, or the source handed back, changes nothing here.
    assert _translate(jid).json() == {"changed": [{"line": 1, "was": "Hi there", "text": "Hello"}]}
    assert [s[:2] for s in perso.spent] == [("edit", 501), ("edit", 502)]
    perso.reword = {}
    assert _translate(jid, [2]).json() == {"changed": []}
    assert _translate(jid, [9]).status_code == 422


def test_translate_again_on_a_perso_dub_says_what_perso_refused(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.fail["edit"] = PersoCreditExhaustedError()
    r = _translate(jid, [1])
    assert r.status_code == 402 and "credits" in r.json()["detail"]
    assert client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][0]["text"] == "Hi there"


def test_the_log_names_the_line_and_never_its_words(perso, tmp_path):
    jid, _ = _job(tmp_path)
    _edit(jid, 2, "Goodbye")
    _voice(jid, 2)
    logs = "\n".join(state.job_store.get(jid).get("logs") or [])
    assert "Line 2" in logs and "Perso credits used: 3" in logs
    assert "Goodbye" not in logs and "Bye now" not in logs


def test_nothing_is_spent_without_confirm(perso, tmp_path):
    jid, _ = _job(tmp_path)
    for path in (f"/api/dub/jobs/{jid}/perso/script/1/voice",
                 f"/api/dub/jobs/{jid}/perso/script/1/reset",
                 f"/api/dub/jobs/{jid}/perso/proofread"):
        r = client.post(path, json={})
        assert r.status_code == 409 and "confirm" in r.json()["detail"]
    assert perso.spent == []


def test_a_voice_whose_address_is_not_in_the_answer_is_read_off_the_script(perso, tmp_path):
    jid, work = _job(tmp_path)
    perso.voice_answer = lambda n: {}
    assert _voice(jid, 1).status_code == 200
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "/perso-storage/new2.mp3"


def test_a_dub_never_fetched_is_fetched_first(perso, tmp_path):
    jid, work = _job(tmp_path, fetched=False)
    assert _voice(jid, 1).status_code == 200
    assert (work / "translated.srt").exists() and (work / "qwen_line_1.wav").exists()
    assert perso.spent == [("edit", 501, "Hi there"), ("voice", 501, "Hi there")]


REFUSALS = [
    ("edit", PersoCreditExhaustedError(), 402, "credits are used up"),
    ("voice", PersoCreditExhaustedError(), 402, "credits are used up"),
    ("voice", PersoModelRefusedError("VT40918"), 409, "Use All at once"),
    ("voice", httpx.ReadTimeout("timed out"), 504, "did not answer in time"),
    ("voice", httpx.ConnectError("no route"), 503, "Could not reach Perso"),
    # A company network's own certificate: another network, not the same one again.
    ("voice", httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                                 "self-signed certificate in certificate chain (_ssl.c:1006)"),
     503, "A company network or security program blocked the connection"),
    # Anything else is said in words; its type name is for the log.
    ("voice", KeyError("sha"), 500, "Perso could not make the change. Press it again in a moment."),
    # Perso gave up on it: our sentence, and Perso's own words and code under it.
    ("voice", pcm.PersoProjectFailedError("Perso voice", "Sentence is locked", "VT4001"), 502,
     "Perso could not finish this job. Press it again in a moment.\nPerso said: Sentence is locked (VT4001)"),
    ("voice", PersoUnavailableError("HTTP 503"), 503, "temporarily unavailable"),
    ("voice", pcm.PersoInvalidKeyError("HTTP 401"), 409, "rejected the API key"),
    ("download", httpx.ReadTimeout("timed out"), 504, "did not answer in time"),
]


@pytest.mark.parametrize("where,error,status,words", REFUSALS,
                         ids=["%s-%s" % (w, type(e).__name__) for w, e, _s, _w in REFUSALS])
def test_what_goes_wrong_reaches_the_screen_in_words(perso, tmp_path, where, error, status, words):
    jid, work = _job(tmp_path)
    perso.fail[where] = error
    r = _voice(jid, 1)
    assert r.status_code == status
    assert words in r.json()["detail"]
    # The line sounds as it did, and the video was left alone.
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "dub voice 0"
    assert perso.built == []
    # And the seat is free again.
    perso.fail.clear()
    assert _voice(jid, 1).status_code == 200


def test_persos_own_refusal_is_quoted_without_an_address(perso, tmp_path):
    jid, _ = _job(tmp_path)
    req = httpx.Request("PATCH", SENTENCE)
    perso.fail["edit"] = httpx.HTTPStatusError(
        "Client error '400 Bad Request': Perso said Sentence is locked / VT4001",
        request=req, response=httpx.Response(400, request=req))
    r = _voice(jid, 1)
    assert r.status_code == 409
    assert "Sentence is locked" in r.json()["detail"]
    assert "api.perso.ai" not in r.json()["detail"]


def test_a_press_after_a_lost_download_pays_nothing_more(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 1, "Hello")
    perso.fail["download"] = httpx.ConnectError("dropped")
    assert _voice(jid, 1).status_code == 503
    assert [s[0] for s in perso.spent] == ["edit", "voice"]

    perso.fail.clear()
    r = _voice(jid, 1)
    assert r.status_code == 200 and r.json()["credits"] == 0
    assert [s[0] for s in perso.spent] == ["edit", "voice"], "Perso was not asked twice"
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "/perso-storage/new2.mp3"
    assert len(perso.built) == 1


def test_a_press_after_a_failed_rebuild_pays_nothing_more(perso, tmp_path, monkeypatch):
    jid, _ = _job(tmp_path)

    def broken(*a):
        raise RuntimeError("mux failed")
    monkeypatch.setattr(script_api, "rebuild_dub", broken)
    assert _voice(jid, 1).status_code == 500
    monkeypatch.setattr(script_api, "rebuild_dub", lambda *a: perso.built.append(a))
    assert _voice(jid, 1).status_code == 200
    assert [s[0] for s in perso.spent] == ["edit", "voice"]


def test_remake_voices_does_not_send_a_line_whose_voice_says_its_words(perso, tmp_path):
    # A table drawn before the agent remade line 1 still offered it (night
    # test 2026-10-01): Remake voices sends changed_only, and a done line
    # costs nothing.
    jid, _ = _job(tmp_path)
    _edit(jid, 1, "Hello")
    again = {"confirm": True, "changed_only": True}
    url = f"/api/dub/jobs/{jid}/perso/script/1/voice"
    assert client.post(url, json=again).json()["ok"] is True
    assert [s[0] for s in perso.spent] == ["edit", "voice"]
    second = client.post(url, json=again).json()
    assert second["unchanged"] is True and second["credits"] == 0
    assert [s[0] for s in perso.spent] == ["edit", "voice"]
    # Asked for by name, an unchanged line is still remade.
    assert _voice(jid, 1).status_code == 200
    assert len(perso.spent) == 4


def test_the_script_stamp_moves_when_the_words_change(perso, tmp_path):
    jid, work = _job(tmp_path)
    stamp = client.get(f"/api/dub/jobs/{jid}/script/stamp").json()["stamp"]
    assert stamp == client.get(f"/api/dub/jobs/{jid}/script").json()["stamp"]
    # One second after 1970, a time every file system keeps exactly (Windows
    # stores file times in 100 ns steps, so 1 ns came back as 0).
    long_ago = 1_000_000_000
    os.utime(work / "dubbed.mp4", ns=(long_ago, long_ago))
    os.utime(work / "translated.srt", ns=(long_ago, long_ago))
    # Taken again once both files are long ago: on Windows the edit could land in
    # the same clock tick as _job's writes and keep the first stamp (2026-10-12).
    stamp = client.get(f"/api/dub/jobs/{jid}/script/stamp").json()["stamp"]
    assert stamp == str(long_ago)
    _edit(jid, 1, "Hello")
    assert client.get(f"/api/dub/jobs/{jid}/script/stamp").json()["stamp"] != stamp
    # A Perso mirror not fetched yet has no script here to watch.
    (tmp_path / "b").mkdir()
    unfetched, _ = _job(tmp_path / "b", fetched=False)
    assert client.get(f"/api/dub/jobs/{unfetched}/script/stamp").json() == {"stamp": None}


def test_new_words_after_a_lost_download_are_asked_for_again(perso, tmp_path):
    jid, _ = _job(tmp_path)
    _edit(jid, 1, "Hello")
    perso.fail["download"] = httpx.ConnectError("dropped")
    _voice(jid, 1)
    perso.fail.clear()
    _edit(jid, 1, "Hello again")
    assert _voice(jid, 1).status_code == 200
    assert perso.spent[-1] == ("voice", 501, "Hello again")


def test_two_presses_at_once_on_one_job(perso, tmp_path):
    jid, _ = _job(tmp_path)
    with perso_edit.working(jid, "line"):
        r = _voice(jid, 1)
    assert r.status_code == 409 and "already working" in r.json()["detail"]
    assert perso.spent == []


def test_a_job_that_is_still_running_is_left_alone(perso, tmp_path):
    jid, _ = _job(tmp_path, status="running")
    r = _voice(jid, 1)
    assert r.status_code == 409 and "still running" in r.json()["detail"]
    assert perso.spent == []


def test_a_job_perso_never_dubbed_is_refused(perso, tmp_path):
    jid, _ = _job(tmp_path, dub_mode="local")
    for r in (_voice(jid, 1),
              client.get(f"/api/dub/jobs/{jid}/perso/edit"),
              client.post(f"/api/dub/jobs/{jid}/perso/proofread", json={"confirm": True})):
        assert r.status_code == 409 and "not dubbed by Perso" in r.json()["detail"]
    assert client.post("/api/dub/jobs/nope/perso/script/1/voice",
                       json={"confirm": True}).status_code == 404


def test_a_line_that_is_not_there_and_a_line_with_no_words(perso, tmp_path):
    jid, _ = _job(tmp_path)
    assert _voice(jid, 3).status_code == 422
    _edit(jid, 1, " ")
    r = _voice(jid, 1)
    assert r.status_code == 422 and "no words" in r.json()["detail"]
    assert perso.spent == []


def test_a_project_that_changed_on_perso_is_not_written_into_by_number(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.sentences.pop()
    r = _voice(jid, 1)
    assert r.status_code == 409 and "changed on Perso" in r.json()["detail"]
    assert perso.spent == []


def test_a_voice_made_on_this_computer_turns_perso_editing_off(perso, tmp_path, monkeypatch):
    jid, _ = _job(tmp_path)
    monkeypatch.setattr(script_api, "resynth_one_line", lambda *a: "made.wav")
    _edit(jid, 1, "Hello")
    assert client.post(f"/api/dub/jobs/{jid}/script/1/voice").status_code == 200

    said = client.get(f"/api/dub/jobs/{jid}/script").json()["perso_edit"]
    assert said["available"] is False and said["reason"] == perso_edit.LOCAL_VOICE
    for r in (_voice(jid, 2),
              client.post(f"/api/dub/jobs/{jid}/perso/script/2/reset", json={"confirm": True}),
              client.post(f"/api/dub/jobs/{jid}/perso/script/2/fit", json={"text": "x"}),
              client.post(f"/api/dub/jobs/{jid}/perso/proofread", json={"confirm": True})):
        assert r.status_code == 409 and r.json()["detail"] == perso_edit.LOCAL_VOICE
    assert perso.spent == []


def test_fit_is_persos_own_verdict_and_saves_nothing(perso, tmp_path):
    jid, work = _job(tmp_path)
    r = client.post(f"/api/dub/jobs/{jid}/perso/script/2/fit", json={"text": "A much longer line"})
    assert r.status_code == 200
    assert r.json() == {"line": 2, "matching_rate": {"level": 2, "levelType": "LOW"},
                        "rewrite": {"speed": "fast", "current": 180}}
    assert perso.spent == [] and not (work / "edited.srt").exists()
    assert client.post(f"/api/dub/jobs/{jid}/perso/script/2/fit",
                       json={"text": "  "}).status_code == 422


def test_reset_brings_persos_words_and_voice_back(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 1, "Hello")
    _voice(jid, 1)
    r = client.post(f"/api/dub/jobs/{jid}/perso/script/1/reset", json={"confirm": True})
    assert r.status_code == 200 and r.json()["line"] == 1
    assert perso.spent[-1] == ("reset", 501)
    line = client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][0]
    assert line["text"] == "Hi there" and line["voice_stale"] is False and line["edited"] is False
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "/perso-storage/reset.mp3"
    assert len(perso.built) == 2


def _proofread(jid):
    return client.post(f"/api/dub/jobs/{jid}/perso/proofread", json={"confirm": True})


def test_proofread_replaces_the_script_the_voices_and_the_video(perso, tmp_path):
    jid, work = _job(tmp_path)
    r = _proofread(jid)
    assert r.status_code == 200 and r.json() == {"started": True, "fetch_only": False}
    _wait_idle(jid)

    assert perso.spent == [("proofread",)]
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert live["working"] is None and live["error"] is None and live["unfetched"] is False
    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert [l["text"] for l in body["lines"]] == ["Hello there", "Bye now"]
    assert body["edited"] is False
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "/perso-storage/p1.mp3"
    assert (work / "dubbed.mp4").read_text(encoding="utf-8") == "video"
    assert not (work / "dubbed.mp4.perso-new").exists()
    assert "Perso credits used: 20" in "\n".join(state.job_store.get(jid)["logs"])


def test_proofread_is_refused_while_words_wait_for_their_voice(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 2, "Goodbye")
    r = _proofread(jid)
    assert r.status_code == 409 and "Line 2" in r.json()["detail"]
    assert perso.spent == []
    assert "Goodbye" in (work / "edited.srt").read_text(encoding="utf-8")


def test_on_nightingale_the_waiting_words_go_to_perso_with_the_proofread(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.tts_model = "NIGHTINGALE"
    # Perso would say "nothing to proofread" until the words are there.
    perso.retranslate = False
    _edit(jid, 2, "Goodbye")
    assert _proofread(jid).status_code == 200
    _wait_idle(jid)
    assert perso.spent == [("edit", 502, "Goodbye"), ("proofread",)]
    lines = client.get(f"/api/dub/jobs/{jid}/script").json()["lines"]
    assert [l["text"] for l in lines] == ["Hello there", "Goodbye"]
    assert not any(l["voice_stale"] or l["edited"] for l in lines)
    assert "Goodbye" not in "\n".join(state.job_store.get(jid)["logs"])


def test_proofread_keeps_the_edited_script_it_replaces(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 2, "Goodbye")
    _voice(jid, 2)
    assert _proofread(jid).status_code == 200
    _wait_idle(jid)
    assert not (work / "edited.srt").exists()
    assert "Goodbye" in (work / "edited.before-proofread.srt").read_text(encoding="utf-8")


def test_proofread_is_refused_when_perso_has_nothing_to_go_over(perso, tmp_path):
    jid, _ = _job(tmp_path)
    perso.retranslate = False
    r = _proofread(jid)
    assert r.status_code == 409 and "nothing to redo" in r.json()["detail"]
    assert perso.spent == []


@pytest.mark.parametrize("error,words", [
    (PersoCreditExhaustedError(), "credits are used up"),
    (PersoModelRefusedError("VT40918"), "Use All at once"),
    (httpx.ReadTimeout("timed out"), "did not answer in time"),
], ids=["credits", "model", "timeout"])
def test_a_proofread_perso_did_not_take_leaves_everything_as_it_was(perso, tmp_path, error, words):
    jid, work = _job(tmp_path)
    perso.fail["proofread"] = error
    assert _proofread(jid).status_code == 200
    _wait_idle(jid)
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert words in live["error"] and live["unfetched"] is False
    assert (work / "dubbed.mp4").read_bytes() == b"old video"
    assert live["available"] is True


def test_a_proofread_cut_off_while_perso_worked_is_fetched_not_paid_again(perso, tmp_path):
    jid, work = _job(tmp_path)
    perso.fail["proofread-wait"] = httpx.ConnectError("dropped")
    assert _proofread(jid).status_code == 200
    _wait_idle(jid)
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert live["unfetched"] is True and live["available"] is False
    assert live["reason"] == perso_edit.never_fetched()
    # The lines here are the old ones, so none of them goes to Perso.
    assert _voice(jid, 1).status_code == 409

    perso.fail.clear()
    r = _proofread(jid)
    assert r.json() == {"started": True, "fetch_only": True}
    _wait_idle(jid)
    assert perso.spent == [("proofread",), ("wait",)]
    live = client.get(f"/api/dub/jobs/{jid}/perso/edit").json()
    assert live["unfetched"] is False and live["available"] is True and live["error"] is None
    assert (work / "dubbed.mp4").read_text(encoding="utf-8") == "video"


def test_one_proofread_at_a_time(perso, tmp_path):
    jid, _ = _job(tmp_path)
    with perso_edit.working(jid, "proofread"):
        assert client.get(f"/api/dub/jobs/{jid}/perso/edit").json()["working"] == "proofread"
        r = _proofread(jid)
    assert r.status_code == 409 and "already working" in r.json()["detail"]
    assert perso.spent == []


def test_a_refreshed_line_keeps_its_old_voice_until_the_new_one_is_whole(tmp_path):
    work = tmp_path / "job"
    work.mkdir()
    (work / "qwen_line_0.wav").write_text("old", encoding="utf-8")

    class Pc:
        def download_media(self, url, out):
            open(out, "w").write("new")

    def broken(src, dest):
        open(dest, "w").write("half")
        raise RuntimeError("could not convert")

    with pytest.raises(RuntimeError):
        perso_materialize.fetch_line(Pc(), "/a.mp3", str(work), 0, broken)
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "old"
    assert sorted(p.name for p in work.iterdir()) == ["qwen_line_0.wav"]


def test_the_workspace_a_dub_was_made_in_is_kept_with_it():
    from app import jobs
    assert "perso_space_seq" in jobs.SAVED_FIELDS
    assert perso_edit.project_of({"perso_project_seq": "77"}) == (77, None)
    assert perso_edit.project_of({"perso_project_seq": 77, "perso_space_seq": 9}) == (77, 9)


def test_the_words_perso_rewords_are_the_ones_the_script_shows(perso, tmp_path):
    jid, work = _job(tmp_path)
    perso.reword = {"Goodbye": "Goodbye, my friend"}
    _edit(jid, 2, "Goodbye")
    r = _voice(jid, 2)
    assert r.status_code == 200 and r.json()["reworded"] is True
    # Perso speaks what it kept, so that is what is asked for and shown.
    assert perso.spent == [("edit", 502, "Goodbye"), ("voice", 502, "Goodbye, my friend")]
    body = client.get(f"/api/dub/jobs/{jid}/script").json()
    assert body["lines"][1]["text"] == "Goodbye, my friend"
    assert body["lines"][1]["voice_stale"] is False
    assert body["perso_edit"]["available"] is True
    assert "my friend" not in "\n".join(state.job_store.get(jid)["logs"])


def test_a_line_perso_reworded_says_so_with_the_users_words(perso, tmp_path):
    # Perso cannot be told to keep the words, so the change is never silent:
    # "There are many ways…" came back as a longer sentence of its own with
    # nothing on screen (night test 2026-10-01).
    jid, _ = _job(tmp_path)
    perso.reword = {"Goodbye": "Goodbye, my friend"}
    _edit(jid, 2, "Goodbye")
    answer = _voice(jid, 2).json()
    assert answer["you_wrote"] == "Goodbye" and answer["perso_said"] == "Goodbye, my friend"
    lines = client.get(f"/api/dub/jobs/{jid}/script").json()["lines"]
    assert lines[1]["reworded"] == "Goodbye" and "reworded" not in lines[0]
    # Reverted, the line no longer says Perso's words, and the note goes.
    assert client.post(f"/api/dub/jobs/{jid}/script/2/revert").status_code == 200
    assert "reworded" not in client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][1]
    # Voiced again as written, there is nothing to say.
    _edit(jid, 2, "Bye")
    _voice(jid, 2)
    assert "reworded" not in client.get(f"/api/dub/jobs/{jid}/script").json()["lines"][1]


def test_a_press_after_the_voice_was_never_made_asks_again(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 1, "Hello")
    perso.fail["voice"] = httpx.ConnectError("dropped")
    assert _voice(jid, 1).status_code == 503
    # The words reached Perso and its sentence has no voice now.
    assert perso.sentences[0]["audioUrl"] is None

    perso.fail.clear()
    r = _voice(jid, 1)
    assert r.status_code == 200
    # The words are Perso's already: only the voice is asked for again.
    assert [s[0] for s in perso.spent] == ["edit", "voice"]
    assert (work / "qwen_line_0.wav").read_text(encoding="utf-8") == "/perso-storage/new2.mp3"


def test_a_proofread_keeps_the_videos_own_words_as_the_source(perso, tmp_path):
    jid, work = _job(tmp_path)
    _edit(jid, 1, "Hello")
    assert _voice(jid, 1).status_code == 200
    assert perso.sentences[0]["originalText"] == "Hello"
    assert _proofread(jid).status_code == 200
    _wait_idle(jid)
    assert "안녕" in (work / "original.srt").read_text(encoding="utf-8")
