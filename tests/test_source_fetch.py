"""app/source_fetch.py: URL guard and yt-dlp error classification.

Nothing here touches the network. source_fetch._run is the only place that
starts a process, and every test that needs a yt-dlp result replaces it.
"""
import json
import sys

import pytest

from app import source_fetch


def test_rejects_non_http_urls():
    for bad in ("file:///etc/passwd", "ftp://host/v.mp4", "/Users/me/v.mp4", ""):
        with pytest.raises(source_fetch.FetchError) as e:
            source_fetch.validate_url(bad)
        assert e.value.reason == "unsupported"


def test_accepts_http_and_https():
    source_fetch.validate_url("https://www.youtube.com/watch?v=abc")
    source_fetch.validate_url("http://example.com/v.mp4")


@pytest.mark.parametrize("stderr,reason", [
    # YouTube
    ("ERROR: unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>", "network"),
    ("ERROR: [youtube] abc: Sign in to confirm your age", "login"),
    ("ERROR: [youtube] abc: This video is not available in your country", "geo"),
    ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "login"),
    ("ERROR: [youtube] abc: Video unavailable. This video has been removed", "gone"),
    # Instagram Reels -- the site that refuses most often, so its wording matters
    ("ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required", "login"),
    ("ERROR: [Instagram] abc: You need to log in to access this content", "login"),
    ("ERROR: [Instagram] abc: Restricted Video: You must be 18 years old or over to see this video", "login"),
    # TikTok
    ("ERROR: [TikTok] abc: Video not available", "gone"),
    ("ERROR: [TikTok] abc: This video is private", "login"),
    # Neither, and nothing
    ("ERROR: Unsupported URL: https://example.com/page", "unsupported"),
    ("ERROR: something nobody has seen before", "unknown"),
])
def test_classify_maps_stderr_to_a_reason(stderr, reason):
    got_reason, message = source_fetch.classify(stderr)
    assert got_reason == reason
    assert message and message[0].isupper() and message.endswith(".")


def test_classify_prefers_network_over_everything():
    # A dead connection can produce stderr that also mentions sign-in. Retrying
    # after an upgrade is pointless when the network is the problem, so the
    # network verdict has to win or fetch() will waste two minutes upgrading.
    stderr = "ERROR: unable to download webpage. Sign in to confirm your age"
    assert source_fetch.classify(stderr)[0] == "network"


# ---------------------------------------------------------------- _run


TITLE = "한국어 제목"  # a title in the source language, as yt-dlp reports it


def test_run_decodes_child_output_as_utf8():
    """The two tests that let _run start a real process.

    Every other test replaces _run, so its pipe was never exercised. Both ends
    have to name UTF-8 or they agree only by accident of the machine's locale.
    This one writes raw UTF-8 bytes, so it fails if the PARENT is left to the
    locale: under cp949 these bytes raise UnicodeDecodeError and cost the
    fetch.
    """
    code, out, err = source_fetch._run(
        [sys.executable, "-c",
         "import sys; sys.stdout.buffer.write(%r)" % (TITLE + "\n").encode("utf-8")])
    assert code == 0
    assert out.strip() == TITLE


def test_run_pins_the_child_to_utf8_output():
    """...and this one lets the child encode the text itself, the way yt-dlp
    does when it prints a line carrying the video's own title. It fails if the
    CHILD is left to the locale while the reader expects UTF-8."""
    code, out, err = source_fetch._run(
        [sys.executable, "-c", "print(%r)" % TITLE])
    assert code == 0
    assert out.strip() == TITLE


# ---------------------------------------------------------------- probe


def _fake_run(code=0, stdout="", stderr=""):
    """Build a stand-in for source_fetch._run that records how it was called."""
    calls = []

    def run(args, on_line=None, cancel_check=None, timeout=None):
        calls.append(args)
        if on_line:
            for line in stdout.splitlines():
                on_line(line)
        return code, stdout, stderr

    run.calls = calls
    return run


def test_probe_returns_title_duration_and_thumbnail(monkeypatch):
    payload = json.dumps({
        "title": "How to make sourdough bread",
        "duration": 1392,
        "thumbnail": "https://i.ytimg.com/vi/abc/hq.jpg",
        "extractor_key": "Youtube",
    })
    run = _fake_run(stdout=payload)
    monkeypatch.setattr(source_fetch, "_run", run)

    got = source_fetch.probe("https://youtu.be/abc")

    assert got["title"] == "How to make sourdough bread"
    assert got["duration_sec"] == 1392
    assert got["thumbnail_url"] == "https://i.ytimg.com/vi/abc/hq.jpg"
    assert got["site"] == "Youtube"


def test_probe_never_downloads(monkeypatch):
    run = _fake_run(stdout=json.dumps({"title": "x"}))
    monkeypatch.setattr(source_fetch, "_run", run)
    source_fetch.probe("https://youtu.be/abc")
    args = run.calls[0]
    assert "--skip-download" in args
    assert "--no-playlist" in args


def test_probe_raises_classified_error(monkeypatch):
    monkeypatch.setattr(source_fetch, "_run", _fake_run(
        code=1, stderr="ERROR: [youtube] abc: Sign in to confirm your age"))
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.probe("https://youtu.be/abc")
    assert e.value.reason == "login"


def test_probe_raises_when_output_is_not_json(monkeypatch):
    monkeypatch.setattr(source_fetch, "_run", _fake_run(stdout="not json at all"))
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.probe("https://youtu.be/abc")
    assert e.value.reason == "unknown"


# ---------------------------------------------------------------- fetch


class _Sequence:
    """A _run stand-in that returns a different result per call."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, args, on_line=None, cancel_check=None, timeout=None):
        self.calls.append(args)
        code, stdout, stderr = self.results.pop(0)
        if on_line:
            for line in stdout.splitlines():
                on_line(line)
        return code, stdout, stderr


def _count_upgrades(monkeypatch):
    box = {"n": 0}
    monkeypatch.setattr(source_fetch, "_upgrade", lambda: box.__setitem__("n", box["n"] + 1))
    return box


def test_fetch_succeeds_without_upgrading(monkeypatch, tmp_path):
    upgrades = _count_upgrades(monkeypatch)
    monkeypatch.setattr(source_fetch, "_run", _Sequence((0, "[download] 100%", "")))
    source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"))
    assert upgrades["n"] == 0


def test_fetch_upgrades_once_then_succeeds(monkeypatch, tmp_path):
    upgrades = _count_upgrades(monkeypatch)
    seq = _Sequence(
        (1, "", "ERROR: [youtube] abc: Requested format is not available"),
        (0, "[download] 100%", ""),
    )
    monkeypatch.setattr(source_fetch, "_run", seq)
    lines = []
    source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"), log=lines.append)
    assert upgrades["n"] == 1
    assert len(seq.calls) == 2
    assert any("Updating the downloader" in x for x in lines)


def test_fetch_upgrades_at_most_once(monkeypatch, tmp_path):
    upgrades = _count_upgrades(monkeypatch)
    seq = _Sequence(
        (1, "", "ERROR: boom"),
        (1, "", "ERROR: [youtube] abc: This video is not available in your country"),
    )
    monkeypatch.setattr(source_fetch, "_run", seq)
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"))
    assert upgrades["n"] == 1
    assert len(seq.calls) == 2
    assert e.value.reason == "geo"  # the SECOND attempt's reason is what the user sees


def test_fetch_skips_the_upgrade_on_network_errors(monkeypatch, tmp_path):
    upgrades = _count_upgrades(monkeypatch)
    seq = _Sequence((1, "", "ERROR: unable to download webpage"))
    monkeypatch.setattr(source_fetch, "_run", seq)
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"))
    assert upgrades["n"] == 0
    assert len(seq.calls) == 1
    assert e.value.reason == "network"


def test_fetch_reports_percentage_as_stage_zero(monkeypatch, tmp_path):
    monkeypatch.setattr(source_fetch, "_run", _Sequence(
        (0, "[download]   0.0% of 40MiB\n[download]  45.3% of 40MiB\n", "")))
    lines = []
    source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"), log=lines.append)
    # "0/6 …" keeps ui/src/dubApi.mjs:232 at stage 0, so no stage dot lights up
    # and the message is shown verbatim. See the spec's "Flow" section.
    assert any(x.startswith("0/6 ") and "45" in x for x in lines)
