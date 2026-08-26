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
