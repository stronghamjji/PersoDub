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
