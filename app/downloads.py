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

_PERCENT = re.compile(r"(\d+)%")

# What Finder and Explorer refuse in a name, plus the colon macOS shows as
# a slash. Each becomes " - " (or "-" between digits, so "17/17" reads
# "17-17"), never dropped: a title with its punctuation taken out reads wrong.
_BAD = re.compile(r'[\\/:*?"<>|]+')


def save_folder(chosen: str, day: str, project: str) -> str:
    """Where a saved file goes: the folder the caller named, or -- the rule
    every save in the app follows -- Downloads/<day>/<project>. The erased
    video and a saved clip used to land loose in Downloads while the dub's
    exports sat in their day-and-project folder (Windows, 2026-09-10)."""
    if chosen:
        return os.path.expanduser(chosen)
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

    def start(self, url: str, root: str, probe: Callable, fetch: Callable,
              error_type=Exception) -> Download:
        """Probe, then fetch, on a thread; the record fills in as it goes."""
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
                d.path = dest
                d.percent = 100
                d.status = "ready"
            except error_type as e:
                d.reason = getattr(e, "reason", "unknown")
                d.error = getattr(e, "message", None) or str(e) or "Couldn't fetch the video."
                d.status = "failed"
            except Exception:  # noqa: BLE001 -- the record must never hang
                d.reason = "unknown"
                d.error = "Couldn't fetch the video."
                d.status = "failed"

        threading.Thread(target=run, daemon=True).start()
        return d
