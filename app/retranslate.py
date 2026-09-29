"""Translate chosen lines of a finished dub again (user, 2026-09-28).

The dub's own translation step, run over a few lines after the fact: the same
length-fit translation (app/text/length_fit.py fit_translate) against each
line's time slot, written through edit_line so the translation's first
version stays in translated.srt to compare against and put back.

A source sentence the dub split across several lines (sentence splitting runs
after translation, app/pipeline.py) is one unit here: choosing any of those
lines translates the whole sentence once, and its sentences are dealt back
over the lines by time -- the way the dub first divided them.
"""
from typing import Callable, List, Optional

from app.dub_script import edit_line, load_lines
from app.text.length_fit import fit_translate
from app.text.srt import _SENT_SPLIT


def _groups(lines: List[dict]) -> List[List[dict]]:
    """Runs of neighbouring lines that read the same source sentence."""
    out: List[List[dict]] = []
    for line in lines:
        if out and line["source"] and out[-1][-1]["source"] == line["source"]:
            out[-1].append(line)
        else:
            out.append([line])
    return out


def _deal(text: str, group: List[dict]) -> List[str]:
    """One translation over the group's lines: each sentence to the line whose
    time holds the sentence's middle, by its share of the characters."""
    if len(group) == 1:
        return [text]
    parts = [p.strip() for p in _SENT_SPLIT.split(text.strip()) if p.strip()]
    start, end = group[0]["start"], group[-1]["end"]
    total = sum(len(p) for p in parts) or 1
    out = [[] for _ in group]
    done = 0
    for p in parts:
        mid = start + (end - start) * (done + len(p) / 2) / total
        done += len(p)
        k = next((i for i, g in enumerate(group) if mid < g["end"]), len(group) - 1)
        out[k].append(p)
    if all(out):
        return [" ".join(o) for o in out]
    # Fewer sentences than lines: a line dealt nothing kept its OLD words and
    # voice beside the new ones, and the dub said the first half twice
    # (review, 2026-09-29). The words are shared out by each line's time.
    return _by_time(text.strip(), group)


def _by_time(text: str, group: List[dict]) -> List[str]:
    spaced = " " in text
    units = text.split() if spaced else list(text)
    if len(units) < len(group):
        # Fewer words than lines (one word over two lines): nothing to share.
        return [text] + [""] * (len(group) - 1)
    start, span = group[0]["start"], (group[-1]["end"] - group[0]["start"]) or 1
    cuts = [round(len(units) * (g["end"] - start) / span) for g in group]
    out, at = [], 0
    for i, cut in enumerate(cuts):
        left = len(group) - 1 - i                       # lines still to feed
        cut = len(units) if left == 0 else min(max(cut, at + 1), len(units) - left)
        out.append((" " if spaced else "").join(units[at:cut]))
        at = cut
    return out


def retranslate_lines(work_dir: str, numbers: Optional[List[int]], lang_code: str,
                      language: str, translator,
                      log: Optional[Callable[[str], None]] = None) -> List[dict]:
    """Translate the given lines (all when None) again and write the new words.

    Returns one {"line", "was", "text"} per line whose words changed."""
    lines = load_lines(work_dir, lang_code)
    wanted = set(numbers) if numbers is not None else {l["line"] for l in lines}
    unknown = sorted(n for n in wanted if not 1 <= n <= len(lines))
    if unknown:
        raise ValueError(f"There is no line {unknown[0]}.")
    groups = [g for g in _groups(lines)
              if g[0]["source"] and any(l["line"] in wanted for l in g)]
    if not groups:
        return []
    sources = [g[0]["source"] for g in groups]
    slots = [round(g[-1]["end"] - g[0]["start"], 2) for g in groups]
    if not getattr(translator, "length_rules", True):
        slots = None
    new = fit_translate(translator, sources, language, None, slots, log=log)
    changed = []
    for group, text in zip(groups, new):
        if not text.strip():
            continue   # no usable answer: the line keeps the words it had
        for line, words in zip(group, _deal(text, group)):
            if words and words != line["text"]:
                edit_line(work_dir, line["line"], words, lang_code)
                changed.append({"line": line["line"], "was": line["text"], "text": words})
    return changed
