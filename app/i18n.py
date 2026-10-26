"""The engine's sentences in the user's language.

The English sentence in the code IS the key: t("Unknown job: {jid}", jid=jid)
looks that sentence up in the language's table (app/i18n/app.<code>.json, a
flat {"English": "translation"}) and answers the English itself when there is
no entry, so an untranslated sentence still reads instead of showing a key.
The same scheme as the page (ui/src/i18n.mjs) and the desktop shell
(desktop/src/i18n.js).

Only for what a person reads -- an HTTPException detail, a job's message or
notice, a tool result the Dub Agent passes on. Log lines stay English: the
page's progress parser, the privacy masks and the failure reports read them.

Which language: kit.env's PERSODUB_LANG ("auto", "en" or "ko"), the one
Settings > About writes. "auto" (or nothing) means the computer's language,
which the desktop shell reads from the system and hands the engine at launch
as PERSODUB_LOCALE ("ko" or "en"); a plain server run has none and speaks
English. Decided on first use and kept, because t() may run for every line of
a job; saving the setting calls set_language, so no restart is needed.
"""
import json
import os
import re
from typing import Dict, Optional, Tuple

from app.settings_env import LANG_KEY, current_value

# The languages a table can exist for; "en" needs none.
LANGUAGES = ("en", "ko")
# What PERSODUB_LANG may say.
SETTINGS = ("auto",) + LANGUAGES
LOCALE_ENV = "PERSODUB_LOCALE"

_TABLE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "i18n")
_tables: Dict[str, Dict[str, str]] = {}
_language: Optional[str] = None   # None: not decided yet


def saved_setting() -> str:
    """kit.env's PERSODUB_LANG as Settings shows it: "auto" unless it says en or ko."""
    value = current_value(LANG_KEY).strip().lower()
    return value if value in SETTINGS else "auto"


def resolve(setting: Optional[str]) -> str:
    """The language a setting means on this computer."""
    setting = (setting or "").strip().lower()
    if setting in LANGUAGES:
        return setting
    locale = os.environ.get(LOCALE_ENV, "").strip().lower()
    return locale if locale in LANGUAGES else "en"


def set_language(setting: Optional[str]) -> None:
    """Speak what `setting` ("auto", "en", "ko") means from the next t() on."""
    global _language
    _language = resolve(setting)


def current_language() -> str:
    global _language
    if _language is None:
        _language = resolve(saved_setting())
    return _language


def _table(code: str) -> Dict[str, str]:
    if code not in _tables:
        try:
            with open(os.path.join(_TABLE_DIR, f"app.{code}.json"), encoding="utf-8") as f:
                _tables[code] = json.load(f)
        except (OSError, ValueError):
            # A missing or broken table leaves that language on English
            # rather than failing whatever was about to be said.
            _tables[code] = {}
    return _tables[code]


_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def t(key: str, **values) -> str:
    """The sentence `key` in the current language, `{name}` filled from `values`.

    Not str.format: a sentence may carry braces of its own, and a {name} with
    no value stays as written, which is easier to notice than a KeyError.
    """
    code = current_language()
    return _fill(_table(code).get(key, key) if code != "en" else key, values)


def english(key: str, **values) -> str:
    """The sentence in English, {app} and `values` filled: for a sentence the
    page translates itself by matching it (app/engines_status.py)."""
    return _fill(key, values)


def both(key: str, **values) -> Tuple[str, str]:
    """(English, the user's language): the sentence `key` filled both ways.

    For a sentence stored in English and shown in the user's language: a
    failed job's error, which the desktop app sorts failures by and the
    failure reports send, beside its error_shown (app/jobs.py shown_error).
    tests/test_i18n.py counts both("...") as a key, as it does t("...").
    """
    return _fill(key, values), t(key, **values)


APP_NAME_ENV = "PERSODUB_APP_NAME"


def app_name() -> str:
    """What the sentences call the app: the desktop shell passes the edition's
    name (desktop/src/edition.js displayName); a plain server run is PersoDub."""
    return os.environ.get(APP_NAME_ENV, "").strip() or "PersoDub"


def _fill(text: str, values) -> str:
    text = text.replace("{app}", app_name())
    if not values:
        return text
    return _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), text)
