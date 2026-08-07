# -*- coding: utf-8 -*-
"""Length-fitting translation — states a per-line 'character budget' as a number so lines fit inside their slot.

Principle (a syllable budget + paraphrase loop):
  1. For each line, character budget = slot seconds x CPS (srt_utils table) x WINDOW_HIGH (1.15),
     stated in the prompt as "within N characters"
     (the old "within X.X seconds" instruction can't be counted by an LLM → "within N chars" can be)
  2. A line is judged against a ±15% budget window (see WINDOW_LOW/WINDOW_HIGH below): if its
     estimated speech time falls outside [slot*0.85, slot*1.15] -- too long OR too short -- re-ask
     only that line for a rewrite closer to the window (up to 3 times)
  3. Accept a re-asked result only if it moved closer to the window than before — if it ultimately
     fails, keep the current one (any remaining overflow is handled by the existing borrow_time/atempo)
"""
import json
import re

from app.text.srt import _SYL_PER_SEC, estimate_seconds
from app.translate import _ask_with_retry, script_ok

# ±15% budget window (2026-07-30 calibration, replaces the old single MARGIN multiplier):
# a line's estimated speech time must land inside [slot*WINDOW_LOW, slot*WINDOW_HIGH], or it
# gets re-translated -- too long (overflow, gets cut) or too short (dead air). This unifies what
# used to be two separate checks (this file's over-budget retry + pipeline.py's FILL_RATIO
# under-fill check) into one judgment. Calibrated in the speech-rate budget revision of 2026-07-30 (section 5b).
WINDOW_LOW = 0.85
WINDOW_HIGH = 1.15
MAX_RETRY = 3      # number of re-requests
NO_BUDGET_SLOT_S = 1.0  # slots shorter than this get no budget (a breeding ground for bad grammar)

# Lines translated per draft call. Small enough that the output JSON array stays aligned
# (a single 40+ line batch silently mis-numbers its back half — measured), large enough
# to keep the local flow of the dialogue.
DRAFT_CHUNK = 6

# A few fixed, general style examples per target language. Showing the model what natural,
# colloquial, actor-performable dubbing sounds like pulls a local LLM toward that register
# (contractions, spoken endings, idiomatic word choice) far better than adjectives alone.
# These are NOT taken from any specific scene, so they are reusable and leak nothing.
_STYLE_PRIMER = {
    "ko": [
        ("Don't you dare walk away from me.", "감히 나한테서 도망칠 생각 마."),
        ("I've got nothing left to lose.", "난 더 잃을 것도 없어."),
        ("You have no idea what you've done.", "네가 무슨 짓을 했는지 넌 몰라."),
        ("We're running out of time.", "시간이 없어."),
        ("It's not what it looks like.", "이건 네 생각과 달라."),
        ("Just stay with me, okay?", "정신 차려, 응?"),
    ],
    "en": [
        ("감히 나한테서 도망칠 생각 마.", "Don't you dare walk away from me."),
        ("난 더 잃을 것도 없어.", "I've got nothing left to lose."),
        ("네가 무슨 짓을 했는지 넌 몰라.", "You have no idea what you've done."),
        ("시간이 없어.", "We're running out of time."),
        ("이건 네 생각과 달라.", "It's not what it looks like."),
        ("정신 차려, 응?", "Just stay with me, okay?"),
    ],
}

# Output-hygiene rules shared by every translation prompt. Without them local models
# (Gemma especially) leak *markdown asterisks*, [speaker] tags, or a stray foreign word.
_BANS = (
    "- Each output string is ONLY the translated line: no line numbers, no [speaker] tags, "
    "no markdown (no *asterisks*), no surrounding quotes, and never mix in another language.\n"
)


def _primer_block(target_lang):
    # type: (str) -> str
    """Style-example block for the target language ("" for languages we have no primer for)."""
    t = target_lang.lower()
    key = "ko" if t in ("ko", "korean") else "en" if t in ("en", "english") else None
    if not key:
        return ""
    ex = "\n".join("- %s\n  -> %s" % (s, d) for s, d in _STYLE_PRIMER[key])
    return (
        "Match the natural, colloquial, actor-performable style of these examples "
        "(contractions, spoken sentence endings, idiomatic word choice, no stiffness):\n%s\n\n" % ex
    )


def syllable_budget(duration_sec, lang, margin=WINDOW_HIGH):
    # type: (float, str, float) -> int
    """Slot seconds → target number of characters (syllables) speakable at a natural pace in that time.

    Sub-1-second slots would budget only 3-5 characters, which can hold no real phrase and only
    produces bad grammar — so they are exempted from the constraint (999) and left to borrow_time/speed-up.
    """
    if duration_sec < NO_BUDGET_SLOT_S:
        return 999
    sps = _SYL_PER_SEC.get(lang.lower(), 5.0)
    return max(2, int(duration_sec * sps * margin))


def in_window(estimated_sec, duration_sec):
    # type: (float, float) -> bool
    """True if the estimated speech time falls inside the ±15% budget window around the slot.

    Sub-NO_BUDGET_SLOT_S slots are exempt (always True) -- same grammar-floor reasoning as
    syllable_budget's 999 exemption.
    """
    if duration_sec < NO_BUDGET_SLOT_S:
        return True
    return duration_sec * WINDOW_LOW <= estimated_sec <= duration_sec * WINDOW_HIGH


def _window_distance(estimated_sec, duration_sec):
    # type: (float, float) -> float
    """0 if inside the window, else how far outside it (seconds) -- used to check a re-ask
    actually moved a line closer to fitting, in either direction."""
    lo, hi = duration_sec * WINDOW_LOW, duration_sec * WINDOW_HIGH
    if estimated_sec < lo:
        return lo - estimated_sec
    if estimated_sec > hi:
        return estimated_sec - hi
    return 0.0


def _unit(lang):
    # type: (str) -> str
    """Budget unit label — Korean counts easily in 'characters', Latin-script languages in 'syllables'."""
    return "characters" if lang.lower() in ("ko", "korean", "ja", "japanese", "zh", "chinese") else "syllables"


def build_budget_prompt(texts, target_lang, source_lang, budgets, scene_context=None):
    # type: (List[str], str, Optional[str], List[int], Optional[List[str]]) -> str
    """First-pass translation prompt: style examples + a per-line character budget.

    scene_context (all source lines of the scene) is shown read-only so the model keeps the
    flow and tone; only `texts` are translated. Passing a small chunk as `texts` (not the whole
    scene) keeps the output array short enough to stay aligned.
    """
    u = _unit(target_lang)
    lines = [
        ("%d. (about %d %s) %s" % (i + 1, b, u, t)) if b < 999
        else ("%d. (no length limit) %s" % (i + 1, t))
        for i, (t, b) in enumerate(zip(texts, budgets))
    ]
    src = "from %s " % source_lang if source_lang else ""
    ctx = ""
    if scene_context:
        ctx = ("The full scene, for context only (do NOT translate these — just read them for flow and tone):\n%s\n\n"
               % "\n".join("- %s" % c for c in scene_context))
    header = ("You are a professional dubbing translator. Translate the %d subtitle lines below %sinto natural colloquial %s.\n\n"
              % (len(texts), src, target_lang))
    rules = (
        "★Absolute rules (must not be broken): ① Do not drop subjects, objects, or particles just to save characters "
        "② End every sentence with a predicate (do not end on a noun or modifier) ③ Do not keep the original word order; "
        "write in %s word order.\n"
        "The character count is a 'target', not a 'hard cap' — naturalness comes first, and going up to 1.15x the target is fine. "
        "Breaking grammar to cut characters is a failed translation.\n"
        "Keep the original tone (informal stays informal), as natural colloquial dubbing lines an actor can perform. "
        "No stiff literary or translationese style. Do not merge or split lines.\n" % target_lang
    )
    tail = ("Output only a JSON array containing exactly %d strings in order. No other text.\n\n%s"
            % (len(texts), "\n".join(lines)))
    return header + _primer_block(target_lang) + ctx + rules + _BANS + tail


def build_shorten_prompt(sources, currents, target_lang, budgets):
    # type: (List[str], List[str], str, List[int]) -> str
    """Re-request: shorter, same meaning. The original is included so the meaning doesn't drift."""
    u = _unit(target_lang)
    lines = []
    for i, (src, cur, b) in enumerate(zip(sources, currents, budgets)):
        lines.append("%d. Original: %s\n   Current translation (too long): %s\n   → within %d %s"
                     % (i + 1, src, cur, b, u))
    return (
        "The %s dubbing lines below are longer than their set length. Keep the same meaning as the original while "
        "shortening each line close to the specified number of %s, and rewrite them.\n"
        "★Absolute rules: Do not drop subjects, objects, or particles. End every sentence with a predicate. "
        "Being a bit long is better than broken grammar — an ungrammatical line is a failed translation.\n"
        "You may drop less-important modifiers and filler, but keep the core meaning and emotion. Keep it colloquial.\n"
        % (target_lang, u)
        + _BANS
        + "Output only a JSON array containing exactly %d strings in order. No other text.\n\n%s"
        % (len(sources), "\n".join(lines))
    )


# 1-2 examples of good compression under a tight budget (idiomatic, not word-for-word) --
# written for this prompt, not taken from any scene, so they leak nothing and stay reusable.
_COMPRESSION_EXAMPLES = {
    "ko": [
        ("I can't believe you're actually doing this to me, after everything we've been through together.",
         "네가 진짜 이럴 줄은 몰랐어."),
    ],
    "en": [
        ("나는 이제 더 이상 너를 예전처럼 믿을 수가 없을 것 같아.",
         "I just can't trust you anymore."),
    ],
}


def _compression_examples_block(target_lang):
    # type: (str) -> str
    t = target_lang.lower()
    key = "ko" if t in ("ko", "korean") else "en" if t in ("en", "english") else None
    if not key:
        return ""
    ex = "\n".join(
        "- %s\n  -> %s (short, idiomatic, keeps the feeling -- not a literal word-for-word cut)"
        % (s, d) for s, d in _COMPRESSION_EXAMPLES[key]
    )
    return "Example of good compression under a tight budget:\n%s\n\n" % ex


def _hard_target(budget, unit, target_lang):
    # type: (int, str, str) -> str
    """Per-line hard-cap phrase for the target budget (stated in Korean for a Korean target,
    per the calibration report's 'state it as a hard rule' instruction)."""
    if target_lang.lower() in ("ko", "korean"):
        return "HARD LIMIT: 반드시 %d자 이내 (target %d %s, not a suggestion)" % (budget, budget, unit)
    return "HARD LIMIT: within %d %s -- do not exceed except as an absolute last resort" % (budget, unit)


def _hard_minimum(budget, unit, target_lang):
    # type: (int, str, str) -> str
    """Per-line hard-MINIMUM phrase for a too-short line. The 2026-07-30 v2 builds
    proved the under-window re-ask fired correctly but still shipped 0.55x-filled
    lines, because every re-ask stated _hard_target's upper cap ('within N') even
    when the problem was the line being TOO SHORT -- the model was literally told
    to stay under a ceiling while we needed it to write more. State a floor instead.
    budget is the slot's upper-edge character budget (slot*cps*WINDOW_HIGH), so the
    window's lower edge is budget*WINDOW_LOW/WINDOW_HIGH and its center budget/WINDOW_HIGH."""
    lo = max(2, int(budget * WINDOW_LOW / WINDOW_HIGH))
    target = max(lo, int(round(budget / WINDOW_HIGH)))
    if target_lang.lower() in ("ko", "korean"):
        return ("HARD MINIMUM: 반드시 %d자 이상, 목표 %d자 안팎 (지금은 너무 짧아서 "
                "화면에 어색한 침묵이 생김)" % (lo, target))
    return ("HARD MINIMUM: at least %d %s, aim for about %d -- the current line is too "
            "short and leaves dead air on screen" % (lo, unit, target))


def build_candidates_prompt(sources, currents, target_lang, budgets, directions):
    # type: (List[str], List[str], str, List[int], List[str]) -> str
    """Re-request: for each out-of-window line, ask for exactly 3 numbered candidate
    translations in this one response (parsed by parse_candidates_array, scored by
    pick_candidate against the ±15% window). Replaces asking for a single rewrite per retry
    round -- still one call, but 3 alternatives to choose from instead of one shot.

    directions[i] is "long" (too long -- shorten) or "short" (too short -- fill it out a bit);
    a batch can mix both (the unified window judgment covers over-budget and under-filled
    lines in the same re-ask).
    """
    u = _unit(target_lang)
    lines = []
    for src, cur, b, d in zip(sources, currents, budgets, directions):
        want = "too long" if d == "long" else "too short (leaves an awkward silence)"
        # Direction-aware target: a too-long line gets the upper cap, a too-short
        # line gets a MINIMUM (see _hard_minimum -- stating the cap for short lines
        # was exactly why v2's lengthen retries never produced longer candidates).
        target = _hard_target(b, u, target_lang) if d == "long" else _hard_minimum(b, u, target_lang)
        lines.append("Original: %s\n   Current translation (%s): %s\n   -> %s"
                     % (src, want, cur, target))
    lines = ["%d. %s" % (i + 1, ln) for i, ln in enumerate(lines)]
    return (
        "The %s dubbing lines below don't fit their time slot -- some are too long, some too short. "
        "For EACH line, give exactly 3 DIFFERENT candidate translations, numbered 1/2/3, that keep "
        "the original's meaning.\n"
        "★A short idiomatic phrase that keeps the feeling beats a complete, grammatically perfect "
        "long sentence when space is tight -- aim for natural spoken compression, not a "
        "word-for-word cut.\n"
        "★Absolute rules: Do not drop subjects, objects, or particles needed for meaning. End every "
        "sentence with a predicate. Keep it colloquial, natural spoken dubbing.\n"
        "For 'too short' lines: bring out more of the original's nuance and detail to fill the "
        "target length naturally -- do not just repeat words or add filler.\n"
        % target_lang
        + _compression_examples_block(target_lang)
        + _BANS
        + "Output only a JSON array of %d items, one per line in order. Each item is itself a JSON "
        "array of your 3 candidate strings (no numbering inside the string). No other text.\n\n%s"
        % (len(sources), "\n".join(lines))
    )


def _split_candidates(item):
    # type: (object) -> List[str]
    """One line's raw candidate item -> list of candidate strings (up to 3), tolerant of the
    model nesting a real list, or (fallback) returning a single numbered string
    ("1. a\\n2. b\\n3. c", "1) a", ...) or a single plain string."""
    if isinstance(item, list):
        return [str(c).strip() for c in item if str(c).strip()]
    text = str(item).strip()
    parts = re.split(r"(?:^|\n)\s*[123][.\):]\s*", text)
    parts = [p.strip() for p in parts if p.strip()]
    return parts if parts else ([text] if text else [])


def parse_candidates_array(raw, n):
    # type: (str, int) -> List[List[str]]
    """Parse a candidates-retry response: a JSON array of n items, each item that line's up to
    3 candidate strings (see _split_candidates for the tolerated shapes). Always returns
    exactly n lists (possibly empty if a line's candidates couldn't be parsed at all)."""
    s = raw.strip()
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL).strip()
    s = re.sub(r"^```[a-zA-Z]*", "", s).strip().strip("`").strip()
    start, end = s.find("["), s.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("Could not find a JSON array in the candidates response: %s" % raw[:200])
    arr = json.loads(s[start:end + 1])
    if len(arr) != n:
        raise ValueError("Candidate line count mismatch: got %d, need %d" % (len(arr), n))
    return [_split_candidates(item) for item in arr]


def _ask_candidates_with_retry(ask, prompt, n, tries=3):
    # type: (Callable[[str], str], str, int, int) -> List[List[str]]
    """Same format-recovery pattern as app.translate._ask_with_retry, for the nested
    candidates format."""
    last_err = None
    for attempt in range(tries):
        raw = ask(prompt if attempt == 0 else prompt
                  + "\n\n(Note: output exactly %d items, each item itself a JSON array of "
                    "your 3 candidate strings.)" % n)
        try:
            return parse_candidates_array(raw, n)
        except ValueError as e:
            last_err = e
    raise last_err


def pick_candidate(candidates, target_lang, duration, index=0, log=None):
    # type: (List[str], str, float, int, Optional[Callable[[str], None]]) -> str
    """From a line's (up to 3) candidate translations, pick the one closest to fitting the
    ±15% budget window. Inside-window wins outright (first one found); if none fit, pick the
    one with the smallest overshoot past the slot and log a WARNING with the line index and
    overshoot in seconds. Raises ValueError if candidates is empty."""
    log = log or (lambda m: None)
    if not candidates:
        raise ValueError("no candidates to pick from")
    scored = [(c, estimate_seconds(c, target_lang)) for c in candidates]
    if duration < NO_BUDGET_SLOT_S:
        # Budget-EXEMPT slot (grammar floor, see syllable_budget's 999) -- but
        # exempt from the budget, not from choosing wisely: in_window() is always
        # True here, so without this the FIRST candidate won arbitrarily (the v2
        # vertex build shipped a long line into a sub-1s slot exactly that way).
        # The shortest candidate is the only one with a chance to fit.
        return min(scored, key=lambda cs: (cs[1], len(cs[0])))[0]
    for c, sec in scored:
        if in_window(sec, duration):
            return c
    over = [(c, sec) for c, sec in scored if sec > duration]
    if over:
        c, sec = min(over, key=lambda cs: cs[1])
        log("   ⚠️ WARNING line %d: no candidate fit the ±15%% window — using the shortest "
            "overshoot (+%.2fs over the %.2fs slot)" % (index, sec - duration, duration))
        return c
    # all candidates are (unusually) shorter than the slot itself and still outside the
    # window's lower edge -- keep the one closest to filling it
    c, _ = max(scored, key=lambda cs: cs[1])
    log("   ⚠️ WARNING line %d: no candidate fit the ±15%% window — using the fullest "
        "one available (still short of the %.2fs slot)" % (index, duration))
    return c


def build_candidates_draft_prompt(texts, target_lang, source_lang, budgets, scene_context=None):
    # type: (List[str], str, Optional[str], List[int], Optional[List[str]]) -> str
    """First-pass translation prompt, candidates version: for EACH line, ask for exactly 3
    numbered candidate translations (not 1) respecting its character budget -- so the single
    call a paid translator ever gets (max_budget_retries=0, see app/translate.py) already
    yields a best-of-3 pick (see pick_candidate), not just one shot. Local/free translators
    get the same treatment for free (no extra cost -- still one call) and can still retry
    further with build_candidates_prompt if the pick is still out of window.

    scene_context (all source lines of the scene) is shown read-only so the model keeps the
    flow and tone; only `texts` are translated. Passing a small chunk as `texts` (not the whole
    scene) keeps the output array short enough to stay aligned.
    """
    u = _unit(target_lang)
    lines = [
        ("%d. (%s) %s" % (i + 1, _hard_target(b, u, target_lang), t)) if b < 999
        else ("%d. (no length limit) %s" % (i + 1, t))
        for i, (t, b) in enumerate(zip(texts, budgets))
    ]
    src = "from %s " % source_lang if source_lang else ""
    ctx = ""
    if scene_context:
        ctx = ("The full scene, for context only (do NOT translate these — just read them for flow and tone):\n%s\n\n"
               % "\n".join("- %s" % c for c in scene_context))
    header = ("You are a professional dubbing translator. For EACH of the %d subtitle lines below %sgive "
              "exactly 3 DIFFERENT candidate translations, numbered 1/2/3, into natural colloquial %s.\n\n"
              % (len(texts), src, target_lang))
    rules = (
        "★Absolute rules (must not be broken): ① Do not drop subjects, objects, or particles just to save characters "
        "② End every sentence with a predicate (do not end on a noun or modifier) ③ Do not keep the original word order; "
        "write in %s word order.\n"
        "★A short idiomatic phrase that keeps the feeling beats a complete, grammatically perfect long sentence "
        "when space is tight -- vary your 3 candidates from more literal/complete to more compressed/idiomatic, "
        "so at least one is likely to fit.\n"
        "Keep the original tone (informal stays informal), as natural colloquial dubbing lines an actor can perform. "
        "No stiff literary or translationese style. Do not merge or split lines.\n" % target_lang
    )
    tail = ("Output only a JSON array of %d items, one per line in order. Each item is itself a JSON array of "
            "your 3 candidate strings (no numbering inside the string). No other text.\n\n%s"
            % (len(texts), "\n".join(lines)))
    return (header + _primer_block(target_lang) + ctx + rules
            + _compression_examples_block(target_lang) + _BANS + tail)


def _draft_in_chunks(engine, texts, target_lang, source_lang, budgets):
    # type: (TranslationEngine, List[str], str, Optional[str], List[int]) -> List[str]
    """First-pass draft (single candidate per line), DRAFT_CHUNK lines at a time. Used only
    when fit_translate has no durations/window to pick a candidate against (see
    _draft_candidates_in_chunks for the length-fit path, which is what actually needs 3
    candidates). Each call sees the whole scene as read-only context (for flow) but only
    translates its chunk, so the JSON array stays short and aligned. Falls back to one line
    at a time if a chunk's count keeps mismatching."""
    out = []  # type: List[str]
    for a in range(0, len(texts), DRAFT_CHUNK):
        chunk, chunk_budgets = texts[a:a + DRAFT_CHUNK], budgets[a:a + DRAFT_CHUNK]
        try:
            out.extend(_ask_with_retry(
                engine._ask,
                build_budget_prompt(chunk, target_lang, source_lang, chunk_budgets, scene_context=texts),
                len(chunk)))
        except ValueError:
            for t, b in zip(chunk, chunk_budgets):
                out.extend(_ask_with_retry(
                    engine._ask,
                    build_budget_prompt([t], target_lang, source_lang, [b], scene_context=texts),
                    1))
    return out


def _draft_candidates_in_chunks(engine, texts, target_lang, source_lang, budgets, windows, log):
    # type: (TranslationEngine, List[str], str, Optional[str], List[int], List[Optional[float]], Callable[[str], None]) -> List[str]
    """First-pass draft, candidates version: DRAFT_CHUNK lines at a time, each line getting 3
    candidates in the SAME call, picked immediately against its ±15% window (pick_candidate).
    This is what makes a paid translator's single, retry-free call (max_budget_retries=0)
    already get a best-of-3 choice instead of a single shot -- see fit_translate. Falls back
    to one line at a time if a chunk's count keeps mismatching.
    """
    out = []  # type: List[str]
    for a in range(0, len(texts), DRAFT_CHUNK):
        chunk = texts[a:a + DRAFT_CHUNK]
        chunk_budgets = budgets[a:a + DRAFT_CHUNK]
        chunk_windows = windows[a:a + DRAFT_CHUNK]
        try:
            candidate_lists = _ask_candidates_with_retry(
                engine._ask,
                build_candidates_draft_prompt(chunk, target_lang, source_lang, chunk_budgets, scene_context=texts),
                len(chunk))
        except ValueError:
            candidate_lists = []
            for t, b in zip(chunk, chunk_budgets):
                candidate_lists.extend(_ask_candidates_with_retry(
                    engine._ask,
                    build_candidates_draft_prompt([t], target_lang, source_lang, [b], scene_context=texts),
                    1))
        for idx, (cands, w) in enumerate(zip(candidate_lists, chunk_windows)):
            cands = [c for c in cands if script_ok(c, target_lang)] or cands
            if not cands:
                out.append("")
                continue
            if w is not None:
                out.append(pick_candidate(cands, target_lang, w, index=a + idx, log=log))
            else:
                out.append(cands[0])
    return out


def fit_translate(
    engine,                       # TranslationEngine (uses ._ask)
    texts,                        # List[str] original lines
    target_lang,                  # str
    source_lang=None,             # Optional[str]
    durations=None,               # Optional[List[float]] slot seconds
    log=None,                     # Optional[Callable[[str], None]]
    max_retry=None,               # Optional[int] -- None consults engine.max_budget_retries
):
    # type: (...) -> List[str]
    """Budget/window-based length-fitting translation. With no durations, translates once without a budget.

    Unified window judgment (2026-07-30 calibration): a line is out-of-budget if its estimated
    speech time falls outside [slot*WINDOW_LOW, slot*WINDOW_HIGH] -- covers both "too long"
    (used to be this function's own over-budget check) and "too short" (used to be
    pipeline.py's separate FILL_RATIO check) in one re-ask loop.

    max_retry caps how many re-ask rounds run. If not given explicitly, it's read from
    engine.max_budget_retries (see app/translate.py TranslationEngine) so each translator
    declares its own policy -- local/free engines (Ollama) get the full budget (3), paid
    engines (Gemini/Vertex) get 0 (cost/429-driven -- their ONE first-pass call already asks
    for 3 candidates per line and picks the best fit, see _draft_candidates_in_chunks, so "no
    retries" doesn't mean "no choice", just no extra calls after that one).

    Honest limitation (2026-07-30 v3): for paid engines an under-filled line whose 3 draft
    candidates are ALL too short simply ships short -- there is no retry budget to lengthen
    it here. The downstream mitigations are duration-fit take selection (app/qwen_select.py
    prefers the take closest to the slot) and the leading-pause borrow at assembly; neither
    can conjure missing words, so some dead air can remain on such lines.
    """
    log = log or (lambda m: None)
    if max_retry is None:
        max_retry = getattr(engine, "max_budget_retries", MAX_RETRY)
    if not texts:
        return []
    if not durations:
        # No slot to fit against -- 3 candidates would have nothing to pick between, so a
        # plain single-candidate draft is all this case needs.
        budgets = [999] * len(texts)  # no budget info → effectively unlimited
        windows = [None] * len(texts)  # no slot → nothing to judge against
        best = _draft_in_chunks(engine, texts, target_lang, source_lang, budgets)
    else:
        budgets = [syllable_budget(d, target_lang) for d in durations]
        windows = list(durations)
        # First pass: candidates-based budget-stated translation, drafted in small chunks so
        # a long scene stays aligned (a single 40+ line batch silently mis-numbers its back
        # half). Each line gets 3 candidates in this one call and the best fit is picked
        # immediately (see _draft_candidates_in_chunks) -- this is the ONLY call a paid
        # translator (max_budget_retries=0) ever makes for this line.
        best = _draft_candidates_in_chunks(engine, texts, target_lang, source_lang, budgets, windows, log)

    def _out_of_window():
        return [i for i in range(len(best))
                if windows[i] is not None
                and not in_window(estimate_seconds(best[i], target_lang), windows[i])]

    # Second pass on: pick only out-of-window lines (too long OR too short) and ask each for
    # 3 candidate rewrites in one call (up to max_retry rounds), picking the one closest to
    # the window (see pick_candidate).
    for attempt in range(max_retry):
        out = _out_of_window()
        if not out:
            break
        log("   %d lines outside the ±15%% budget window → candidate re-translation (%d/%d)"
            % (len(out), attempt + 1, max_retry))
        directions = [
            "long" if estimate_seconds(best[i], target_lang) > windows[i] * WINDOW_HIGH else "short"
            for i in out
        ]
        try:
            candidate_lists = _ask_candidates_with_retry(
                engine._ask,
                build_candidates_prompt([texts[i] for i in out],
                                        [best[i] for i in out],
                                        target_lang,
                                        [budgets[i] for i in out],
                                        directions),
                len(out))
        except ValueError:
            break  # if format failures keep recurring, stop and keep the current result
        for i, cands in zip(out, candidate_lists):
            cands = [c for c in cands if script_ok(c, target_lang)]
            if not cands:
                continue  # nothing usable came back for this line -- keep the current best
            picked = pick_candidate(cands, target_lang, windows[i], index=i, log=log)
            # accept only if it moved closer to the window than the current best (otherwise
            # keep existing) -- same regression guard as the single-candidate version had.
            old_dist = _window_distance(estimate_seconds(best[i], target_lang), windows[i])
            new_dist = _window_distance(estimate_seconds(picked, target_lang), windows[i])
            if new_dist < old_dist:
                best[i] = picked

    still = _out_of_window()
    if still:
        log("   %d lines remained outside the budget window — keeping current (handled by borrow/speed-up)" % len(still))
    return best
