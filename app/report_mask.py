# -*- coding: utf-8 -*-
"""Taking a person out of a log line, before the line can leave this computer.

The same five rules as the desktop shell's own masker (desktop/src/report.js
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

# The four key shapes that really do turn up in a log.
_KEYS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),      # OpenAI-style
    re.compile(r"\bAIza[A-Za-z0-9_-]{10,}"),    # Google API keys
    re.compile(r"\bghp_[A-Za-z0-9_-]{8,}"),     # GitHub personal access tokens
    re.compile(r"\bhf_[A-Za-z0-9_-]{8,}"),      # Hugging Face tokens
)

# Anything else long enough to be a secret -- but only OUTSIDE a path. The
# guards on either side are the path characters: a run touching a slash, a
# backslash or a dot is part of a filename or a directory, and redacting those
# used to swallow whole model folders and leave a report nobody could read.
_LONG_TOKEN = re.compile(r"(?<![A-Za-z0-9_\-/\\.])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/\\.])")

_URL = re.compile(r"\bhttps?://[^\s\"'<>)\]}]+", re.IGNORECASE)
_URL_HOST = re.compile(r"^(https?://)([^/?#]+)", re.IGNORECASE)

# What follows a home directory, up to the first space: the folders and the
# file name, all of which belong to the user rather than to the failure.
_UNDER_HOME = r"((?:[\\/][^\\/\s\"']+)*)"
# A file name with spaces in it survives that, because a path stops at
# whitespace -- and it has to, or "could not open /Users/x/kit because the disk
# is full" would swallow the sentence. What gives such a name away is that it
# ends in an extension, so this second pass folds "~/... Q3 board review.mp4"
# into "~/.../*.mp4" and leaves prose alone.
_SPACED_FILENAME = re.compile(r"(~[\\/]…)((?: [^\s\\/\"']+)*\.[A-Za-z0-9]{1,8})(?=[\s\"']|$)")
_EXTENSION = re.compile(r"^[A-Za-z0-9]{1,8}$")

REDACTED = "[REDACTED]"
ELLIPSIS = "…"
# The tail every report carries in its issue body. The archive behind it holds
# the whole log; this is the part a person reads first.
TAIL_LINES = 200


def _host_only(match: "re.Match") -> str:
    """A URL reduced to scheme and host. A download link can carry a signed
    token and a video link is the user's viewing history -- neither is a fact
    about the failure."""
    m = _URL_HOST.match(match.group(0))
    return "%s%s/..." % (m.group(1), m.group(2)) if m else "[URL]"


def _separator_forms(path: str):
    """The same path written the three ways a log can spell it. Windows
    libraries disagree with each other about the separator inside one process."""
    return [path, path.replace("\\", "/"), path.replace("/", "\\")]


def _collapse_under_home(rest: str) -> str:
    """What is left of a path once its home half is gone: only the extension.

    The folders and the file name under a home directory are the user's own
    business -- a client, a project, what they were watching."""
    if not rest:
        return "~"
    sep = rest[0]
    segments = [s for s in re.split(r"[\\/]", rest) if s]
    last = segments[-1] if segments else ""
    dot = last.rfind(".")
    ext = last[dot:] if dot > 0 and _EXTENSION.match(last[dot + 1:]) else ""
    return "~%s%s%s*%s" % (sep, ELLIPSIS, sep, ext) if ext else "~%s%s" % (sep, ELLIPSIS)


def mask_text(text: str, home: str = "", kit: str = "") -> str:
    """Every rule, in the order they depend on each other.

    1. A URL becomes its own scheme and host.
    2. The kit's own path keeps everything but the user's name. Which model,
       which venv, which folder a step died in is the diagnosis itself, so this
       runs first and takes those paths out of rule 3's way.
    3. Every other path under the home directory collapses to "~/.../*.ext".
    4. The four key shapes go.
    5. What is left that is 32+ token characters, and is not part of a path, is
       redacted.

    The paths are settled before the keys on purpose: done the other way round,
    rule 5 ate the path segments rules 2 and 3 exist to keep readable.
    """
    out = text or ""
    out = _URL.sub(_host_only, out)
    if kit:
        # Both lists are built by the same transformation, so a kit path
        # spelled with one separator is replaced by a mask spelled with that
        # one. A lambda, not a replacement string: a Windows mask is full of
        # backslashes, which re.sub would read as escapes.
        forms = _separator_forms(kit)
        under_home = bool(home) and kit[:len(home)].lower() == home.lower()
        masks = _separator_forms("~" + kit[len(home):]) if under_home else forms
        for form, mask in zip(forms, masks):
            out = re.sub(re.escape(form), lambda _m, r=mask: r, out, flags=re.IGNORECASE)
    if home:
        for form in dict.fromkeys(_separator_forms(home)):
            out = re.sub(re.escape(form) + _UNDER_HOME,
                         lambda m: _collapse_under_home(m.group(1)),
                         out, flags=re.IGNORECASE)
        out = _SPACED_FILENAME.sub(
            lambda m: "%s%s*%s" % (m.group(1), m.group(1)[1], m.group(2)[m.group(2).rfind("."):]),
            out)
    for pattern in _KEYS:
        out = pattern.sub(REDACTED, out)
    return _LONG_TOKEN.sub(REDACTED, out)


def mask_tail(text: str, home: str = "", kit: str = "", max_lines: int = TAIL_LINES) -> str:
    """The last max_lines lines of a log, masked. Empty in, empty out."""
    if not (text or "").strip():
        return ""
    lines = (text or "").splitlines()
    return mask_text("\n".join(lines[-max_lines:]), home, kit).strip()


def read_masked(path: str, home: str = "", kit: str = "", max_bytes: int = 8 * 1024 * 1024) -> str:
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
        return mask_text(data.decode("utf-8", errors="replace"), home, kit)
    except OSError:
        return ""
