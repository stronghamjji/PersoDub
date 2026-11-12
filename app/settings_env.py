"""Read/write the desktop kit's kit.env for the Settings screen.

kit.env is the single config file the engines read at startup (see the
desktop shell's kitEnv.js). The Settings modal used to store API keys in
localStorage, which nothing ever read -- this module makes saving real.
Saved values are shown back in Settings (single-user desktop app, the user
owns this file). Localhost-only comes from the 127.0.0.1 bind; main.py's
TrustedHost middleware only rejects foreign Host headers (DNS rebinding) on
top of that. A saved key takes effect on the next dub, not the next app start:
everything that needs one reads it back through current_value() below.
"""
import contextlib
import os
import shutil
from typing import Dict, Iterator, Optional, Tuple

MANAGED_KEYS = ("GEMINI_API_KEY", "PERSO_API_KEY", "PERSO_SPACE_SEQ")

# Settings > Privacy is one switch, Share usage data, kept as the three lines
# the desktop shell already reads out of kit.env before every send. They are
# not API keys, so not in MANAGED_KEYS, and the switch writes all three at once
# so the screen and the shell cannot disagree.
#
# Usage counts (desktop/src/analytics.js): "1" means off.
ANALYTICS_OFF_KEY = "PERSODUB_NO_ANALYTICS"

# Job records and automatic failure reports (desktop/src/report.js): "1" means
# off.
REPORTS_OFF_KEY = "PERSODUB_NO_REPORTS"

# The buttons pressed and screens shown (desktop/src/events.js): "1" or "0";
# with no line they are recorded. The shell also holds them back whenever the
# counts are off, whatever this line says.
EVENTS_KEY = "PERSODUB_EVENTS"

# The app's language ("auto", "en" or "ko"), from Settings > About. One line
# for all three parts: the engine (app/i18n.py), the page (through
# GET /api/settings) and the desktop shell (desktop/src/i18n.js) all read it.
LANG_KEY = "PERSODUB_LANG"

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


def _assignments(path: str) -> Iterator[Tuple[str, str]]:
    """Every KEY=value line of kit.env, as (key, value), read the way the
    desktop shell reads it (kitEnv.js parseEnvFile) so the two cannot disagree
    about what a line says: a byte-order mark at the top of the file is not
    part of the first key, a leading `export ` is dropped, and one pair of
    quotes around a value is taken off. A kit.env saved by Notepad with a mark,
    or one with PERSODUB_NO_ANALYTICS="1", read here as having no such line,
    so a computer that had turned everything off looked partly on.

    Nor does a byte that is not UTF-8 stop the reading, as it does not stop the
    shell's: a kit.env saved in the computer's own encoding (cp949, a Korean
    note or folder name in it) reads with U+FFFD where those bytes are and
    every other line as written. Refusing the whole file answered 500 to every
    route that reads a setting, and the page then showed Share usage data on
    for a computer that had turned it off."""
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            yield key.strip(), value


def read_key_status() -> Optional[Dict[str, bool]]:
    """{key_set booleans} from kit.env, or None when there is no kit."""
    path = env_path()
    if not path or not os.path.exists(path):
        return None
    status = dict.fromkeys(MANAGED_KEYS, False)
    for key, value in _assignments(path):
        if key in status and value:
            status[key] = True
    return status


def read_value(key: str) -> Optional[str]:
    """The current value of one kit.env key, last assignment wins (matching
    kitEnv.js's parse). None when unset, empty, or there is no kit."""
    path = env_path()
    if not path or not os.path.exists(path):
        return None
    value = None
    for k, v in _assignments(path):
        if k == key and v:
            value = v
    return value


def defined_value(key: str) -> Optional[str]:
    """What kit.env ASSIGNS to `key`: the value, or "" when the line is there
    but empty, or None when the file has no such line (or there is no kit).

    Unlike read_value, an empty assignment is an answer rather than a miss --
    that is the whole point. `PERSO_API_KEY=` is what Settings writes when the
    user deletes a key, and it has to mean "there is no key", not "look
    somewhere else". Last assignment wins, matching kitEnv.js's parse.
    """
    path = env_path()
    if not path or not os.path.exists(path):
        return None
    value = None
    for k, v in _assignments(path):
        if k == key:
            value = v
    return value


def current_value(key: str) -> str:
    """The value in force right now: whatever kit.env says, and only if kit.env
    says nothing at all, the process environment. "" when neither has it.

    kit.env wins so a key saved seconds ago is used by the very next dub -- the
    process env only holds what existed when the app started, so reading it
    first would make every saved key wait for a restart. Crucially, kit.env
    wins even when it assigns an EMPTY value: a user who deletes their key in
    Settings must actually lose it, not silently keep dubbing on the key the
    process happened to start with. The env fallback is for a kit.env that
    never mentions the key -- server deployments, which have no kit at all.
    """
    defined = defined_value(key)
    if defined is not None:
        return defined
    return os.environ.get(key, "") or ""


def _write_env(to_set: Dict[str, str]) -> None:
    """Write KEY=value lines into kit.env, backing it up first (kit.env.bak is
    the file as it was before this write).

    Raises FileNotFoundError without a kit, even when there is nothing to
    write: a caller that thinks it saved something must not be told it did."""
    path = env_path()
    if not path or not os.path.exists(path):
        raise FileNotFoundError("kit.env not found -- not a desktop install")
    for v in to_set.values():
        # A newline would inject arbitrary KEY=value lines into the engine env.
        if any(ch in v for ch in "\r\n") or not v.isprintable():
            # Imported here: app/i18n.py reads its setting through this module.
            from app.i18n import t
            raise ValueError(t("API keys must be a single line of printable text"))
    if to_set:
        shutil.copy2(path, path + ".bak")
        # A byte that is not UTF-8 is carried through the rewrite as the byte
        # it was (surrogateescape, in and out), so a line this write does not
        # set -- a note or a folder name in the computer's own encoding -- is
        # still what its owner saved.
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
        new_text = update_env_text(text, to_set)
        # Written beside it and moved over it, as the shell's writer does
        # (kitEnv.js setKitEnvValue): kit.env is never seen half-written, and a
        # write that stops part way leaves the file as it was.
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write(new_text)
            os.chmod(tmp, 0o600)
            try:
                os.replace(tmp, path)
            except OSError:
                # Windows will not replace a file another program has open at
                # that moment (the shell reading it, a virus scanner): then it
                # is written in place, as it always was before.
                with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(new_text)
        finally:
            # No copy of the keys is left lying beside them, whatever happened.
            with contextlib.suppress(OSError):
                os.remove(tmp)
        # Keys live here now -- keep both files owner-only.
        os.chmod(path, 0o600)
        os.chmod(path + ".bak", 0o600)


# The per-stage dub defaults (app/setup.py) live in kit.env too. Not API keys,
# so not in MANAGED_KEYS; the same writer, the same backup, the same 0600.
DEFAULT_KEYS = ("DUB_MODE", "SEP_ENGINE", "STT_ENGINE", "TRANSLATE_ENGINE", "VOICE_QUALITY",
                "TTS_ENGINE")


def write_values(values: Dict[str, str]) -> None:
    """Write dub-default lines into kit.env (with a .bak backup). Only the
    DEFAULT_KEYS are accepted -- everything else in that file is an API key
    or the shell's own configuration, and this is not the door for those."""
    bad = [k for k in values if k not in DEFAULT_KEYS]
    if bad:
        raise ValueError("not a dub default: %s" % ", ".join(bad))
    _write_env(dict(values))


def write_keys(values: Dict[str, Optional[str]]) -> Dict[str, bool]:
    """Write values into kit.env (with a .bak backup) and return the resulting
    set/unset status. None leaves a key untouched; an empty string CLEARS it
    (writes `KEY=`) -- without this, a mistyped key or a stale workspace pin
    could never be removed from the app. Raises FileNotFoundError without a kit."""
    _write_env({k: v for k, v in values.items() if k in MANAGED_KEYS and v is not None})
    return read_key_status() or {}


def read_share_usage() -> bool:
    """Whether the Share usage data switch is on. Off only when the usage counts
    and the failure reports are both off: the shell holds the button events back
    whenever the counts are off, so those two lines together mean nothing
    leaves, with or without an events line. Absent means on."""
    return not (read_value(ANALYTICS_OFF_KEY) == "1" and read_value(REPORTS_OFF_KEY) == "1")


def write_share_usage(on: bool) -> None:
    """Turn the three lines on or off together, in one write. Takes effect on
    the next send -- the shell re-reads kit.env every time, so nothing waits
    for a restart."""
    _write_env({ANALYTICS_OFF_KEY: "0" if on else "1",
                REPORTS_OFF_KEY: "0" if on else "1",
                EVENTS_KEY: "1" if on else "0"})


def settle_share_usage() -> None:
    """Bring a kit.env from the versions with three switches to one answer.

    A computer that had only some of them off reads as on (read_share_usage),
    so its three lines are all written as on; otherwise the screen would say
    on while one line still held something back. Everything on and everything
    off are left exactly as they are, file untouched, which is also what makes
    a second call do nothing. Without a kit (a run from source) no line reads
    as off, so nothing is written."""
    any_off = (read_value(ANALYTICS_OFF_KEY) == "1" or read_value(REPORTS_OFF_KEY) == "1"
               or read_value(EVENTS_KEY) == "0")
    if any_off and read_share_usage():
        write_share_usage(True)


def write_language(value: str) -> None:
    """Save the app's language setting. The caller checks the value; the
    engine switches through app.i18n.set_language, the shell re-reads this
    line at its next launch."""
    _write_env({LANG_KEY: value})
