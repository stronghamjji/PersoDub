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


@pytest.fixture(autouse=True)
def _new_reply(tmp_path, monkeypatch, request):
    """Each test is a reply of its own: the server lives one message long,
    and the asks it keeps on disk go to a folder of this test's own. Unless a
    test is about the asking itself (marked `guard`), the user is taken to
    have had every plan in an earlier reply, so confirm=true goes through."""
    mcp_server._asked.clear()
    monkeypatch.setattr(mcp_server, "_ASK_FILE", str(tmp_path / "asked.json"))
    if not request.node.get_closest_marker("guard"):
        mcp_server._write_asks({t: {"plan": "*", "pid": 0} for t in (
            "queue_dub", "erase_subtitles", "remake_voices", "remake_line_voice",
            "proofread_dub", "change_speaker", "extract_subtitles", "set_default")})
        monkeypatch.setattr(mcp_server, "_forget_ask", lambda tool, plan: None)   # the yes stands all test long
    # queue_dub reads the saved defaults before it starts (which stages are
    # paid). A test that stubs nothing gets an empty one there and the closed
    # app everywhere else, as the real network would answer.
    def default_get(url, **kw):
        if str(url).endswith("/api/setup"):
            return _Response(200, {"defaults": {}})
        raise httpx.ConnectError("connection refused")
    monkeypatch.setattr(mcp_server.httpx, "get", default_get)


def _next_reply():
    """The user's message in between: a fresh server process, with the asks of
    the reply before still on file as another process's."""
    mcp_server._asked.clear()
    _as_earlier()


def _as_earlier():
    """Every ask on file, as put by another (earlier) process."""
    asks = mcp_server._asks_on_file()
    for tool, value in asks.items():
        asks[tool] = [{**e, "pid": 0} for e in mcp_server._ask_entries(value)]
    mcp_server._write_asks(asks)


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
    # The remakes read the job first, to tell a Perso dub from a local one.
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(200, {"id": "job7", "dub_mode": "local"}))
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

@pytest.fixture
def a_perso_job(monkeypatch):
    """change_speaker reads the job first; these tests are about a Perso dub."""
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(200, {"id": "job7", "dub_mode": "perso"}))


def test_change_speaker_on_a_local_dub_says_so_before_any_credit_question(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(200, {"id": "job7", "dub_mode": "local"}))
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    with pytest.raises(ValueError, match="Perso dubbing only"):
        mcp_server.change_speaker("job7", 3)
    assert posted == []

def test_change_speaker_asks_before_spending(monkeypatch, a_perso_job):
    # Without confirm=True nothing may be posted -- the agent must relay the
    # question and only proceed once the user agrees (money rule A).
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append(a))
    out = mcp_server.change_speaker("job7", 3)
    assert out.get("needs_confirmation") is True
    assert "credit" in out.get("message", "").lower()
    assert posted == []


def test_change_speaker_posts_once_confirmed(monkeypatch, a_perso_job):
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


def test_change_speaker_relays_a_refusal(monkeypatch, a_perso_job):
    def fake_post(url, json=None, timeout=None):
        return _Response(409, {"detail": "Only Perso dubbing has server-side speakers."})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="Only Perso dubbing"):
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


def test_queue_dub_will_not_take_a_yes_in_the_reply_that_asked(monkeypatch, tmp_path):
    # Claude asked "Proceed?" and answered it itself in the same reply,
    # starting a dubbing the user never agreed to (night test 2026-10-01).
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: posted.append(url) or _Response(
        200, {"job_id": "j1", "status": "queued"}))
    monkeypatch.setattr(
        mcp_server.httpx, "get",
        lambda url, params=None, timeout=None: _Response(
            200, {"seconds": 10.0, "credits_estimate": 0, "credits_balance": None,
                  "defaults": {}}))
    out = mcp_server.queue_dub(str(video), "ja")
    # The plan names the file and the language, not only "Proceed?".
    assert "영상.mp4 into Japanese." in out["message"]
    with pytest.raises(ValueError, match="has not answered yet"):
        mcp_server.queue_dub(str(video), "ja", confirm=True)
    assert posted == []

    _next_reply()   # the user's yes arrives as the next message
    assert mcp_server.queue_dub(str(video), "ja", confirm=True)["job_id"] == "j1"


def test_erase_subtitles_puts_the_plan_first_and_starts_on_the_yes(monkeypatch, tmp_path):
    # Free, but it holds this machine for minutes: "2 dubbing, 1 erase"
    # started the erase without saying which file (night test 2026-10-01).
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: posted.append(url) or _Response(
        200, {"job_id": "e1", "status": "queued"}))
    out = mcp_server.erase_subtitles(str(video), area="whole", start=20, end=30)
    assert out["needs_confirmation"] is True
    assert "영상.mp4 from 20s to 30s, anywhere in the frame" in out["message"]
    with pytest.raises(ValueError, match="has not answered yet"):
        mcp_server.erase_subtitles(str(video), area="whole", start=20, end=30, confirm=True)
    assert posted == []

    _next_reply()
    assert mcp_server.erase_subtitles(str(video), area="whole", confirm=True)["job_id"] == "e1"


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
    # Perso's own name for the language on the Perso path (app/languages.py).
    assert calls["data"]["language"] == "English (US)"
    assert calls["data"]["language_code"] == "en"
    assert calls["data"]["dub_mode"] == "perso"
    assert calls["data"]["source_language_code"] == "ko"
    assert calls["file_name"] == "영상.mp4"


def test_queue_dub_says_local_out_loud_so_the_servers_perso_default_cannot_take_it(monkeypatch, tmp_path):
    # Left unsaid, a local dub went to Perso and cost 10 credits the agent had
    # promised were not needed (Windows F10, 2026-10-07).
    video = _tmp_video(tmp_path)
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["data"] = data
        return _Response(200, {"job_id": "j2", "status": "running", "dub_mode": "local"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.queue_dub(str(video), "ko", dub_mode="local", confirm=True)
    assert calls["data"]["dub_mode"] == "local"
    assert "perso_model" not in calls["data"]


def test_queue_dub_refuses_a_language_the_voices_cannot_speak(tmp_path):
    video = _tmp_video(tmp_path)
    with pytest.raises(ValueError, match="target_language"):
        mcp_server.queue_dub(str(video), "sw", confirm=True)


def test_queue_dub_names_every_separation_it_takes_and_passes_the_roformer_through(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    with pytest.raises(ValueError, match='separation must be "local", "roformer", "perso" or empty'):
        mcp_server.queue_dub(str(video), "en", separation="mdx", confirm=True)
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["data"] = data
        return _Response(200, {"job_id": "j2", "status": "queued"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.queue_dub(str(video), "en", separation="roformer", confirm=True)
    assert calls["data"]["sep_engine"] == "roformer"


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
    # The other way round is the 0.6.5 bug: the table is the allow list, so a
    # served tool it lacks makes Claude ask a permission nobody can grant.
    unallowed = served - set(TOOL_LABELS)
    assert not unallowed, "served but never allowed: %s" % sorted(unallowed)


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


def test_queue_dub_relays_what_this_computer_cannot_do(monkeypatch, tmp_path):
    # app/room.py's refusals: too little memory (422), too little room (507).
    video = _tmp_video(tmp_path)
    for status, detail in ((422, "Dubbing needs 8 GB of memory on this computer."),
                           (507, "Not enough space. Needs 8.2 GB, 1.1 GB free.")):
        monkeypatch.setattr(mcp_server.httpx, "post",
                            lambda *a, _r=_Response(status, {"detail": detail}), **kw: _r)
        with pytest.raises(ValueError) as e:
            mcp_server.queue_dub(str(video), "en", confirm=True)
        assert str(e.value) == detail


def test_remaking_voices_relays_a_full_disk(monkeypatch):
    detail = "Not enough space. Needs 3.0 GB, 0.5 GB free."
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda *a, **kw: _Response(507, {"detail": detail}))
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(200, {"id": "j1", "dub_mode": "local"}))
    with pytest.raises(ValueError, match="Not enough space"):
        mcp_server.remake_line_voice("j1", 1)
    with pytest.raises(ValueError, match="Not enough space"):
        mcp_server.remake_voices("j1")


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
    # state keeps the app's own word -- the same one download_model answers
    # with -- and the percentage rides beside it. Rewriting state to
    # "downloading 41%" left the two tools speaking different languages about
    # the same model.
    assert out["models"][0]["state"] == "downloading"
    assert out["models"][0]["progress_text"] == "downloading 41%"
    assert out["keys"] == {"perso": True, "gemini": False}


def test_get_setup_leaves_a_state_without_progress_alone(monkeypatch):
    payload = {"models": [{"id": "whisper", "name": "Whisper", "bytes": 3000000000,
                           "state": "not_downloaded"}]}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, payload))
    out = mcp_server.get_setup()
    assert out["models"][0]["state"] == "not_downloaded"
    assert "progress_text" not in out["models"][0]


@pytest.mark.parametrize("tool", [
    lambda: mcp_server.get_setup(),
    lambda: mcp_server.set_default("translator", "gemma"),
    lambda: mcp_server.download_model("gemma"),
])
def test_the_setup_tools_say_the_app_is_closed(monkeypatch, tool):
    # The tools reach the app over HTTP on this machine, so a refused
    # connection means PersoDub itself is not open. Saying that beats handing
    # the assistant a raw httpx error to guess at.
    def refuse(*a, **kw):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(mcp_server.httpx, "get", refuse)
    monkeypatch.setattr(mcp_server.httpx, "post", refuse)
    with pytest.raises(ValueError, match="PersoDub is not running"):
        tool()


def test_queue_dub_says_the_app_is_closed_too(monkeypatch, tmp_path):
    # Not only the setup tools: every call in mcp_server goes through
    # _api_get/_api_post, so the POST that actually starts a dub answers with
    # the same sentence instead of a raw ConnectError (2026-09-06).
    video = _tmp_video(tmp_path)

    def refuse(*a, **kw):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(mcp_server.httpx, "post", refuse)
    with pytest.raises(ValueError, match="PersoDub is not running"):
        mcp_server.queue_dub(str(video), "en", confirm=True)


def test_set_default_posts_one_stage_and_relays_a_refusal(monkeypatch):
    posted = {}

    def fake_post(url, json=None, data=None, files=None, timeout=None):
        posted["url"] = url
        posted["json"] = json
        if json.get("translator") == "hunyuan":
            return _Response(503, {"detail": "Settings need a desktop install (no kit.env found)"})
        return _Response(200, {"defaults": {"translator": "gemma"}})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.set_default("translator", "gemma")
    assert posted["url"].endswith("/api/setup") and posted["json"] == {"translator": "gemma"}
    assert out["defaults"]["translator"] == "gemma"
    with pytest.raises(ValueError, match="desktop install"):
        mcp_server.set_default("translator", "hunyuan")


def test_download_model_never_downloads_it_only_offers_the_button(monkeypatch):
    # Codex once sent confirm=true itself and started 7.6 GB before asking
    # (Windows full test, 2026-09-25). Now only the user's press on the chat's
    # button starts a download: this tool posts nothing, whatever it is given.
    rows = {"models": [{"id": "gemma", "name": "Gemma 3", "bytes": 7600000000, "state": "not_downloaded"}]}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, rows))
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: posted.append(url))
    out = mcp_server.download_model("gemma")
    assert out["button_shown"] is True and out["gb"] == 7.6 and out["id"] == "gemma"
    assert "only when the user presses" in out["message"]
    assert posted == []
    import inspect
    assert "confirm" not in inspect.signature(mcp_server.download_model).parameters


def test_download_model_says_when_it_is_already_there_or_unknown(monkeypatch):
    rows = {"models": [{"id": "hunyuan", "name": "Hunyuan", "bytes": 1100000000, "state": "ready"}]}
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, params=None, timeout=None: _Response(200, rows))
    assert mcp_server.download_model("hunyuan")["state"] == "ready"
    with pytest.raises(ValueError, match="No such model"):
        mcp_server.download_model("llama")


def test_queue_dub_knows_persos_languages_on_the_perso_path_only(monkeypatch, tmp_path):
    from app import languages
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    video = _tmp_video(tmp_path)
    with pytest.raises(ValueError, match="target_language"):
        mcp_server.queue_dub(str(video), "hi", confirm=True)          # the local voices cannot
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["data"] = data
        return _Response(200, {"job_id": "j1", "status": "running"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.queue_dub(str(video), "hi", dub_mode="perso", confirm=True)
    assert out["job_id"] == "j1"
    assert calls["data"]["language"] == "Hindi" and calls["data"]["language_code"] == "hi"


def test_queue_dub_passes_the_perso_voice_model_and_refuses_one_the_language_lacks(monkeypatch, tmp_path):
    from app import languages
    monkeypatch.setattr(languages, "_fetch", lambda: None)
    video = _tmp_video(tmp_path)
    # Refused before anything is asked or started, naming the model and the language.
    with pytest.raises(ValueError, match="Wren.*English \\(Australia\\)"):
        mcp_server.queue_dub(str(video), "en-AU", dub_mode="perso", perso_model="wren")
    calls = []

    def fake_post(url, data=None, files=None, timeout=None):
        calls.append(data)
        return _Response(200, {"job_id": "j1", "status": "running"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.queue_dub(str(video), "ko", dub_mode="perso", perso_model="wren", confirm=True)
    assert calls[-1]["perso_model"] == "WREN"
    # Not named: the app picks. Named for a local dubbing: it does not apply.
    mcp_server.queue_dub(str(video), "ko", dub_mode="perso", confirm=True)
    mcp_server.queue_dub(str(video), "ko", perso_model="wren", confirm=True)
    assert "perso_model" not in calls[-2] and "perso_model" not in calls[-1]


# --- fetching a link, and rubbing out subtitles ------------------------------

def test_download_video_waits_until_the_file_is_really_there(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda url, **kw: _Response(200, {"id": "d1"}))
    answers = [
        _Response(200, {"status": "downloading", "percent": 40}),
        _Response(200, {"status": "ready", "path": "/w/downloads/d1/source.mp4",
                        "title": "a clip", "duration_sec": 61.0}),
    ]
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: answers.pop(0))
    monkeypatch.setattr(mcp_server.time, "sleep", lambda _s: None)
    assert mcp_server.download_video("https://example.com/v") == {
        "path": "/w/downloads/d1/source.mp4", "title": "a clip",
        "duration_sec": 61.0, "download_id": "d1",
    }


def test_download_video_repeats_the_reason_a_link_failed(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda url, **kw: _Response(200, {"id": "d1"}))
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(
        200, {"status": "failed", "error": "This video is private."}))
    with pytest.raises(ValueError, match="private"):
        mcp_server.download_video("https://example.com/v")


def test_erase_subtitles_turns_bottom_into_the_bottom_quarter(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    monkeypatch.setattr(mcp_server.media, "video_size", lambda p: (608, 1080))
    calls = {}

    def fake_post(url, data=None, files=None, timeout=None):
        calls["url"], calls["data"] = url, data
        return _Response(200, {"job_id": "e1", "status": "running"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.erase_subtitles(str(video), area="bottom", start=20, end=30, confirm=True)
    assert out == {"job_id": "e1", "status": "running",
                   "area_used": "the bottom quarter of the frame"}
    assert calls["url"] == "%s/api/erase" % mcp_server.API
    assert calls["data"]["area"] == "[810, 1080, 0, 608]"
    # One call does the cut and the erase -- not cut_clip and then this.
    assert calls["data"]["trim_start"] == "20" and calls["data"]["trim_end"] == "30"


def test_erase_subtitles_asks_the_app_where_the_subtitles_are_first(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    posted = []

    def fake_post(url, data=None, files=None, timeout=None):
        posted.append(url)
        if url.endswith("/suggest"):
            return _Response(200, {"found": True, "area": [614, 847, 23, 571],
                                   "width": 608, "height": 1080})
        return _Response(200, {"job_id": "e1", "status": "queued"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.erase_subtitles(str(video), confirm=True)
    assert posted == ["%s/api/erase/suggest" % mcp_server.API,
                      "%s/api/erase" % mcp_server.API]
    assert out["area_used"] == "where the subtitles were found"


def test_erase_subtitles_passes_a_box_through_and_names_the_whole_frame(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    calls = []

    def fake_post(url, data=None, files=None, timeout=None):
        calls.append(data["area"])
        return _Response(200, {"job_id": "e1", "status": "running"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.erase_subtitles(str(video), area=[660, 800, 0, 608], confirm=True)
    mcp_server.erase_subtitles(str(video), area="whole", confirm=True)
    assert calls == ["[660, 800, 0, 608]", "whole"]


def test_erase_subtitles_says_plainly_that_the_eraser_is_not_installed(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: _Response(
        409, {"detail": {"reason": "pack_missing", "pack": "subtitle-eraser"}}))
    with pytest.raises(ValueError, match="not installed on this computer"):
        mcp_server.erase_subtitles(str(video), area="whole", confirm=True)


def test_erase_subtitles_refuses_a_video_that_is_not_there(tmp_path):
    with pytest.raises(ValueError, match="No such video"):
        mcp_server.erase_subtitles(str(tmp_path / "nope.mp4"), area="whole")


def test_save_erased_returns_where_the_file_went(monkeypatch):
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["url"], posted["json"] = url, json
        return _Response(200, {"path": "/Users/x/Downloads/clip (no subtitles).mp4"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    out = mcp_server.save_erased("e1")
    assert out["path"].endswith("(no subtitles).mp4")
    assert posted["url"] == "%s/api/erase/e1/save" % mcp_server.API
    assert posted["json"] == {}


def test_get_job_status_of_an_erase_carries_the_percent_and_the_file(monkeypatch):
    def fake_get(url, **kw):
        if url.endswith("/api/dub/jobs/e1"):
            return _Response(200, {"status": "done", "kind": "erase", "logs": []})
        return _Response(200, {"percent": 100, "done": True,
                               "result": {"out_path": "/w/day/clip_erase/erased.mp4"},
                               "check": {"frames_checked": 114, "frames_with_text": 0,
                                         "sample_times": []}})

    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)
    out = mcp_server.get_job_status("e1")
    assert out["percent"] == 100 and out["done"] is True
    assert out["result_path"].endswith("erased.mp4")
    # "Is it really gone?" -- the agent can answer it without opening the video.
    assert out["check"]["frames_with_text"] == 0


JOBS = {"jobs": [
    {"id": "e1", "kind": "erase", "status": "running", "project": "clip8"},
    {"id": "d2", "kind": "dub", "status": "queued", "project": "clip9"},
    {"id": "d3", "kind": "dub", "status": "done", "project": "clip7"},
]}


def test_list_jobs_names_what_is_running_so_stop_it_can_find_a_job(monkeypatch):
    # "Stop the subtitle erase" -- work started on the screen has an id nobody
    # has seen, and without this the assistant had nothing to cancel by
    # (user, 2026-09-09).
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(200, JOBS))
    out = mcp_server.list_jobs()
    assert [j["id"] for j in out] == ["e1", "d2"]
    assert out[0] == {"id": "e1", "kind": "erase", "title": "clip8", "status": "running",
                      "language_code": None, "project_id": "e1"}


def test_list_jobs_says_which_dubbings_are_languages_of_one_video(monkeypatch):
    # Add language: the second dubbing names the first as its project; a job
    # saved before that field existed is a project of its own.
    jobs = {"jobs": [
        {"id": "d5", "kind": "dub", "status": "done", "project": "cats", "language_code": "en",
         "project_id": "d4"},
        {"id": "d4", "kind": "dub", "status": "done", "project": "cats", "language_code": "ko"},
    ]}
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(200, jobs))
    out = mcp_server.list_jobs(active_only=False)
    assert [(j["project_id"], j["language_code"]) for j in out] == [("d4", "en"), ("d4", "ko")]


def test_list_jobs_can_list_the_finished_ones_too(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(200, JOBS))
    assert [j["id"] for j in mcp_server.list_jobs(active_only=False)] == ["e1", "d2", "d3"]


def test_list_videos_names_the_videos_the_app_is_holding(monkeypatch, tmp_path):
    held = tmp_path / "source.mp4"
    held.write_bytes(b"video-bytes")
    (tmp_path / "in the folder.mp4").write_bytes(b"video-bytes")
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(
        200, {"downloads": [{"status": "ready", "path": str(held), "title": "a fetched link"},
                            {"status": "downloading", "path": "", "title": "not yet"}]}))
    out = mcp_server.list_videos(str(tmp_path))
    assert out["videos"][0]["name"] == "a fetched link"
    assert out["videos"][0]["held"] is True
    assert "not yet" not in [v["name"] for v in out["videos"]]


def test_list_videos_still_lists_the_folder_when_the_app_is_closed(monkeypatch, tmp_path):
    (tmp_path / "clip.mp4").write_bytes(b"video-bytes")

    def closed(url, **kw):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(mcp_server.httpx, "get", closed)
    assert [v["name"] for v in mcp_server.list_videos(str(tmp_path))["videos"]] == ["clip.mp4"]


# --- what the agent is told when a tool says no --------------------------

def test_a_refusal_keeps_its_reason_for_the_agent():
    # mcp >= 2.2 hands the agent "Error executing tool X" and nothing else for
    # any exception that is not a ToolError: the kit shipped 2.2.0 while the
    # dev venv had 2.0.0, and eleven refused dubs in the 0.6.2 full test came
    # back as "등록 오류" with no reason (2026-09-16).
    from mcp.server.mcpserver.exceptions import ToolError
    with pytest.raises(ToolError, match="dub_mode"):
        mcp_server.queue_dub("x.mp4", "en", dub_mode="cloud")


def test_queue_dub_names_the_perso_credits_a_local_dub_will_spend(monkeypatch, tmp_path):
    # "Local" dub, but the saved defaults send transcription through Perso:
    # the agent told the user it was free (0.6.2 full test, F30) and never
    # said the balance (F35).
    video = _tmp_video(tmp_path)
    asked = []

    def fake_get(url, params=None, timeout=None):
        asked.append((url, params))
        if url.endswith("/api/setup"):
            return _Response(200, {"defaults": {"stt": "perso", "separation": "local"}})
        return _Response(200, {"seconds": 10.0, "credits_estimate": 2, "credits_balance": 500})

    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: pytest.fail("posted"))
    out = mcp_server.queue_dub(str(video), "en")
    assert out["needs_confirmation"] is True
    assert "free" not in out["message"]
    assert "Perso" in out["message"] and "2 credits" in out["message"] and "500" in out["message"]
    # The balance comes from the perso estimate, not the local one.
    assert any(p and p.get("engine") == "perso" for _u, p in asked)


# --- a paid choice is asked about before it becomes the default ---------------

def test_set_default_asks_before_a_choice_that_spends_credits(monkeypatch):
    # "음성 인식만 페르소로" -- the assistant switched STT_ENGINE to perso before
    # asking anything. The user said no to the dub and the default stayed paid,
    # so every later dub would have spent credits (Windows full test, F35).
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append((a, kw)) or _Response(200, {}))
    for stage, choice in (("stt", "perso"), ("separation", "perso"), ("dub_mode", "perso"), ("translator", "gemini"),
                          # Spelled any other way too: the app saves a choice trimmed and
                          # lowercased, and "Gemini" became the default unasked (2026-10-10).
                          ("translator", "Gemini"), ("dub_mode", "PERSO"), ("stt", " perso")):
        out = mcp_server.set_default(stage, choice)
        assert out["needs_confirmation"] is True and "every" in out["message"]
    assert posted == []


def test_set_default_changes_a_paid_choice_once_confirmed_and_a_free_one_at_once(monkeypatch):
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda url, json=None, timeout=None: posted.append(json) or _Response(200, {"defaults": {}}))
    mcp_server.set_default("stt", "perso", confirm=True)
    mcp_server.set_default("stt", "local")
    mcp_server.set_default("translator", "gemma")
    mcp_server.set_default("translator", "Gemini", confirm=True)
    assert posted == [{"stt": "perso"}, {"stt": "local"}, {"translator": "gemma"}, {"translator": "gemini"}]


def test_set_default_refuses_a_stage_or_choice_it_does_not_have_before_posting(monkeypatch):
    # The app passes over a stage it does not know, so "Translator" changed
    # nothing and said nothing (2026-10-10).
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: posted.append((a, kw)) or _Response(200, {}))
    with pytest.raises(ValueError, match="Unknown stage: Translator"):
        mcp_server.set_default("Translator", "hunyuan")
    with pytest.raises(ValueError, match="translator must be one of"):
        mcp_server.set_default("translator", "nope")
    assert posted == []


@pytest.mark.guard
def test_set_default_will_not_save_a_paid_default_on_a_yes_nobody_was_asked_for(monkeypatch):
    # confirm=true on the first call saved a paid default straight away: like
    # every paid tool, the plan with its cost reaches the user first.
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post",
                        lambda url, json=None, timeout=None: posted.append(json) or _Response(200, {"defaults": {}}))
    with pytest.raises(ValueError, match="spends credits"):
        mcp_server.set_default("translator", "gemini", confirm=True)
    mcp_server.set_default("translator", "Gemini")
    with pytest.raises(ValueError, match="has not answered yet"):
        mcp_server.set_default("translator", "gemini", confirm=True)
    assert posted == []

    _next_reply()   # the user's yes arrives as the next message
    mcp_server.set_default("translator", "gemini", confirm=True)
    assert posted == [{"translator": "gemini"}]


def test_queue_dub_takes_the_engines_for_this_dub_only(monkeypatch, tmp_path):
    # One dub through Perso transcription is a choice about that dub: it must
    # not take changing the default for every dub to get it.
    video = _tmp_video(tmp_path)
    sent = {}

    def fake_post(url, data=None, files=None, timeout=None, **kw):
        sent.update(data or {})
        return _Response(200, {"job_id": "j1", "status": "queued"})

    monkeypatch.setattr(mcp_server.httpx, "post", fake_post)
    mcp_server.queue_dub(str(video), "en", stt="perso", separation="local", confirm=True)
    assert sent["stt_engine"] == "perso" and sent["sep_engine"] == "local"


def test_queue_dub_prices_the_engines_named_for_this_dub(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)

    def fake_get(url, params=None, timeout=None):
        if url.endswith("/api/setup"):
            return _Response(200, {"defaults": {"stt": "local", "separation": "local"}})
        return _Response(200, {"seconds": 10.0, "credits_estimate": 2, "credits_balance": 500})

    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: pytest.fail("posted"))
    out = mcp_server.queue_dub(str(video), "en", stt="perso")
    assert "2 credits" in out["message"] and "500" in out["message"] and "free" not in out["message"]
    with pytest.raises(ValueError, match="stt"):
        mcp_server.queue_dub(str(video), "en", stt="whisper")


def _gemini_default(monkeypatch):
    def fake_get(url, params=None, timeout=None):
        if url.endswith("/api/setup"):
            return _Response(200, {"defaults": {"stt": "local", "separation": "local", "translator": "gemini"}})
        return _Response(200, {"seconds": 30.0, "credits_estimate": 0, "credits_balance": None})
    monkeypatch.setattr(mcp_server.httpx, "get", fake_get)


def test_queue_dub_says_a_gemini_translation_spends_the_users_quota(monkeypatch, tmp_path):
    # set_default asks before Gemini becomes the default because it spends the
    # user's Gemini API quota, yet a Gemini dub's plan said it "runs free on
    # this machine" (2026-10-10).
    video = _tmp_video(tmp_path)
    _gemini_default(monkeypatch)
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: pytest.fail("posted"))
    for translator in ("gemini", ""):   # named for this dub, or the saved default
        message = mcp_server.queue_dub(str(video), "ko", translator=translator)["message"]
        assert "free" not in message and "Gemini API quota" in message
    message = mcp_server.queue_dub(str(video), "ko", translator="hunyuan")["message"]
    assert "runs free on this machine" in message and "quota" not in message


@pytest.mark.guard
def test_queue_dub_will_not_start_a_gemini_dub_on_a_yes_nobody_was_asked_for(monkeypatch, tmp_path):
    video = _tmp_video(tmp_path)
    _gemini_default(monkeypatch)
    monkeypatch.setattr(mcp_server.httpx, "post", lambda *a, **kw: pytest.fail("posted"))
    with pytest.raises(ValueError, match="spends credits"):
        mcp_server.queue_dub(str(video), "ko", confirm=True)


# --- a Perso dub's voices are remade by Perso, and that is asked first -------

class _PersoApp:
    """The app's side of one Perso dub: what it answers, and what was posted."""

    def __init__(self, monkeypatch, edit=None, lines=None):
        self.edit = {"available": True, "reason": "", "nightingale": False,
                     "retranslate_available": True, "working": None,
                     "unfetched": False, "error": None, **(edit or {})}
        self.lines = lines or []
        self.posted = []
        self.answer = _Response(200, {"line": 3, "ok": True, "credits": 2})
        monkeypatch.setattr(mcp_server.httpx, "get", self.get)
        monkeypatch.setattr(mcp_server.httpx, "post", self.post)

    def get(self, url, **kw):
        if url.endswith("/perso/edit"):
            return _Response(200, self.edit)
        if url.endswith("/script"):
            return _Response(200, {"lines": self.lines})
        return _Response(200, {"id": "job7", "status": "done", "dub_mode": "perso",
                               "result": {"out_path": "/nowhere/dubbed.mp4"}})

    def post(self, url, json=None, timeout=None, **kw):
        self.posted.append((url.replace(mcp_server.API, ""), json))
        return self.answer


def test_remaking_a_perso_line_asks_before_spending(monkeypatch):
    app = _PersoApp(monkeypatch)
    out = mcp_server.remake_line_voice("job7", 3)
    assert out["needs_confirmation"] is True and "credits" in out["message"]
    assert app.posted == []


def test_remaking_a_perso_line_goes_to_perso_once_confirmed(monkeypatch):
    app = _PersoApp(monkeypatch)
    assert mcp_server.remake_line_voice("job7", 3, confirm=True)["credits"] == 2
    assert app.posted == [("/api/dub/jobs/job7/perso/script/3/voice", {"confirm": True})]


def test_a_nightingale_dub_is_sent_to_proofread_instead(monkeypatch):
    app = _PersoApp(monkeypatch, edit={"nightingale": True})
    with pytest.raises(ValueError, match="proofread_dub"):
        mcp_server.remake_line_voice("job7", 3, confirm=True)
    assert app.posted == []


def test_a_perso_dub_voiced_on_this_computer_stays_on_this_computer(monkeypatch):
    from app.perso_edit import LOCAL_VOICE
    app = _PersoApp(monkeypatch, edit={"available": False, "reason": LOCAL_VOICE})
    mcp_server.remake_line_voice("job7", 3)
    assert app.posted == [("/api/dub/jobs/job7/script/3/voice", None)]


def test_a_perso_dub_that_cannot_be_edited_now_is_not_voiced_here_instead(monkeypatch):
    app = _PersoApp(monkeypatch, edit={"available": False, "reason": "This job is still running."})
    with pytest.raises(ValueError, match="still running"):
        mcp_server.remake_line_voice("job7", 3, confirm=True)
    assert app.posted == []


def test_perso_refusals_reach_the_agent_with_their_reason(monkeypatch):
    app = _PersoApp(monkeypatch)
    app.answer = _Response(402, {"detail": "Perso credits are used up. Recharge to continue."})
    with pytest.raises(ValueError, match="credits are used up"):
        mcp_server.remake_line_voice("job7", 3, confirm=True)


def test_remake_voices_on_a_perso_dub_sends_each_changed_line_to_perso(monkeypatch):
    lines = [{"line": 1, "voice_stale": False}, {"line": 2, "voice_stale": True},
             {"line": 3, "voice_stale": True}]
    app = _PersoApp(monkeypatch, lines=lines)
    out = mcp_server.remake_voices("job7")
    assert out["needs_confirmation"] is True and "2 voices" in out["message"]
    assert app.posted == []

    _next_reply()   # the user's yes is the next message
    out = mcp_server.remake_voices("job7", confirm=True)
    assert out == {"remade": [2, 3], "skipped": 1, "credits": 4}
    assert [p[0] for p in app.posted] == ["/api/dub/jobs/job7/perso/script/2/voice",
                                          "/api/dub/jobs/job7/perso/script/3/voice"]


def test_remake_voices_on_a_perso_dub_with_nothing_changed_asks_nothing(monkeypatch):
    app = _PersoApp(monkeypatch, lines=[{"line": 1, "voice_stale": False}])
    assert mcp_server.remake_voices("job7") == {"remade": [], "skipped": 1}
    assert app.posted == []


def test_translating_a_perso_dub_again_changes_words_only_and_asks_nothing(monkeypatch):
    app = _PersoApp(monkeypatch)
    app.answer = _Response(200, {"changed": []})
    assert mcp_server.retranslate_lines("job7", [2]) == {"changed": []}
    assert app.posted == [("/api/dub/jobs/job7/retranslate", {"lines": [2]})]


def test_translating_again_with_a_translator_not_downloaded_names_it(monkeypatch):
    # A Hunyuan project whose model is gone: the app's 409 download dialog
    # payload, said as a sentence rather than relayed raw.
    app = _PersoApp(monkeypatch)
    app.answer = _Response(409, {"detail": {"missing": [
        {"id": "hunyuan", "name": "Hunyuan 1.8B", "bytes": 1100000000}]}})
    with pytest.raises(ValueError, match=r"Hunyuan 1\.8B \(1\.1 GB\)"):
        mcp_server.retranslate_lines("job7", [2])


def test_proofread_asks_then_starts(monkeypatch):
    app = _PersoApp(monkeypatch)
    out = mcp_server.proofread_dub("job7")
    assert out["needs_confirmation"] is True and "credits" in out["message"]
    assert "free" not in out["message"]
    assert app.posted == []
    app.answer = _Response(200, {"started": True, "fetch_only": False})
    _next_reply()   # the user's yes is the next message
    assert mcp_server.proofread_dub("job7", confirm=True)["started"] is True
    assert app.posted == [("/api/dub/jobs/job7/perso/proofread", {"confirm": True})]


def test_proofread_names_the_free_first_one_on_nightingale(monkeypatch):
    _PersoApp(monkeypatch, edit={"nightingale": True})
    assert "first time on this dubbing is free" in mcp_server.proofread_dub("job7")["message"]


def test_proofread_is_refused_when_perso_has_nothing_to_go_over(monkeypatch):
    app = _PersoApp(monkeypatch, edit={"retranslate_available": False})
    with pytest.raises(ValueError, match="nothing to redo"):
        mcp_server.proofread_dub("job7", confirm=True)
    assert app.posted == []


def test_a_proofread_never_fetched_is_fetched_without_asking(monkeypatch):
    app = _PersoApp(monkeypatch, edit={"available": False, "unfetched": True,
                                       "retranslate_available": False})
    app.answer = _Response(200, {"started": True, "fetch_only": True})
    assert mcp_server.proofread_dub("job7")["fetch_only"] is True


def test_proofread_is_for_perso_dubs_only(monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get",
                        lambda url, **kw: _Response(200, {"id": "job7", "dub_mode": "local"}))
    with pytest.raises(ValueError, match="Perso dubbing only"):
        mcp_server.proofread_dub("job7", confirm=True)


def test_job_status_of_a_perso_dub_says_what_perso_is_doing(monkeypatch):
    _PersoApp(monkeypatch, edit={"working": "proofread"})
    assert mcp_server.get_job_status("job7")["perso_edit"]["working"] == "proofread"


def test_editing_a_perso_dub_nobody_opened_fetches_it_first(monkeypatch, tmp_path):
    app = _PersoApp(monkeypatch)
    job = {"id": "job7", "dub_mode": "perso", "language_code": "en",
           "result": {"out_path": str(tmp_path / "dubbed.mp4")}}
    monkeypatch.setattr(mcp_server, "_job", lambda job_id: job)
    edited = []
    monkeypatch.setattr(mcp_server, "edit_line", lambda *a: edited.append(a) or {"line": 1})
    mcp_server.edit_script_line("job7", 1, "Hello")
    assert app.posted == [("/api/dub/jobs/job7/perso/materialize", None)]
    assert edited == [(str(tmp_path), 1, "Hello", "en")]


# export_script and edit_script_line said no with a plain ValueError, which
# mcp >= 2.2 hands the agent as "Error executing tool X" with no reason
# (0.9.2 agent tool run, 2026-10-28).
def test_export_and_edit_refusals_reach_the_agent_with_their_reason(monkeypatch, tmp_path):
    from mcp.server.mcpserver.exceptions import ToolError
    job = {"id": "job7", "dub_mode": "local", "language_code": "ko",
           "result": {"out_path": str(tmp_path / "dubbed.mp4")}}
    monkeypatch.setattr(mcp_server, "_job", lambda job_id: job)

    def no(*a):
        raise ValueError("only inside its own job folder")
    monkeypatch.setattr(mcp_server, "export_srt", no)
    monkeypatch.setattr(mcp_server, "edit_line", no)
    with pytest.raises(ToolError, match="only inside its own job folder"):
        mcp_server.export_script("job7", "../outside.srt")
    with pytest.raises(ToolError, match="only inside its own job folder"):
        mcp_server.edit_script_line("job7", 9, "Hello")


def test_editing_a_job_with_no_script_says_so_without_its_folder(monkeypatch, tmp_path):
    from mcp.server.mcpserver.exceptions import ToolError
    job = {"id": "job7", "dub_mode": "local", "language_code": "ko",
           "result": {"out_path": str(tmp_path / "dubbed.mp4")}}
    monkeypatch.setattr(mcp_server, "_job", lambda job_id: job)
    with pytest.raises(ToolError, match="no script yet") as e:
        mcp_server.edit_script_line("job7", 1, "Hello")
    assert str(tmp_path) not in str(e.value)


# Several plans put in one reply ("Shall I start all three?") are all the
# user's to say yes to in the next. Only the last was kept on file, so a batch
# that spends credits started one video per answer (final review, 2026-10-12).
@pytest.mark.guard
def test_every_plan_put_in_one_reply_can_be_confirmed_in_the_next():
    for plan in ("a.mp4|ko|local|stt", "b.mp4|ko|local|stt"):
        mcp_server._ask("queue_dub", {}, plan=plan)
    _next_reply()
    mcp_server._answered("queue_dub", "a.mp4|ko|local|stt", paid=True)
    mcp_server._answered("queue_dub", "b.mp4|ko|local|stt", paid=True)
    # Each yes is used once, and a plan nobody was asked about still waits.
    for plan in ("a.mp4|ko|local|stt", "c.mp4|ko|local|stt"):
        with pytest.raises(ValueError, match="spends credits"):
            mcp_server._answered("queue_dub", plan, paid=True)


# A new question replaces the plans of the reply before: a plan from an older
# reply, which the user may have turned down, is not started on a later yes.
@pytest.mark.guard
def test_a_new_question_replaces_the_plans_of_an_older_reply():
    mcp_server._ask("queue_dub", {}, plan="a")
    _next_reply()
    mcp_server._ask("queue_dub", {}, plan="b")
    _next_reply()
    with pytest.raises(ValueError, match="spends credits"):
        mcp_server._answered("queue_dub", "a", paid=True)
    mcp_server._answered("queue_dub", "b", paid=True)


@pytest.mark.guard
def test_a_plan_put_again_in_the_reply_that_confirms_it_is_not_a_new_question(monkeypatch, tmp_path):
    # The agent put the plan, the user said yes, and in the next reply the
    # agent put the same plan once more before confirming: every consent had
    # to be given twice (Windows F41, 2026-10-07).
    monkeypatch.setattr(mcp_server, "_ASK_FILE", str(tmp_path / "asked.json"))
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: posted.append(url) or _Response(
        200, {"job_id": "j1", "status": "queued"}))
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, params=None, timeout=None: _Response(
        200, {"seconds": 10.0, "credits_estimate": 0, "credits_balance": None, "defaults": {}}))

    # Reply 1: the plan is put. (A fresh server process next time: _asked is empty again.)
    first = mcp_server.queue_dub(str(video), "ja")
    _next_reply()
    # Reply 2, after the user's yes: the same plan put again, then confirmed.
    again = mcp_server.queue_dub(str(video), "ja")
    assert again["message"] == first["message"]
    # The file still holds reply 1's ask, so this confirm is the user's answer.
    assert mcp_server._asks_on_file()["queue_dub"][0]["pid"] == 0
    assert mcp_server.queue_dub(str(video), "ja", confirm=True)["job_id"] == "j1"
    assert posted == ["%s/api/dub/start" % mcp_server.API]
    # ...and is used up: the next same plan has to be asked afresh.
    assert "queue_dub" not in mcp_server._asks_on_file()

    # A different plan in that reply (another language) is a new question.
    _next_reply()
    mcp_server.queue_dub(str(video), "ja")
    _as_earlier()
    mcp_server.queue_dub(str(video), "ko")
    with pytest.raises(ValueError, match="has not answered yet"):
        mcp_server.queue_dub(str(video), "ko", confirm=True)


@pytest.mark.guard
def test_a_dub_that_spends_credits_is_not_started_on_the_users_word_alone(monkeypatch, tmp_path):
    # "Dub test90.mp4 into English, on this computer" started a dub whose
    # transcription ran on Perso, with no quote (Mac F10, 2026-10-08).
    video = _tmp_video(tmp_path)
    posted = []
    monkeypatch.setattr(mcp_server.httpx, "post", lambda url, **kw: posted.append(url) or _Response(
        200, {"job_id": "j1", "status": "queued"}))
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, params=None, timeout=None: _Response(
        200, {"seconds": 10.0, "credits_estimate": 2, "credits_balance": 100,
              "defaults": {"stt": "perso", "separation": "local", "voice": "qwen3"}}))
    with pytest.raises(ValueError, match="spends credits"):
        mcp_server.queue_dub(str(video), "en", confirm=True)
    assert posted == []
    # Named free, it may start on the user's word: the message said which file and to go.
    assert mcp_server.queue_dub(str(video), "en", stt="local", confirm=True)["job_id"] == "j1"
    # Asked first, the user's yes in the next reply starts the paid one.
    mcp_server.queue_dub(str(video), "en")
    _next_reply()
    assert mcp_server.queue_dub(str(video), "en", confirm=True)["job_id"] == "j1"


def test_get_job_status_of_a_running_dub_carries_the_screens_percent(monkeypatch):
    # The agent used to answer "no percent given" (Windows F6, 2026-10-07).
    logs = ["1/6 a", "2/6 b", "3/6 c", "2 dialogue lines prepared", "4/6 d", "   line 0: chose take 2"]
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(
        200, {"status": "running", "kind": "dub", "logs": logs}))
    out = mcp_server.get_job_status("d1")
    assert out["stage"] == 4 and out["label"] == "Dubbing" and out["percent"] == 75


# "Read it all again" (Windows test F18, 2026-10-11): every line, changed or
# not. It takes a while, so the number of lines goes to the user first.
def test_remake_every_voice_asks_with_the_line_count_then_remakes_them_all(posted, monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(200, {
        "id": "job7", "dub_mode": "local", "language_code": "ko",
        "result": {"out_path": "/w/dubbed/dubbed.mp4"}}))
    monkeypatch.setattr(mcp_server, "load_lines", lambda work, lang: [
        {"line": 1, "text": "one"}, {"line": 2, "text": ""}, {"line": 3, "text": "three"}])
    asked = mcp_server.remake_voices("job7", every_line=True)
    assert asked["needs_confirmation"] is True and "all 2 lines" in asked["message"]
    assert posted == []
    _next_reply()
    posted.answer = _Response(200, {"remade": [1, 3], "skipped": 1})
    assert mcp_server.remake_voices("job7", confirm=True, every_line=True) == {"remade": [1, 3], "skipped": 1}
    assert posted == ["%s/api/dub/jobs/job7/voices/all" % mcp_server.API]


# A busy or failing voice engine reached the agent as a bare HTTP error, with
# nothing to tell the user (final review, 2026-10-12).
def test_a_busy_voice_engine_reaches_the_agent_with_its_sentence(posted, monkeypatch):
    monkeypatch.setattr(mcp_server.httpx, "get", lambda url, **kw: _Response(200, {
        "id": "job7", "dub_mode": "local", "result": {"out_path": "/w/dubbed/dubbed.mp4"}}))
    posted.answer = _Response(503, {"detail": "The voice engine is busy. Wait for the running dubbing to finish."})
    with pytest.raises(ValueError, match="voice engine is busy"):
        mcp_server.remake_voices("job7")


def test_remake_every_voice_on_a_perso_dub_points_to_proofread(monkeypatch):
    app = _PersoApp(monkeypatch)
    with pytest.raises(ValueError, match="proofread_dub"):
        mcp_server.remake_voices("job7", every_line=True)
    assert app.posted == []


# A Perso dub whose voices are made here now (a line was remade on this
# computer) is read again here, as its changed lines already are: refused, the
# agent had no way to do it (final review, 2026-10-12).
def test_remake_every_voice_on_a_perso_dub_voiced_here_stays_here(monkeypatch):
    from app.perso_edit import LOCAL_VOICE
    app = _PersoApp(monkeypatch, edit={"available": False, "reason": LOCAL_VOICE})
    monkeypatch.setattr(mcp_server, "load_lines", lambda work, lang: [
        {"line": 1, "text": "one"}, {"line": 2, "text": "two"}])
    asked = mcp_server.remake_voices("job7", every_line=True)
    assert asked["needs_confirmation"] is True and "all 2 lines" in asked["message"]
    assert app.posted == []
    _next_reply()
    app.answer = _Response(200, {"remade": [1, 2], "skipped": 0})
    assert mcp_server.remake_voices("job7", confirm=True, every_line=True) == {"remade": [1, 2], "skipped": 0}
    assert [url for url, _ in app.posted] == ["/api/dub/jobs/job7/voices/all"]
