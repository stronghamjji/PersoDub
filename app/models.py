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
import time

from app.i18n import t

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


def _hf_download_whole(base: str, markers) -> bool:
    """Every marker has bytes in it and no piece is still being fetched."""
    if any(os.path.getsize(p) == 0 for p in markers):
        return False
    pieces = os.path.join(base, ".cache", "huggingface", "download")
    return all(not any(f.endswith(".incomplete") for f in files)
               for _root, _dirs, files in os.walk(pieces))


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
        # A cancelled download can leave the marker behind empty, with the
        # rest still in .incomplete pieces: that read as ready and the dub then
        # failed on it (Mac full test, 2026-09-25). Only a whole download is.
        if entry["source"].get("kind") != "hf" or _hf_download_whole(base, markers):
            return "ready"
        return "paused"
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
from app import netlog
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
    """True while any job is queued, running or still stopping -- removal is
    refused then (409). A stopped job's thread goes on using the models until
    its next checkpoint, and a queued one loads them when its turn comes."""
    from app import state  # late import: read the store as it stands right now
    from app.jobs import JobStatus
    try:
        return any(j.get("status") in (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING)
                   for j in state.job_store.all())
    except Exception:
        return False


def shown_words(text: str) -> str:
    """A catalog name or hint (models_catalog.json) in the user's language.
    Each one is written out here, where the tables' check (tests/test_i18n.py)
    can see it; a product's own name (Whisper, Gemma 3) has no entry and stays
    as it is, and so does a line added to the catalog without one here."""
    return {
        "Audio separation, speech-to-text, voices": t("Audio separation, speech-to-text, voices"),
        "Local translation (Hunyuan, Gemma 3)": t("Local translation (Hunyuan, Gemma 3)"),
        "Subtitle eraser": t("Subtitle eraser"),
        "More careful": t("More careful"),
        "Small and quick": t("Small and quick"),
        "Default · Comes with Python + PyTorch": t("Default · Comes with Python + PyTorch"),
    }.get(text, text)


def find(mid):
    for m in load_catalog():
        if m["id"] == mid:
            return m
    return None


def status_rows():
    """What GET /api/models serves: catalog entries (minus always-installed)
    with live download state layered over the on-disk state. One that comes
    with a pack (Demucs, in Python + PyTorch) says which: the screen lists it
    with its stage but offers no download or removal of its own."""
    kit = kit_dir()
    rows = []
    for m in load_catalog():
        if m["role"] == "always":
            continue
        row = {"id": m["id"], "role": m["role"], "name": shown_words(m["name"]), "bytes": _pack_bytes(m),
               # A short note after "Ready" in Settings, only where the row's
               # group title does not say what it is for; "" when it does.
               "hint": shown_words(m.get("hint", ""))}
        if m.get("comes_with"):
            row["comes_with"] = m["comes_with"]
        with _lock:
            rt = dict(_downloads.get(m["id"]) or {})
        if rt.get("state") in ("queued", "downloading"):
            # Queued shows as downloading-with-no-percent, and so does one started
            # before its first byte: queued tells the screen to say "waiting", not
            # "getting ready" (Windows C2, 2026-10-21).
            row["state"] = "downloading"
            row["progress"] = rt.get("pct")
            row["queued"] = rt.get("state") == "queued"
        else:
            row["state"] = model_state(m, kit)
            if row["state"] == "downloading":
                row["progress"] = None   # a pack the shell is installing: the page has the figure
            if rt.get("state") == "failed" and rt.get("error"):
                row["error"] = rt["error"]
        rows.append(row)
    return rows


# In English on purpose: the page hands a pack's removal to the desktop app
# when the refusal is this sentence (ui/src/modelsDialog.mjs), and says it in
# its own language where it shows it.
PACKS_ARE_THE_SHELLS = "PersoDub installs this itself."


def request_download(entry) -> str:
    """"started" | "already". Queues the model; one download runs at a time."""
    global _worker
    if entry["role"] == "pack":
        raise ValueError(PACKS_ARE_THE_SHELLS)
    if entry["source"].get("kind") == "ollama" and not _runtime.url("ollama"):
        # Only the runtime can pull into its store, and it is not running:
        # say so up front instead of queueing a pull that fails on an empty URL.
        raise ValueError(t("Local translation models (Hunyuan, Gemma 3) need a program called Ollama "
                           "to run. Download it in Settings > Models."))
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
            raise ValueError(t("Local translation models (Hunyuan, Gemma 3) need a program called Ollama "
                               "to run. Download it in Settings > Models."))
        # A model pulled under one name and renamed (Hunyuan: pulled from
        # hf.co/..., then given its tag with our template) is held by both
        # names; deleting only the tag freed nothing, 1.1 GB stayed on disk
        # (Windows, 2026-09-25). Its layers go when the last name does.
        names = [entry["source"]["tag"]]
        pull = entry["source"].get("pull")
        if pull and pull not in names:
            names.append(pull)
        for name in names:
            _requests.delete(f"{ollama_url}/api/delete", json={"model": name}, timeout=60)
    else:
        _shutil.rmtree(os.path.join(kit, *entry["dir"].split("/")), ignore_errors=True)


def _drain():
    while True:
        with _lock:
            if not _queue:
                return
            mid = _queue.pop(0)
            # No figure before the first byte: "Downloading… 0%" from the press
            # on, held 4 s before the first percent, read as stuck (Windows C2, 2026-10-21).
            _downloads[mid].update(state="downloading", pct=None)
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
                if cancelled():
                    # A cancel that broke the connection on its way out is
                    # still a cancel: the disk says paused, nothing failed.
                    _downloads.pop(mid, None)
                else:
                    _downloads[mid] = {"state": "failed", "pct": None, "error": _stopped_reason(e)}


# The row's error is read on screen, so it says why in plain words; the
# exception itself is in the log above. "ChunkedEncodingError: ('Connection
# broken: IncompleteRead(...)')" was shown when Wi-Fi dropped (Windows H9/H10,
# 2026-10-06). The hf tool's failure arrives as its last lines of text.
_NO_ROOM = ("no space left", "errno 28", "not enough space", "disk is full")
_NO_NETWORK = ("connection", "incompleteread", "chunkedencoding", "timed out", "timeout",
               "network", "no such host", "getaddrinfo", "name resolution", "max retries", "ssl")


def _stopped_reason(exc) -> str:
    text = ("%s %s" % (type(exc).__name__, exc)).lower()
    if any(w in text for w in _NO_ROOM):
        return t("Not enough space on this computer.")
    # Ahead of the dropped connection it also reads as: pressing Resume on the
    # same network only fails again.
    if netlog.certificate_refused(text):
        return t("A company network or security program blocked the connection. "
                 "Connect to another Wi-Fi or a hotspot, then press Resume.")
    if any(w in text for w in _NO_NETWORK):
        return t("Connection lost.")
    return t("The download stopped.")


def _run_download(entry, kit, progress, cancelled):
    """One model's download, end to end, between a START line and a DONE,
    CANCELLED or FAILED line with its seconds in the app log."""
    kind = "ollama" if entry["source"].get("kind") == "ollama" else "hf"
    log.info("MODEL %s DOWNLOAD START (%s)", entry["id"], kind)
    began = time.monotonic()
    try:
        if kind == "ollama":
            _pull_ollama(entry, progress, cancelled)
        else:
            _pull_hf(entry, kit, progress, cancelled)
    except Exception as e:
        # A cancel that broke the connection on its way out is still a
        # cancel, as _drain counts it.
        if cancelled():
            log.info("MODEL %s DOWNLOAD CANCELLED (%.1fs)", entry["id"], time.monotonic() - began)
        else:
            log.error("MODEL %s DOWNLOAD FAILED (%.1fs): %s: %s",
                      entry["id"], time.monotonic() - began, type(e).__name__, e)
        raise
    # A cancel returns too, with the pieces kept.
    log.info("MODEL %s DOWNLOAD %s (%.1fs)", entry["id"], "CANCELLED" if cancelled() else "DONE",
             time.monotonic() - began)


def _venv_python(kit: str) -> str:
    """The interpreter in app_venv -- the one venv every install has. It moved
    here from qwen_venv in 0.5.1, when that venv was retired.

    The hf CLI is run as a module through this interpreter (`-m
    huggingface_hub.cli.hf`), not via app_venv's own hf(.exe) launcher: that
    launcher is a freshly created, unsigned file pip writes into the venv at
    install time, and exactly the kind of thing Smart App Control or an
    antivirus can refuse to run with "spawn UNKNOWN" (issue #48). Same fix as
    desktop/src/installSpec.js's models step, on the app side."""
    bindir = "Scripts" if _sys.platform == "win32" else "bin"
    return os.path.join(kit, "app_venv", bindir, "python.exe" if _sys.platform == "win32" else "python")


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


def _hf_files(dest):
    """(name under dest, with "/" between folders, bytes) of every file the
    hf tool left there, in name order. Its own .cache folder is not the model's."""
    found = []
    for root, dirs, files in os.walk(dest):
        if root == dest:
            dirs[:] = [d for d in dirs if d != ".cache"]
        for f in files:
            path = os.path.join(root, f)
            found.append((os.path.relpath(path, dest).replace(os.sep, "/"), os.path.getsize(path)))
    return sorted(found)


def _pull_hf(entry, kit, progress, cancelled):
    """One catalog model from Hugging Face (_hf_download), between DOWNLOAD
    START and DONE, CANCELLED or FAILED lines in the app log (app/netlog.py).
    Once it is in, a FILE line for every file the folder holds, then the
    totals; the speed is of what came this time, which a resumed download has
    less of."""
    src = entry["source"]
    dest = os.path.join(kit, *entry["dir"].split("/"))
    base = (os.environ.get("HF_ENDPOINT") or "https://huggingface.co").rstrip("/")
    what = "hf %s@%s" % (src["repo"], src["rev"][:7])
    log.info(netlog.start(what, f"{base}/{src['repo']}", dest))
    began = time.monotonic()
    before = _dir_bytes(dest)
    try:
        _hf_download(entry, kit, progress, cancelled, what, began)
    except BaseException as e:
        # A cancel that broke the tool on its way out is a cancel, as _drain
        # and _run_download count it.
        if cancelled():
            log.info(netlog.cancelled(what, time.monotonic() - began))
        else:
            log.error(netlog.failed(what, time.monotonic() - began, netlog.described(e), base))
        raise
    if cancelled():
        log.info(netlog.cancelled(what, time.monotonic() - began))
        return
    files = _hf_files(dest)
    for name, size in files:
        log.info(netlog.file_line(what, name, f"{base}/{src['repo']}/resolve/{src['rev']}/{name}", size))
    # The tool compares each file's size with the one the server announced
    # (the shell's hf lines say the same, desktop/src/installSpec.js).
    log.info(netlog.done(what, time.monotonic() - began, sum(size for _name, size in files),
                         "size checked by hf", files=len(files), fetched=max(0, _dir_bytes(dest) - before)))


def _hf_download(entry, kit, progress, cancelled, what, began):
    """hf CLI download -- it resumes partial files by itself (--local-dir).

    Percent is what is on disk against the catalog's size, not the tool's own
    figure: that one counts files ("Fetching 13 files: 92%") and read 92% while
    1.2 of 3.7 GB had arrived (Windows, 2026-09-07). A failed run is tried
    again up to HF_ATTEMPTS times -- the tool resumes its .incomplete files,
    and each new try is a RETRY line named `what`, its seconds counted from
    `began` -- and the process is always ended with us, never left running on
    its own.
    """
    import time

    from app.agents.base import _end  # the app's proven process-tree stopper

    dest = os.path.join(kit, *entry["dir"].split("/"))
    os.makedirs(dest, exist_ok=True)
    src = entry["source"]
    argv = [_venv_python(kit), "-m", "huggingface_hub.cli.hf", "download", src["repo"], *src.get("files", []),
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
            got = _dir_bytes(dest)
            # Less the tool's own .gitignore, one byte it writes before it asks
            # the server for anything: counted, the row would read 0% before a
            # byte of the model had come.
            with contextlib.suppress(OSError):
                got -= os.path.getsize(os.path.join(dest, ".cache", "huggingface", ".gitignore"))
            progress(min(99, int(100 * got / total_bytes)) if got > 0 else None)   # None: no byte yet (_drain)

    recent = []   # the tool's last words, for the error a failure carries
    for attempt in range(1, HF_ATTEMPTS + 1):
        # utf-8 with replacement: the tool draws its progress bars in UTF-8, and
        # a Korean Windows console's default (cp949) choked on them mid-stream.
        proc = _subprocess.Popen(argv, stdout=_subprocess.PIPE, stderr=_subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace", env=env)
        # The percent is measured on its own clock, not on the tool's output:
        # without a terminal the tool prints almost nothing while a file
        # streams in, and the figure sat at 10% for a whole 2.9 GB (Windows).
        # A cancel is heard on the same clock, for the same reason: checked
        # only between the tool's lines, Cancel let a 3.1 GB download run to
        # the end (Windows test C3, 2026-10-10). Ending the tool ends its
        # output, so the reading loop below stops by itself.
        stop_meter = _threading.Event()

        def meter():
            while not stop_meter.wait(1.0):
                if cancelled():
                    _end(proc)
                    return
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
        if attempt < HF_ATTEMPTS:
            log.warning(netlog.retry(what, attempt + 1, HF_ATTEMPTS, time.monotonic() - began,
                                     f"hf download exited {rc}: " + " | ".join(recent)))
            time.sleep(3)
    # The exit code alone said nothing ("hf download exited 1", Windows,
    # 2026-09-07); the tool's own last lines say what went wrong.
    tail = " | ".join(recent[-3:])
    raise RuntimeError(f"hf download exited {rc}" + (f": {tail}" if tail else ""))


def _ollama_source(name):
    """Where Ollama fetches a model name from: "gemma3:12b" from its own
    registry's library, "hf.co/tencent/..." from the host the name begins with."""
    first, _, rest = name.partition("/")
    if rest and ("." in first or ":" in first):
        return f"https://{name}"
    return "https://registry.ollama.ai/" + (name if rest else f"library/{name}")


def _pull_ollama(entry, progress, cancelled):
    """Pull through the app's own running Ollama server (resume is Ollama's),
    between DOWNLOAD START and DONE, CANCELLED or FAILED lines in the app log
    (app/netlog.py): a FILE line for each layer once it is in, and Ollama's
    own "verifying sha256 digest" and "success" once each.
    A model that needs the validated chat template baked in (Hunyuan) gets a
    create call on top -- the same two-step flow verified 2026-08-31."""
    src = entry["source"]
    pull_name = src.get("pull") or src["tag"]
    ollama_url = _runtime.url("ollama")
    what, source = f"ollama {pull_name}", _ollama_source(pull_name)
    log.info(netlog.start(what, source, note=f"via {ollama_url}/api/pull"))
    began = time.monotonic()
    # Each layer's size, and how much of it was here before this pull: the
    # speed is of what came now, not of what Ollama had kept.
    layers, had, logged, said = {}, {}, set(), set()

    def layer_in(digest):
        if digest not in logged:
            logged.add(digest)
            log.info(netlog.file_line(what, "layer " + digest.split(":")[-1][:12], source, layers[digest]))

    try:
        r = _requests.post(f"{ollama_url}/api/pull",
                           json={"model": pull_name, "stream": True}, stream=True, timeout=600)
        log.info(netlog.connected(what, r.status_code, ollama_url))
        r.raise_for_status()
        for line in r.iter_lines():
            if cancelled():
                r.close()
                break
            if not line:
                continue
            d = json.loads(line)
            if "error" in d:
                raise RuntimeError(d["error"])
            if d.get("digest") and d.get("total"):
                layers[d["digest"]] = d["total"]
                had.setdefault(d["digest"], d.get("completed") or 0)
                if (d.get("completed") or 0) >= d["total"]:
                    layer_in(d["digest"])
            elif not d.get("digest"):
                # Ollama goes on to its checks only once every layer is in.
                for digest in layers:
                    layer_in(digest)
                if d.get("status") in ("verifying sha256 digest", "success") and d["status"] not in said:
                    said.add(d["status"])
                    log.info(f"DOWNLOAD {what}: {d['status']}")
            if d.get("total") and d.get("completed") is not None:
                # None: no byte yet (_drain).
                progress(int(100 * d["completed"] / d["total"]) if d["completed"] else None)
    except Exception as e:
        # A cancel that broke the stream on its way out is a cancel, as
        # _run_download counts it.
        if cancelled():
            log.info(netlog.cancelled(what, time.monotonic() - began))
        else:
            log.error(netlog.failed(what, time.monotonic() - began, netlog.described(e), source))
        raise
    if cancelled():
        log.info(netlog.cancelled(what, time.monotonic() - began))
        return
    for digest in layers:
        layer_in(digest)
    check = "sha256 checked by ollama" if "verifying sha256 digest" in said else netlog.NOT_CHECKED
    log.info(netlog.done(what, time.monotonic() - began, sum(layers.values()), check,
                         files=len(layers), fetched=sum(layers[g] - had[g] for g in layers)))
    if src.get("needs_template"):
        cr = _requests.post(f"{ollama_url}/api/create",
                            json={"model": src["tag"], "from": pull_name,
                                  "template": _config.HUNYUAN_TEMPLATE,
                                  "parameters": _config.HUNYUAN_PARAMETERS,
                                  "stream": False}, timeout=600)
        cr.raise_for_status()
        if cr.json().get("status") != "success":
            raise RuntimeError(f"Ollama create reported: {cr.json().get('status')}")
