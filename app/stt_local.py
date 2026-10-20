"""Local Whisper STT (no-API-key fallback, no container dependency).

Subprocess bridge to app/scripts/whisper_transcribe.py -- the app's own Python
3.8 venv doesn't have faster-whisper/ctranslate2 installed, so transcription
runs as a separate process under STT_PYTHON (a dedicated venv), same
"subprocess into a heavier venv, parse its JSON" convention app/qwen_scoring.py
uses for the take scorer.

Unlike qwen_scoring.score_takes() (which degrades to None on failure so a dub
job can keep going without best-of-N), transcribe_local() RAISES on any
failure. It has no fallback of its own -- it IS the last fallback (see
app/docs/INTEGRATION_SPEC.md) -- so the caller must decide what happens next.
"""
import json
import os
import re
import subprocess
import tempfile
import time
import wave
from typing import Callable, List, Optional

from app.agents.base import _end
from app.config import NONVERBAL_WHISPER_MODEL, NONVERBAL_WHISPER_PYTHON
from app.jobs import JobCancelled
from app.nonverbal import _PUNCT_RE, MIN_RMS_DBFS, _span_rms_db
from app.run_errors import PartsMissing, describe_exit_failure, describe_start_failure, model_failed_to_load
from app.text.srt import clamp_cues
from app.timeouts import scaled_timeout

# Dedicated venv with faster-whisper installed (see app/docs/INTEGRATION_SPEC.md
# for how it was set up). Override with STT_PYTHON for a different interpreter
# (see env.server.example for this server's actual path).
STT_PYTHON = os.environ.get("STT_PYTHON", "python3")

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "whisper_transcribe.py")

# What Whisper writes over music or silence, learned from video sign-offs and
# subtitle credits: a whole line, lowercased, spaces and punctuation taken out
# (nonverbal._PUNCT_RE). A 10 s TikTok came back as "Thank you for watching!"
# over music alone (Windows B5/D14, 2026-10-06).
_MADE_UP = re.compile("|".join([
    r"thankyou", r"thank(s|you)(so|very)?(much)?forwatching", r"pleasesubscribe.*",
    r"(subtitles|captions)by.*", r".*amaraorg.*",
    r"감사합니다", r"시청해주셔서(정말)?감사합니다", r"다음영상에서(또)?만나요", r"구독과좋아요.*",
    r"mbc뉴스.*", r"자막(제공|by).*",
    r"ご視聴ありがとうございました", r"チャンネル登録.*",
    r"(谢谢|感谢)(大家的?)?(观看|收看)", r"字幕(由|提供).*", r"[请請]不吝.*",
    r"graciasporver(el)?(video)?", r"subtítulos(por|realizados).*",
    r"mercidavoirregardé(cettevidéo)?", r"soustitres.*",
    r"vielendankfürszuschauen", r"untertitel.*",
    r"obrigad[oa]porassistir", r"legendas.*",
    r"grazieperlavisione", r"sottotitoli.*",
    r"спасибозапросмотр", r"субтитры.*", r"продолжениеследует",
]))


def _made_up(cue: dict, vocals_path: str) -> bool:
    """True for one of Whisper's made-up lines over a quiet stretch of the
    vocals track. A speaker who really says it is loud there and is kept, as
    is any line when the track cannot be read."""
    if not _MADE_UP.fullmatch(_PUNCT_RE.sub("", cue["text"].lower())):
        return False
    try:
        return _span_rms_db(vocals_path, cue["start"], cue["end"]) < MIN_RMS_DBFS
    except (OSError, EOFError, wave.Error):
        return False


class NoSpeech(RuntimeError):
    """Whisper heard nobody speaking: a music-only or silent video. The
    video is fine; it simply has nothing to dub."""


def _run(cmd: List[str], timeout: float,
         cancel_check: Optional[Callable[[], bool]] = None) -> subprocess.CompletedProcess:
    """subprocess.run(cmd, capture_output=True, text=True, timeout=timeout),
    with cancel_check asked every half second: a yes ends the process and
    raises JobCancelled. run heard no Stop until Whisper was done, and Stop
    during Transcribing took 47 s (Windows test C10, 2026-10-20).

    The single place transcribe_local starts Whisper -- tests replace exactly
    this function.
    """
    deadline = time.monotonic() + timeout
    # `with` waits for the process before this returns, so the temp folder
    # holding its output is never removed while it is still in use (Windows
    # refuses to).
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding="utf-8", errors="replace") as proc:
        try:
            while True:
                try:
                    # Both pipes are read while it waits: a full one stalls Whisper.
                    out, err = proc.communicate(timeout=0.5)
                    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
                except subprocess.TimeoutExpired:
                    pass
                if cancel_check is not None and cancel_check():
                    raise JobCancelled("Transcription was stopped.")
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(cmd, timeout)
        except BaseException:
            # The whole tree: on Windows STT_PYTHON is a venv's python.exe, a
            # launcher that starts the real interpreter as its own child, which
            # ending the launcher alone can leave running.
            _end(proc)
            raise


def transcribe_local(
    audio_path: str,
    language: Optional[str] = None,
    word_timestamps: bool = False,
    timeout: int = 900,
    log: Optional[Callable[[str], None]] = None,
    on_language: Optional[Callable[[str], None]] = None,
    video_duration: Optional[float] = None,
    vocals_path: Optional[str] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> List[dict]:
    """Transcribe audio_path with local Whisper. Returns a list of cues in the
    same shape the pipeline expects everywhere else: [{"start": float,
    "end": float, "text": str}, ...] (see app/srt_utils.Cue).

    video_duration, when known, also ends every line where the video ends.
    vocals_path, when given, drops Whisper's made-up lines ("Thank you for
    watching!") wherever that track is quiet (_made_up). cancel_check, when
    given, is asked while Whisper runs (_run): a Stop ends it there and then
    and raises JobCancelled, which is not a failure.

    Raises RuntimeError (with a clear message) on any failure: missing
    interpreter/script, subprocess crash/timeout, non-zero exit, bad JSON
    output, or the worker itself reporting an error. Never returns partial
    results.

    When no language hint was given, whisper_transcribe.py's auto-detected
    source language is reported to `log` (if given) as one line -- otherwise
    it would just be discarded.
    """
    if not os.path.exists(audio_path):
        raise RuntimeError("audio file not found: %s" % audio_path)
    if not (os.path.exists(STT_PYTHON) and os.access(STT_PYTHON, os.X_OK)):
        raise PartsMissing("local STT interpreter not found: %s" % STT_PYTHON)
    if not os.path.exists(SCRIPT_PATH):
        raise PartsMissing("local STT script missing: %s" % SCRIPT_PATH)

    # video_duration, when known, scales `timeout` up for long videos (see
    # app.timeouts.scaled_timeout); omitted, it's today's fixed value.
    effective_timeout = scaled_timeout(video_duration, timeout)

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = os.path.join(tmp_dir, "whisper_output.json")
        cmd = [STT_PYTHON, SCRIPT_PATH, "--audio", audio_path, "--output", out_path]
        if language:
            cmd += ["--language", language]
        if word_timestamps:
            cmd += ["--word-timestamps"]

        try:
            r = _run(cmd, timeout=effective_timeout, cancel_check=cancel_check)
        except JobCancelled:
            raise  # a Stop, not a failure to start
        except Exception as e:
            raise RuntimeError(describe_start_failure("local STT", e, effective_timeout)) from e

        if r.returncode != 0 or not os.path.exists(out_path):
            detail = describe_exit_failure("local STT", r)
            # A broken model file is a broken download, not a broken video.
            raise (PartsMissing if model_failed_to_load(detail) else RuntimeError)(detail)

        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local STT produced invalid output (%s)" % str(e)[:200]) from e

    if not result.get("ok"):
        raise RuntimeError("local STT reported an error (%s)" % str(result.get("error"))[:300])

    if not language:
        detected = result.get("language")
        if detected:
            if log:
                log("   detected source language: %s" % detected)
            if on_language:
                on_language(detected)

    segments = clamp_cues(result.get("segments") or [], video_duration)
    if vocals_path:
        segments = [c for c in segments if not _made_up(c, vocals_path)]
    if not segments:
        raise NoSpeech("This video has no speech to transcribe.")
    return segments


# The small Whisper the laughter check already loads (openai-whisper "base",
# app/nonverbal.py). Hearing Fast lines back with it costs 0.5s a line on an
# M4's CPU; the large model this module uses for the video took 9.4s a line.
# It still heard all three kinds of wrong line Qwen made in finished dubs
# ("Get get get get get going", "Good, good, good..." for "G-G-G", words the
# script never had) -- 10 of 13 (2026-10-01).
_LINE_RUNNER = """
import json, sys
import whisper
model_name, language, in_path, out_path = sys.argv[1:5]
model = whisper.load_model(model_name)
out = {}
for p in json.load(open(in_path, encoding="utf-8")):
    out[p] = model.transcribe(p, language=language or None, fp16=False, temperature=0.0,
                              condition_on_previous_text=False)["text"].strip()
json.dump(out, open(out_path, "w", encoding="utf-8"))
"""


def transcribe_batch(paths: List[str], language: Optional[str] = None,
                     timeout: Optional[float] = None) -> Optional[dict]:
    """{path: what the small Whisper heard} for many short files, the model
    loaded once. None when it cannot run: unlike transcribe_local this is a
    check on lines already made, and a job goes on without it."""
    py = NONVERBAL_WHISPER_PYTHON
    if not paths or not (os.path.exists(py) and os.access(py, os.X_OK)):
        return None
    with tempfile.TemporaryDirectory() as tmp_dir:
        list_path = os.path.join(tmp_dir, "audio_list.json")
        out_path = os.path.join(tmp_dir, "heard.json")
        with open(list_path, "w", encoding="utf-8") as f:
            json.dump(paths, f)
        try:
            r = subprocess.run([py, "-c", _LINE_RUNNER, NONVERBAL_WHISPER_MODEL, language or "", list_path, out_path],
                               capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=timeout or 120 + 10 * len(paths))
            with open(out_path, encoding="utf-8") as f:
                heard = json.load(f)
        except Exception:
            return None
    return heard if r.returncode == 0 else None
