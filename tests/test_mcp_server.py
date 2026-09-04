"""The handles the assistant reaches PersoDub through.

The tools are thin: they call the app's own HTTP API and hand the answer back.
What is worth pinning down is WHICH call each one makes -- remake_voices used to
start a whole new job from the script, which is not what "remake the voices"
means to the person asking for it.
"""
import httpx
import pytest

import app.mcp_server as mcp_server


class _Response:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)


class _Calls(list):
    """The URLs posted so far, plus the answer the next post is given."""
    answer = _Response(200, {})


@pytest.fixture
def posted(monkeypatch):
    """Record every POST the tools make, and answer with whatever is queued."""
    calls = _Calls()
    calls.answer = _Response(200, {"remade": [2, 5], "skipped": 3})

    def fake_post(url, **kw):
        calls.append(url)
        return calls.answer

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    return calls


def test_remake_voices_asks_for_the_stale_lines_not_a_whole_new_job(posted):
    assert mcp_server.remake_voices("job7") == {"remade": [2, 5], "skipped": 3}
    # /redub starts a second job in a second folder and respeaks every line.
    assert posted == ["%s/api/dub/jobs/job7/voices/stale" % mcp_server.API]
    assert "redub" not in posted[0]


def test_remake_voices_says_so_plainly_when_the_job_cannot_be_remade(posted):
    posted.answer = _Response(409, {"detail": "This job is still running."})
    with pytest.raises(ValueError, match="still running"):
        mcp_server.remake_voices("job7")


def test_remake_voices_names_a_job_that_is_not_there(posted):
    posted.answer = _Response(404, {"detail": "Unknown job"})
    with pytest.raises(ValueError, match="no such job: job7"):
        mcp_server.remake_voices("job7")


def test_remake_line_voice_asks_for_that_one_line(posted):
    posted.answer = _Response(200, {"line": 3, "ok": True})
    assert mcp_server.remake_line_voice("job7", 3) == {"line": 3, "ok": True}
    assert posted == ["%s/api/dub/jobs/job7/script/3/voice" % mcp_server.API]


# --- change_speaker: the Perso-dub tool with the pay-gate -------------------

def test_change_speaker_asks_before_spending(monkeypatch):
    # Without confirm=True nothing may be posted -- the agent must relay the
    # question and only proceed once the user agrees (money rule A).
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    out = mcp_server.change_speaker("job7", 3)
    assert out.get("needs_confirmation") is True
    assert "credit" in out.get("message", "").lower()
    assert posted == []


def test_change_speaker_posts_once_confirmed(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append((url, json))
        return _Response(200, {"line": 3, "new_speaker": 6})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.change_speaker("job7", 3, confirm=True)
    assert out == {"line": 3, "new_speaker": 6}
    url, body = calls[0]
    assert url == "%s/api/dub/jobs/job7/perso/speaker" % mcp_server.API
    assert body == {"line": 3}


def test_change_speaker_relays_a_refusal(monkeypatch):
    def fake_post(url, json=None, timeout=None):
        return _Response(409, {"detail": "Only Perso dubs have server-side speakers."})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="Only Perso dubs"):
        mcp_server.change_speaker("job7", 3, confirm=True)


def test_get_script_serves_a_perso_dub_through_the_api(monkeypatch):
    # A Perso dub's lines live on Perso's side -- the tool must read them from
    # the app's script endpoint instead of the local files it uses otherwise.
    def fake_get(url, **kw):
        if url.endswith("/api/dub/jobs/jobP"):
            return _Response(200, {"id": "jobP", "status": "done", "dub_mode": "perso"})
        if url.endswith("/api/dub/jobs/jobP/script"):
            return _Response(200, {"lines": [{"line": 1, "text": "Hi", "source": "안녕"}],
                                   "readonly": True})
        raise AssertionError("unexpected GET %s" % url)

    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)
    lines = mcp_server.get_script("jobP")
    assert lines == [{"line": 1, "text": "Hi", "source": "안녕"}]


def test_extract_subtitles_names_the_price_before_spending(monkeypatch):
    # Without confirm=True the tool may only ask /estimate (free) -- never
    # /extract, which is the paid call (money rule A, like change_speaker).
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    monkeypatch.setattr(
        mcp_server.httpx, "get",
        lambda url, params=None, timeout=None: _Response(
            200, {"seconds": 47.0, "credits_estimate": 10, "credits_balance": 120}))
    out = mcp_server.extract_subtitles("/tmp/영상.mp4", engine="perso")
    assert out.get("needs_confirmation") is True
    assert "10" in out.get("message", "")
    assert "120" in out.get("message", "")
    assert posted == []


def test_extract_subtitles_posts_once_confirmed(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append((url, json, timeout))
        return _Response(200, {"srt_path": "/tmp/영상.srt", "lines": 4})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.extract_subtitles("/tmp/영상.mp4", engine="perso", confirm=True)
    assert out == {"srt_path": "/tmp/영상.srt", "lines": 4}
    url, body, timeout = calls[0]
    assert url == "%s/api/subtitles/extract" % mcp_server.API
    assert body == {"video_path": "/tmp/영상.mp4", "engine": "perso"}
    # Transcription takes minutes -- the ten-second default would cut it off.
    assert timeout >= 600


def test_extract_subtitles_relays_a_refusal(monkeypatch):
    def fake_get(url, params=None, timeout=None):
        return _Response(404, {"detail": "No such video: /tmp/x.mp4"})

    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)
    with pytest.raises(ValueError, match="No such video"):
        mcp_server.extract_subtitles("/tmp/x.mp4", engine="perso")


def test_cut_clip_posts_the_range_and_needs_no_confirmation(monkeypatch):
    # Free and local: unlike the Perso-paid tools there is no confirm gate.
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append((url, json))
        return _Response(200, {"clip_path": "/tmp/영상-clip-10s-25s.mp4",
                               "seconds": 15.0})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.cut_clip("/tmp/영상.mp4", "10", "25")
    assert out["clip_path"].endswith("-clip-10s-25s.mp4")
    url, body = calls[0]
    assert url == "%s/api/clips/cut" % mcp_server.API
    assert body == {"video_path": "/tmp/영상.mp4", "start": "10", "end": "25"}


def test_cut_clip_relays_a_refusal(monkeypatch):
    def fake_post(url, json=None, timeout=None):
        return _Response(422, {"detail": "The clip must start before it ends."})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="start before it ends"):
        mcp_server.cut_clip("/tmp/영상.mp4", "25", "10")


def test_extract_subtitles_asks_which_engine_when_none_is_named(monkeypatch):
    # Free or paid is the user's call -- the tool refuses to pick for them.
    called = []
    monkeypatch.setattr(mcp_server.httpx, "get", lambda *a, **kw: called.append(a))
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: called.append(a))
    with pytest.raises(ValueError, match="local.*perso|perso.*local"):
        mcp_server.extract_subtitles("/tmp/영상.mp4")
    assert called == []


def test_extract_subtitles_local_runs_at_once_for_free(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append((url, json))
        return _Response(200, {"srt_path": "/tmp/영상.srt", "lines": 2})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.extract_subtitles("/tmp/영상.mp4", engine="local")
    assert out["lines"] == 2
    assert calls[0][1] == {"video_path": "/tmp/영상.mp4", "engine": "local"}


def test_list_videos_shows_only_videos_newest_first(tmp_path):
    import time as _time
    old = tmp_path / "옛날영상.mp4"
    old.write_bytes(b"a" * 1000)
    _time.sleep(0.01)
    new = tmp_path / "새영상.mov"
    new.write_bytes(b"b" * 2000)
    (tmp_path / "문서.pdf").write_bytes(b"x")
    (tmp_path / "._새영상.mov").write_bytes(b"x")     # macOS metadata litter
    (tmp_path / ".숨김.mp4").write_bytes(b"x")
    out = mcp_server.list_videos(str(tmp_path))
    assert [v["name"] for v in out["videos"]] == ["새영상.mov", "옛날영상.mp4"]
    assert out["videos"][0]["path"] == str(new)
    assert out["videos"][0]["size_mb"] >= 0


def test_list_videos_names_a_folder_that_is_not_there(tmp_path):
    with pytest.raises(ValueError, match="폴더|folder|No such"):
        mcp_server.list_videos(str(tmp_path / "없는폴더"))


def _tmp_video(tmp_path):
    v = tmp_path / "영상.mp4"
    v.write_bytes(b"video-bytes")
    return v


def test_queue_dub_asks_with_the_credit_price_for_perso(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    monkeypatch.setattr(
        mcp_server.httpx, "get",
        lambda url, params=None, timeout=None: _Response(
            200, {"seconds": 47.0, "credits_estimate": 10, "credits_balance": 500}))
    out = mcp_server.queue_dub(str(video), "en", dub_mode="perso")
    assert out.get("needs_confirmation") is True
    # Dubbing is about 1 credit per SECOND -- not STT's 1-per-5s.
    assert "47" in out["message"]
    assert "500" in out["message"]
    assert posted == []


def test_queue_dub_asks_even_for_a_free_local_dub(monkeypatch, tmp_path):
    # Free, but hours of this machine's time -- never started unasked.
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    monkeypatch.setattr(
        mcp_server.httpx, "get",
        lambda url, params=None, timeout=None: _Response(
            200, {"seconds": 47.0, "credits_estimate": 0, "credits_balance": None}))
    out = mcp_server.queue_dub(str(video), "en")
    assert out.get("needs_confirmation") is True
    assert posted == []


def test_queue_dub_starts_the_job_once_confirmed(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["url"] = url
        calls["data"] = data
        calls["file_name"] = files["video"][0]
        return _Response(200, {"job_id": "j1", "status": "running"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.queue_dub(str(video), "en", dub_mode="perso",
                               source_language="ko", confirm=True)
    assert out == {"job_id": "j1", "status": "running"}
    assert calls["url"] == "%s/api/dub/start" % mcp_server.API
    assert calls["data"]["language"] == "English"
    assert calls["data"]["language_code"] == "en"
    assert calls["data"]["dub_mode"] == "perso"
    assert calls["data"]["source_language_code"] == "ko"
    assert calls["file_name"] == "영상.mp4"


def test_queue_dub_refuses_a_language_the_voices_cannot_speak(tmp_path):
    video = _tmp_video(tmp_path)
    with pytest.raises(ValueError, match="target_language"):
        mcp_server.queue_dub(str(video), "sw", confirm=True)


def test_queue_dub_passes_the_named_translator_through(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["data"] = data
        return _Response(200, {"job_id": "j2", "status": "queued"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.queue_dub(str(video), "en", translator="gemini", confirm=True)
    assert calls["data"]["translate_engine"] == "gemini"


def _job_answer(monkeypatch, status, project="회사소개"):
    monkeypatch.setattr(
        mcp_server.httpx, "get",
        lambda url, **kw: _Response(200, {"id": "j1", "status": status,
                                          "project": project}))


def test_cancel_dub_takes_a_waiting_job_out_at_once(monkeypatch):
    # Leaving the line loses nothing, so the user's ask is confirmation enough.
    _job_answer(monkeypatch, "queued")
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        return _Response(200, {"job_id": "j1", "status": "cancelled"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.cancel_dub("j1")
    assert out == {"job_id": "j1", "status": "cancelled"}
    assert calls == ["%s/api/dub/jobs/j1/cancel" % mcp_server.API]


def test_cancel_dub_stops_a_running_job_at_once(monkeypatch):
    # No second question: a cancel is urgent, and asking again meant the job
    # was sometimes finished before the user could answer (user, 2026-09-01).
    # "Cancel it" IS the confirmation.
    _job_answer(monkeypatch, "running")
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        return _Response(200, {"job_id": "j1", "status": "cancelling"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.cancel_dub("j1")
    assert out == {"job_id": "j1", "status": "cancelling"}
    assert calls == ["%s/api/dub/jobs/j1/cancel" % mcp_server.API]


def test_cancel_dub_says_so_when_the_job_is_already_finished(monkeypatch):
    _job_answer(monkeypatch, "done")
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    with pytest.raises(ValueError, match="done"):
        mcp_server.cancel_dub("j1")
    assert posted == []


def test_cancel_dub_names_a_job_that_is_not_there(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(404, {}))
    with pytest.raises(ValueError, match="no such job"):
        mcp_server.cancel_dub("ghost")


def test_the_stdio_server_actually_serves_every_tool():
    # Registration alone is not delivery: `python -m app.mcp_server` stops at
    # the __main__ run block, so a tool defined below it imports fine (and
    # passes every test above) yet never reaches the assistant. cancel_dub
    # shipped exactly that way on 2026-09-01. This speaks to the server the
    # one way the CLIs do -- over stdio -- and reads the list it hands out.
    import json
    import os
    import subprocess
    import sys
    # A real handshake, one message at a time: piling all three lines in and
    # closing stdin raced the server's own shutdown-on-EOF, which sometimes ate
    # the answer (flaky 2026-09-01).
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.mcp_server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, env={**os.environ, "PERSODUB_API": "http://127.0.0.1:1"},
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    def say(msg):
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def hear(want_id):
        while True:
            line = proc.stdout.readline()
            if not line:
                raise AssertionError("the server hung up before answering")
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == want_id:
                return m

    try:
        say({"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "probe", "version": "0"}}})
        hear(1)
        say({"jsonrpc": "2.0", "method": "notifications/initialized"})
        say({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        served = {t["name"] for t in hear(2)["result"]["tools"]}
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
    from app.agents.claude import TOOL_LABELS
    missing = set(TOOL_LABELS) - served
    assert not missing, "promised to the assistant but never served: %s" % sorted(missing)


def test_burn_subtitles_posts_the_preset_and_needs_no_confirmation(monkeypatch):
    calls = {}

    def fake_post(url, json=None, timeout=None):
        calls["url"] = url
        calls["json"] = json
        return _Response(200, {"out_path": "/v/쇼츠-sub-variety.mp4",
                               "preset": "variety"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.burn_subtitles("/v/쇼츠.mp4", preset="variety")
    assert out["out_path"].endswith("-sub-variety.mp4")
    assert calls["url"] == "%s/api/subtitles/burn" % mcp_server.API
    assert calls["json"] == {"video_path": "/v/쇼츠.mp4", "srt_path": "",
                             "preset": "variety"}


def test_burn_subtitles_relays_a_refusal(monkeypatch):
    def fake_post(url, json=None, timeout=None):
        return _Response(404, {"detail": "No subtitle file to lay on."})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="No subtitle file"):
        mcp_server.burn_subtitles("/v/쇼츠.mp4")


def test_queue_dub_names_the_missing_model_instead_of_a_raw_error(monkeypatch, tmp_path):
    # The app refuses with 409 {"missing": [...]} when a chosen engine's model is not
    # downloaded. Relayed raw, the agent could only tell the user "an error" (2026-09-04).
    video = _tmp_video(tmp_path)
    detail = {"missing": [{"id": "gemma", "name": "Gemma 3", "bytes": 7600000000}],
              "total_bytes": 7600000000, "free_bytes": 10**11}
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda *a, **kw: _Response(409, {"detail": detail}))
    with pytest.raises(ValueError) as e:
        mcp_server.queue_dub(str(video), "en", translator="gemma", confirm=True)
    msg = str(e.value)
    assert "Gemma 3" in msg and "7.6 GB" in msg
    assert "Settings" in msg and "hunyuan" in msg
    assert "{" not in msg, "no raw dict for the agent to parrot"


def test_queue_dub_keeps_a_plain_string_refusal_as_is(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda *a, **kw: _Response(409, {"detail": "A dub is already running"}))
    with pytest.raises(ValueError, match="A dub is already running"):
        mcp_server.queue_dub(str(video), "en", confirm=True)


# ---- setup tools (2026-09-04): the agent can see, change and complete the setup

def test_get_setup_reports_stages_models_and_keys(monkeypatch):
    payload = {"defaults": {"translator": "hunyuan", "stt": "local"},
               "choices": {"translator": ["hunyuan", "gemma", "gemini"]},
               "models": [{"id": "gemma", "name": "Gemma 3", "bytes": 7600000000,
                           "state": "downloading", "progress": 41}],
               "keys": {"perso": True, "gemini": False}}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, payload))
    out = mcp_server.get_setup()
    assert out["defaults"]["translator"] == "hunyuan"
    assert out["models"][0]["gb"] == 7.6
    assert out["models"][0]["state"] == "downloading 41%"
    assert out["keys"] == {"perso": True, "gemini": False}


def test_set_default_posts_one_stage_and_relays_a_refusal(monkeypatch):
    posted = {}

    def fake_post(url, json=None, data=None, files=None, timeout=None):
        posted["url"] = url
        posted["json"] = json
        if json.get("translator") == "nope":
            return _Response(422, {"detail": "translator must be one of: hunyuan, gemma, gemini"})
        return _Response(200, {"defaults": {"translator": "gemma"}})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.set_default("translator", "gemma")
    assert posted["url"].endswith("/api/setup") and posted["json"] == {"translator": "gemma"}
    assert out["defaults"]["translator"] == "gemma"
    with pytest.raises(ValueError, match="one of"):
        mcp_server.set_default("translator", "nope")


def test_download_model_asks_first_then_starts(monkeypatch):
    # The real answer shape of GET /api/models: {"models": [...]} (a bare list in
    # this test hid a crash on the first live call, 2026-09-04).
    rows = {"models": [{"id": "gemma", "name": "Gemma 3", "bytes": 7600000000, "state": "not_downloaded"}]}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, rows))
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda url, **kw: (posted.append(url), _Response(202, {"state": "downloading"}))[1])
    ask = mcp_server.download_model("gemma")
    assert ask["needs_confirmation"] is True and ask["gb"] == 7.6 and posted == []
    go = mcp_server.download_model("gemma", confirm=True)
    assert go["state"] == "downloading" and posted[0].endswith("/api/models/gemma/download")


def test_download_model_says_when_it_is_already_there_or_unknown(monkeypatch):
    rows = {"models": [{"id": "hunyuan", "name": "Hunyuan", "bytes": 1100000000, "state": "ready"}]}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, rows))
    assert mcp_server.download_model("hunyuan")["state"] == "ready"
    with pytest.raises(ValueError, match="No such model"):
        mcp_server.download_model("llama")
