"""Where a pack process actually is right now.

A pack (the Ollama runtime, the Qwen3-TTS sidecar) is started by the desktop
shell, which picks its own free port and writes it into
<kit>/runtime.json (see desktop/src/runtimeFile.js). This module is the
backend's only way to find that URL: read the file fresh on every call, never
cached, because the shell can install and start a pack -- rewriting the file
-- while this process is already running; caching would keep serving a stale
or absent URL until a restart.

Inside a kit (PERSODUB_KIT_DIR set, which the shell's kit.env always does)
runtime.json is the only word: a pack whose process is not running has no
URL, full stop. The environment is deliberately NOT consulted there -- the
shell passes kit.env into this process, and kits from before packs existed
carry a fixed QWEN_TTS_URL line in it, which would make a missing voice
engine look present. Without a kit (a dev run of the backend alone) the
config constants apply, which read OLLAMA_URL / QWEN_TTS_URL from the
environment with the stock ports as defaults.
"""
import json
import os
from typing import Optional

from app import config

_DEV_FALLBACK = {
    "ollama": "OLLAMA_URL",
    "tts": "QWEN_TTS_URL",
}


def url(name: str) -> str:
    """The live URL for pack `name` ("ollama" or "tts"), or "" when no pack
    process has announced one."""
    kit = os.environ.get("PERSODUB_KIT_DIR")
    if kit:
        try:
            with open(os.path.join(kit, "runtime.json"), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return ""   # no runtime.json yet, or a broken one: no pack is up
        value = data.get(f"{name}_url") if isinstance(data, dict) else None
        return value if isinstance(value, str) else ""
    attr = _DEV_FALLBACK.get(name)
    return getattr(config, attr, "") if attr else ""


def state(name: str) -> str:
    """What the shell last said about pack `name` while it has no URL:
    "starting" (its process is coming up) or "failed" (it did not come up),
    else "". Written next to the URL in runtime.json and removed once the
    process answers (desktop/src/orchestrator.js PACK_STATE_KEY)."""
    kit = os.environ.get("PERSODUB_KIT_DIR")
    if not kit:
        return ""
    try:
        with open(os.path.join(kit, "runtime.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return ""
    value = data.get(f"{name}_state") if isinstance(data, dict) else None
    return value if value in ("starting", "failed") else ""


def failure(name: str) -> str:
    """Why pack `name` failed, when the shell could tell from its last lines:
    "memory" (the computer ran out of it), else "". Written beside its
    "failed" state (desktop/src/orchestrator.js PACK_FAILURE_KEY)."""
    kit = os.environ.get("PERSODUB_KIT_DIR")
    if not kit:
        return ""
    try:
        with open(os.path.join(kit, "runtime.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return ""
    value = data.get(f"{name}_failure") if isinstance(data, dict) else None
    return value if value == "memory" else ""


def pid(name: str) -> Optional[int]:
    """The process id the shell wrote beside pack `name`'s URL in
    runtime.json ("tts" -> tts_pid, "ollama" -> ollama_pid), or None. Read
    for the memory line in the job log only (app/memline.py)."""
    kit = os.environ.get("PERSODUB_KIT_DIR")
    if not kit:
        return None
    try:
        with open(os.path.join(kit, "runtime.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    value = data.get(f"{name}_pid") if isinstance(data, dict) else None
    return value if isinstance(value, int) and value > 0 else None
