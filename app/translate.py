"""Translation socket — Gemini (Google AI Studio, and Vertex AI) adapters.

Translates multiple dialogue lines into the target language. Because this is for
dubbing, each line is requested to have a spoken length similar to the original
(to fit the time slot).
GeminiTranslator uses a consumer AI Studio API key (GEMINI_API_KEY), never shown on
screen. VertexTranslator uses a service-account (OAuth) instead -- see its docstring.
"""
import hashlib
import json
import subprocess
import tempfile
import os
import re
import threading
import time
from typing import List, Optional

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

from app import runtime
from app.config import (
    GEMINI_MODEL,
    OLLAMA_GEMMA_MODEL,
    OLLAMA_HUNYUAN_MODEL,
    OLLAMA_MODEL,
    OLLAMA_QWEN_MODEL,
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
    """Quick check that the translation is in the target language's script (prevents wrong-language output)."""
    lang = lang.lower()
    if lang in ("ko", "korean"):
        # Dubbing lines must be pure Hangul for the TTS to read — mixed-in Latin letters are invalid
        # (blocks real cases like "덴 đâu?", "dent 자리에")
        return bool(_HANGUL_CHAR.search(text)) and not _LATIN_CHAR.search(_ACRONYM.sub("", text))
    if lang in ("ja", "japanese", "zh", "chinese"):
        return bool(_NON_LATIN.search(text))
    # Latin-script languages: invalid if Hangul, kana, or Han characters are mixed in
    return not _NON_LATIN.search(text)


def _ask_with_retry(ask, prompt: str, n: int, tries: int = 3) -> List[str]:
    """(tries: an engine whose every ask is a message off an account's allowance
    says so with `format_tries`; see _translate_with_fallback.)"""
    """If the LLM doesn't respect the line count, re-ask with a correction appended (up to `tries` times)."""
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


def _one_line_or_untranslated(ask, prompt: str, tries: int = 3) -> str:
    """The last-resort single-line ask. A line that still cannot be read after
    its retries is UNTRANSLATED rather than the end of the job. Only a bad
    answer is forgiven: a translator that cannot be reached at all still raises,
    because it would fail every other line the same way."""
    try:
        return _ask_with_retry(ask, prompt, 1, tries)[0]
    except ValueError:
        return UNTRANSLATED


def _translate_with_fallback(engine, texts, target_lang, source_lang, durations, fuller):
    """Translate DRAFT_CHUNK lines per request, the same size the length-fit path
    uses: one prompt holding a whole video's lines asks for an answer longer
    than the model will write, and it comes back cut off. A chunk that keeps
    breaking the line count is asked again one line at a time (guarantees the
    count); a line that fails even then is left UNTRANSLATED."""
    from app.text.length_fit import DRAFT_CHUNK  # length_fit imports this module
    tries = getattr(engine, "format_tries", 3)
    out = []
    for a in range(0, len(texts), DRAFT_CHUNK):
        chunk = texts[a:a + DRAFT_CHUNK]
        chunk_durations = durations[a:a + DRAFT_CHUNK] if durations else None
        try:
            prompt = build_dub_prompt(chunk, target_lang, source_lang, chunk_durations, fuller)
            out.extend(_ask_with_retry(engine._ask, prompt, len(chunk), tries))
        except ValueError:
            for i, t in enumerate(chunk):
                d = [chunk_durations[i]] if chunk_durations else None
                prompt = build_dub_prompt([t], target_lang, source_lang, d, fuller)
                out.append(_one_line_or_untranslated(engine._ask, prompt, tries))
    return out


class TranslationEngine:
    id: str = ""
    display_name: str = ""

    # How many "still outside the ±15% budget window" retry rounds app.text.length_fit.fit_translate
    # may spend re-asking a line (see app/text/length_fit.py MAX_RETRY). Default 3, for local/free
    # engines -- paid Google engines override this to 0 (cost/429-driven, see GeminiTranslator).
    max_budget_retries: int = 3
    # Whether a line with the wrong letters in it (Latin inside Korean, say) is
    # asked again. True for the local models, which do slip into another
    # language; ChatGPT's own choices stand -- a product name it keeps in
    # English is its call, not a mistake to re-ask (user, 2026-09-25).
    recheck_script: bool = True
    # Whether this engine is told how long each line may be at all (character
    # budgets, the re-asks, the seconds a line must fit). False for a model that
    # cannot follow such a rule -- see OllamaTranslator.
    length_rules: bool = True

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

    def __init__(self, api_key: Optional[str] = None, model: str = GEMINI_MODEL):
        # Resolved here, not at import time: current_value reads kit.env first,
        # so a key saved in Settings works on the next dub without a restart.
        # An explicit api_key (tests, callers) still wins.
        from app.settings_env import current_value

        self.api_key = api_key if api_key is not None else current_value("GEMINI_API_KEY")
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


# Codex features switched off for a translation run (`codex features list`).
CHATGPT_NO_TOOLS = ("shell_tool", "unified_exec", "browser_use", "computer_use",
                    "in_app_browser", "apps", "plugins", "multi_agent", "goals", "hooks",
                    "image_generation", "view_image")

# What ChatGPT's own free plan chats with (its default since 2026-08-06), by
# the name the sign-in program lists it under.
CHATGPT_DEFAULT_MODEL = "gpt-5.6-luna"


class ChatGptNotSignedInError(RuntimeError):
    """The ChatGPT sign-in is missing or expired. The pipeline turns it into
    the notice that sends the user to Settings."""


class ChatGptLimitError(RuntimeError):
    """The ChatGPT account's usage allowance is used up for now."""


class ChatGptTranslator(TranslationEngine):
    """Translate with the user's own ChatGPT account -- free plan included.

    OpenAI opens exactly one door for another program to use a ChatGPT
    account: the "Sign in with ChatGPT" flow of its Codex program. That program
    is the wire here and nothing more: the app pipes the same dubbing prompt
    the other translators get, in one message per chunk, and reads the last
    reply back out of a file. No chat window, nothing typed by the user, and
    the sign-in itself stays in Codex's own files on this machine.

    Not a ChatGPT product feature, so no ChatGPT branding in the wording that
    reaches OpenAI: the prompt is the app's own. The binary is found the way
    the Dub Agent finds it (app/agents/base.py find_cli), so a user who signed
    in for the agent is signed in for this too.
    """
    id = "chatgpt"
    display_name = "ChatGPT"
    # One extra round at most: every re-ask is a message off the account's
    # allowance, and a free plan's is small.
    max_budget_retries = 1
    recheck_script = False
    # One more ask when an answer cannot be read, not two: a bad chunk used to
    # cost up to 21 messages of a free plan (review 2026-09-23).
    format_tries = 2

    def __init__(self, binary: Optional[str] = None, model: Optional[str] = None,
                 timeout: float = 300.0):
        from app.agents import base as agent_base

        self.binary = binary if binary is not None else agent_base.find_cli("codex")
        # The model ChatGPT itself answers a free account with -- never the
        # one the user's own Codex setup names (a coding model, and on this
        # Mac the top-tier one; user, 2026-09-23). PERSODUB_CHATGPT_MODEL in
        # kit.env is the one way to pick another.
        wanted = os.environ.get("PERSODUB_CHATGPT_MODEL", "")
        if not re.match(r"^[A-Za-z0-9._:-]{1,64}$", wanted):
            wanted = CHATGPT_DEFAULT_MODEL
        self.model = model if model is not None else wanted
        self.timeout = timeout
        # Where each answer is kept for this job (set by the pipeline). A job
        # that stops at the usage limit and is resumed asks the same questions
        # again; the ones already answered come from here instead of from the
        # user's ChatGPT allowance.
        self.answers_dir: Optional[str] = None

    def _command(self, workdir: str, out_path: str) -> List[str]:
        cmd = [self.binary, "exec",
               # A translation is not a session to keep, not a repo to read,
               # and gets no tools: the sandbox and the two switches say so.
               "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
               "--sandbox", "read-only", "-C", workdir, "--color", "never",
               "-c", "tools.web_search=false", "-c", "skills.include_instructions=false",
               # A translation is a plain answer: the lightest thinking, the
               # fewest of the account's messages spent on it.
               "-c", 'model_reasoning_effort="low"',
               "-o", out_path]
        # No tools at all: a read-only sandbox still lets the shell READ, and
        # a line of dialogue that says "run ls ~" is text to translate, not an
        # instruction (review 2026-09-23; checked: with these off, that line
        # came back translated and nothing ran).
        for feature in CHATGPT_NO_TOOLS:
            cmd += ["--disable", feature]
        if self.model:
            cmd += ["-m", self.model]
        return cmd + ["-"]   # the prompt comes on stdin

    def _ask(self, prompt: str) -> str:
        if not self.answers_dir:
            return self._ask_chatgpt(prompt)
        key = hashlib.sha256(f"{self.model}\n{prompt}".encode("utf-8")).hexdigest()[:32]
        path = os.path.join(self.answers_dir, key + ".txt")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
        reply = self._ask_chatgpt(prompt)
        os.makedirs(self.answers_dir, exist_ok=True)
        with open(path + ".part", "w", encoding="utf-8") as f:
            f.write(reply)
        os.replace(path + ".part", path)
        return reply

    def _ask_chatgpt(self, prompt: str) -> str:
        if not self.binary:
            raise ChatGptNotSignedInError("The ChatGPT sign-in program is not installed on this computer")
        from app.agents import base as agent_base

        with tempfile.TemporaryDirectory(prefix="persodub-chatgpt-", ignore_cleanup_errors=True) as workdir:
            out_path = os.path.join(workdir, "reply.txt")
            proc = subprocess.Popen(self._command(workdir, out_path), stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                    encoding="utf-8", errors="replace", env=agent_base.chatgpt_env())
            try:
                stdout, stderr = proc.communicate(prompt, timeout=self.timeout)
            except subprocess.TimeoutExpired as e:
                # The whole process tree: on Windows an npm .cmd shim leaves
                # node holding the pipes when only cmd.exe is killed.
                agent_base._end(proc)
                raise RuntimeError(f"ChatGPT did not answer within {int(self.timeout)}s") from e
            r = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
            if os.path.exists(out_path):
                with open(out_path, encoding="utf-8") as f:
                    reply = f.read()
                if reply.strip():
                    return reply
            # The last message is also printed on stdout; a reply file that
            # did not arrive (an odd temp path) is not a failed translation.
            if r.returncode == 0 and "[" in (r.stdout or ""):
                return r.stdout
            self._explain(r.returncode, r.stderr or "")
            raise RuntimeError("ChatGPT sent no reply")

    @staticmethod
    def _explain(code: int, said: str) -> None:
        # The Dub Agent's own reading of the same CLI's complaints
        # (app/agents/base.py): "not logged in", a 401, "run codex login" on
        # one side; "usage limit", 429, "quota exceeded" on the other.
        from app.agents import base as agent_base

        # Only the CLI's own error lines are read: its output also echoes the
        # prompt, and the video's words ("you've hit your usage limit") must
        # neither read as an account state nor reach the log or a failure
        # report (review 2026-09-23).
        errors = "\n".join(ln for ln in said.splitlines() if re.match(r"\s*error\b", ln, re.I))
        if agent_base._says(agent_base._NOT_LOGGED_IN, errors):
            raise ChatGptNotSignedInError("ChatGPT is not signed in")
        if agent_base._says(agent_base._RATE_LIMITED, errors):
            raise ChatGptLimitError("ChatGPT usage limit reached")
        if code != 0:
            last = errors.strip().splitlines()[-1][:160] if errors.strip() else "exit %d" % code
            raise RuntimeError(f"ChatGPT translation failed ({last})")

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


# How many attempts one Ollama request gets, and the wait before each retry
# (5s, then 10s). The failures worth retrying are a local server's passing ones:
# refused while the desktop restarts the pack, a timeout, a 5xx when the model
# runner died (out of memory) and is being reloaded -- a reload of a 7-12B model
# takes about 10s on this hardware, so 15s of waiting covers one. A 4xx is our
# own request and would fail the same way again, so it is not retried.
OLLAMA_TRIES = 3
OLLAMA_BACKOFF_S = 5

# num_predict (the answer's token cap) from how many lines a request asks for --
# every prompt lists them as "N. ..." at the start of a line; the scene context
# and the style examples are "- ..." and do not count. 256 tokens a line is room
# for three candidates of a long line (a 20s Korean line is ~90 syllables, about
# as many tokens) with the JSON around them, and a full DRAFT_CHUNK of 6 lines
# comes out at 2048 -- the fixed cap every request had before, which chunks have
# been fitting inside. Floor 1024 so a one-line ask still has room for a
# preamble; ceiling 8192 because an answer longer than that is not one a local
# model finishes cleanly, and the per-line fallback is the better road for it.
# A prompt with no numbered lines keeps the old 2048.
_ASKED_LINE = re.compile(r"^\d+\. ", re.MULTILINE)


def _num_predict(prompt: str) -> int:
    n = len(_ASKED_LINE.findall(prompt))
    if not n:
        return 2048
    return max(1024, min(8192, 512 + 256 * n))


def _ollama_error(r) -> requests.exceptions.HTTPError:
    """An HTTP error that carries Ollama's own reason ("model not found", "llama
    runner process has terminated") -- raise_for_status names only the URL, and
    the reason was being thrown away. A reason can name a file under the home
    folder, so it is masked the way a failure report is before it is cut short."""
    from app.report_mask import mask_text
    status = getattr(r, "status_code", 0)
    body = mask_text((getattr(r, "text", "") or "")[:2000], home=os.path.expanduser("~"))
    return requests.exceptions.HTTPError(
        "Ollama answered HTTP %s: %s" % (status, " ".join(body.split())[:200]), response=r)


class OllamaTranslator(TranslationEngine):
    """Local LLM (Ollama) translator — runs on this server (internal) without internet or a key.

    Uses the same prompt/parsing as Gemini, so it follows the length-fitting and compression instructions the same way.
    """

    id = "ollama"
    display_name = "Ollama (local LLM)"

    # Local/free -- no cost or rate-limit pressure, keep the full retry budget (base default).
    max_budget_retries = 3

    def __init__(self, url: Optional[str] = None, model: str = OLLAMA_MODEL):
        # Resolved here, not as a default-argument value: a default argument is
        # evaluated once at import time, before the desktop shell has started
        # (or restarted) the pack and written its port to runtime.json.
        self.url = (url or runtime.url("ollama")).rstrip("/")
        self.model = model
        # Hunyuan MT is a translation-only model: asked to fit a line into N
        # characters, it gave the request back as the line ("반드시 10자 이내"
        # spoken in 30 of 152 lines, 2026-09-19). It gets no length rules; a
        # line that runs long is the Dub Agent's to trim (owner, 2026-08-20).
        self.length_rules = model != OLLAMA_HUNYUAN_MODEL

    def _ask(self, prompt: str) -> str:
        if "qwen3" in self.model:
            # Qwen3 is a reasoning model; "/no_think" skips its verbose <think> block
            # so it emits the JSON array directly (otherwise it runs out of tokens thinking).
            prompt = "/no_think\n" + prompt
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            # num_predict: upper bound on output length (safety) — stops the model even if it runs away;
            # sized to the request (see _num_predict), a fixed 2048 cut long answers off mid-string (#88).
            # top_k/top_p are pinned, not left to the host: the server's gemma-dub carries no sampling
            # parameters (so it ran on Ollama's defaults), while the public gemma3:12b bakes in
            # top_k 64 / top_p 0.95. That looser sampling showed up as off-target languages and lines
            # missing the ±15% length window. Translation wants the conservative end either way.
            # No "format": "json": Ollama's JSON mode forces an object at the top, and every prompt
            # here asks for an array -- gemma3:12b answered {"line one": "line two"} under it (2026-09-18).
            "options": {"temperature": 0.3, "top_k": 40, "top_p": 0.9,
                        "num_predict": _num_predict(prompt)},
        }
        # Same retry shape as GeminiTranslator._ask -- see OLLAMA_TRIES for what is retried.
        last_err = None
        for attempt in range(OLLAMA_TRIES):
            if attempt:
                time.sleep(OLLAMA_BACKOFF_S * attempt)
            try:
                r = requests.post(f"{self.url}/api/chat", json=body, timeout=300)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_err = e
                continue
            status = getattr(r, "status_code", 200)
            if status >= 400:
                last_err = _ollama_error(r)
                if status < 500:
                    break
                continue
            return r.json()["message"]["content"]
        raise last_err

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


# Engine name -> how to build that translator. Each entry is a lambda rather
# than the built instance (or the bare class) so nothing is decided at import
# time: the names inside are looked up on this module when get_translator is
# actually called, which is what lets a test swap a class here and get its own
# class back.
TRANSLATORS = {
    "gemini": lambda: GeminiTranslator(),
    "chatgpt": lambda: ChatGptTranslator(),
    "vertex": lambda: VertexTranslator(),
    "qwen": lambda: OllamaTranslator(model=OLLAMA_QWEN_MODEL),
    "gemma": lambda: OllamaTranslator(model=OLLAMA_GEMMA_MODEL),
    "hunyuan": lambda: OllamaTranslator(model=OLLAMA_HUNYUAN_MODEL),
}


# Picks a translator based on the setting (TRANSLATE_ENGINE). If engine is given, it takes precedence.
def get_translator(engine=None):
    picked = (engine or TRANSLATE_ENGINE or "").lower()
    # Unknown or empty name -> the local Ollama engine on its default model,
    # the free path that works with no key and no setting.
    return TRANSLATORS.get(picked, lambda: OllamaTranslator())()


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
        + register_rule(target_lang) +
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
