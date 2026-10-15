"""app/source_fetch.py: URL guard and yt-dlp error classification.

Nothing here touches the network. source_fetch._run is the only place that
starts a process, and every test that needs a yt-dlp result replaces it.
"""
import json
import logging
import re
import subprocess
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
    upgrades = _count_upgrades(monkeypatch)
    run = _fake_run(code=1, stderr="ERROR: [youtube] abc: Sign in to confirm your age")
    monkeypatch.setattr(source_fetch, "_run", run)
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.probe("https://youtu.be/abc")
    assert e.value.reason == "login"
    assert upgrades["n"] == 1 and len(run.calls) == 2   # tried once more, then gave up


def test_probe_raises_when_output_is_not_json(monkeypatch):
    _count_upgrades(monkeypatch)
    monkeypatch.setattr(source_fetch, "_run", _fake_run(stdout="not json at all"))
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.probe("https://youtu.be/abc")
    assert e.value.reason == "unknown"


# A stale yt-dlp fails at the probe first, and every pasted link is probed
# before it is downloaded: the download's upgrade-and-retry was never reached,
# and a link that a new yt-dlp could read failed on the spot (Windows test B6,
# 2026-10-10). The probe gets the same one retry.
def test_probe_upgrades_once_then_succeeds(monkeypatch):
    upgrades = _count_upgrades(monkeypatch)
    seq = _Sequence(
        (1, "", "ERROR: [youtube] abc: Incomplete YouTube ID abc"),
        (0, json.dumps({"title": "Me at the zoo", "duration": 19}), ""),
    )
    monkeypatch.setattr(source_fetch, "_run", seq)
    got = source_fetch.probe("https://youtu.be/abc")
    assert got["title"] == "Me at the zoo"
    assert upgrades["n"] == 1 and len(seq.calls) == 2


def test_probe_skips_the_upgrade_on_network_errors(monkeypatch):
    upgrades = _count_upgrades(monkeypatch)
    seq = _Sequence((1, "", "ERROR: unable to download webpage"))
    monkeypatch.setattr(source_fetch, "_run", seq)
    with pytest.raises(source_fetch.FetchError) as e:
        source_fetch.probe("https://youtu.be/abc")
    assert e.value.reason == "network"
    assert upgrades["n"] == 0 and len(seq.calls) == 1


# The upgrade-and-retry left nothing in backend.log, so a log could not tell a
# stale yt-dlp from a link no yt-dlp can read (Windows test B6, 2026-10-11).
# Only the kind of failure: yt-dlp's own words name the video by its id, and
# the app log goes out with a failure report (final review, 2026-10-12).
def test_the_upgrade_and_retry_are_written_to_the_log(monkeypatch, caplog):
    _count_upgrades(monkeypatch)
    seq = _Sequence(
        (1, "", "ERROR: [youtube] abc: Incomplete YouTube ID abc"),
        (1, "", "ERROR: [youtube] abc: Video unavailable"),
    )
    monkeypatch.setattr(source_fetch, "_run", seq)
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"), pytest.raises(source_fetch.FetchError):
        source_fetch.probe("https://youtu.be/abc")
    assert "yt-dlp failed (unknown); updating it and trying once more" in caplog.text
    assert "yt-dlp failed again after the update (gone)" in caplog.text
    assert "abc" not in caplog.text, "the video's id stays out of the log"


def test_a_retry_that_works_is_written_to_the_log(monkeypatch, caplog):
    _count_upgrades(monkeypatch)
    seq = _Sequence(
        (1, "", "ERROR: [youtube] abc: Incomplete YouTube ID abc"),
        (0, json.dumps({"title": "Me at the zoo"}), ""),
    )
    monkeypatch.setattr(source_fetch, "_run", seq)
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"):
        source_fetch.probe("https://youtu.be/abc")
    assert "worked after the update" in caplog.text


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
    monkeypatch.setattr(source_fetch, "_upgrade", lambda trace=None: box.__setitem__("n", box["n"] + 1))
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


# Two installs into one venv at once can leave it half-written, and now a probe
# and a download (or two pasted links) can both reach the upgrade together.
def test_upgrades_never_run_two_at_once(monkeypatch):
    import threading
    import time
    busy = {"now": 0, "most": 0}
    lock = threading.Lock()

    def slow_pip(args, **kwargs):
        with lock:
            busy["now"] += 1
            busy["most"] = max(busy["most"], busy["now"])
        time.sleep(0.05)
        with lock:
            busy["now"] -= 1
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(source_fetch.subprocess, "run", slow_pip)
    threads = [threading.Thread(target=source_fetch._upgrade) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert busy["most"] == 1


def test_fetch_reports_percentage_as_stage_zero(monkeypatch, tmp_path):
    monkeypatch.setattr(source_fetch, "_run", _Sequence(
        (0, "[download]   0.0% of 40MiB\n[download]  45.3% of 40MiB\n", "")))
    lines = []
    source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"), log=lines.append)
    # "0/6 …" keeps ui/src/dubApi.mjs:232 at stage 0, so no stage dot lights up
    # and the message is shown verbatim. See the spec's "Flow" section.
    assert any(x.startswith("0/6 ") and "45" in x for x in lines)


# ---------------------------------------------------------------- the log lines
# Where a video came from, where it went, which yt-dlp fetched it and what it
# took (app/netlog.py) -- never yt-dlp's own words, which name the video by its id.

def _fetch_lines(caplog):
    return [(r.levelname, r.getMessage()) for r in caplog.records
            if r.name == "persodub.source_fetch" and r.getMessage().startswith("DOWNLOAD ")]


def test_a_fetch_says_where_from_where_to_with_which_yt_dlp_and_what_it_took(monkeypatch, tmp_path, caplog):
    dest = tmp_path / "input.mp4"

    def run(args, on_line=None, cancel_check=None, timeout=None):
        for line in ("[youtube] dQw4w9WgXcQ: Downloading webpage",
                     "[info] dQw4w9WgXcQ: Downloading 1 format(s): 137+140",
                     "[download]  45.3% of 40MiB"):
            on_line(line)
        dest.write_bytes(b"v" * 17_200_000)
        return 0, "", ""

    monkeypatch.setattr(source_fetch, "_run", run)
    monkeypatch.setattr(source_fetch, "_ytdlp_version", lambda: "2026.8.19")
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"):
        source_fetch.fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3", str(dest))
    lines = [msg for _level, msg in _fetch_lines(caplog)]
    assert lines[:2] == [
        f"DOWNLOAD START video from https://www.youtube.com/watch?… to {dest} via yt-dlp 2026.8.19",
        "DOWNLOAD FILE video: format 137+140 from https://www.youtube.com/watch?…",
    ]
    assert re.fullmatch(r"DOWNLOAD DONE video: 17\.2 MB in \d+\.\ds( \(.+/s\))?, not checked", lines[2])
    assert len(lines) == 3
    assert not any("dQw4w9WgXcQ" in line for line in lines)


def test_a_fetch_that_fails_says_why_in_the_apps_words(monkeypatch, tmp_path, caplog):
    _count_upgrades(monkeypatch)
    monkeypatch.setattr(source_fetch, "_run", _Sequence(
        (1, "", "ERROR: [youtube] dQw4w9WgXcQ: unable to download webpage")))
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"), pytest.raises(source_fetch.FetchError):
        source_fetch.fetch("https://youtu.be/dQw4w9WgXcQ", str(tmp_path / "input.mp4"))
    level, msg = _fetch_lines(caplog)[-1]
    assert level == "ERROR"
    assert re.fullmatch(r"DOWNLOAD FAILED video after \d+\.\ds: FetchError: Check your internet connection\. "
                        r"\(youtu\.be\)", msg)


def test_a_dubs_fetch_writes_its_lines_and_its_update_into_the_jobs_file(monkeypatch, tmp_path):
    handed = []
    monkeypatch.setattr(source_fetch, "_upgrade", lambda trace=None: handed.append(trace))
    monkeypatch.setattr(source_fetch, "_run", _Sequence(
        (1, "", "ERROR: [youtube] abc: Requested format is not available"), (0, "[download] 100%", "")))
    screen, traced = [], []

    def log(msg):
        screen.append(msg)

    log.trace = lambda msg, level="INFO": traced.append((level, msg))
    source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"), log=log)
    assert handed == [log.trace]
    assert [(level, msg.split(" ")[1]) for level, msg in traced] == [
        ("INFO", "START"), ("ERROR", "FAILED"), ("INFO", "START"), ("INFO", "DONE")]
    assert not any(msg.startswith("DOWNLOAD") for msg in screen)


def test_the_update_says_which_yt_dlp_it_replaced_with_which(monkeypatch, caplog):
    versions = iter(["2026.8.19", "2026.10.1"])
    monkeypatch.setattr(source_fetch, "_ytdlp_version", lambda: next(versions))
    monkeypatch.setattr(source_fetch.subprocess, "run", lambda args, **kw: subprocess.CompletedProcess(args, 0, "", ""))
    traced = []
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"):
        source_fetch._upgrade(lambda msg, level="INFO": traced.append((level, msg)))
    assert traced[0] == ("INFO", f"DOWNLOAD START pip yt-dlp from https://pypi.org/simple to {sys.prefix}")
    assert traced[1][0] == "INFO"
    assert re.fullmatch(r"DOWNLOAD DONE pip yt-dlp: 2026\.8\.19 -> 2026\.10\.1 in \d+\.\ds, sha256 checked by pip",
                        traced[1][1])
    assert len(traced) == 2
    assert _fetch_lines(caplog) == [], "a trace writes the app log itself (app/jobs.py), so not twice"


def test_an_update_pip_refused_says_pips_error_not_its_notice(monkeypatch, caplog):
    monkeypatch.setattr(source_fetch.subprocess, "run", lambda args, **kw: subprocess.CompletedProcess(
        args, 1, "", "ERROR: Could not find a version that satisfies the requirement yt-dlp\n"
                     "[notice] A new release of pip is available: 24.0 -> 25.2"))
    with caplog.at_level(logging.INFO, logger="persodub.source_fetch"):
        source_fetch._upgrade()   # no raise: the caller tries once more with the yt-dlp it has
    level, msg = _fetch_lines(caplog)[-1]
    assert level == "ERROR"
    assert re.fullmatch(r"DOWNLOAD FAILED pip yt-dlp after \d+\.\ds: pip exited 1: ERROR: Could not find a version "
                        r"that satisfies the requirement yt-dlp \(pypi\.org\)", msg)


def test_a_cancelled_fetch_closes_its_start(monkeypatch, tmp_path):
    def cancelled_run(args, on_line=None, cancel_check=None, timeout=None):
        raise source_fetch.JobCancelled()

    upgrades = _count_upgrades(monkeypatch)
    monkeypatch.setattr(source_fetch, "_run", cancelled_run)
    traced = []

    def log(msg):
        pass

    log.trace = lambda msg, level="INFO": traced.append((level, msg))
    with pytest.raises(source_fetch.JobCancelled):
        source_fetch.fetch("https://youtu.be/abc", str(tmp_path / "input.mp4"), log=log, cancel_check=lambda: True)
    assert [level for level, _msg in traced] == ["INFO", "INFO"]
    assert traced[0][1].startswith("DOWNLOAD START video from https://youtu.be/abc to ")
    assert re.fullmatch(r"DOWNLOAD CANCELLED video after \d+\.\ds", traced[1][1])
    assert upgrades["n"] == 0, "a cancel is no reason to update yt-dlp"
