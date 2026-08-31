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
