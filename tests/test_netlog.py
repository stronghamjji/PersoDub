"""app/netlog.py: the words every download and upload is written down in --
the desktop shell's own -- and where they go: the job's file when the
transfer is a job's, the app log always."""
import logging
import re
import time

import pytest

from app import netlog, perso_client, source_fetch
from app.jobs import JobStore
from app.report_mask import mask_text


# Cut where the shell's sizeText cuts (desktop/src/logLine.js), so one file
# reads the same in shell.log and persodub.log.
@pytest.mark.parametrize("n,text", [
    (0, "0 B"), (358, "358 B"), (1000, "1000 B"), (2100, "2.1 kB"), (10_000, "10.0 kB"), (94_600, "94 kB"),
    (1_000_000, "1000 kB"), (17_200_000, "17.2 MB"), (1_300_000_000, "1.3 GB"),
])
def test_sizes_read_in_decimal_units_as_the_shell_writes_them(n, text):
    assert netlog.size_text(n) == text


def test_a_link_keeps_its_address_and_loses_its_query():
    # A signed storage link carries its token in the query.
    signed = "https://perso.blob.core.windows.net/media/input.mp4?sv=2024&sig=SECRET"
    assert netlog.no_query(signed) == "https://perso.blob.core.windows.net/media/input.mp4?…"
    assert netlog.no_query("from https://youtu.be/abc to /w/a?b.mp4") == "from https://youtu.be/abc to /w/a?b.mp4"
    assert netlog.start("perso media", "/w/input.mp4", signed, note="(94 kB)", word="UPLOAD") == (
        "UPLOAD START perso media from /w/input.mp4 to https://perso.blob.core.windows.net/media/input.mp4?… (94 kB)")
    assert "SECRET" not in netlog.file_line("x", "a", signed)
    assert "SECRET" not in netlog.failed("x", 1.0, "ConnectError: refused for url " + signed, signed)


def test_a_links_user_and_password_go_as_the_shell_cuts_them():
    # desktop/src/logLine.js urlText: "https://…@host".
    assert netlog.no_query("from https://me:s3cret@mirror.example/simple?token=1 or http://me@h:8080/x") == (
        "from https://…@mirror.example/simple?… or http://…@h:8080/x")
    # An @ further along a link is its path's, not a user's.
    assert netlog.no_query("https://www.youtube.com/@channel/videos") == "https://www.youtube.com/@channel/videos"
    mirror = "https://me:s3cret@mirror.example:8443/simple"
    assert netlog.host_of(mirror) == "mirror.example:8443"
    assert netlog.start("pip yt-dlp", mirror, "/v") == "DOWNLOAD START pip yt-dlp from https://…@mirror.example:8443/simple to /v"
    assert "s3cret" not in netlog.failed("pip yt-dlp", 1.0, "pip exited 1: " + mirror, mirror)
    assert "s3cret" not in netlog.connected("pip yt-dlp", 401, mirror)
    # A job's failure lines describe errors with the same function (app/jobs.py).
    assert netlog.described(RuntimeError("GET " + mirror + "?k=1 failed")) == (
        "RuntimeError: GET https://…@mirror.example:8443/simple?… failed")


def test_each_line_has_its_shape():
    assert netlog.start("video", "https://youtu.be/abc", "/w/input.mp4", note="via yt-dlp 2026.8.19") == (
        "DOWNLOAD START video from https://youtu.be/abc to /w/input.mp4 via yt-dlp 2026.8.19")
    assert netlog.connected("perso dubbing", 200, "https://portal-media.perso.ai/a.mp4", 17_200_000) == (
        "DOWNLOAD CONNECTED perso dubbing: HTTP 200 from portal-media.perso.ai, 17.2 MB")
    assert netlog.connected("ollama gemma3:12b", 200, "http://127.0.0.1:11434") == (
        "DOWNLOAD CONNECTED ollama gemma3:12b: HTTP 200 from 127.0.0.1:11434, size unknown")
    assert netlog.file_line("hf r/x@abc1234", "config.json", "https://huggingface.co/r/x/resolve/abc/config.json",
                            2100) == ("DOWNLOAD FILE hf r/x@abc1234: config.json 2.1 kB "
                                      "from https://huggingface.co/r/x/resolve/abc/config.json")
    assert netlog.retry("perso dubbing", 2, 3, 2, "RemoteProtocolError: peer\nclosed") == (
        "DOWNLOAD RETRY perso dubbing (2/3) after 2.0s: RemoteProtocolError: peer closed")
    assert netlog.failed("video", 3.14, "FetchError: Check your internet connection.", "https://youtu.be/abc") == (
        "DOWNLOAD FAILED video after 3.1s: FetchError: Check your internet connection. (youtu.be)")
    assert netlog.cancelled("hf r/x@abc1234", 42.0) == "DOWNLOAD CANCELLED hf r/x@abc1234 after 42.0s"
    assert netlog.cancelled("perso media", 1.0, word="UPLOAD") == "UPLOAD CANCELLED perso media after 1.0s"


def test_done_says_how_much_how_fast_and_what_checked_it():
    assert netlog.done("perso dubbing", 5.0, 17_200_000) == (
        "DOWNLOAD DONE perso dubbing: 17.2 MB in 5.0s (3.4 MB/s), not checked")
    # A resumed download: the speed is of what came this time, not of all it holds.
    assert netlog.done("hf r/x@abc1234", 10.0, 4_500_000_000, "size checked by hf", files=12,
                       fetched=1_000_000_000) == (
        "DOWNLOAD DONE hf r/x@abc1234: 12 files, 4.5 GB in 10.0s (100.0 MB/s), size checked by hf")
    # Nothing came, every layer was here already: the shell's own words for it.
    assert netlog.done("ollama gemma3:12b", 2.0, 358, "sha256 checked by ollama", files=1, fetched=0) == (
        "DOWNLOAD DONE ollama gemma3:12b: 1 file, 358 B in 2.0s (already on disk), sha256 checked by ollama")
    assert netlog.done("pip yt-dlp", 8.1, "2026.8.19 -> 2026.10.1", "sha256 checked by pip") == (
        "DOWNLOAD DONE pip yt-dlp: 2026.8.19 -> 2026.10.1 in 8.1s, sha256 checked by pip")
    assert netlog.done("video", 0.0, None) == "DOWNLOAD DONE video: size unknown in 0.0s, not checked"
    assert netlog.done("perso media", 0.5, 2_000_000, word="UPLOAD") == (
        "UPLOAD DONE perso media: 2.0 MB in 0.5s (4.0 MB/s), not checked")


def test_a_line_goes_through_the_jobs_trace_when_there_is_one_else_into_the_app_log(caplog):
    traced = []
    logger = logging.getLogger("persodub.test_netlog")
    with caplog.at_level(logging.INFO, logger="persodub.test_netlog"):
        netlog.say(lambda line, level="INFO": traced.append((level, line)), logger, "DOWNLOAD START a from b",
                   "WARNING")
        netlog.say(None, logger, "DOWNLOAD FAILED a after 1.0s: X (b)", "ERROR")
    assert traced == [("WARNING", "DOWNLOAD START a from b")]
    assert [(r.levelname, r.getMessage()) for r in caplog.records] == [
        ("ERROR", "DOWNLOAD FAILED a after 1.0s: X (b)")]


def test_a_failure_report_keeps_a_links_site_and_none_of_the_users_path():
    # Lines carry the whole link and path; app/report_mask.py cuts both
    # before a report leaves the computer.
    home, kit = "/Users/someone", "/Users/someone/PersoDub/kit"
    line = netlog.start("video", "https://youtu.be/dQw4w9WgXcQ", kit + "/workspace/2026-10-16/my wedding/input.mp4",
                        note="via yt-dlp 2026.8.19")
    assert mask_text(line, home, kit) == ("DOWNLOAD START video from https://youtu.be/... "
                                          "to ~/PersoDub/kit/workspace/2026-10-16/*/input.mp4 via yt-dlp 2026.8.19")
    line = netlog.start("perso media", "/Users/someone/Desktop/Q3 board review.mp4",
                        "https://perso.blob.core.windows.net/media/Q3%20board%20review.mp4?sig=SECRET",
                        note="(94 kB)", word="UPLOAD")
    assert mask_text(line, home, kit) == (
        "UPLOAD START perso media from ~/…/*.mp4 to https://perso.blob.core.windows.net/... (94 kB)")


_STAMPED = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - job-\w+ - (\w+) - (.*)$")


def test_a_jobs_file_holds_its_downloads_and_its_screen_does_not(tmp_path, monkeypatch, caplog):
    def yt_dlp(args, on_line=None, cancel_check=None, timeout=None):
        on_line("[info] abc: Downloading 1 format(s): 18")
        on_line("[download] 100.0% of 1.00MiB")
        with open(args[args.index("-o") + 1], "wb") as f:
            f.write(b"v" * 1000)
        return 0, "", ""

    class Answer:
        status_code = 200
        content = b"DUB-BYTES"

        def raise_for_status(self):
            pass

    monkeypatch.setattr(source_fetch, "_run", yt_dlp)
    monkeypatch.setattr(source_fetch, "_ytdlp_version", lambda: "2026.8.19")
    monkeypatch.setattr(perso_client, "MEDIA_HOST", "https://media.example.com")
    monkeypatch.setattr(perso_client.httpx, "get", lambda url, **kw: Answer())
    video, dubbed = str(tmp_path / "input.mp4"), str(tmp_path / "dubbed.mp4")

    def work(log):
        source_fetch.fetch("https://youtu.be/abc", video, log=log)
        pc = perso_client.PersoClient(api_key="dummy", space_seq=9)
        pc.trace = log.trace   # as app/dub_launch.py and app/pipeline.py hand it over
        pc.download_media("/perso-storage/dubbed.mp4?sig=SECRET", dubbed, what="perso dubbing")

    store = JobStore(log_dir=str(tmp_path))
    with caplog.at_level(logging.INFO, logger="persodub"):
        jid = store.run_async(work)
        for _ in range(200):
            if store.get(jid)["status"] != "running":
                break
            time.sleep(0.02)
    assert store.get(jid)["status"] == "done"
    # The app log has each line once, from the job's trace: "job-<id>: DOWNLOAD ...".
    told = [(r.name, r.getMessage()) for r in caplog.records if "DOWNLOAD " in r.getMessage()]
    assert len(told) == 6 and all(name == "persodub.jobs" and msg.startswith(f"job-{jid}: DOWNLOAD ")
                                  for name, msg in told)
    lines = [m.groups() for m in map(_STAMPED.match, (tmp_path / f"job-{jid}.log").read_text(
        encoding="utf-8").splitlines()) if m and "DOWNLOAD " in m.group(2)]
    shapes = [(level, re.sub(r"in \d+\.\ds( \([^)]*\))?", "in Ns", msg)) for level, msg in lines]
    assert shapes == [
        ("INFO", f"DOWNLOAD START video from https://youtu.be/abc to {video} via yt-dlp 2026.8.19"),
        ("INFO", "DOWNLOAD FILE video: format 18 from https://youtu.be/abc"),
        ("INFO", "DOWNLOAD DONE video: 1000 B in Ns, not checked"),
        ("INFO", f"DOWNLOAD START perso dubbing from https://media.example.com/perso-storage/dubbed.mp4?… to {dubbed}"),
        ("INFO", "DOWNLOAD CONNECTED perso dubbing: HTTP 200 from media.example.com, 9 B"),
        ("INFO", "DOWNLOAD DONE perso dubbing: 9 B in Ns, not checked"),
    ]
    assert store.get(jid)["logs"] == ["0/6 Fetching video… 100%"]
