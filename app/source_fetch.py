"""URL -> a video file on disk. Knows nothing about dubbing.

yt-dlp runs as a subprocess (never imported) for one specific reason: when a
fetch fails and we reinstall a newer yt-dlp, the very next attempt has to use
it. An in-process import would keep the already-loaded old module alive until
the app restarts, which is exactly the failure this module exists to recover
from. Shelling out to a heavy tool also matches how app/stt_local.py and
app/qwen_scoring.py already work.
"""
import importlib.metadata
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from typing import Callable, List, Optional, Tuple
from urllib.parse import urlparse

from app import netlog
from app.i18n import t
from app.jobs import JobCancelled

# The "0/6" prefix only, from the leaf module that owns the stage table --
# never from app/pipeline.py, which would make "download a video" import the
# whole orchestrator (TTS engine, diarizer, Qwen pipeline) for one string.
from app.stages import pre_stage_marker

logger = logging.getLogger("persodub.source_fetch")

YTDLP_BASE = [sys.executable, "-m", "yt_dlp", "--no-playlist"]
FETCH_TIMEOUT = 1800


class FetchError(RuntimeError):
    """A fetch that failed for a reason we can explain to a person.

    reason is the machine-readable key ("login", "network", ...); message is
    the sentence shown in the UI; detail carries a stderr excerpt for the log.
    """

    def __init__(self, reason: str, message: str, detail: str = ""):
        self.reason = reason
        self.message = message
        self.detail = detail
        super().__init__(message)

    @property
    def shown(self) -> str:
        """The message in the user's language, for an answer the page shows.
        The message itself stays in English: a dub that fetches its own link
        fails with it, and the desktop app sorts failures by their words."""
        return {
            "network": t("Check your internet connection."),
            "login": t("This video needs a sign-in, so it can't be fetched."),
            "geo": t("This video isn't available in your region."),
            "gone": t("This video is private or has been deleted."),
            "unsupported": t("This site isn't supported yet."),
        }.get(self.reason, t("Could not fetch the video from this link. "
                             "Paste it again in a moment, or drag the video file in."))


# Ordered: the first group whose needle appears in stderr wins. "network" is
# first on purpose -- see test_classify_prefers_network_over_everything.
_PATTERNS: List[Tuple[str, Tuple[str, ...], str]] = [
    ("network", (
        "unable to download webpage", "nodename nor servname", "getaddrinfo",
        "temporary failure in name resolution", "network is unreachable",
        "connection refused", "connection reset", "timed out",
    ), "Check your internet connection."),
    ("login", (
        "sign in to confirm", "sign in if you", "sign in to view", "log in",
        "requires authentication", "members-only", "private video",
        # Instagram wraps three different causes in one sentence
        # ("...not available, rate-limit reached or login required"). Sign-in is
        # the actionable one of the three, so it wins.
        "login required", "rate-limit reached", "18 years old",
        "this video is private",
    ), "This video needs a sign-in, so it can't be fetched."),
    ("geo", (
        "not available in your country", "geo restriction", "geo-restricted",
        "blocked in your country",
    ), "This video isn't available in your region."),
    ("gone", (
        "video unavailable", "video not available", "has been removed",
        "does not exist",
        "account associated with this video has been terminated",
    ), "This video is private or has been deleted."),
    ("unsupported", (
        "unsupported url", "is not a valid url",
    ), "This site isn't supported yet."),
]
_UNKNOWN = ("unknown", "Could not fetch the video from this link. Paste it again in a moment, or drag the video file in.")


def classify(stderr: str) -> Tuple[str, str]:
    """Map yt-dlp's English, technical stderr onto (reason, human sentence)."""
    low = (stderr or "").lower()
    for reason, needles, message in _PATTERNS:
        if any(n in low for n in needles):
            return reason, message
    return _UNKNOWN


def validate_url(url: str) -> None:
    """Accept only web addresses. Without this yt-dlp would happily take
    file:// paths, turning a text box into a local-file reader."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise FetchError("unsupported", "This site isn't supported yet.", url or "")


def _run(
    args: List[str],
    on_line: Optional[Callable[[str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    timeout: int = FETCH_TIMEOUT,
) -> Tuple[int, str, str]:
    """Run args, streaming stdout lines to on_line. Returns (code, out, err).

    The single place this module starts a process -- tests replace exactly this
    function, which is why nothing else in the module calls subprocess.
    """
    # Both ends of this pipe are pinned to UTF-8. Left alone, each end follows
    # the machine's locale -- cp949 on a Korean Windows, UTF-8 on macOS -- and
    # they agree only as long as nothing moves one of them: a PYTHONIOENCODING
    # already in the environment, or a yt-dlp that picks its own encoding, is
    # enough to split them. A split costs the whole fetch, because a byte the
    # reader cannot decode raises UnicodeDecodeError out of the line loop
    # below. Naming the encoding on both ends makes a Korean title behave the
    # same on every machine. errors="replace" is the last resort: a stray
    # undecodable byte should never cost a download.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1, env=env,
    )
    out_lines = []
    try:
        for line in proc.stdout:
            out_lines.append(line)
            if on_line:
                on_line(line.rstrip())
            if cancel_check and cancel_check():
                proc.kill()
                proc.wait(timeout=10)
                raise JobCancelled()
        proc.wait(timeout=timeout)
    except JobCancelled:
        raise
    except subprocess.TimeoutExpired:
        proc.kill()
        raise FetchError("network", "Check your internet connection.", "timed out")
    stderr = proc.stderr.read() if proc.stderr else ""
    return proc.returncode, "".join(out_lines), stderr


PROBE_TIMEOUT = 60


def probe(url: str) -> dict:
    """Read a link's metadata without downloading a byte.

    Cheap enough (seconds) to run the moment a URL is pasted, which is what
    makes the confirm card possible. A link it cannot read gets the one
    upgrade-and-retry a download gets: every pasted link is probed before it
    is fetched, so a stale yt-dlp fails here first, and with no retry here the
    download's own was never reached (Windows test B6, 2026-10-10).
    """
    validate_url(url)
    return _once_more_after_upgrade(lambda: _probe_once(url))


def _probe_once(url: str) -> dict:
    code, out, err = _run(
        YTDLP_BASE + ["--dump-single-json", "--skip-download", url],
        timeout=PROBE_TIMEOUT,
    )
    if code != 0:
        reason, message = classify(err)
        raise FetchError(reason, message, err.strip()[-300:])
    try:
        info = json.loads(out)
    except Exception as e:
        raise FetchError("unknown", _UNKNOWN[1], str(e)[:200]) from e
    duration = info.get("duration")
    return {
        "title": info.get("title") or "Untitled",
        "duration_sec": int(duration) if duration else None,
        "thumbnail_url": info.get("thumbnail"),
        "site": info.get("extractor_key"),
    }


_PERCENT = re.compile(r"\[download\]\s+([\d.]+)%")
# What yt-dlp says it is about to fetch: "[info] <id>: Downloading 1 format(s):
# 137+140". Only the formats are kept -- the id names the video.
_FORMATS = re.compile(r"\[info\] .+?: Downloading \d+ format\(s\): (.+)")
UPGRADE_TIMEOUT = 300
# Where pip looks for the new yt-dlp.
PYPI = "https://pypi.org/simple"
# One install at a time: two into the same venv can leave it half-written, and
# a probe and a download (or two pasted links) can reach the upgrade together.
_UPGRADE_LOCK = threading.Lock()


def _ytdlp_version() -> str:
    """The yt-dlp this process runs, as pip installed it ("2026.8.19")."""
    try:
        return importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def _upgrade(trace=None) -> None:
    """Reinstall yt-dlp at the newest version, into the venv we are running in,
    between DOWNLOAD START and DONE or FAILED lines (app/netlog.py) -- through
    `trace` into the job's file when a dub's fetch asked for it. DONE names
    the version before and after.

    Separate from _run so tests can count upgrades independently of downloads.
    Failure is swallowed by the caller: an upgrade that cannot happen must not
    replace the download error the user actually needs to read.
    """
    with _UPGRADE_LOCK:
        before = _ytdlp_version()
        netlog.say(trace, logger, netlog.start("pip yt-dlp", PYPI, sys.prefix))
        began = time.monotonic()
        try:
            ran = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=UPGRADE_TIMEOUT,
            )
        except Exception as e:
            netlog.say(trace, logger, netlog.failed("pip yt-dlp", time.monotonic() - began,
                                                    netlog.described(e), PYPI), "ERROR")
            raise
        if ran.returncode:
            # pip's own error, not the notice about a newer pip it can print last.
            said = (ran.stderr or ran.stdout or "").strip().splitlines()
            why = next((s for s in reversed(said) if s.startswith("ERROR")), said[-1] if said else "")
            netlog.say(trace, logger, netlog.failed("pip yt-dlp", time.monotonic() - began,
                                                    f"pip exited {ran.returncode}: {why}", PYPI), "ERROR")
        else:
            netlog.say(trace, logger, netlog.done("pip yt-dlp", time.monotonic() - began,
                                                  f"{before} -> {_ytdlp_version()}", "sha256 checked by pip"))


def _once_more_after_upgrade(attempt: Callable, upgrading: Optional[Callable[[], None]] = None, trace=None):
    """attempt(), and once more after upgrading yt-dlp when it failed for any
    reason but the network; upgrading() is told just before the upgrade, and
    the upgrade's lines go through `trace` when given.

    YouTube changes how it serves video every few weeks and yt-dlp ships a fix
    within days; a copy pinned at install time goes stale and the user reads it
    as "the app broke". One upgrade-and-retry turns most of those into a delay
    nobody notices. Exactly one, though -- a loop would strand the user.
    """
    try:
        return attempt()
    except FetchError as first:
        if first.reason == "network":
            # Fetching a new yt-dlp over a dead connection fails too, and costs
            # the user another couple of minutes to learn nothing.
            raise
        # The kind of failure only: yt-dlp's words name the video by its id,
        # and this log goes out with a failure report.
        logger.info("yt-dlp failed (%s); updating it and trying once more", first.reason)
        if upgrading:
            upgrading()
        try:
            _upgrade(trace)
        except Exception:
            raise first
    try:
        result = attempt()
    except FetchError as again:
        logger.info("yt-dlp failed again after the update (%s)", again.reason)
        raise
    logger.info("yt-dlp worked after the update")
    return result


def _download_once(url: str, dest: str, log, cancel_check) -> None:
    """One yt-dlp run, between DOWNLOAD START and DONE, CANCELLED or FAILED
    lines (app/netlog.py) -- into the job's file too when `log` is a job's --
    with a FILE line for the formats yt-dlp says it takes. The FAILED line
    says the kind of failure, never yt-dlp's own words, which name the video
    by its id."""
    trace = getattr(log, "trace", None)
    netlog.say(trace, logger, netlog.start("video", url, dest, note=f"via yt-dlp {_ytdlp_version()}"))
    began = time.monotonic()

    def on_line(line: str) -> None:
        m = _PERCENT.search(line)
        if m and log:
            # "0/N ..." is deliberate: parseProgress only advances on a matching
            # stage number, and STAGE_LABELS has no 0, so this shows the text
            # as-is with no stage dot lit.
            log("%s Fetching video… %s%%" % (pre_stage_marker(), m.group(1).split(".")[0]))
        m = _FORMATS.match(line)
        if m:
            netlog.say(trace, logger, netlog.file_line("video", "format " + m.group(1), url))

    try:
        code, _out, err = _run(
            YTDLP_BASE + [
                "--newline", "--no-warnings",
                # H.264 + AAC when the site has them at the same resolution:
                # Windows' player and many editors can't open AV1 or Opus.
                "-f", "bv*+ba/b", "-S", "lang,res,fps,vcodec:h264,acodec:aac",
                "--merge-output-format", "mp4",
                "-o", dest, url,
            ],
            on_line=on_line,
            cancel_check=cancel_check,
        )
        if code != 0:
            reason, message = classify(err)
            raise FetchError(reason, message, err.strip()[-300:])
    except JobCancelled:
        netlog.say(trace, logger, netlog.cancelled("video", time.monotonic() - began))
        raise
    except Exception as e:
        netlog.say(trace, logger, netlog.failed("video", time.monotonic() - began, netlog.described(e), url),
                   "ERROR")
        raise
    size = os.path.getsize(dest) if os.path.isfile(dest) else None
    netlog.say(trace, logger, netlog.done("video", time.monotonic() - began, size))


def fetch(url: str, dest: str, log=None, cancel_check=None) -> None:
    """Download url to dest. Upgrades yt-dlp and retries once on failure
    (_once_more_after_upgrade)."""
    validate_url(url)

    def upgrading() -> None:
        if log:
            log(f"{pre_stage_marker()} Updating the downloader…")

    _once_more_after_upgrade(lambda: _download_once(url, dest, log, cancel_check), upgrading,
                             getattr(log, "trace", None))
