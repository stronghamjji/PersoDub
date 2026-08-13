"""URL -> a video file on disk. Knows nothing about dubbing.

yt-dlp runs as a subprocess (never imported) for one specific reason: when a
fetch fails and we reinstall a newer yt-dlp, the very next attempt has to use
it. An in-process import would keep the already-loaded old module alive until
the app restarts, which is exactly the failure this module exists to recover
from. Shelling out to a heavy tool also matches how app/stt_local.py and
app/qwen_scoring.py already work.
"""
import json
import os
import re
import subprocess
import sys
from typing import Callable, List, Optional, Tuple
from urllib.parse import urlparse

from app.jobs import JobCancelled

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
_UNKNOWN = ("unknown", "Couldn't fetch the video.")


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
    makes the confirm card possible.
    """
    validate_url(url)
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
UPGRADE_TIMEOUT = 300


def _upgrade() -> None:
    """Reinstall yt-dlp at the newest version, into the venv we are running in.

    Separate from _run so tests can count upgrades independently of downloads.
    Failure is swallowed by the caller: an upgrade that cannot happen must not
    replace the download error the user actually needs to read.
    """
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
        capture_output=True, text=True, timeout=UPGRADE_TIMEOUT,
    )


def _download_once(url: str, dest: str, log, cancel_check) -> None:
    def on_line(line: str) -> None:
        m = _PERCENT.search(line)
        if m and log:
            # "0/6 ..." is deliberate: parseProgress only advances on a matching
            # stage number, and STAGE_LABELS has no 0, so this shows the text
            # as-is with no stage dot lit.
            log("0/6 Fetching video… %s%%" % m.group(1).split(".")[0])

    code, _out, err = _run(
        YTDLP_BASE + [
            "--newline", "--no-warnings",
            "-f", "bv*+ba/b", "--merge-output-format", "mp4",
            "-o", dest, url,
        ],
        on_line=on_line,
        cancel_check=cancel_check,
    )
    if code != 0:
        reason, message = classify(err)
        raise FetchError(reason, message, err.strip()[-300:])


def fetch(url: str, dest: str, log=None, cancel_check=None) -> None:
    """Download url to dest. Upgrades yt-dlp and retries once on failure.

    YouTube changes how it serves video every few weeks and yt-dlp ships a fix
    within days; a copy pinned at install time goes stale and the user reads it
    as "the app broke". One upgrade-and-retry turns most of those into a delay
    nobody notices. Exactly one, though -- a loop would strand the user.
    """
    validate_url(url)
    try:
        _download_once(url, dest, log, cancel_check)
        return
    except FetchError as first:
        if first.reason == "network":
            # Fetching a new yt-dlp over a dead connection fails too, and costs
            # the user another couple of minutes to learn nothing.
            raise
        if log:
            log("0/6 Updating the downloader…")
        try:
            _upgrade()
        except Exception:
            raise first
    _download_once(url, dest, log, cancel_check)
