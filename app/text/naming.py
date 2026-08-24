# -*- coding: utf-8 -*-
"""Turning a video's title into a folder name a filesystem will accept.

Pure string work -- knows nothing about files or HTTP, so the tests run with
nothing else present (docs/development.md).
"""
import re
import unicodedata
from typing import Iterable, Optional

# Characters a path cannot hold on macOS or Windows, plus the control range.
_ILLEGAL = re.compile(r'[/\\:*?"<>|\x00-\x1f]')
MAX_COUNTER = 999


def safe_name(raw, max_len=80):
    # type: (str, int) -> str
    """A folder-safe version of `raw`, or "" when nothing usable is left.

    Normalizes to NFC first: macOS hands back decomposed Korean (NFD), and a
    folder created under one form is not found by a name built under the other.
    An empty result means the caller should fall back to a random name.
    """
    if not raw:
        return ""
    name = unicodedata.normalize("NFC", raw)
    name = _ILLEGAL.sub("", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:max_len].strip(" .")


def next_free(base, taken):
    # type: (str, Iterable[str]) -> Optional[str]
    """`base`, or `base_001`.. if it is taken. None once three digits run out."""
    used = set(taken)
    if base not in used:
        return base
    for n in range(1, MAX_COUNTER + 1):
        candidate = "%s_%03d" % (base, n)
        if candidate not in used:
            return candidate
    return None
