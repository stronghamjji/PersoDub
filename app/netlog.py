# -*- coding: utf-8 -*-
"""The words a download or an upload is written down in -- the desktop
shell's own (desktop/src/download.js, logLine.js) -- so every file the app
moves says where it came from, that it connected, and that it finished:

  DOWNLOAD START video from https://youtu.be/x to /…/input.mp4 via yt-dlp 2026.8.19
  DOWNLOAD CONNECTED perso dubbing: HTTP 200 from portal-media.perso.ai, 17.2 MB
  DOWNLOAD FILE hf Qwen/x@fd4b254: model.safetensors 3.8 GB from https://huggingface.co/Qwen/x/resolve/…
  DOWNLOAD RETRY perso dubbing (2/3) after 31.2s: RemoteProtocolError: peer closed connection
  DOWNLOAD DONE hf Qwen/x@fd4b254: 12 files, 4.5 GB in 180.2s (25.2 MB/s), size checked by hf
  DOWNLOAD FAILED video after 3.1s: FetchError: Check your internet connection. (youtu.be)
  DOWNLOAD CANCELLED hf Qwen/x@fd4b254 after 42.0s
  UPLOAD START perso media from /…/input.mp4 to https://x.blob.core.windows.net/y/input.mp4?… (17.2 MB)

A tool's own milestones go between them as "DOWNLOAD <what>: <its words>".
A link is written whole but for its query, which can carry a signed token,
and a user:password before its host, which become "?…" and "…@"; a path is
written whole. Before a log leaves this computer both are cut down
(app/report_mask.py): a link to its site, a path under the home folder to
"~/…/*.mp4".

A leaf module, like app/report_mask.py: it imports nothing from the app.
"""
import errno
import logging
import re
from urllib.parse import urlsplit

# How much of one message, answer or output line a failure's lines keep.
CUT = 300
# A URL's query string: "?" after "://host/path", up to a space or a quote. A
# signed storage link (Perso's upload) carries its token there, and httpx puts
# the whole link into its message.
_QUERY = re.compile(r"(://[^\s\"'?]*)\?[^\s\"']*")
# A user and password before a link's host: "https://me:secret@mirror/…". A
# package mirror's address can carry them; the shell's urlText cuts them the
# same way (desktop/src/logLine.js).
_USERINFO = re.compile(r"\b(https?://)[^\s/@?#\"']+@")
# What a DONE line says when nothing compared the file with a checksum.
NOT_CHECKED = "not checked"


def no_query(text: str) -> str:
    """Every URL in `text` kept to its address: "https://x.blob/y?…", and
    a user:password before its host as "…@"."""
    return _QUERY.sub(r"\1?…", _USERINFO.sub(r"\1…@", text))


def described(exc: BaseException) -> str:
    """"RuntimeError: the model refused": the type and what it says, on one
    line and cut short, every link without its query; the type alone when it
    says nothing."""
    try:
        said = " ".join(no_query(str(exc)).split())[:CUT]
    except Exception:   # a __str__ that fails, which Python's own traceback copes with too
        said = ""
    # An OS error's sentence is in the computer's language (Windows said
    # "대상 컴퓨터에서 연결을 거부했으므로…" for 10061); its errno name reads
    # the same everywhere, so it goes on the end: "[ECONNREFUSED]".
    code = errno.errorcode.get(getattr(exc, "errno", None)) if isinstance(exc, OSError) else None
    # Windows names a socket error WSAE...; without the "WSA" it reads as
    # macOS and Linux name it: Windows' WSAECONNREFUSED is their ECONNREFUSED.
    if code and code.startswith("WSAE"):
        code = code[3:]
    if code:
        said = f"{said} [{code}]" if said else f"[{code}]"
    return f"{type(exc).__name__}: {said}" if said else type(exc).__name__


def size_text(n: int) -> str:
    """Bytes in decimal units, cut as the shell's sizeText cuts them: "358 B",
    "1.2 kB", "94 kB", "17.2 MB", "1.3 GB"."""
    if n > 1e9:
        return f"{n / 1e9:.1f} GB"
    if n > 1e6:
        return f"{n / 1e6:.1f} MB"
    if n > 1e4:
        return f"{int(n / 1e3)} kB"
    if n > 1e3:
        return f"{n / 1e3:.1f} kB"
    return f"{n} B"


def host_of(url: str) -> str:
    """The site a link points at, with its port and without any
    user:password: "127.0.0.1:11434"."""
    return urlsplit(url).netloc.rpartition("@")[2]


def say(trace, logger: logging.Logger, line: str, level: str = "INFO") -> None:
    """One line through `trace` -- a job's log.trace (app/jobs.py _launch),
    which writes the job's file and the app log both -- when there is one,
    else into the app log through the module's own logger."""
    if trace:
        trace(line, level=level)
    else:
        logger.log(getattr(logging, level), line)


def _one_line(text: str) -> str:
    return " ".join(no_query(str(text)).split())[:CUT]


def start(what: str, src: str, dest: str = "", note: str = "", word: str = "DOWNLOAD") -> str:
    """"DOWNLOAD START video from <link> to <path> <note>". An upload's `src`
    is the path and its `dest` the link."""
    return no_query(f"{word} START {what} from {src}" + (f" to {dest}" if dest else "")
                    + (f" {note}" if note else ""))


def connected(what: str, status: int, url: str, size=None, word: str = "DOWNLOAD") -> str:
    """"DOWNLOAD CONNECTED perso dubbing: HTTP 200 from <host>, 17.2 MB" --
    "size unknown" when the answer did not say."""
    return (f"{word} CONNECTED {what}: HTTP {status} from {host_of(url)}, "
            + (size_text(size) if size is not None else "size unknown"))


def file_line(what: str, name: str, url: str, size=None) -> str:
    """"DOWNLOAD FILE <what>: config.json 2.1 kB from <link>": one line for
    each file when one download is many."""
    return no_query(f"DOWNLOAD FILE {what}: {name}" + (f" {size_text(size)}" if size is not None else "")
                    + f" from {url}")


def retry(what: str, n: int, total: int, secs: float, reason: str) -> str:
    """"DOWNLOAD RETRY <what> (2/3) after 3.1s: <reason>": try n of all
    `total` is next, `secs` after the START line, as the shell counts them."""
    return f"DOWNLOAD RETRY {what} ({n}/{total}) after {secs:.1f}s: {_one_line(reason)}"


def done(what: str, secs: float, size=None, check: str = NOT_CHECKED, files=None, fetched=None,
         word: str = "DOWNLOAD") -> str:
    """"DOWNLOAD DONE <what>: 12 files, 4.5 GB in 180.2s (25.2 MB/s), not checked".

    `size` is the bytes it holds -- or, where there is no count, the words for
    what changed ("2026.8.19 -> 2026.10.1"), with no speed. The speed is of
    the size, or of `fetched` when given: the bytes that came over the network
    this time, which a resumed download has fewer of, and none at all is
    "(already on disk)", as the shell says it."""
    amount = size if isinstance(size, str) else ("size unknown" if size is None else size_text(size))
    if files is not None:
        amount = f"{files} file{'' if files == 1 else 's'}, {amount}"
    moved = size if fetched is None else fetched
    if not isinstance(moved, int):
        speed = ""
    elif fetched == 0:
        speed = " (already on disk)"
    else:
        speed = f" ({moved / 1e6 / max(secs, 0.001):.1f} MB/s)"
    return f"{word} DONE {what}: {amount} in {secs:.1f}s{speed}, {check}"


def failed(what: str, secs: float, reason: str, url: str, word: str = "DOWNLOAD") -> str:
    """"DOWNLOAD FAILED video after 3.1s: <Type>: <message> (<host>)", for
    the ERROR level. `reason` is described(exc) for an exception."""
    return f"{word} FAILED {what} after {secs:.1f}s: {_one_line(reason)} ({host_of(url)})"


def cancelled(what: str, secs: float, word: str = "DOWNLOAD") -> str:
    """"DOWNLOAD CANCELLED video after 3.1s": a cancel stopped it, which is
    no failure. It closes the START line as DONE or FAILED would."""
    return f"{word} CANCELLED {what} after {secs:.1f}s"
