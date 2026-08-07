"""Translation socket — Gemini (Google AI Studio, and Vertex AI) adapters.

Translates multiple dialogue lines into the target language. Because this is for
dubbing, each line is requested to have a spoken length similar to the original
(to fit the time slot).
GeminiTranslator uses a consumer AI Studio API key (GEMINI_API_KEY), never shown on
screen. VertexTranslator uses a service-account (OAuth) instead -- see its docstring.
"""
import json
import re
import threading
import time
from typing import List, Optional

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

from app.config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    OLLAMA_GEMMA_MODEL,
    OLLAMA_MODEL,
    OLLAMA_QWEN_MODEL,
    OLLAMA_URL,
    TRANSLATE_ENGINE,
    VERTEX_LOCATION,
    VERTEX_MODEL,
    VERTEX_SA_KEY_PATH,
)


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
        "Do not merge or split lines.\n"
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
        raise ValueError(f"Could not find a JSON array in the translation response: {raw[:200]}")
    arr = json.loads(s[start : end + 1])
    if len(arr) != n:
        raise ValueError(f"Translated line count mismatch: got {len(arr)}, need {n}")
    return [str(x) for x in arr]


_NON_LATIN = re.compile(r"[가-힣ぁ-んァ-ヶ一-鿕]")
_HANGUL_CHAR = re.compile(r"[가-힣]")
_LATIN_CHAR = re.compile(r"[a-zA-ZÀ-ɏ]")  # includes extended Latin (đ, é, etc.)


def script_ok(text: str, lang: str) -> bool:
    """Quick check that the translation is in the target language's script (prevents wrong-language output)."""
    lang = lang.lower()
    if lang in ("ko", "korean"):
        # Dubbing lines must be pure Hangul for the TTS to read — mixed-in Latin letters are invalid
        # (blocks real cases like "덴 đâu?", "dent 자리에")
        return bool(_HANGUL_CHAR.search(text)) and not _LATIN_CHAR.search(text)
    if lang in ("ja", "japanese", "zh", "chinese"):
        return bool(_NON_LATIN.search(text))
    # Latin-script languages: invalid if Hangul, kana, or Han characters are mixed in
    return not _NON_LATIN.search(text)


def _ask_with_retry(ask, prompt: str, n: int, tries: int = 3) -> List[str]:
    """If the LLM doesn't respect the line count, re-ask with a correction appended (up to `tries` times)."""
    last_err = None
    for attempt in range(tries):
        raw = ask(prompt if attempt == 0 else prompt + f"\n\n(Note: do not merge lines; answer only with a JSON array of exactly {n} items.)")
        try:
            return parse_json_array(raw, n)
        except ValueError as e:
            last_err = e
    raise last_err


def _translate_with_fallback(engine, texts, target_lang, source_lang, durations, fuller):
    """If batch translation ultimately fails to respect the line count, translate one line at a time (guarantees line count)."""
    try:
        prompt = build_dub_prompt(texts, target_lang, source_lang, durations, fuller)
        return _ask_with_retry(engine._ask, prompt, len(texts))
    except ValueError:
        out = []
        for i, t in enumerate(texts):
            d = [durations[i]] if durations else None
            prompt = build_dub_prompt([t], target_lang, source_lang, d, fuller)
            out.append(_ask_with_retry(engine._ask, prompt, 1)[0])
        return out


class TranslationEngine:
    id: str = ""
    display_name: str = ""

    # How many "still outside the ±15% budget window" retry rounds app.text.length_fit.fit_translate
    # may spend re-asking a line (see app/len_fit.py MAX_RETRY). Default 3, for local/free
    # engines -- paid Google engines override this to 0 (cost/429-driven, see GeminiTranslator).
    max_budget_retries: int = 3

    def translate(
        self,
        texts: List[str],
        target_lang: str,
        source_lang: Optional[str] = None,
        durations: Optional[List[float]] = None,
        fuller: bool = False,
    ) -> List[str]:
        raise NotImplementedError


# Where the "quota used up" popup sends the user: the AI Studio key page, which
# carries the plan-upgrade flow for the key PersoDub is using.
GEMINI_UPGRADE_URL = "https://aistudio.google.com/app/apikey"


class GeminiQuotaExhaustedError(RuntimeError):
    """Gemini quota/rate limit exhausted (HTTP 429, still 429 after backoff).

    Distinct type (not a plain HTTPError) for the same reason as
    PersoCreditExhaustedError in app/perso_client.py: the pipeline turns it
    into a structured notice so the UI can pop a recharge/upgrade dialog.
    """

    def __init__(self, message: str = "Gemini quota is used up", link: str = GEMINI_UPGRADE_URL):
        super().__init__(message)
        self.link = link


class GeminiUnavailableError(RuntimeError):
    """Google's Gemini servers overloaded or down (HTTP 5xx). Not a quota
    problem -- recharging won't help, retrying later will."""


class GeminiTranslator(TranslationEngine):
    id = "gemini"
    display_name = "Google Gemini (AI Studio)"

    # Paid API (cost + 429 rate-limit risk per call) -- no budget-window retry rounds, exactly
    # one translation attempt per line (2026-07-30 calibration, user decision).
    max_budget_retries = 0

    def __init__(self, api_key: str = GEMINI_API_KEY, model: str = GEMINI_MODEL):
        self.api_key = api_key
        self.model = model

    def _ask(self, prompt: str) -> str:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        # The key travels in the x-goog-api-key header, NEVER in the URL:
        # raise_for_status() embeds the full URL in its error message, which
        # flows into job logs, the jobs API, and the screen (where a ?key= URL
        # leaked the user's key until 2026-08-07).
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json"},
        }
        # Long prompts can take over 2 minutes -> 300s timeout. Retry on timeout,
        # and back off on 429 (free-tier rate limit).
        last_err = None
        for attempt in range(4):
            try:
                r = requests.post(
                    url, headers={"x-goog-api-key": self.api_key}, json=body, timeout=300
                )
                status = getattr(r, "status_code", 200)
                if status == 429:
                    last_err = GeminiQuotaExhaustedError()
                    time.sleep(15 * (attempt + 1))
                    continue
                if status >= 500:
                    raise GeminiUnavailableError(f"Gemini server error (HTTP {status})")
                r.raise_for_status()
                return r.json()["candidates"][0]["content"]["parts"][0]["text"]
            except requests.exceptions.Timeout as e:
                last_err = e
        raise last_err

    def translate(self, texts, target_lang, source_lang=None, durations=None, fuller=False):
        if not texts:
            return []
        return _translate_with_fallback(self, texts, target_lang, source_lang, durations, fuller)


class VertexTranslator(GeminiTranslator):
    """Gemini via Vertex AI -- same prompts/parsing/response shape as GeminiTranslator
    (inherits .translate()), but authenticates with a service account (OAuth) instead of a
    consumer AI Studio key, and calls the region-pinned Vertex REST endpoint. Paid quota, no
    free-tier 429s -- the official path for the "Vertex gemini-2.5-flash us-central1" combo
    (speech-rate budget revision 2026-07-30, section 5b). The key file's contents are never read
    by this class directly -- google-auth's Credentials.from_service_account_file() does that
    internally; this code only ever holds the resulting Credentials object.
    """

    id = "vertex"
    display_name = "Google Gemini (Vertex AI)"
    max_budget_retries = 0  # paid API -- same cost-driven policy as GeminiTranslator

    def __init__(
        self,
        sa_path: str = VERTEX_SA_KEY_PATH,
        location: str = VERTEX_LOCATION,
        model: str = VERTEX_MODEL,
        credentials=None,
        project: Optional[str] = None,
    ):
        self._loc, self.model = location, model
        self.api_key = "vertex"  # not a real key -- Vertex authenticates via OAuth, not ?key=
        if credentials is not None and project is not None:
            # dependency-injection seam for tests -- never touches the key file
            self._creds, self._proj = credentials, project
        else:
            self._creds = service_account.Credentials.from_service_account_file(
                sa_path, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            self._proj = self._creds.project_id
        self._lock = threading.Lock()

    def _token(self) -> str:
        with self._lock:
            if not self._creds.valid:
                self._creds.refresh(GoogleAuthRequest())
            return self._creds.token

    def _ask(self, prompt: str) -> str:
        url = (
            f"https://{self._loc}-aiplatform.googleapis.com/v1/projects/"
            f"{self._proj}/locations/{self._loc}/publishers/google/models/"
            f"{self.model}:generateContent"
        )
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json"},
        }
        # Same retry/backoff shape as GeminiTranslator._ask -- long prompts can take over 2
        # minutes, and Vertex can still 429 under sustained load even on a paid project.
        last_err = None
        for attempt in range(4):
            try:
                r = requests.post(
                    url, headers={"Authorization": "Bearer " + self._token()},
                    json=body, timeout=300,
                )
                if getattr(r, "status_code", 200) == 429:
                    last_err = requests.exceptions.HTTPError("429 rate limited")
                    time.sleep(15 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json()["candidates"][0]["content"]["parts"][0]["text"]
            except requests.exceptions.Timeout as e:
                last_err = e
        raise last_err


class OllamaTranslator(TranslationEngine):
    """Local LLM (Ollama) translator — runs on this server (internal) without internet or a key.

    Uses the same prompt/parsing as Gemini, so it follows the length-fitting and compression instructions the same way.
    """

    id = "ollama"
    display_name = "Ollama (local LLM)"

    # Local/free -- no cost or rate-limit pressure, keep the full retry budget (base default).
    max_budget_retries = 3

    def __init__(self, url: str = OLLAMA_URL, model: str = OLLAMA_MODEL):
        self.url = url.rstrip("/")
        self.model = model

    def _ask(self, prompt: str) -> str:
        if "qwen3" in self.model:
            # Qwen3 is a reasoning model; "/no_think" skips its verbose <think> block
            # so it emits the JSON array directly (otherwise it runs out of tokens thinking).
            prompt = "/no_think\n" + prompt
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            # num_predict: upper bound on output length (safety) — stops the model even if it runs away
            # top_k/top_p are pinned, not left to the host: the server's gemma-dub carries no sampling
            # parameters (so it ran on Ollama's defaults), while the public gemma3:12b bakes in
            # top_k 64 / top_p 0.95. That looser sampling showed up as off-target languages and lines
            # missing the ±15% length window. Translation wants the conservative end either way.
            "options": {"temperature": 0.3, "top_k": 40, "top_p": 0.9, "num_predict": 2048},
        }
        r = requests.post(f"{self.url}/api/chat", json=body, timeout=300)
        r.raise_for_status()
        return r.json()["message"]["content"]

    def translate(
        self,
        texts: List[str],
        target_lang: str,
        source_lang: Optional[str] = None,
        durations: Optional[List[float]] = None,
        fuller: bool = False,
    ) -> List[str]:
        if not texts:
            return []
        return _translate_with_fallback(
            self, texts, target_lang, source_lang, durations, fuller
        )


# Picks a translator based on the setting (TRANSLATE_ENGINE). If engine is given, it takes precedence.
def get_translator(engine=None):
    picked = (engine or TRANSLATE_ENGINE or "").lower()
    if picked == "gemini":
        return GeminiTranslator()
    if picked == "vertex":
        return VertexTranslator()
    if picked == "qwen":
        return OllamaTranslator(model=OLLAMA_QWEN_MODEL)
    if picked == "gemma":
        return OllamaTranslator(model=OLLAMA_GEMMA_MODEL)
    return OllamaTranslator()


# --- Two-pass dubbing translation (draft meaning-first, then length-fit) ---
def build_draft_prompt(texts, target_lang, source_lang, speakers=None):
    src = "from %s " % source_lang if source_lang else ""
    lines = []
    for i, t in enumerate(texts):
        who = ""
        if speakers and i < len(speakers) and speakers[i]:
            who = "[%s] " % speakers[i]
        lines.append("%d. %s%s" % (i + 1, who, t))
    return (
        "You are a professional dubbing translator. Translate the %d lines below %sinto natural, "
        "colloquial %s for dubbing.\n" % (len(texts), src, target_lang)
        + "These lines are ONE continuous scene. Read them together and keep the flow, tone, "
        "and who is speaking to whom.\n"
        "Rules:\n"
        "- Preserve meaning, emotion, and register (informal stays informal).\n"
        "- Write lines a voice actor can perform naturally, no stiff/literary translationese.\n"
        "- Keep names and recurring terms consistent across lines.\n"
        "- Do NOT worry about length yet; prioritize correct, natural meaning.\n"
        "- Do not merge or split lines.\n"
        "- Each output string must contain ONLY the translated line. Never include the line "
        "number or the [speaker] tag, and never mix in other languages (e.g. Chinese) — "
        "those are context only.\n"
        "Output only a JSON array of exactly %d strings in order. No other text.\n\n" % len(texts)
        + "\n".join(lines)
    )


def _fit_lengths(engine, sources, draft, durations, target_lang, max_retry=3):
    from app.text.length_fit import build_shorten_prompt, syllable_budget
    from app.text.srt import _count_syllables
    best = list(draft)
    budgets = [syllable_budget(d, target_lang) for d in durations]
    for _ in range(max_retry):
        over = [i for i in range(len(best)) if _count_syllables(best[i], target_lang) > budgets[i]]
        if not over:
            break
        redo = _ask_with_retry(
            engine._ask,
            build_shorten_prompt(
                [sources[i] for i in over],
                [best[i] for i in over],
                target_lang,
                [budgets[i] for i in over],
            ),
            len(over),
        )
        for k, i in enumerate(over):
            best[i] = redo[k]
    return best


def _draft(engine, texts, target_lang, source_lang, speakers):
    """Draft-translate the whole scene at once. If the model returns the wrong line
    count, fall back to line-by-line (guarantees the count, at the cost of context)."""
    try:
        return _ask_with_retry(
            engine._ask, build_draft_prompt(texts, target_lang, source_lang, speakers), len(texts)
        )
    except ValueError:
        out = []
        for i, t in enumerate(texts):
            sp = [speakers[i]] if speakers and i < len(speakers) else None
            out.append(_ask_with_retry(
                engine._ask, build_draft_prompt([t], target_lang, source_lang, sp), 1)[0])
        return out


def translate_scene(engine, texts, target_lang, source_lang=None, durations=None, speakers=None):
    """Two-pass dubbing translation: draft (meaning, full context) then length-fit."""
    if not texts:
        return []
    draft = _draft(engine, texts, target_lang, source_lang, speakers)
    if not durations:
        return draft
    return _fit_lengths(engine, texts, draft, durations, target_lang)
