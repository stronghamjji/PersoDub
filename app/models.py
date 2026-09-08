"""Model catalog and download-state detection.

One catalog file (models_catalog.json) is the single place model names,
sources, sizes and completion markers live -- the installer, the boot check,
this server and the screen all agree because they all read it.

States (the words the screen shows, App Store style):
  ready          every marker file exists
  paused         the model's directory exists but markers are missing
                 (a download died halfway -- the screen offers Resume)
  not_downloaded the directory does not exist (never fetched, or removed)

This distinction is what keeps the 2026-08-14 "install died halfway = broken
forever" bug from coming back: half-downloaded is a visible, resumable state,
never silently "done" and never a dead end.
"""
import contextlib
import json
import logging
import os
import shutil

log = logging.getLogger("persodub.models")

CATALOG_PATH = os.path.join(os.path.dirname(__file__), "models_catalog.json")

# Served when the catalog file is unreadable: never crash the server over a
# broken JSON -- dubbing with API engines must keep working. Only the
# always-installed entries, which the install itself guarantees.
_ALWAYS_FALLBACK = [
    {"id": "demucs", "role": "always", "name": "Sound separation", "bytes": 81000000,
     "source": {"kind": "hf", "repo": "adefossez/HTDemucs",
                "rev": "bf35a81b663819a8255c8fefee17f9d812b786b5",
                "files": ["htdemucs.yaml", "955717e8.safetensors"]},
     "dir": "models/demucs/HTDemucs", "markers": ["955717e8.safetensors"]},
]

_REQUIRED_FIELDS = ("id", "role", "name", "bytes", "dir", "markers", "source")


def load_catalog():
    """The model catalog, or the always-installed minimum if the file is bad."""
    try:
        with open(CATALOG_PATH, encoding="utf-8") as f:
            cat = json.load(f)
        if not isinstance(cat, list) or not cat:
            raise ValueError("catalog is not a non-empty list")
        for m in cat:
            for key in _REQUIRED_FIELDS:
                # A pack has no source: the desktop shell installs it, not this
                # process (see PACKS in desktop/src/installSpec.js).
                if key == "source" and m.get("role") == "pack":
                    continue
                if key not in m:
                    raise ValueError(f"entry {m.get('id')!r} lacks {key!r}")
        return cat
    except Exception as e:
        log.warning("models_catalog.json unreadable (%s) -- serving always-installed minimum", e)
        return list(_ALWAYS_FALLBACK)


def kit_dir() -> str:
    """Where the kit lives. The desktop shell injects kit.env (which carries
    PERSODUB_KIT_DIR) into this process's environment at engine start."""
    return os.environ.get("PERSODUB_KIT_DIR", "")


def platform_key() -> str:
    """Which of a pack's sizes applies here: "mac", or on Windows "win-gpu" /
    "win-cpu" by the torch variant the desktop shell chose at install
    (PERSODUB_TORCH_VARIANT in kit.env; absent means the GPU build, which is
    what every kit before the variant existed installed)."""
    if not _sys.platform.startswith("win"):
        return "mac"
    variant = os.environ.get("PERSODUB_TORCH_VARIANT", "").strip().lower()
    return "win-cpu" if variant == "cpu" else "win-gpu"


def _pack_bytes(entry):
    """A pack's size on this platform; a model's size is one number already."""
    b = entry["bytes"]
    return b.get(platform_key(), 0) if isinstance(b, dict) else b


def model_state(entry, kit: str) -> str:
    """"ready" | "paused" | "not_downloaded" for one catalog entry."""
    base = os.path.join(kit, *entry["dir"].split("/"))
    if entry["role"] == "pack":
        # The desktop app is installing it right now: it says so with a stamp,
        # since this process cannot see the shell's work and the half-made
        # folder alone read as "paused" (2026-09-08).
        if os.path.exists(os.path.join(kit, ".install", f"{entry['id']}.installing")):
            return "downloading"
        # Pack markers are kit-relative (they span folders: the installer's
        # own .ok stamp plus the pack's files); the Ollama binary carries the
        # platform's suffix, as the shell writes it.
        markers = []
        for m in entry["markers"]:
            rel = m.split("/")
            if _sys.platform.startswith("win") and rel[-1] == "ollama":
                rel[-1] += ".exe"
            markers.append(os.path.join(kit, *rel))
        if markers and all(os.path.exists(p) for p in markers):
            return "ready"
        return "paused" if os.path.isdir(base) else "not_downloaded"
    markers = [os.path.join(base, *m.split("/")) for m in entry["markers"]]
    if markers and all(os.path.exists(p) for p in markers):
        return "ready"
    if entry["source"].get("kind") == "ollama":
        # No "paused" from disk for Ollama models: partial blobs live in a
        # store shared across models and cannot be attributed to one of them.
        # ollama pull resumes from its own cache anyway, so calling it
        # not_downloaded loses nothing.
        return "not_downloaded"
    return "paused" if os.path.isdir(base) else "not_downloaded"


# ── downloads: one at a time, cancellable, resumable ───────────────────────
# In-memory only: on a server restart a half-download simply shows as
# "paused" from disk and the screen offers Resume -- nothing else to persist.
import shutil as _shutil
import subprocess as _subprocess
import sys as _sys
import threading as _threading

import requests as _requests

from app import config as _config
from app import runtime as _runtime

_downloads = {}   # id -> {"state": "queued"|"downloading"|"failed", "pct", "error"}
_queue = []
_cancel = {}      # id -> threading.Event
_lock = _threading.Lock()
_worker = None


def reset_downloads_for_tests():
    global _worker
    with _lock:
        _downloads.clear()
        _queue.clear()
        _cancel.clear()
    _worker = None


def free_bytes_at(path):
    """Bytes free on the volume holding path, or None when unreadable (a
    preflight that cannot read the disk must not become the reason a download
    fails).

    Walks up to the nearest existing parent first: the kit folder and a job's
    workspace are both asked about before they are made, and asking about a
    path that does not exist yet answers nothing at all when the disk under it
    is the thing being asked about.

    shutil.disk_usage, not os.statvfs: statvfs is not on Windows, where the
    dub's space check silently passed everything (CI, 2026-09-07).
    """
    path = path or "."
    while path and not os.path.exists(path):
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    try:
        return shutil.disk_usage(path or "/").free
    except Exception:
        return None


def dub_in_progress() -> bool:
    """True while any dub job runs -- removal is refused then (409)."""
    from app import state  # late import: read the store as it stands right now
    try:
        return any(j.get("status") == "running" for j in state.job_store.all())
    except Exception:
        return False


def find(mid):
    for m in load_catalog():
        if m["id"] == mid:
            return m
    return None


def status_rows():
    """What GET /api/models serves: catalog entries (minus always-installed)
    with live download state layered over the on-disk state."""
    kit = kit_dir()
    rows = []
    for m in load_catalog():
        if m["role"] == "always":
            continue
        row = {"id": m["id"], "role": m["role"], "name": m["name"], "bytes": _pack_bytes(m),
               # One line under the name in Settings: what this is for.
               "hint": m.get("hint", "")}
        with _lock:
            rt = dict(_downloads.get(m["id"]) or {})
        if rt.get("state") in ("queued", "downloading"):
            # Queued shows as downloading-with-no-percent; the screen says "waiting".
            row["state"] = "downloading"
            row["progress"] = rt.get("pct")
        else:
            row["state"] = model_state(m, kit)
            if row["state"] == "downloading":
                row["progress"] = None   # a pack the shell is installing: the page has the figure
            if rt.get("state") == "failed" and rt.get("error"):
                row["error"] = rt["error"]
        rows.append(row)
    return rows


PACKS_ARE_THE_SHELLS = "Packs are installed by the desktop app"


def request_download(entry) -> str:
    """"started" | "already". Queues the model; one download runs at a time."""
    global _worker
    if entry["role"] == "pack":
        raise ValueError(PACKS_ARE_THE_SHELLS)
    if entry["source"].get("kind") == "ollama" and not _runtime.url("ollama"):
        # Only the runtime can pull into its store, and it is not running:
        # say so up front instead of queueing a pull that fails on an empty URL.
        raise ValueError("Install the Translation runtime first, then download this model.")
    with _lock:
        state = (_downloads.get(entry["id"]) or {}).get("state")
        if state in ("queued", "downloading"):
            return "already"
        _downloads[entry["id"]] = {"state": "queued", "pct": None, "error": ""}
        _cancel[entry["id"]] = _threading.Event()
        _queue.append(entry["id"])
        if _worker is None or not _worker.is_alive():
            _worker = _threading.Thread(target=_drain, daemon=True)
            _worker.start()
    return "started"


def cancel_download(mid):
    """Stop a running download (its pieces stay -- Paused) or unqueue one."""
    with _lock:
        ev = _cancel.get(mid)
        if ev:
            ev.set()
        if mid in _queue:
            _queue.remove(mid)
            _downloads.pop(mid, None)


def remove_model(entry):
    if entry["role"] == "pack":
        raise ValueError(PACKS_ARE_THE_SHELLS)
    kit = kit_dir()
    if entry["source"].get("kind") == "ollama":
        # The blob store is shared across Ollama models: deleting through the
        # server removes exactly this model's layers, an rmtree would take
        # every other model with it.
        ollama_url = _runtime.url("ollama")
        if not ollama_url:
            # Only the runtime can take a model out of its shared blob store,
            # and it is not running. Say so: a silent "removed" that removed
            # nothing is worse than a refusal.
            raise ValueError("Install the Translation runtime first, then remove this model.")
        _requests.delete(f"{ollama_url}/api/delete",
                         json={"model": entry["source"]["tag"]}, timeout=60)
    else:
        _shutil.rmtree(os.path.join(kit, *entry["dir"].split("/")), ignore_errors=True)


def _drain():
    while True:
        with _lock:
            if not _queue:
                return
            mid = _queue.pop(0)
            _downloads[mid].update(state="downloading", pct=0)
        entry = find(mid)
        cancelled = _cancel[mid].is_set

        def progress(pct, mid=mid):
            with _lock:
                if mid in _downloads:
                    _downloads[mid]["pct"] = pct

        try:
            _run_download(entry, kit_dir(), progress, cancelled)
            with _lock:
                # Success OR cancel: drop the record -- the disk now tells the
                # truth (ready, or paused with the pieces kept).
                _downloads.pop(mid, None)
        except Exception as e:
            # Logged with the traceback: the reason used to live only in the
            # row's error field, so a support log said nothing (Windows, 2026-09-07).
            log.exception("download of %s failed", mid)
            with _lock:
                _downloads[mid] = {"state": "failed", "pct": None, "error": str(e)[:300]}


def _run_download(entry, kit, progress, cancelled):
    if entry["source"].get("kind") == "ollama":
        _pull_ollama(entry, progress, cancelled)
    else:
        _pull_hf(entry, kit, progress, cancelled)


def _hf_cli(kit: str) -> str:
    """The `hf` CLI in app_venv -- the one venv every install has. It moved
    here from qwen_venv in 0.5.1, when that venv was retired."""
    bindir = "Scripts" if _sys.platform == "win32" else "bin"
    return os.path.join(kit, "app_venv", bindir, "hf.exe" if _sys.platform == "win32" else "hf")


HF_ATTEMPTS = 3            # a CDN read timeout mid-file is retried; hf resumes the .incomplete
HF_DOWNLOAD_TIMEOUT = "60"  # seconds per read; the tool's own default of 10 gave up on slow CDNs


def _dir_bytes(path: str) -> int:
    """Bytes on disk under path, .incomplete pieces included -- what has really
    arrived, which is what a percent should mean."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            with contextlib.suppress(OSError):
                total += os.path.getsize(os.path.join(root, f))
    return total


def _pull_hf(entry, kit, progress, cancelled):
    """hf CLI download -- it resumes partial files by itself (--local-dir).

    Percent is what is on disk against the catalog's size, not the tool's own
    figure: that one counts files ("Fetching 13 files: 92%") and read 92% while
    1.2 of 3.7 GB had arrived (Windows, 2026-09-07). A failed run is tried
    again up to HF_ATTEMPTS times -- the tool resumes its .incomplete files --
    and the process is always ended with us, never left running on its own.
    """
    import time

    from app.agents.base import _end  # the app's proven process-tree stopper

    dest = os.path.join(kit, *entry["dir"].split("/"))
    os.makedirs(dest, exist_ok=True)
    src = entry["source"]
    argv = [_hf_cli(kit), "download", src["repo"], *src.get("files", []),
            "--revision", src["rev"], "--local-dir", dest]
    env = {**os.environ, "HF_HUB_DOWNLOAD_TIMEOUT": HF_DOWNLOAD_TIMEOUT,
           "HF_HUB_DISABLE_PROGRESS_BARS": "0", "PYTHONUTF8": "1"}
    total_bytes = int(entry.get("bytes") or 0)
    last_report = 0.0

    def report_from_disk(force=False):
        nonlocal last_report
        if not total_bytes:
            return
        now = time.monotonic()
        if force or now - last_report >= 1.0:
            last_report = now
            progress(min(99, int(100 * _dir_bytes(dest) / total_bytes)))

    recent = []   # the tool's last words, for the error a failure carries
    for attempt in range(1, HF_ATTEMPTS + 1):
        # utf-8 with replacement: the tool draws its progress bars in UTF-8, and
        # a Korean Windows console's default (cp949) choked on them mid-stream.
        proc = _subprocess.Popen(argv, stdout=_subprocess.PIPE, stderr=_subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace", env=env)
        # The percent is measured on its own clock, not on the tool's output:
        # without a terminal the tool prints almost nothing while a file
        # streams in, and the figure sat at 10% for a whole 2.9 GB (Windows).
        stop_meter = _threading.Event()

        def meter():
            while not stop_meter.wait(1.0):
                report_from_disk(force=True)
        _threading.Thread(target=meter, daemon=True).start()
        try:
            for line in proc.stdout:
                if cancelled():
                    _end(proc)
                    return
                line = line.strip()
                if line:
                    recent.append(line)
                    del recent[:-6]
            rc = proc.wait()
        except BaseException:
            _end(proc)   # never leave the tool downloading on its own
            raise
        finally:
            stop_meter.set()
        if cancelled():
            return
        report_from_disk(force=True)
        if rc == 0:
            return
        log.warning("hf download of %s exited %s (attempt %d/%d): %s",
                    entry["id"], rc, attempt, HF_ATTEMPTS, " | ".join(recent))
        if attempt < HF_ATTEMPTS:
            time.sleep(3)
    # The exit code alone said nothing ("hf download exited 1", Windows,
    # 2026-09-07); the tool's own last lines say what went wrong.
    tail = " | ".join(recent[-3:])
    raise RuntimeError(f"hf download exited {rc}" + (f": {tail}" if tail else ""))


def _pull_ollama(entry, progress, cancelled):
    """Pull through the app's own running Ollama server (resume is Ollama's).
    A model that needs the validated chat template baked in (Hunyuan) gets a
    create call on top -- the same two-step flow verified 2026-08-31."""
    src = entry["source"]
    pull_name = src.get("pull") or src["tag"]
    ollama_url = _runtime.url("ollama")
    r = _requests.post(f"{ollama_url}/api/pull",
                       json={"model": pull_name, "stream": True}, stream=True, timeout=600)
    r.raise_for_status()
    for line in r.iter_lines():
        if cancelled():
            r.close()
            return
        if not line:
            continue
        d = json.loads(line)
        if "error" in d:
            raise RuntimeError(d["error"])
        if d.get("total") and d.get("completed") is not None:
            progress(int(100 * d["completed"] / d["total"]))
    if cancelled():
        return
    if src.get("needs_template"):
        cr = _requests.post(f"{ollama_url}/api/create",
                            json={"model": src["tag"], "from": pull_name,
                                  "template": _config.HUNYUAN_TEMPLATE,
                                  "parameters": _config.HUNYUAN_PARAMETERS,
                                  "stream": False}, timeout=600)
        cr.raise_for_status()
        if cr.json().get("status") != "success":
            raise RuntimeError(f"Ollama create reported: {cr.json().get('status')}")
