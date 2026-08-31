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
import json
import logging
import os

log = logging.getLogger(__name__)

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


def model_state(entry, kit: str) -> str:
    """"ready" | "paused" | "not_downloaded" for one catalog entry."""
    base = os.path.join(kit, *entry["dir"].split("/"))
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
import re as _re
import shutil as _shutil
import subprocess as _subprocess
import sys as _sys
import threading as _threading

import requests as _requests

from app import config as _config

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
    """Bytes free on the kit's volume, or None when unreadable (a preflight
    that cannot read the disk must not become the reason a download fails)."""
    try:
        st = os.statvfs(path or ".")
        return st.f_bavail * st.f_frsize
    except Exception:
        return None


def dub_in_progress() -> bool:
    """True while any dub job runs -- removal is refused then (409)."""
    from app.main import job_store  # late import: app.main imports this module
    try:
        return any(j.get("status") == "running" for j in job_store.all())
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
        row = {"id": m["id"], "role": m["role"], "name": m["name"], "bytes": m["bytes"]}
        with _lock:
            rt = dict(_downloads.get(m["id"]) or {})
        if rt.get("state") in ("queued", "downloading"):
            # Queued shows as downloading-with-no-percent; the screen says "waiting".
            row["state"] = "downloading"
            row["progress"] = rt.get("pct")
        else:
            row["state"] = model_state(m, kit)
            if rt.get("state") == "failed" and rt.get("error"):
                row["error"] = rt["error"]
        rows.append(row)
    return rows


def request_download(entry) -> str:
    """"started" | "already". Queues the model; one download runs at a time."""
    global _worker
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
    kit = kit_dir()
    if entry["source"].get("kind") == "ollama":
        # The blob store is shared across Ollama models: deleting through the
        # server removes exactly this model's layers, an rmtree would take
        # every other model with it.
        _requests.delete(f"{_config.OLLAMA_URL}/api/delete",
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
            with _lock:
                _downloads[mid] = {"state": "failed", "pct": None, "error": str(e)[:120]}


def _run_download(entry, kit, progress, cancelled):
    if entry["source"].get("kind") == "ollama":
        _pull_ollama(entry, progress, cancelled)
    else:
        _pull_hf(entry, kit, progress, cancelled)


def _pull_hf(entry, kit, progress, cancelled):
    """hf CLI download -- it resumes partial files by itself (--local-dir)."""
    from app.agents.base import _end  # the app's proven process-tree stopper

    dest = os.path.join(kit, *entry["dir"].split("/"))
    os.makedirs(dest, exist_ok=True)
    bindir = "Scripts" if _sys.platform == "win32" else "bin"
    hf = os.path.join(kit, "qwen_venv", bindir, "hf.exe" if _sys.platform == "win32" else "hf")
    src = entry["source"]
    argv = [hf, "download", src["repo"], *src.get("files", []),
            "--revision", src["rev"], "--local-dir", dest]
    proc = _subprocess.Popen(argv, stdout=_subprocess.PIPE, stderr=_subprocess.STDOUT, text=True)
    pct_re = _re.compile(r"(\d{1,3})%")
    for line in proc.stdout:
        if cancelled():
            _end(proc)
            return
        m = pct_re.search(line)
        if m:
            progress(min(100, int(m.group(1))))
    rc = proc.wait()
    if cancelled():
        return
    if rc != 0:
        raise RuntimeError(f"hf download exited {rc}")


def _pull_ollama(entry, progress, cancelled):
    """Pull through the app's own running Ollama server (resume is Ollama's).
    A model that needs the validated chat template baked in (Hunyuan) gets a
    create call on top -- the same two-step flow verified 2026-08-31."""
    src = entry["source"]
    pull_name = src.get("pull") or src["tag"]
    r = _requests.post(f"{_config.OLLAMA_URL}/api/pull",
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
        cr = _requests.post(f"{_config.OLLAMA_URL}/api/create",
                            json={"model": src["tag"], "from": pull_name,
                                  "template": _config.HUNYUAN_TEMPLATE,
                                  "parameters": _config.HUNYUAN_PARAMETERS,
                                  "stream": False}, timeout=600)
        cr.raise_for_status()
        if cr.json().get("status") != "success":
            raise RuntimeError(f"Ollama create reported: {cr.json().get('status')}")
