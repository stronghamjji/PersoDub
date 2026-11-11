"""What every dubbing translation prompt shares, and how its answer is read.

The standard dubbing prompt and the one speech level a Korean script keeps;
the answer's shape (a JSON array holding exactly one string per line); the
check that a line came back in the target language's letters; and the
re-asks when an answer breaks the format. The translators (app/translate.py)
and the length passes (app/text/length_fit.py, app/text/pace_fit.py) all
build on these. They live here, below all three, so that none of those
modules has to import another one back.
"""
import json
import re
from typing import List, Optional

from app.config import LANGUAGE_NAMES


# --- Dubbing translation prompt/parsing (shared across engines, testable without network) ---
def build_dub_prompt(
    texts: List[str],
    target_lang: str,
    source_lang: Optional[str],
    durations: Optional[List[float]],
    fuller: bool = False,
) -> str:
    lines = []
    for i, t in enumerate(texts):
        if durations and durations[i] < 0.8:
            # Ultra-short line: impossible instructions like "within 0.3s" break the model
            slot = " (very short exclamation — one or two words only)"
        elif durations:
            slot = f" (must fit within {durations[i]:.1f}s)"
        else:
            slot = ""
        lines.append(f"{i + 1}.{slot} {t}")
    src = f"from {source_lang} " if source_lang else ""
    length_rule = (
        "★Most important: translate each line to a length that can be spoken at a natural pace within its time. "
        "It must not be longer than the original (keep the syllable count similar to or shorter than the original).\n"
    )
    if fuller:
        length_rule = (
            "★These lines are too short for the given time, so dubbing them leaves long silences. "
            "Bring out more of the original's nuance and flavor, and translate again to a length that "
            "naturally fills the time. But never exceed the given time.\n"
        )
    return (
        f"You are a professional dubbing translator. Translate the {len(texts)} subtitle lines below {src}into natural "
        f"colloquial {target_lang}.\n"
        + length_rule
        + "Keep the original tone (informal stays informal, formal stays formal), preserve the emotion and mood, "
        "and translate into natural colloquial dubbing lines an actor can perform. No stiff literary or translationese style.\n"
        + register_rule(target_lang)
        + "Do not merge or split lines.\n"
        "These lines are spoken aloud: no dashes (— – --), parentheses or brackets. Use commas and periods only.\n"
        f"Output only a JSON array containing exactly {len(texts)} strings in order. No other text.\n\n"
        + "\n".join(lines)
    )


def parse_json_array(raw: str, n: int) -> List[str]:
    s = raw.strip()
    # Reasoning models (e.g. Qwen3) prepend a <think>...</think> block — drop it.
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL).strip()
    s = re.sub(r"^```[a-zA-Z]*", "", s).strip().strip("`").strip()
    start, end = s.find("["), s.rfind("]")
    if start == -1 or end == -1:
        # The answer's length, never the answer: it is the video's dialogue in
        # translation, and this sentence goes into the job log and, on a
        # failure, into a public issue's Error box (issues #86, #88, #102).
        raise ValueError(f"Could not find a JSON array in the translation response (response length {len(raw)})")
    arr = json.loads(s[start : end + 1])
    if len(arr) != n:
        raise ValueError(f"Translated line count mismatch: got {len(arr)}, need {n}")
    # A line is a string. str() of whatever else came back used to go straight
    # into the script -- a dict's braces and quotes, read aloud by the voice
    # (Windows full test, 2026-09-17). An object holding exactly one string is
    # that string; anything else is a malformed answer, and raising here is what
    # makes the caller ask again.
    out = []
    for x in arr:
        if isinstance(x, dict):
            strings = [v for v in x.values() if isinstance(v, str)]
            x = strings[0] if len(strings) == 1 else x
        if not isinstance(x, str):
            raise ValueError(f"A translated line is not text (it is a {type(x).__name__})")
        out.append(x)
    return out


# The ten languages script_ok knows the script of, as the app names a target:
# by code or by name, lowercased.
_SCRIPT_KNOWN = set(LANGUAGE_NAMES) | {name.lower() for name in LANGUAGE_NAMES.values()}
_NON_LATIN = re.compile(r"[가-힣ぁ-んァ-ヶ一-鿕]")
_HANGUL_CHAR = re.compile(r"[가-힣]")
_LATIN_CHAR = re.compile(r"[a-zA-ZÀ-ɏ]")  # includes extended Latin (đ, é, etc.)
# An all-capitals short word Korean itself writes in Latin letters: AI, PM,
# UI UX, GPT-4.0, 오픈AI. ChatGPT keeps them, and treating them as English
# re-asked every such line twice and warned "needs review" on a good script
# (5-minute runs, 2026-09-24).
_ACRONYM = re.compile(r"(?<![A-Za-z])[A-Z]{1,6}[0-9]*(?:[.\-][A-Z0-9]+)*(?![a-z])")


def register_rule(target_lang: str) -> str:
    """One speech level for a whole Korean script. English has none to keep,
    so "keep the original tone" let each line pick its own and a video came
    out half 해요체, half 반말 (user chose 해요체, 2026-09-25)."""
    if target_lang.lower() in ("ko", "korean"):
        return ("Korean speech level: write EVERY line in polite 해요체 (sentences end in -요), "
                "the same for the whole video, even when the original is casual.\n")
    return ""


def script_ok(text: str, lang: str) -> bool:
    """Quick check that the translation is in the target language's script (prevents wrong-language output).

    Only for the ten languages whose script is written down here. Any other
    passes: OmniVoice speaks 646, and "not Korean, Japanese or Chinese, so
    Latin letters" refused every line of Cantonese, Wu or Hakka."""
    lang = lang.lower()
    if lang not in _SCRIPT_KNOWN:
        return True
    if lang in ("ko", "korean"):
        # Dubbing lines must be pure Hangul for the TTS to read — mixed-in Latin letters are invalid
        # (blocks real cases like "덴 đâu?", "dent 자리에")
        return bool(_HANGUL_CHAR.search(text)) and not _LATIN_CHAR.search(_ACRONYM.sub("", text))
    if lang in ("ja", "japanese", "zh", "chinese"):
        return bool(_NON_LATIN.search(text))
    # Latin-script languages: invalid if Hangul, kana, or Han characters are mixed in
    return not _NON_LATIN.search(text)


def ask_with_retry(ask, prompt: str, n: int, tries: int = 3) -> List[str]:
    """If the LLM doesn't respect the line count, re-ask with a correction appended (up to `tries` times).

    (tries: an engine whose every ask is a message off an account's allowance
    says so with `format_tries`; see app/translate.py _translate_with_fallback.)"""
    last_err = None
    for attempt in range(tries):
        raw = ask(prompt if attempt == 0 else prompt + f"\n\n(Note: do not merge lines; answer only with a JSON array of exactly {n} items.)")
        try:
            return parse_json_array(raw, n)
        except ValueError as e:
            last_err = e
    raise last_err


# What a line the translator never answered in a usable form is left holding.
# Empty on purpose: an empty line is not spoken (app/qwen_pipeline.py synth_lines
# leaves it silent), and the script marks it "Not translated" (app/dub_script.py
# load_lines) so it can be written by hand or by the agent. One such line used
# to fail the whole job -- issue #82 lost a 969-line dub to it.
UNTRANSLATED = ""


def one_line_or_untranslated(ask, prompt: str, tries: int = 3) -> str:
    """The last-resort single-line ask. A line that still cannot be read after
    its retries is UNTRANSLATED rather than the end of the job. Only a bad
    answer is forgiven: a translator that cannot be reached at all still raises,
    because it would fail every other line the same way."""
    try:
        return ask_with_retry(ask, prompt, 1, tries)[0]
    except ValueError:
        return UNTRANSLATED
