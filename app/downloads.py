# -*- coding: utf-8 -*-
"""The New project screen's holding area: a link fetched into the workspace
(or a file dropped there), kept while the user plays it and picks a stretch,
then saved where they want or handed to a dub. Nothing here knows about
dubbing -- a saved file is just a file.

One record per download, in memory: the app restarts rarely and a download
that did not finish is not worth resuming (the link is still in the box)."""
import os
import re
import threading
import uuid
from typing import Callable, Dict, Optional

from app.i18n import t
from app.settings_env import current_value

_PERCENT = re.compile(r"(\d+)%")

# The folder the Download dialog's Change picked. The desktop shell writes it
# into kit.env (desktop/src/downloadsIpc.js) and saves a dub's files there
# itself; this is the same folder for the files the app writes.
DOWNLOAD_DIR_KEY = "PERSODUB_DOWNLOAD_DIR"

# What Finder and Explorer refuse in a name, plus the colon macOS shows as
# a slash. Each becomes " - " (or "-" between digits, so "17/17" reads
# "17-17"), never dropped: a title with its punctuation taken out reads wrong.
_BAD = re.compile(r'[\\/:*?"<>|]+')


def save_folder(chosen: str, day: str, project: str) -> str:
    """Where a saved file goes: the folder the caller named, or -- the rule
    every save in the app follows -- Downloads/<day>/<project>. The erased
    video and a saved clip used to land loose in Downloads while the dub's
    exports sat in their day-and-project folder (Windows, 2026-09-10).

    Downloads is the folder picked in the Download dialog instead, while it is
    there; one that is gone (a drive taken out) leaves the files in Downloads."""
    if chosen:
        return os.path.expanduser(chosen)
    picked = current_value(DOWNLOAD_DIR_KEY)
    if picked and os.path.isdir(picked):
        return os.path.join(picked, day, project)
    # expanduser only replaces the "~": a "/" written after it survives, so on
    # Windows this came back as C:\Users\me/Downloads\2026-09-11\clip and the
    # path the app reported was not the path Windows would have written (CI
    # found it, 2026-09-11). Every separator comes from os.path.join now.
    return os.path.join(os.path.expanduser("~"), "Downloads", day, project)


def file_stem(title: str) -> str:
    """A title as a file name: bad characters swapped, runs of space collapsed."""
    def swap(m):
        s, e = m.start(), m.end()
        before = title[s - 1] if s else " "
        after = title[e] if e < len(title) else " "
        return "-" if before.isdigit() and after.isdigit() else " - "
    stem = _BAD.sub(swap, title)
    stem = re.sub(r"\s+", " ", stem).strip(" .")
    return stem or "video"


class Download:
    def __init__(self, did: str, url: str, folder: str):
        self.id = did
        self.url = url
        self.folder = folder
        self.status = "probing"      # probing | downloading | ready | failed
        self.percent = 0
        self.title = ""
        self.duration_sec = 0
        self.thumbnail_url = ""
        self.site = ""
        self.path = ""
        self.error = ""
        self.reason = ""

    def as_dict(self) -> dict:
        return {
            "id": self.id, "url": self.url, "status": self.status,
            "percent": self.percent, "title": self.title,
            "duration_sec": self.duration_sec, "thumbnail_url": self.thumbnail_url,
            "site": self.site, "path": self.path, "error": self.error,
            "reason": self.reason,
        }


class DownloadStore:
    def __init__(self):
        self._items: Dict[str, Download] = {}
        self._lock = threading.Lock()

    def get(self, did: str) -> Optional[Download]:
        with self._lock:
            return self._items.get(did)

    def all(self):
        """Everything being held right now. The Dub Agent lists these beside a
        folder's videos, so a link the user fetched on the screen can be named
        without their knowing where in the workspace it landed."""
        with self._lock:
            return list(self._items.values())

    def add_file(self, root: str, title: str, duration_sec: float, write: Callable[[str], None]) -> Download:
        """A file the user already has (dropped on the screen), held the same
        way a fetched link is, so Save clip and Start dubbing read one record
        whichever way the video arrived. `write(dest)` puts the bytes at dest."""
        did = uuid.uuid4().hex[:8]
        folder = os.path.join(root, "downloads", did)
        os.makedirs(folder, exist_ok=True)
        d = Download(did, "", folder)
        d.title = title or "video"
        d.duration_sec = duration_sec or 0
        dest = os.path.join(folder, "source.mp4")
        write(dest)
        d.path = dest
        d.percent = 100
        d.status = "ready"
        with self._lock:
            self._items[did] = d
        return d

    def hold_again(self, did: str, path: str, title: str, duration_sec: float) -> Download:
        """A file this store held before the app restarted -- the records live in
        memory only, the files stay on disk -- held again under the same id."""
        d = Download(did, "", os.path.dirname(path))
        d.title = title or "video"
        d.duration_sec = duration_sec or 0
        d.path = path
        d.percent = 100
        d.status = "ready"
        with self._lock:
            self._items[did] = d
        return d

    def start(self, url: str, root: str, probe: Callable, fetch: Callable,
              error_type=Exception, measure: Optional[Callable] = None) -> Download:
        """Probe, then fetch, on a thread; the record fills in as it goes.

        measure(path) -> seconds reads the length off the fetched file when the
        site's page did not say it (Instagram reels: yt-dlp's info carries no
        duration, 2026-10-08). Without it the screen opened the project at
        00:00 with an empty timeline."""
        did = uuid.uuid4().hex[:8]
        folder = os.path.join(root, "downloads", did)
        os.makedirs(folder, exist_ok=True)
        d = Download(did, url, folder)
        with self._lock:
            self._items[did] = d

        def on_log(line: str) -> None:
            m = _PERCENT.search(line)
            if m:
                d.percent = min(100, int(m.group(1)))

        def run() -> None:
            try:
                info = probe(url)
                d.title = info.get("title") or "video"
                d.duration_sec = info.get("duration_sec") or 0
                d.thumbnail_url = info.get("thumbnail_url") or ""
                d.site = info.get("site") or ""
                d.status = "downloading"
                dest = os.path.join(folder, "source.mp4")
                fetch(url, dest, log=on_log)
                if not d.duration_sec and measure:
                    d.duration_sec = measure(dest) or 0
                d.path = dest
                d.percent = 100
                d.status = "ready"
            except error_type as e:
                d.reason = getattr(e, "reason", "unknown")
                # `shown`: FetchError's message in the user's language.
                d.error = getattr(e, "shown", None) or str(e) or t(
                    "Could not fetch the video from this link. "
                    "Paste it again in a moment, or drag the video file in.")
                d.status = "failed"
            except Exception:  # noqa: BLE001 -- the record must never hang
                d.reason = "unknown"
                d.error = t("Could not fetch the video from this link. "
                            "Paste it again in a moment, or drag the video file in.")
                d.status = "failed"

        threading.Thread(target=run, daemon=True).start()
        return d
