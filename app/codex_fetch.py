"""OpenAI's sign-in program, fetched into PersoDub's own folder.

ChatGPT translation runs through the Codex CLI: it is the one route OpenAI
opens for a ChatGPT account, free plan included. A computer that never had
Codex could not sign in at all -- "Couldn't start" on a tester's Mac
(user, 2026-09-28). So the first Sign In fetches it here, pinned to one
version and checked against npm's own checksum, and app/agents/base.py
finds it in the kit when nothing else is installed.
"""

import base64
import hashlib
import logging
import os
import platform
import shutil
import sys
import tarfile
import threading
from typing import Optional

import requests

log = logging.getLogger("persodub.codex_fetch")

VERSION = "0.157.1"

# (sys.platform, platform.machine()) -> (npm package suffix, folder inside it,
# npm's sha512 for that package). The Mac app is Apple silicon only.
PACKAGES = {
    ("darwin", "arm64"): ("darwin-arm64", "aarch64-apple-darwin",
                          "62/e4TZ34z93KK3FYIHmo/K88aH0JRPA8x7SAVBdK4iG9f9HPO2tsDrJcmOj9z6DrFpMvPEVymomCbYpqN+ylQ=="),
    ("win32", "AMD64"): ("win32-x64", "x86_64-pc-windows-msvc",
                         "vgqs/VRXNwhLYMsZDgYfnRSXpRh5Nm782L8lacGskw86kOxbMaquvQKxkuZHUBrJA2XGcksB7rMUHy1XaCJgrA=="),
}


# How far the fetch has got, for the sign-in window to show while it waits:
# people took a silent minute for a hang (tester's Mac, 2026-09-28).
# stage: "" (idle), "download" or "unpack"; bytes in, and the total when known.
progress = {"stage": "", "got": 0, "total": 0}
# One fetch at a time: Cancel closes the window but the download goes on, and a
# second Sign In waits for it instead of writing the same file twice.
_lock = threading.Lock()


def _kit() -> str:
    # The same folder app/agents/base.py chatgpt_env() keeps the sign-in in.
    return os.environ.get("PERSODUB_KIT_DIR") or os.path.join(os.path.expanduser("~"), ".persodub")


def bin_dir() -> str:
    return os.path.join(_kit(), "codex", "bin")


def package() -> Optional[tuple]:
    """This computer's package, or None where there is none to fetch."""
    return PACKAGES.get((sys.platform, platform.machine()))


def fetch() -> str:
    """Download, check and unpack the sign-in program; return its bin folder.

    Raises RuntimeError with a sentence fit for the screen."""
    pkg = package()
    if pkg is None:
        raise RuntimeError("ChatGPT sign-in is not available on this computer.")
    with _lock:
        exe = os.path.join(bin_dir(), "codex.exe" if sys.platform == "win32" else "codex")
        if os.path.isfile(exe):
            return bin_dir()   # the fetch this one waited for already did it
        return _fetch(pkg)


def _fetch(pkg: tuple) -> str:
    suffix, folder, sha512 = pkg
    root = os.path.join(_kit(), "codex")
    part = root + ".download"
    staging = root + ".unpacking"
    url = f"https://registry.npmjs.org/@openai/codex/-/codex-{VERSION}-{suffix}.tgz"
    os.makedirs(_kit(), exist_ok=True)
    digest = hashlib.sha512()
    progress.update(stage="download", got=0, total=0)
    try:
        with requests.get(url, stream=True, timeout=(15, 60)) as r:
            r.raise_for_status()
            progress["total"] = int(r.headers.get("Content-Length") or 0)
            with open(part, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    progress["got"] += len(chunk)
    except (requests.RequestException, OSError) as e:
        progress["stage"] = ""
        raise RuntimeError("Couldn't download the ChatGPT sign-in. Check your internet and try again.") from e
    progress["stage"] = "unpack"
    try:
        if base64.b64encode(digest.digest()).decode() != sha512:
            raise RuntimeError("The ChatGPT sign-in download was damaged. Try again.")
        shutil.rmtree(staging, ignore_errors=True)
        prefix = f"package/vendor/{folder}/"
        with tarfile.open(part, "r:gz") as tar:
            members = []
            for m in tar.getmembers():
                if not m.name.startswith(prefix) or m.name == prefix:
                    continue
                m.name = m.name[len(prefix):]
                members.append(m)
            tar.extractall(staging, members=members, filter="data")
        shutil.rmtree(root, ignore_errors=True)
        os.replace(staging, root)
    except OSError as e:
        raise RuntimeError("Couldn't set up the ChatGPT sign-in. Check free space and try again.") from e
    finally:
        progress["stage"] = ""
        for leftover in (part, staging):
            if os.path.isdir(leftover):
                shutil.rmtree(leftover, ignore_errors=True)
            elif os.path.exists(leftover):
                os.remove(leftover)
    return bin_dir()


def prefetch() -> None:
    """At launch, fetch ahead on a computer that will need it: ChatGPT is the
    translator and no sign-in program is here. By the time Sign In is pressed
    it is usually done, and the window goes straight to the browser (user,
    2026-09-28). A press while it is still running waits on the same lock and
    shows its progress; a failure here is simply tried again by Sign In."""
    from app import setup
    from app.agents import base
    if package() is None or base.find_cli("codex") or setup.default_for("translator") != "chatgpt":
        return

    def run():
        try:
            fetch()
            log.info("ChatGPT sign-in program fetched ahead of Sign In")
        except Exception as e:   # Sign In tries again, and says why if it fails too
            log.info("Fetching the ChatGPT sign-in program ahead failed (%s)", type(e).__name__)

    threading.Thread(target=run, daemon=True, name="codex-prefetch").start()
