# -*- coding: utf-8 -*-
"""Taking a person out of a log line, before the line can leave this computer.

The same four rules as the desktop shell's own masker (desktop/src/report.js
maskText), in the same order, because the two halves of one failure report
must not disagree about what a secret is: the shell masks what it collects
(shell.log, the error message), this masks what the backend collects (the
app's rolling log and the failed job's log).

A leaf module on purpose -- it imports nothing from the app -- so the tests can
hold it to a table of inputs and outputs, and so anything that ever needs to
mask text can have it without pulling in a router.
"""
import os
import re

# The two key shapes that really do turn up in a log, plus the catch-all: an
# unbroken run of 32 or more letters and digits is a token, a hash or a session
# id, and none of the three is worth publishing on a public issue.
_OPENAI_KEY = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}")
_GOOGLE_KEY = re.compile(r"\bAIza[A-Za-z0-9_-]{10,}")
_LONG_RUN = re.compile(r"\b[A-Za-z0-9]{32,}\b")
_URL = re.compile(r"\bhttps?://[^\s\"'<>)\]}]+", re.IGNORECASE)
_URL_HOST = re.compile(r"^(https?://)([^/?#]+)", re.IGNORECASE)

REDACTED = "[REDACTED]"
# The tail every report carries in its issue body. The archive behind it holds
# the whole log; this is the part a person reads first.
TAIL_LINES = 200


def _host_only(match: "re.Match") -> str:
    """A URL reduced to scheme and host. A download link can carry a signed
    token and a video link is the user's viewing history -- neither is a fact
    about the failure."""
    m = _URL_HOST.match(match.group(0))
    return "%s%s/..." % (m.group(1), m.group(2)) if m else "[URL]"


def mask_text(text: str, home: str = "") -> str:
    """Every rule, in the order they depend on each other.

    The long-run rule runs LAST: before the home path is replaced it would eat
    the path's own segments and leave a report nobody could read.
    """
    out = text or ""
    out = _URL.sub(_host_only, out)
    out = _OPENAI_KEY.sub(REDACTED, out)
    out = _GOOGLE_KEY.sub(REDACTED, out)
    if home:
        # Both separators and either case: a Windows log prints the home
        # directory one way or the other depending on which library wrote the
        # line, and Windows paths are case-insensitive.
        forms = {home, home.replace("\\", "/"), home.replace("/", "\\")}
        for form in sorted(forms, key=len, reverse=True):
            out = re.sub(re.escape(form), "~", out, flags=re.IGNORECASE)
    return _LONG_RUN.sub(REDACTED, out)


def mask_tail(text: str, home: str = "", max_lines: int = TAIL_LINES) -> str:
    """The last max_lines lines of a log, masked. Empty in, empty out."""
    if not (text or "").strip():
        return ""
    lines = (text or "").splitlines()
    return mask_text("\n".join(lines[-max_lines:]), home).strip()


def read_masked(path: str, home: str = "", max_bytes: int = 8 * 1024 * 1024) -> str:
    """A log file, masked, at most max_bytes of its end. Missing or unreadable
    is an empty string: a report that cannot include a log is still a report,
    and a failure to read one must never become a second failure."""
    try:
        # Binary, because seeking to a byte offset is only meaningful there:
        # a text file's seek takes an opaque position, not a count of bytes.
        with open(path, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()   # drop the half line the seek landed in
            data = f.read()
        return mask_text(data.decode("utf-8", errors="replace"), home)
    except OSError:
        return ""
