"""Read/write the desktop kit's kit.env for the Settings screen.

kit.env is the single config file the engines read at startup (see the
desktop shell's kitEnv.js). The Settings modal used to store API keys in
localStorage, which nothing ever read -- this module makes saving real.
Saved values are shown back in Settings (single-user desktop app, the user
owns this file). Localhost-only comes from the 127.0.0.1 bind; main.py's
TrustedHost middleware only rejects foreign Host headers (DNS rebinding) on
top of that. A change takes effect on the next app start.
"""
import os
import shutil
from typing import Dict, Optional

MANAGED_KEYS = ("GEMINI_API_KEY", "PERSO_API_KEY", "PERSO_SPACE_SEQ")

KIT_ENV = "kit.env"
# The file was mac.env before Windows existed. The desktop shell renames it on
# startup (kitEnv.js migrateKitEnv), but this module also runs where that shell
# does not -- a kit driven straight from the server or a test -- so the old
# name is still honored when it is the only one present.
LEGACY_KIT_ENV = "mac.env"


def env_path() -> Optional[str]:
    """kit.env location, or None outside a desktop install (e.g. the server)."""
    kit = os.environ.get("PERSODUB_KIT_DIR")
    if not kit:
        return None
    current = os.path.join(kit, KIT_ENV)
    if not os.path.exists(current):
        legacy = os.path.join(kit, LEGACY_KIT_ENV)
        if os.path.exists(legacy):
            return legacy
    return current


def update_env_text(text: str, values: Dict[str, str]) -> str:
    """Set KEY=value lines in env-file text, preserving everything else.

    An existing line (commented out or not) is replaced in place; a missing
    key is appended. Values are written verbatim -- callers pass secrets, so
    nothing here logs or prints.
    """
    lines = text.splitlines()
    seen = set()
    for i, line in enumerate(lines):
        stripped = line.strip().lstrip("#").strip()
        for key, value in values.items():
            # Replace EVERY matching line (commented or not): kitEnv.js parses
            # last-wins, so a hand-added duplicate below the placeholder would
            # otherwise silently keep the old key in force.
            if stripped.startswith(key + "="):
                lines[i] = f"{key}={value}"
                seen.add(key)
    for key, value in values.items():
        if key not in seen:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def read_key_status() -> Optional[Dict[str, bool]]:
    """{key_set booleans} from kit.env, or None when there is no kit."""
    path = env_path()
    if not path or not os.path.exists(path):
        return None
    status = {k: False for k in MANAGED_KEYS}
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    for raw in lines:
        line = raw.strip()
        if line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() in status and value.strip():
            status[key.strip()] = True
    return status


def read_value(key: str) -> Optional[str]:
    """The current value of one kit.env key, last assignment wins (matching
    kitEnv.js's parse). None when unset, empty, or there is no kit."""
    path = env_path()
    if not path or not os.path.exists(path):
        return None
    value = None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == key and v.strip():
                value = v.strip()
    return value


def write_keys(values: Dict[str, Optional[str]]) -> Dict[str, bool]:
    """Write values into kit.env (with a .bak backup) and return the resulting
    set/unset status. None leaves a key untouched; an empty string CLEARS it
    (writes `KEY=`) -- without this, a mistyped key or a stale workspace pin
    could never be removed from the app. Raises FileNotFoundError without a kit."""
    path = env_path()
    if not path or not os.path.exists(path):
        raise FileNotFoundError("kit.env not found -- not a desktop install")
    to_set = {k: v for k, v in values.items() if k in MANAGED_KEYS and v is not None}
    for v in to_set.values():
        # A newline would inject arbitrary KEY=value lines into the engine env.
        if any(ch in v for ch in "\r\n") or not v.isprintable():
            raise ValueError("API keys must be a single line of printable text")
    if to_set:
        shutil.copy2(path, path + ".bak")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(update_env_text(text, to_set))
        # Keys live here now -- keep both files owner-only.
        os.chmod(path, 0o600)
        os.chmod(path + ".bak", 0o600)
    return read_key_status() or {}
