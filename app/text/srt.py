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


# Syllables per second of Qwen3-TTS speech by language, as _count_syllables counts them (one
# character for ko/ja/zh, one vowel group for Latin scripts -- Cyrillic has none, so for ru it is
# words). Measured 2026-10-02 for every language the local voice speaks: 20 natural sentences of
# mixed length each, voiced through the app's own engine call in a neutral cloned voice (Fast
# mode seeds), lead/tail silence trimmed as the assembly does, renders the Fast check would remake
# left out, median rate. The guesses before (ko 4.4, ja 7.5, es 6.5, ru 5.0 by default) sized the
# first translation of a Korean line about a quarter too short and a Russian one over twice too long.
# en and ko were measured again on 2026-10-07 off finished dubs (two clips, 17 lines, the engine's
# actual lines in the cloned voices): 4.2 and 6.2. With the 2026-10-02 figures the first English
# translation came out long and was asked again up to three times (251 s of translation on a
# one-minute clip, 126 s with these), and the Korean one short (half the empty time with these).
_SYL_PER_SEC = {
    "en": 4.2, "english": 4.2,
    "ko": 6.2, "korean": 6.2,
    "ja": 6.13, "japanese": 6.13,
    "zh": 5.23, "chinese": 5.23,
    "es": 4.83, "spanish": 4.83,
    "fr": 5.15, "french": 5.15,
    "de": 4.96, "german": 4.96,
    "it": 4.83, "italian": 4.83,
    "pt": 5.18, "portuguese": 5.18,
    "ru": 2.19, "russian": 2.19,
}

_VOWEL_GROUP = re.compile(r"[aeiouyAEIOUY]+")
_HAN_OR_KANA = re.compile("[\u3040-\u30ff\u4e00-\u9fff]")
# Cyrillic and Greek write every vowel, and one vowel is one syllable.
_CYRILLIC_OR_GREEK_VOWEL = re.compile("[аеёиоуыэюяіїєўАЕЁИОУЫЭЮЯІЇЄЎαεηιουωάέήίόύώϊϋΐΰΑΕΗΙΟΥΩΆΈΉΊΌΎΏ]")


def _count_syllables(text: str, lang: str) -> int:
    """Rough syllable count. For Hangul/Kanji/Kana one character ~ one syllable; for Latin scripts one vowel group ~ one syllable."""
    lang = lang.lower()
    # A language with no pace of its own in the table above (OmniVoice speaks
    # 646) is counted by its letters when it is written in Han characters or
    # kana: Cantonese has no spaces and no Latin vowels, so the count below
    # made a whole line one syllable.
    if lang in ("ko", "korean", "ja", "japanese", "zh", "chinese") or (
            lang not in _SYL_PER_SEC and _HAN_OR_KANA.search(text)):
        # exclude punctuation/whitespace; one character ~ one syllable (digits also count as one syllable)
        return sum(1 for ch in text if ch.isalnum())
    if lang not in _SYL_PER_SEC and not _VOWEL_GROUP.search(text):
        # No Latin vowel to count in a language with no pace of its own
        # (Ukrainian, Greek, Arabic, Hindi, Thai): the count below made every
        # word one syllable, so a line looked short and was asked for longer.
        # Cyrillic and Greek are counted by their vowels. Any other script is
        # an estimate, not a measurement: two letters to a syllable, which is
        # near enough for scripts that leave vowels out or write them as marks.
        vowels = len(_CYRILLIC_OR_GREEK_VOWEL.findall(text))
        letters = sum(1 for ch in text if ch.isalpha())
        digits = sum(ch.isdigit() for ch in text)
        return max(vowels or letters // 2, len(text.split())) + digits
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
# A dubbed line is cut where the speaker really pauses, not at every full stop:
# sentences said without a pause of PAUSE_SEC are voiced as one line, up to
# MAX_LINE_SEC (owner decision 2026-10-01). Short lines left no room for a
# slightly long translation and were voiced one by one with no flow between them.
PAUSE_SEC = 0.5
MAX_LINE_SEC = 10.0
# A line ends where a sentence ends, when the transcript shows sentence ends at
# all: Whisper's own blocks and a speaker's pauses fall inside sentences half the
# time (brown: 6 of 9 lines ended mid-sentence, 2026-10-07), and a line cut there
# is translated as a fragment ("그런데 그는...").
_SENTENCE_END = re.compile(r"[.!?…。！？]['\"”’)]*\s*$")


def ends_sentence(text: str) -> bool:
    return bool(_SENTENCE_END.search(text or ""))


def split_at_sentence_ends(cues: List[Cue]) -> List[Cue]:
    """Each cue cut into its sentences, timed from its words (whisper_transcribe
    --word-timestamps); a cue without words, or with one sentence, is kept."""
    out: List[Cue] = []
    for c in cues:
        words = c.get("words") or []
        if not words:
            out.append(c)
            continue
        groups: List[list] = [[]]
        for w in words:
            groups[-1].append(w)
            if ends_sentence(w["word"]):
                groups.append([])
        groups = [g for g in groups if g]
        if len(groups) <= 1:
            out.append(c)
            continue
        for i, g in enumerate(groups):
            start = c["start"] if i == 0 else g[0]["start"]
            end = c["end"] if i == len(groups) - 1 else g[-1]["end"]
            out.append(dict(c, start=start, end=end, text="".join(w["word"] for w in g).strip(), words=g))
    return out


def clamp_cues(cues: List[Cue], duration) -> List[Cue]:
    """Cues cut to end where the video does; one that starts there or later is
    dropped. Whisper put a line at 0-29.98 s on a 10 s clip (its 30 s window,
    Windows B5/D14 2026-10-06). An unknown duration leaves them as they are."""
    if not duration:
        return cues
    return [dict(c, end=min(c["end"], duration)) for c in cues if c["start"] < duration]


def merge_by_pause(cues: List[Cue]) -> List[Cue]:
    """Join each cue onto the previous one when the same speaker goes on with
    less than PAUSE_SEC of silence, or mid-sentence however long the pause (in a
    transcript that marks sentence ends), and the joined line stays within
    MAX_LINE_SEC. An empty cue is never joined (it is a line still to be filled in)."""
    punctuated = any(ends_sentence(c["text"]) for c in cues)
    out: List[Cue] = []
    for c in cues:
        p = out[-1] if out else None
        goes_on = p is not None and (c["start"] - p["end"] < PAUSE_SEC
                                     or (punctuated and not ends_sentence(p["text"])))
        if (p and c.get("speaker_id") == p.get("speaker_id")
                and goes_on and c["end"] - p["start"] <= MAX_LINE_SEC
                and c["text"].strip() and p["text"].strip()):
            joined = dict(p, end=c["end"], text=p["text"].rstrip() + " " + c["text"].lstrip())
            if "words" in p or "words" in c:
                joined["words"] = p.get("words", []) + c.get("words", [])
            out[-1] = joined
        else:
            out.append(dict(c))
    return out


def split_cues_into_sentences(cues: List[Cue]) -> List[Cue]:
    """Split a cue longer than MAX_LINE_SEC into sentences (.?!), dividing time in proportion to character
    count, then join the sentences back into lines of at most MAX_LINE_SEC.

    When Whisper lumps several sentences into one long block, this spreads them out to keep each dubbed line
    short enough to voice. A cue within MAX_LINE_SEC is kept whole, however many sentences it holds.
    Fragments that are too short (< MIN_SENT_DUR) are merged into a neighboring sentence to prevent ultra-short cues.
    """
    out: List[Cue] = []
    for c in cues:
        parts = [p.strip() for p in _SENT_SPLIT.split(c["text"].strip()) if p.strip()]
        if len(parts) <= 1 or c["end"] - c["start"] <= MAX_LINE_SEC:
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
        out.extend(merge_by_pause(_merge_short_pieces(pieces)))
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
            # never swallow a line left untranslated (empty) -- merged away, it
            # would vanish from the script instead of being marked for a fix
            if not nxt["text"].strip():
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
