"""SRT subtitle parsing/building utilities."""
import re
from typing import List, TypedDict

_TIME = re.compile(r"(\d\d):(\d\d):(\d\d)[,.](\d\d\d)")


class Cue(TypedDict):
    start: float  # seconds
    end: float
    text: str


def _to_seconds(ts: str) -> float:
    h, m, s, ms = _TIME.match(ts).groups()
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _to_ts(sec: float) -> str:
    if sec < 0:
        sec = 0.0
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms == 1000:
        ms = 0
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(text: str) -> List[Cue]:
    """SRT string -> list of subtitle cues."""
    cues: List[Cue] = []
    blocks = re.split(r"\n\s*\n", text.strip())
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        # find the timing line
        time_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if time_idx is None:
            continue
        times = _TIME.findall(lines[time_idx])
        if len(times) < 2:
            continue
        left, right = lines[time_idx].split("-->")
        start = _to_seconds(_TIME.search(left).group(0))
        end = _to_seconds(_TIME.search(right).group(0))
        body = " ".join(lines[time_idx + 1 :]).strip()
        cues.append({"start": start, "end": end, "text": body})
    return cues


# Approximate syllables per second by language -- based on natural speaking pace (VideoLingo approach)
# ko/en: 2026-07-30 measured Qwen3-TTS rates (47 ko lines / 25 en lines, real wav durations vs.
# translated.srt text) -- ko median 4.38 (avg 4.29), en median 4.46 (avg 4.35). The old values
# (ko 7.0, en 4.8) assumed Korean is spoken ~46% faster than English; our TTS voice actually
# speaks both at nearly the same rate, so budgets built on the old numbers ran ~1.4x-1.6x too
# generous and lines overflowed their slots (speech-rate budget revision, 2026-07-30).
_SYL_PER_SEC = {
    "en": 4.45, "english": 4.45,
    "es": 6.5, "spanish": 6.5,
    "ko": 4.4, "korean": 4.4,
    "ja": 7.5, "japanese": 7.5,
    "zh": 5.2, "chinese": 5.2,
}

_VOWEL_GROUP = re.compile(r"[aeiouyAEIOUY]+")


def _count_syllables(text: str, lang: str) -> int:
    """Rough syllable count. For Hangul/Kanji/Kana one character ~ one syllable; for Latin scripts one vowel group ~ one syllable."""
    lang = lang.lower()
    if lang in ("ko", "korean", "ja", "japanese", "zh", "chinese"):
        # exclude punctuation/whitespace; one character ~ one syllable (digits also count as one syllable)
        return sum(1 for ch in text if ch.isalnum())
    n = 0
    for word in text.split():
        syl = len(_VOWEL_GROUP.findall(word)) + sum(ch.isdigit() for ch in word)
        # a silent trailing e ("have", "dance", "made") is not pronounced, so subtract it (-le is the exception: little)
        w = word.strip(".,!?'\"").lower()
        if syl > 1 and w.endswith("e") and not w.endswith("le"):
            syl -= 1
        n += max(syl, 1)  # a word with no vowels ("hmm") still counts as at least 1 syllable
    return n


def estimate_seconds(text: str, lang: str) -> float:
    """Estimate how many seconds this text takes to speak at a natural pace (syllable-based)."""
    sps = _SYL_PER_SEC.get(lang.lower(), 5.0)
    return _count_syllables(text, lang) / sps


_SENT_SPLIT = re.compile(r"(?<=[.!?。！？])\s+")
MIN_SENT_DUR = 0.8  # sentence fragments shorter than this get merged into a neighbor (avoids ultra-short cues)


def split_cues_into_sentences(cues: List[Cue]) -> List[Cue]:
    """Split coarse subtitle cues into sentences (.?!), dividing time in proportion to character count.

    When Whisper lumps several sentences into one block, this spreads them out per sentence to align dubbing timing.
    Fragments that are too short (< MIN_SENT_DUR) are merged into a neighboring sentence to prevent ultra-short cues.
    """
    out: List[Cue] = []
    for c in cues:
        parts = [p.strip() for p in _SENT_SPLIT.split(c["text"].strip()) if p.strip()]
        if len(parts) <= 1:
            out.append(c)
            continue
        total = sum(len(p) for p in parts) or 1
        dur = c["end"] - c["start"]
        pieces: List[Cue] = []
        t = c["start"]
        for i, p in enumerate(parts):
            end = c["end"] if i == len(parts) - 1 else round(t + dur * (len(p) / total), 3)
            # dict(c, ...) so every other key on the source cue survives the
            # split -- notably speaker_id, which borrow_time's cross-speaker
            # guard reads. Rebuilding a bare {start,end,text} dropped it, and a
            # label-less cue silently defeated that guard.
            pieces.append(dict(c, start=round(t, 3), end=end, text=p))
            t = end
        out.extend(_merge_short_pieces(pieces))
    return out


def _merge_short_pieces(pieces: List[Cue]) -> List[Cue]:
    """Merge fragments shorter than MIN_SENT_DUR into the previous one (or the next one if it's the first)."""
    merged: List[Cue] = []
    for p in pieces:
        if merged and (p["end"] - p["start"]) < MIN_SENT_DUR:
            merged[-1]["end"] = p["end"]
            merged[-1]["text"] = (merged[-1]["text"] + " " + p["text"]).strip()
        else:
            merged.append(p)
    # if the first fragment itself is too short, merge it into the next one
    if len(merged) > 1 and (merged[0]["end"] - merged[0]["start"]) < MIN_SENT_DUR:
        merged[1]["start"] = merged[0]["start"]
        merged[1]["text"] = (merged[0]["text"] + " " + merged[1]["text"]).strip()
        merged = merged[1:]
    return merged


# How far a line may exceed its (gap-adjusted) slot before merging it into the
# next line is worth the cost. Merging is destructive -- it swallows whatever sits
# in between, so a laughter beat or sound effect is erased (see
# test_borrow_time_uses_gap_instead_of_merging for the real Joker 2:23 case). A
# line left un-merged is not truncated; nothing downstream shortens it, so it just
# runs slightly into the following silence, which is the cheaper failure.
#
# NB was named MAX_SPEED, described as "maximum post-TTS speed-up (1.5x)". That
# justification is dead -- this app has no time-stretch/atempo stage at all (see
# the stretch watchdog in app/qwen_assemble.py). The 1.5 value is kept because it
# is doing a real job as a merge tolerance, not because of the speed-up story.
# Deliberately NOT tied to len_fit.WINDOW_HIGH: that window decides "re-translate
# this line", a different and much cheaper remedy than merging.
MERGE_TOLERANCE = 1.5


# Maximum time (seconds) that may be borrowed from the silence before the next line, before resorting to merging.
# Merging swallows any laughter/sound effects in between into the speech region, so it's a last resort.
BORROW_SPILL = 0.4
BORROW_SPILL_BUFFER = 0.05  # headroom kept so it doesn't overlap the next line


def borrow_time(cues: List[Cue], lang: str, max_group: int = 3) -> List[Cue]:
    """Borrow time for a line that overruns its slot by more than MERGE_TOLERANCE, by merging it with the next line.

    Before merging, it first tries borrowing a little of the silence before the next line (up to BORROW_SPILL) --
    if that is enough, no merge happens (to preserve laughter/breaths in between).
    To keep dialogue order, it only merges forward (with the next line) and merges at most
    max_group lines at a time. If the last line overflows, there is nowhere to borrow from, so it is
    left as-is -- nothing downstream shortens it, so it simply runs long.
    """
    out: List[Cue] = []
    i = 0
    while i < len(cues):
        cur = dict(cues[i])
        used = 1
        while used < max_group and i + 1 < len(cues):
            nxt = cues[i + 1]
            # never merge lines from different speakers -- the merged line is
            # synthesized in one voice, so a cross-speaker merge puts one
            # character's words in another's mouth
            if cur.get("speaker_id") != nxt.get("speaker_id"):
                break
            slot = cur["end"] - cur["start"]
            gap = nxt["start"] - cur["end"]
            if gap > BORROW_SPILL_BUFFER:
                slot += min(gap - BORROW_SPILL_BUFFER, BORROW_SPILL)
            if estimate_seconds(cur["text"], lang) <= slot * MERGE_TOLERANCE:
                break
            cur["end"] = nxt["end"]
            cur["text"] = (cur["text"] + " " + nxt["text"]).strip()
            i += 1
            used += 1
        out.append(cur)
        i += 1
    return out


def build_srt(cues: List[Cue]) -> str:
    """List of subtitle cues -> SRT string."""
    out = []
    for i, c in enumerate(cues, 1):
        out.append(str(i))
        out.append(f"{_to_ts(c['start'])} --> {_to_ts(c['end'])}")
        out.append(c["text"])
        out.append("")
    return "\n".join(out).strip() + "\n"
