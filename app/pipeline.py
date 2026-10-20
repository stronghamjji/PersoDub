"""Dubbing pipeline orchestrator.

Video + translated subtitles (SRT) -> finished dubbed video (mp4).
If no subtitles are provided: transcribe -> translate (the engine the job names) -> dub.
Every stage runs locally or through our own Qwen3-TTS sidecar -- no third-party
container anywhere in this app.
"""
import json
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
from typing import Callable, List, NoReturn, Optional

from app import config, media, room
from app.audio.onset import snap_starts
from app.config import QWEN_N_TAKES
from app.diar_campplus_client import diarize
from app.engines.base import VoiceEngineDown
from app.engines.qwen_tts import QwenTTSEngine
from app.i18n import both
from app.jobs import JobCancelled, raise_if_cancelled, shown_error, timed_step
from app.perso_client import (
    PersoClient,
    PersoCreditExhaustedError,
    PersoDurationLimitError,
    PersoInvalidKeyError,
    PersoPlanRequiredError,
    PersoProjectFailedError,
    PersoUnavailableError,
    begin_credit_watch,
    end_credit_watch,
    note_credits,
    perso_to_cues,
    short_reason,
)
from app.qwen_pipeline import cleanup_takes, run_qwen_dub
from app.run_errors import PartsMissing, advice_both
from app.scripts.check_leakage import _validate_manifest_spans, measure_leakage
from app.scripts.suppress_vocal_echo import suppress_vocal_echo
from app.separate import SeparationEngine

# Re-exported, not merely used: the stage table lives in app/stages.py (a leaf
# module app/source_fetch.py can import without dragging the orchestrator in),
# and pipeline.STAGES / pipeline.stage_marker stay valid names because tests
# and other modules already read them off this module.
from app.stages import STAGES, pre_stage_marker, stage_marker  # noqa: F401
from app.stt_local import NoSpeech, transcribe_local
from app.text.cues import cue_speaker, match_cue_index
from app.text.length_fit import fit_translate
from app.text.srt import (
    borrow_time,
    build_srt,
    clamp_cues,
    merge_by_pause,
    parse_srt,
    split_at_sentence_ends,
    split_cues_into_sentences,
)
from app.translate import (
    ChatGptLimitError,
    ChatGptNotSignedInError,
    GeminiInvalidKeyError,
    GeminiQuotaExhaustedError,
    GeminiUnavailableError,
    TranslationEngine,
    get_translator,
    script_ok,
)

logger = logging.getLogger("persodub.pipeline")

# The ffmpeg helpers moved to app/media.py (lowest layer, no app imports) so
# app/qwen_pipeline.py can reach them without importing this module back.
# These names stay: pipeline's own call sites below use them, and the tests
# monkeypatch pipeline._mux / _video_duration / ensure_video_length.
# They are aliases, not wrappers, so patching pipeline._mux or
# pipeline._video_duration no longer reaches inside ensure_video_length -- that
# one calls media.mux / media.video_duration directly. A test that stubs two of
# the three and lets the third run really shells out to ffprobe: stub
# ensure_video_length too.
_video_duration = media.video_duration
_mux = media.mux
ensure_video_length = media.ensure_video_length


def _log_stage(log: Callable[[str], None], name: str, text: str) -> None:
    """Log one stage line: the stage's marker, a space, then the given text."""
    log(f"{stage_marker(name)} {text}")


def _timed_stage(log: Callable[[str], None], name: str, **context):
    """One stage between its START and DONE lines in the job's file
    (app/jobs.py timed_step), numbered as its "N/6" lines are; `context` is
    what the stage is given, for its Context line: settings and counts only."""
    return timed_step(log, stage_marker(name), name, **context)


# The cancellation checkpoint between stages (and between a translator's asks)
# is app/jobs.py's, shared with the voice stage; this is the name the stages
# below were written against.
_check_cancel = raise_if_cancelled


def _check_room(work_dir: str, video_path: str, video_duration: Optional[float]) -> None:
    """Room checkpoint, called before each stage beside _check_cancel.

    Stops the job with the numbers (app/room.py) when the rest of it will not
    fit on the disk, rather than halfway through writing a stage's files. A
    link's video is only known here, once it is downloaded.
    """
    short = room.short_of_room(work_dir, video_path, video_duration)
    if short:
        # Measured twice, once per language: a read of the free space is cheap.
        raise shown_error(short, room.short_of_room(work_dir, video_path, video_duration, shown=True) or short)


# The provider failures every stage reports the same way: one short sentence in
# the log, the same sentence as a structured notice for the UI popup, then the
# job fails with that sentence as its error. The third field names the
# exception attribute holding a clickable link, or None when the fix lives
# inside the app (Settings) rather than on the web -- the wording of each
# message is a user decision (2026-08-06), so change it here and nowhere else.
# Each sentence is a function returning both() -- (English, the user's
# language) -- so it is said in the language of the moment it is raised.
# Where to take a failure that is not the user's to fix. The stage sentence
# says which part stopped; this says who can answer for it, because "Perso STT
# failed" on its own left the user with nowhere to go (user, 2026-09-11). Left
# off the two the user CAN fix -- recharging and correcting a key are not
# questions for Perso.
def _ask_perso():
    return both("Ask Perso if it keeps happening.")


def _ask_google():
    return both("Ask Google if it keeps happening.")


def _check_file():
    return both("Check the video file.")


# A helper that is missing its own interpreter, script or model file
# (app/run_errors.py PartsMissing): the download is broken, not the video. The
# sentence names the part, so the user knows which one to download again.
_PARTS_MISSING = {
    "Whisper": lambda: both("The Whisper files for speech-to-text are missing or damaged. "
                            "Open Settings > Models and download Whisper again."),
    "Demucs": lambda: both("The Demucs files for audio separation are missing or damaged. "
                           "Open Settings > Models and download Demucs again."),
}


def _advice(e, part):
    if isinstance(e, PartsMissing):
        return _PARTS_MISSING[part]()
    return advice_both(str(e), _check_file())


_NOTICE_ERRORS = {
    PersoCreditExhaustedError: (
        "perso_credit_exhausted",
        lambda: both("Perso credits are used up. Recharge to continue."),
        "link",
        None,
    ),
    # Longer than the plan allows: the free plan stops at one minute. Its own
    # popup says the limit and links to the plans; nothing to retry.
    PersoDurationLimitError: (
        "perso_duration_limit",
        lambda: both("This video is longer than your Perso plan allows. Upgrade your plan, or set Dubbing to This computer."),
        "link",
        None,
    ),
    # A voice model the plan does not cover (FINCH, NIGHTINGALE need Pro).
    PersoPlanRequiredError: (
        "perso_plan_required",
        lambda: both("This dubbing model needs a higher Perso plan. Upgrade your plan, or choose another dubbing model."),
        "link",
        None,
    ),
    PersoInvalidKeyError: (
        "perso_invalid_key",
        lambda: both("Perso rejected the API key. Open Settings and check the key."),
        None,
        None,
    ),
    PersoUnavailableError: (
        "perso_unavailable",
        lambda: both("Perso's server is temporarily unavailable. Wait a few minutes, then run this job again."),
        None,
        _ask_perso,
    ),
    # Reached, accepted, worked on, given up. The other three are about not
    # getting to Perso at all; this one has an answer from Perso saying the
    # project is over, and the user needs to be told which -- silence here is
    # what left a failed project looking like a running one (user,
    # 2026-09-11). The sentence carries Perso's own reason and code, appended
    # by raise_notice, so the screen and Perso's dashboard read alike.
    PersoProjectFailedError: (
        "perso_project_failed",
        lambda: both("Perso could not finish this job. Try again, or check the project on Perso."),
        None,
        _ask_perso,
    ),
    GeminiQuotaExhaustedError: (
        "gemini_quota_exhausted",
        lambda: both("Gemini quota is used up. Upgrade the key's plan, or try again after the daily reset."),
        "link",
        None,
    ),
    GeminiInvalidKeyError: (
        "gemini_invalid_key",
        lambda: both("Gemini rejected the API key. Open Settings and check the key."),
        None,
        None,
    ),
    GeminiUnavailableError: (
        "gemini_unavailable",
        lambda: both("Google's Gemini server is temporarily overloaded. Wait a few minutes, then run this job again."),
        None,
        _ask_google,
    ),
    ChatGptNotSignedInError: (
        "chatgpt_signed_out",
        lambda: both("ChatGPT is not signed in. Sign in with ChatGPT in Settings, then Resume. "
                     "Or continue with another translator."),
        None,
        None,
    ),
    VoiceEngineDown: (
        "voice_engine_down",
        lambda: both("The voice engine stopped responding. Quit and reopen PersoDub, then Resume."),
        None,
        None,
    ),
    ChatGptLimitError: (
        "chatgpt_limit",
        lambda: both("ChatGPT usage limit reached for now. Wait for it to reset, then Resume. "
                     "Or continue with another translator."),
        None,
        None,
    ),
}

# Which of them each stage catches. Kept separate from the table so a Perso
# stage still cannot swallow a Gemini failure (and the other way round): the
# fall-through "except Exception" after these writes a stage-specific sentence,
# and that is what an unexpected provider error must keep landing in.
_PERSO_NOTICE_ERRORS = (
    PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError,
    PersoProjectFailedError, PersoDurationLimitError, PersoPlanRequiredError,
)
_GEMINI_NOTICE_ERRORS = (GeminiQuotaExhaustedError, GeminiUnavailableError, GeminiInvalidKeyError,
                         ChatGptNotSignedInError, ChatGptLimitError)


def raise_notice(e, log, on_notice) -> NoReturn:
    """Report a _NOTICE_ERRORS failure and fail the job with its message.

    Public: app/dub_launch.py's cloud path fails the same three Perso errors
    the same way, so it calls this rather than keeping its own copy of the
    messages.

    Always raises. Logs one "   Error: …" line (with the link in parentheses
    when the exception carries one), hands on_notice the structured dict the UI
    reads, then raises the message chained from e -- exactly what each
    hand-written except block did before. In two languages: the English one is
    the message (the error, the log, the notice's "message"), the user's is
    the notice's "message_shown" and the job's error_shown (shown_error).
    """
    for cls in type(e).__mro__:
        entry = _NOTICE_ERRORS.get(cls)
        if entry is not None:
            break
    else:  # pragma: no cover -- callers only pass types listed above
        raise e
    notice_type, words, link_attr, ask = entry
    msg, shown = words()
    # The failed job's sentence on screen: ours, with what to do. Perso's
    # words go on a line of their own under it (the job's error_detail): the
    # screen cut one sentence holding both at "Perso said:", and Perso's
    # reason, its code and the advice after them were lost.
    sentence = shown
    detail = None
    # Perso's own words stay whole in the log and the report, so they can be
    # held up against Perso's dashboard (user, 2026-09-11). On screen only
    # its code: Perso writes in English, and the code is all that asking
    # Perso needs (user, 2026-10-20).
    said = getattr(e, "reason", "") or ""
    code = getattr(e, "code", "") or ""
    if said or code:
        perso = both("Perso said: {said}", said=said) if said else both("Perso said: no reason given")
        msg = f"{msg} {perso[0]}" + (f" ({code})" if code else "")
    if code:
        detail = both("Error code {code}", code=code)[1]
        shown = f"{shown} {detail}"
    # Last, after their own words: the code is the thing to quote when asking.
    if ask:
        asked = ask()
        msg, shown, sentence = f"{msg} {asked[0]}", f"{shown} {asked[1]}", f"{sentence} {asked[1]}"
    # A ChatGPT limit that named its reset time says it (weeks, on a free plan),
    # in the order the popup says it: when, then the two ways on.
    resets = getattr(e, "resets", None)
    if isinstance(e, ChatGptLimitError) and resets:
        msg, shown = both("ChatGPT usage limit reached. Resets {resets}. Resume then, or continue with "
                          "another translator.", resets=resets)
    notice = {"type": notice_type, "message": msg, "message_shown": shown}
    # The plan's limit, for the popup that names it ("up to 1 min").
    if getattr(e, "limit_seconds", None):
        notice["limit_seconds"] = e.limit_seconds
    if link_attr:
        notice["link"] = getattr(e, link_attr)
        log(f"   Error: {msg} ({notice['link']})")
    else:
        log(f"   Error: {msg}")
    if on_notice:
        on_notice(notice)
    raise shown_error(msg, sentence if detail else shown, detail) from e


# The name the stages below were written against.
_raise_notice = raise_notice


# What each Perso part says when it fails on an error none of its except
# clauses named: which part stopped and what to switch to -- one whole
# sentence per part, so each language words it its own way. Why it stopped
# goes under it (_raise_perso_failed).
_PERSO_FAILED = {
    "Perso separation": lambda: both("Perso separation failed. Check Settings, or switch separation back to Local."),
    "Perso STT": lambda: both("Perso STT failed. Check Settings, or switch to Whisper (free, offline)."),
    "Perso dubbing": lambda: both("Perso dubbing failed. Check Settings, or use this computer for dubbing."),
}


def _raise_perso_failed(e, log, what) -> NoReturn:
    """Fail a Perso stage on an error none of its except clauses named.

    Always raises. Logs one "   Error: …" line saying which stage stopped
    (`what`, a key of _PERSO_FAILED), why, and what to switch to, then raises
    that sentence (shown_error), chained from e. Shared by the two Perso
    stages below and the cloud dub (app/dub_launch.py), which word such a
    failure alike.
    """
    # short_reason, not str(e): httpx's text ends in the address it called,
    # and a sentence that finishes with a URL reads as somewhere the user
    # is being sent (user, 2026-09-11). The whole of it goes to the log.
    logger.warning("%s failed: %s", what, e)
    msg, shown = _PERSO_FAILED[what]()
    asked = _ask_perso()
    # The reason on a line of its own under the sentence (the job's
    # error_detail): inside it, the screen cut the sentence at the reason's
    # first colon and the advice went with it.
    reason = both("Reason: {reason}", reason=short_reason(e))
    msg, shown = f"{msg} {asked[0]} ({reason[0]})", f"{shown} {asked[1]}"
    log(f"   Error: {msg}")
    raise shown_error(msg, shown, reason[1]) from e


def _manifest_exclude_spans(manifest_path, mix_wav, log):
    """Whitelisted nonverbal spans to skip while measuring, or None.

    Kept laugh/breath spans are literal original-voice copies; measured at full
    strictness they read as persistent leaks and the canceller would erase
    them. An invalid manifest is reported and ignored -- strict measurement is
    the conservative outcome for an untrusted span list."""
    import json
    import wave

    if not manifest_path or not os.path.exists(manifest_path):
        return None
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    kept = manifest.get("kept") or []
    if not kept:
        return None
    with wave.open(mix_wav, "rb") as w:
        mix_dur = w.getnframes() / float(w.getframerate())
    reason = _validate_manifest_spans(kept, mix_dur, mode=manifest.get("mode"))
    if reason is not None:
        log(f"   Warning: nonverbal manifest rejected ({reason}) — measuring at full strictness")
        return None
    return [(float(k["start"]), float(k["end"])) for k in kept]


def leakage_gate(mix_wav, vocals_path, manifest_path, work_dir, log):
    """Stage 5/6: measure original-voice leakage in the finished dub audio and
    cancel persistent echo runs (the Qwen sidecar can bleed its speaker-
    reference prompt into synthesized lines). Returns the path to mux --
    the original when clean, a cleaned copy otherwise. Never raises: a broken
    checker must not fail the dub it is checking.

    Mode (config.PERSODUB_LEAKAGE_GATE, read live so tests/env changes apply):
    "off" skips the stage entirely; "measure" measures and logs but never
    rewrites the mix; anything else ("on" or unrecognised) is today's
    measure-and-auto-fix behavior."""
    mode = config.PERSODUB_LEAKAGE_GATE
    if mode not in ("off", "measure", "on"):
        mode = "on"
    if mode == "off":
        _log_stage(log, "check",
                   "Checking for original-voice leakage… skipped (PERSODUB_LEAKAGE_GATE=off)")
        return mix_wav
    _log_stage(log, "check", "Checking for original-voice leakage…")
    try:
        spans = _manifest_exclude_spans(manifest_path, mix_wav, log)
        r = measure_leakage(mix_wav, vocals_path, exclude_spans=spans)
        if r["pass"]:
            log(f"   leakage gate: PASS ({r['n_windows']} windows checked)")
            return mix_wav
        log(f"   leakage gate: {r['n_fail']} of {r['n_windows']} windows failing "
            f"(worst {r['max_rel_db']:+.1f} dB) — cancelling original-voice echo")
        if mode == "measure":
            log("   measure-only mode (PERSODUB_LEAKAGE_GATE=measure): mix left untouched")
            return mix_wav
        fixed = os.path.join(work_dir, "dub_leakfix.wav")
        n = suppress_vocal_echo(mix_wav, vocals_path, fixed, exclude_spans=spans)
        r2 = measure_leakage(fixed, vocals_path, exclude_spans=spans)
        if r2["pass"]:
            log(f"   leakage gate: PASS after cancelling {n} echo run(s)")
        else:
            log(f"   Warning: leakage gate: still {r2['n_fail']} failing window(s) after "
                f"cancellation — delivering the cleaned mix, but listen before shipping")
        return fixed
    except Exception as e:
        log(f"   Warning: leakage gate skipped ({type(e).__name__}: {str(e)[:80]})")
        return mix_wav


def _record_provided_script(srt_path: str, source_cues: Optional[list], work_dir: str) -> None:
    """The three files the finished screen's script is read from, for a dub
    that was handed its translation instead of making one: voices remade
    from a script (app/api/dub.py dub_job_redub) and a dub started with a
    subtitle file. The automatic path writes them at the end of translation;
    this path skipped that, and the finished screen said "No script was
    recorded for this job" (user, 2026-09-23). Nothing here overwrites a
    file that is already there."""
    dst = os.path.join(work_dir, "translated.srt")
    if os.path.abspath(srt_path) != os.path.abspath(dst) and not os.path.exists(dst):
        shutil.copyfile(srt_path, dst)
    if not source_cues:
        return
    original = os.path.join(work_dir, "original.srt")
    if not os.path.exists(original):
        with open(original, "w", encoding="utf-8") as f:
            f.write(build_srt([dict(c) for c in source_cues]))
    speakers = os.path.join(work_dir, "speakers.json")
    if not os.path.exists(speakers):
        with open(speakers, "w", encoding="utf-8") as f:
            json.dump([{"start": c["start"], "end": c["end"], "speaker": cue_speaker(c)}
                       for c in source_cues], f)


def _auto_translate_srt(
    source_cues: list,
    target_lang: str,
    translator: TranslationEngine,
    work_dir: str,
    source_lang: Optional[str] = None,
    log: Optional[Callable[[str], None]] = None,
) -> str:
    """Translate the source script (source_cues) into the target language and build an SRT.

    source_cues is always provided by the caller (STT -- Perso or local Whisper --
    always runs before this, so there is no more "ask the container for its own
    transcript" fallback). fit_translate() drafts a budget-stated translation, then
    re-requests any line outside its ±15% budget window -- too long OR too short --
    close together (see app/text/length_fit.py; unifies what used to be a separate "too short"
    fill-the-slot pass here).
    """
    log = log or (lambda m: None)
    cues = [dict(c) for c in source_cues]
    texts = [c["text"] for c in cues]
    durations = [round(c["end"] - c["start"], 2) for c in cues]
    # A translator that cannot follow a length rule is given none: no slots,
    # so no budgets and no re-asks (app/translate.py length_rules).
    slots = durations if translator.length_rules else None

    # Translate with an explicit per-line character budget, re-requesting only
    # out-of-window lines (too long or too short) for a closer rewrite.
    try:
        translated = fit_translate(
            translator, texts, target_lang, source_lang, slots, log=log
        )
    except ValueError as e:
        # If formatting keeps failing, fall back to the standard method (built-in line-count guarantee)
        log(f"   Length-fit translation failed ({str(e)[:60]}) — translating with the standard method")
        translated = translator.translate(texts, target_lang, source_lang, slots)

    # Lines the length-fit format got no usable answer for are left UNTRANSLATED
    # there rather than failing the job; the plain format is simpler to answer,
    # so they get one more chance in it. What is still empty after that stays
    # silent in the dub and is marked on the script.
    missing = [i for i, t2 in enumerate(translated) if not t2.strip()]
    if missing:
        log(f"   Length-fit translation failed for {len(missing)} lines — translating them with the standard method")
        redo = translator.translate(
            [texts[i] for i in missing], target_lang, source_lang,
            [slots[i] for i in missing] if slots else None,
        )
        for i, t2 in zip(missing, redo):
            translated[i] = t2

    # Final check: re-translate any line whose characters aren't the target language, whatever stage produced it (up to 2 times)
    # (this also catches cases where compress/fill re-translation pulled in the wrong language)
    # An untranslated line is not a wrong-language one: it has had its retries.
    # A translator whose own wording stands (ChatGPT) is not asked again: the
    # lines are counted for the log and kept as written (user, 2026-09-25).
    if not translator.recheck_script:
        kept_as_written = [i for i, t2 in enumerate(translated)
                           if t2.strip() and not script_ok(t2, target_lang)]
        if kept_as_written:
            log(f"   {len(kept_as_written)} lines keep words in another script, as the translator wrote them")
    for _ in range(2 if translator.recheck_script else 0):
        bad = [i for i, t2 in enumerate(translated)
               if t2.strip() and not script_ok(t2, target_lang)]
        if not bad:
            break
        log(f"   {len(bad)} lines not in the target language → re-translating")
        redo = translator.translate(
            [texts[i] for i in bad], target_lang, source_lang,
            [slots[i] for i in bad] if slots else None,
        )
        for i, t2 in zip(bad, redo):
            if script_ok(t2, target_lang):
                translated[i] = t2
    still_bad = [i for i, t2 in enumerate(translated)
                 if t2.strip() and not script_ok(t2, target_lang)]
    if still_bad and translator.recheck_script:
        log(f"   Warning: {len(still_bad)} lines still not in the target language — output needs review")
    untranslated = [i for i, t2 in enumerate(translated) if not t2.strip()]
    if untranslated and len(untranslated) == len(translated):
        # A dub of nothing but silence is not a finished job -- and without this
        # it would reach the voice stage and fail there, blaming the TTS engine.
        raise shown_error(*both("no line could be translated (0 of {n})", n=len(translated)))
    if untranslated:
        log(f"   Warning: {len(untranslated)} lines could not be translated — left silent, "
            f"marked \"Not translated\" in the script")

    # Keep the source script before the next line overwrites it in place -- past this
    # point the source is gone, and app/dub_script.py needs it to show a line's source
    # next to its translation. Named original.srt, not source.srt: source.srt already
    # belongs to a caller-uploaded source script (app/api/dub.py's dub_start
    # writes the uploaded source_srt there).
    with open(os.path.join(work_dir, "original.srt"), "w", encoding="utf-8") as f:
        f.write(build_srt(cues))

    # Who speaks when, beside it: an SRT has nowhere to keep a speaker label, and
    # the finished screen names each line's speaker from this file.
    with open(os.path.join(work_dir, "speakers.json"), "w", encoding="utf-8") as f:
        json.dump([{"start": c["start"], "end": c["end"], "speaker": cue_speaker(c)}
                   for c in cues], f)

    for c, tr in zip(cues, translated):
        c["text"] = tr
    # Split translated blocks into sentences to fine-tune dubbing timing
    cues = split_cues_into_sentences(cues)
    # Sentences that don't fit even at 1.5x borrow time by merging with the next sentence
    cues = borrow_time(cues, target_lang)
    out_srt = os.path.join(work_dir, "translated.srt")
    # Whole or not at all (Resume trusts this file): written aside, then moved.
    with open(out_srt + ".part", "w", encoding="utf-8") as f:
        f.write(build_srt(cues))
    os.replace(out_srt + ".part", out_srt)
    return out_srt


def _carry_speaker_labels(target_cues: List[dict], labelled_cues: List[dict]) -> None:
    """Give unlabelled cues the speaker of the labelled cue they fall inside.

    An uploaded source script has accurate timing and sentence boundaries but no
    speaker labels, while the transcript that diarization ran on has labels but
    coarser timing. Each script line inherits the label of the transcript line
    its midpoint lands in (app.text.cues.match_cue_index). Lines with no match, and
    cues that already carry a label, are left alone. Mutates target_cues.
    """
    if not target_cues or not labelled_cues:
        return
    if not any(cue_speaker(c) for c in labelled_cues):
        return  # nothing to carry -- diarization did not run or found nothing
    for cue in target_cues:
        if cue_speaker(cue):
            continue
        k = match_cue_index(cue, labelled_cues)
        if k is None:
            continue
        spk = cue_speaker(labelled_cues[k])
        if spk:
            cue["speaker_id"] = spk


def _separate_with_perso(video_path, work_dir, perso_client, cancel_check, on_notice, log):
    """Perso cloud voice/background separation for run_dub's 1b stage.

    Same contract as the local SeparationEngine ({"vocals", "background"}), and
    the same failure grammar as the Perso STT stage in run_dub (2026-08-06 rule:
    the user picked Perso, so a failure FAILS the job -- no silent local
    fallback). Returns (sep_paths, client) so the STT stage can reuse the
    client -- its upload cache is what keeps the same video from being
    uploaded twice when both stages go through Perso.
    """
    # The client is made inside the `try`, so one that cannot be made (no key,
    # or the workspace lookup offline or refused) is worded like a failed
    # call. ws is set first because the `finally` reads it.
    ws = None
    try:
        pc = perso_client or PersoClient()
        pc.cancel_check = cancel_check
        # The upload's and the downloads' lines into the job's file too.
        pc.trace = getattr(log, "trace", None)
        # Say which workspace is paying -- same reason as the STT stage below.
        ws = begin_credit_watch(pc)
        if ws:
            name = ws.get("name") or f"workspace {ws.get('seq')}"
            log(f"   Perso workspace: {name} (#{ws.get('seq')})")
        sep_paths = pc.separate(video_path, work_dir)
        # What THIS job consumed, not just the balance -- a surprise in the
        # credits payload must never discard the paid result (STT stage rule).
        note_credits(ws, pc, log, "Perso separation")
    except JobCancelled:
        raise  # a user cancel is not a Perso failure -- don't rewrap it
    except _PERSO_NOTICE_ERRORS as e:
        _raise_notice(e, log, on_notice)
    except Exception as e:
        _raise_perso_failed(e, log, "Perso separation")
    finally:
        end_credit_watch(ws)   # a call that failed must not count as still running
    return sep_paths, pc


def _stage_separate(video_path, work_dir, sep_engine, perso_client,
                    cancel_check, on_notice, log, video_duration=None):
    """Stage 1/6 -- voice/background separation.

    Local Demucs (default) or Perso cloud. Either way a failure fails the whole
    job: no silent engine substitution (2026-08-06 rule), and no container
    fallback. Returns (vocals_path, background_path, perso_client, model); the
    client comes back because the Perso path may have created one, and the STT
    stage reuses it so the same video is not uploaded twice. `model` is what
    did the separating ("RoFormer", "Demucs" or "Perso"), for the job record:
    the log alone used to say which, and the record said "demucs" for a
    RoFormer run (2026-10-09).

    video_duration, when known, scales the local Demucs subprocess timeout for
    long videos (see app.timeouts.scaled_timeout) -- unused on the Perso path.
    """
    began = time.monotonic()
    if (sep_engine or "").lower() == "perso":
        model = "Perso"
        _log_stage(log, "separate", "Separating background audio via Perso cloud…")
        sep_paths, perso_client = _separate_with_perso(
            video_path, work_dir, perso_client, cancel_check, on_notice, log)
    else:
        engine = SeparationEngine(video_duration=video_duration)
        # getattr: test fakes may not carry them.
        model = getattr(engine, "name", "Demucs")
        _log_stage(log, "separate",
                   f"Separating background audio locally ({model}, {getattr(engine, 'model_file', '?')})…")
        try:
            sep_paths = engine.separate(video_path, work_dir)
        except Exception as e:
            # This one runs on the user's own machine, so there is nobody to
            # ask -- but which thing to look at depends on what stopped it. A
            # timeout and a full disk are not a broken file, and saying so
            # sent people to check the one thing that was fine (2026-09-15).
            advice = _advice(e, "Demucs")
            failed = both("Voice separation failed on this computer.")
            raise shown_error(f"{failed[0]} {advice[0]} ({str(e)[:400]})",
                             f"{failed[1]} {advice[1]} ({str(e)[:400]})")
    # The line a reader judges the stage by: it finished, with what, how long.
    log(f"   Separated in {time.monotonic() - began:.0f} s with {model}: "
        f"{os.path.basename(sep_paths['vocals'])}, {os.path.basename(sep_paths['background'])}")
    return sep_paths["vocals"], sep_paths["background"], perso_client, model


def _separation_note(vocals_path, background_path, model=None):
    """What SEPARATED_NAME holds: the two files by name, and the model that
    made them when it is known (a test fake gives none)."""
    note = {"vocals": os.path.basename(vocals_path), "background": os.path.basename(background_path)}
    if model:
        note["model"] = model
    return note


def _stage_transcribe_perso(video_path, perso_client, cancel_check, on_notice, log, video_duration=None):
    """Stage 2/6 -- Perso cloud STT (diarization & timestamps). Returns
    (cues, client) -- the client so the job can report what the stage spent.

    A failure FAILS the job -- the user picked Perso, and silently substituting
    the local engine meant paid-quality was quietly downgraded with only a log
    line to show for it (user decision 2026-08-06: no fallback; say what is
    wrong and how to fix it instead).
    """
    # Set before the `try` because the `finally` reads it, and a client that
    # cannot be made fails before begin_credit_watch has set it.
    ws = None
    try:
        _log_stage(log, "transcribe", "Running Perso STT (diarization & timestamps)…")
        pc = perso_client or PersoClient()
        # Let Cancel interrupt the Perso progress wait (up to an hour of
        # polling); without this, "Cancelling…" hung until Perso finished.
        pc.cancel_check = cancel_check
        # The upload's lines into the job's file too.
        pc.trace = getattr(log, "trace", None)
        # Say which workspace is paying. A workspace picked in Settings
        # applies only after a restart, so the active one here can differ
        # from what the Settings screen shows -- this line is how the user
        # finds that out (billed the wrong-workspace confusion of
        # 2026-08-06). getattr: test fakes may not carry it.
        ws = begin_credit_watch(pc)
        if ws:
            name = ws.get("name") or f"workspace {ws.get('seq')}"
            log(f"   Perso workspace: {name} (#{ws.get('seq')})")
        segments = pc.transcribe(video_path)
        # What THIS job consumed (balance before minus after), not just the
        # remaining balance (user feedback 2026-08-06). Counted as soon as
        # Perso answers, before the answer is read, as separation and the
        # cloud dub count theirs: the call is billed whatever it holds, an
        # empty transcript too. A surprise in the credits payload must never
        # discard the paid result.
        note_credits(ws, pc, log, "Perso STT")
        perso_cues = clamp_cues(perso_to_cues(segments), video_duration)
        if not perso_cues:
            raise RuntimeError("Perso result is empty")
        # The client goes back with the cues, as _stage_separate's does: it
        # carries what this stage spent, which the finished job reports.
        return perso_cues, pc
    except JobCancelled:
        raise  # a user cancel is not a Perso failure -- don't rewrap it
    except _PERSO_NOTICE_ERRORS as e:
        _raise_notice(e, log, on_notice)
    except Exception as e:
        _raise_perso_failed(e, log, "Perso STT")
    finally:
        end_credit_watch(ws)   # a call that failed must not count as still running


def _stage_transcribe_local(video_path, source_language_code, diar_engine, log, video_duration=None,
                            vocals_path=None, cancel_check=None):
    """Stage 2/6 -- local Whisper transcription (no container at all).

    Returns (src_cues, detected_source_language_code, diar_engine): Whisper
    auto-detects the source language, and it sets no speaker_id, so this path
    also turns CAM++ on unless the caller already picked a diarization engine.

    video_duration, when known, scales the subprocess timeout for long videos
    (see app.timeouts.scaled_timeout) and ends every line where the video
    does; vocals_path lets Whisper's made-up lines over quiet stretches go.
    cancel_check is asked while Whisper runs, so Stop ends it there instead
    of after the whole run.
    """
    _log_stage(log, "transcribe", "Transcribing locally (Whisper, no container)…")
    detected = {"code": None}
    try:
        # NEVER pass language_code here: it names the TARGET language, and
        # forcing it once made an en->ko job decode English speech as Korean
        # phonetic gibberish. Only the UI's explicit SOURCE pick
        # (source_language_code) may be given as a hint; None = auto-detect.
        # Word times, so a line can end where a sentence ends (split_at_sentence_ends).
        src_cues = transcribe_local(
            video_path, language=source_language_code, word_timestamps=True, log=log,
            on_language=lambda c: detected.__setitem__("code", c),
            video_duration=video_duration, vocals_path=vocals_path, cancel_check=cancel_check,
        )
    except JobCancelled:
        raise  # a user cancel is not a failure of this stage
    except NoSpeech as e:
        # A music-only or silent video: said so, instead of "Speech
        # recognition failed. Check the video file." about a file that is fine.
        msg, shown = both("No speech was found in this video. Check that someone is speaking in it.")
        log(f"   Error: {msg}")
        raise shown_error(msg, shown) from e
    except Exception as e:
        # Was re-raised bare, which put a library's own words on the failure
        # card with no hint of which part had stopped (user, 2026-09-11).
        advice = _advice(e, "Whisper")
        failed = both("Speech recognition failed on this computer.")
        msg = f"{failed[0]} {advice[0]} ({str(e)[:400]})"
        log(f"   Error: {msg}")
        raise shown_error(msg, f"{failed[1]} {advice[1]} ({str(e)[:400]})") from e
    # Local Whisper sets no speaker_id -- CAM++ can still label the cues it produced.
    return src_cues, detected["code"], diar_engine or "campplus"


def _stage_diarize(diar_engine, vocals_path, src_cues, num_speakers, log, video_duration=None):
    """Stage 2/6 -- local CAM++ diarization (opt-in). Relabels src_cues in place.

    pyannote-era labels could collapse everyone to a single speaker; CAM++
    re-labels each cue by clustering voice embeddings straight off the local
    Demucs vocals track (diarize() resamples internally, so no separate 16k
    extraction step is needed). It has NO VAD -- it only labels the cue spans
    STT already produced, and a failure is a warning, not a job failure.

    video_duration, when known, scales the subprocess timeout for long videos
    (see app.timeouts.scaled_timeout).
    """
    if diar_engine != "campplus" or not src_cues:
        return
    try:
        _log_stage(log, "transcribe", "Diarizing locally with CAM++ (campplus)…")
        labeled = diarize(vocals_path, src_cues, num_speakers=num_speakers, video_duration=video_duration)
        for cue, lab in zip(src_cues, labeled):
            spk = lab.get("speaker")
            if spk:
                # cue_speaker() reads speaker_id first, then speaker. STT paths
                # (Perso / local Whisper) may already set speaker_id, so we must
                # overwrite THAT field or the CAM++ label is shadowed and does nothing.
                cue["speaker_id"] = spk
        n_spk = len({cue_speaker(c) for c in src_cues if cue_speaker(c)})
        log(f"   CAM++ labeled {len(src_cues)} lines across {n_spk} speakers")
    except Exception as e:
        log(f"   Warning: CAM++ diarization failed ({str(e)[:80]}) — keeping existing labels")


def _pick_source_cues(source_srt_path, perso_cues, src_cues):
    """The cues stage 3 translates from, and the Qwen path clones voices from.

    If source subtitles (a professional script) exist, their timing & sentences
    are accurate, good for both translation and voice references. Otherwise use
    whatever STT produced (Perso if it ran, else local Whisper).
    """
    if source_srt_path is None:
        # A machine transcript cuts at every sentence; a user's script is kept as written.
        return merge_by_pause(split_at_sentence_ends(perso_cues if perso_cues is not None else src_cues))
    with open(source_srt_path, encoding="utf-8-sig") as f:
        source_cues = parse_srt(f.read())
    # parse_srt returns bare {start,end,text} -- a script file carries no
    # speaker labels. Diarization has already labelled the transcript, so
    # carry those labels across by time; without this, ref_cues has no
    # speakers at all and the Qwen path clones a single voice for the whole
    # video (app/qwen_pipeline.py falls back to DEFAULT_SPEAKER).
    _carry_speaker_labels(
        source_cues, perso_cues if perso_cues is not None else src_cues
    )
    return source_cues


def _ready_translator(translator, translate_engine, work_dir, cancel_check, log):
    tr = translator or get_translator(translate_engine)
    # ChatGPT: a Resume re-reads what was already answered (the others keep nothing).
    tr.answers_dir = os.path.join(work_dir, "chatgpt_answers")
    # Cancel between asks, not only after the stage: a cancel during a
    # long translation kept asking ChatGPT for 2.5 minutes (8 more
    # requests off the user's allowance, Windows 2026-09-25). Every
    # request goes through the translator's ask, which runs before_ask first.
    if cancel_check is not None:
        tr.before_ask = lambda: _check_cancel(cancel_check, log)
    return tr


def _stage_translate(srt_path, source_cues, language, translate_engine, translator,
                     work_dir, on_notice, log, cancel_check=None):
    """Stage 3/6 -- translated subtitles, provided or auto-translated.

    Returns (segments, auto_translated): the dialogue lines the dub speaks, and
    whether this run produced them itself. An empty result fails the job --
    without that check the job runs to "done" and ships a video whose speech
    was stripped by separation with no dub to replace it.
    """
    auto_translated = False
    if srt_path is None:
        tr = _ready_translator(translator, translate_engine, work_dir, cancel_check, log)
        # Name the engine (and model) that translated -- a Gemini run and a
        # local Gemma run were indistinguishable in the log (user feedback
        # 2026-08-06).
        tr_name = tr.display_name or type(tr).__name__
        tr_model = tr.model
        engine_label = f"{tr_name} — {tr_model}" if tr_model else tr_name
        _log_stage(log, "translate",
                   f"Translating from source subtitles ({len(source_cues)} lines, {engine_label})…")
        # Same shape as the Perso credit handling above: a short sentence says
        # what happened, the structured notice carries it (plus a link when one
        # helps) to the UI popup. The raw HTTP error stays out of the screen.
        # A ChatGPT that cannot answer (limit, sign-in) stops the dubbing here
        # too: the popup offers the other translators and Resume carries on
        # with the one the user picks (owner, 2026-10-03), never one of ours.
        try:
            srt_path = _auto_translate_srt(
                source_cues, language, tr, work_dir, log=log,
            )
        except _GEMINI_NOTICE_ERRORS as e:
            _raise_notice(e, log, on_notice)
        except JobCancelled:
            raise  # a user cancel is not a translation failure
        except Exception as e:
            # Anything Gemini throws that is not one of the two above still
            # came from Google, and a local model's failure is nobody's to
            # ask about. Either way the sentence names the translator, so
            # the card says which part stopped (user, 2026-09-11).
            logger.warning("Translation failed (%s): %s", engine_label, e)
            where = _ask_google() if "gemini" in tr_name.lower() else \
                both("Try again, or pick another translator in Settings.")
            failed = both("{translator} translation failed.", translator=tr_name)
            # The reason under the sentence (the job's error_detail): inside
            # it, the screen cut "(ChatGPT: no reply)" at the colon. Shortened
            # by short_reason, which keeps a URL and requests' own words out.
            reason = both("Reason: {reason}", reason=short_reason(e))
            msg = f"{failed[0]} {where[0]} ({reason[0]})"
            log(f"   Error: {msg}")
            raise shown_error(msg, f"{failed[1]} {where[1]}", reason[1]) from e
        auto_translated = True
    else:
        _log_stage(log, "translate", "Using the provided translated subtitles")
        _record_provided_script(srt_path, source_cues, work_dir)

    with open(srt_path, encoding="utf-8-sig") as f:
        segments = parse_srt(f.read())
    log(f"   {len(segments)} dialogue lines prepared")
    if not segments:
        raise shown_error(*both("No dialogue lines were found in this video."))
    return segments, auto_translated


def _stage_synthesize(segments, ref_cues, work_dir, vocals_path, background_path,
                      language, n_takes, qwen_engine, on_notice, log, video_duration=None,
                      reuse_lines=False, cancel_check=None, translator=None,
                      sample_cues=None):
    """Stage 4/6 -- cloning & synthesis (Qwen3-TTS, the app's only TTS engine).

    Returns the path of the full-length dubbed audio.

    video_duration, when known, scales the nonverbal-whitelist / company-
    ambience gate's whisper-veto subprocess timeout for long videos (see
    app.timeouts.scaled_timeout).
    """
    effective_n_takes = n_takes if n_takes is not None else QWEN_N_TAKES
    # Say which Voice-quality mode ran (user feedback 2026-08-06). <=1 is the
    # "fast" UI mode: best-of-N selection is disabled (see config.QWEN_N_TAKES).
    mode = ("fast, 1 take/line" if effective_n_takes <= 1
            else f"high quality, best of {effective_n_takes} takes")
    _log_stage(log, "synthesize", f"Cloning & synthesizing voices (Qwen3-TTS — {mode})…")
    engine = qwen_engine or QwenTTSEngine()
    # Say which device this is about to run on. Without it the only symptom of
    # a CPU fallback is the wait, and the user has no way to tell that from the
    # app being slow. Absent (not guessed) when the engine cannot say.
    device = getattr(engine, "device_label", lambda: None)()
    if device:
        log(f"   synthesis device: {device}")

    try:
        return run_qwen_dub(engine, segments, ref_cues, work_dir,
                            vocals_path=vocals_path, background_path=background_path,
                            language=language, n_takes=effective_n_takes, log=log,
                            on_notice=on_notice, video_duration=video_duration,
                            **({"reuse_lines": True} if reuse_lines else {}),
                            **({"cancel_check": cancel_check} if cancel_check else {}),
                            **({"translator": translator} if translator else {}),
                            **({"sample_cues": sample_cues} if sample_cues else {}))
    except VoiceEngineDown as e:
        # The one voice failure that is not one line's: nothing more will be
        # made this run, so the job stops here and the screen says why.
        raise_notice(e, log, on_notice)


def _stage_finish(video_path, audio_wav, out_path, work_dir, log):
    """Stage 6/6 -- mux the dub onto the video, then the length gate. -> None"""
    _log_stage(log, "build", "Building the finished file…")
    d_vid = _video_duration(video_path)
    r = _mux(video_path, audio_wav, out_path, d_vid)
    if r.returncode != 0:
        # ffmpeg could not put the sound on the picture: not the voice
        # engine's failure, whichever engine made the voices. Only its last
        # line, with the folders cut off (media._failure), reaches the screen.
        paths = (video_path, audio_wav, out_path)
        what = both("Could not build the finished video")
        raise shown_error(media._failure(what[0], r.stderr, paths), media._failure(what[1], r.stderr, paths))
    ensure_video_length(video_path, out_path, log)
    # Final assembly + length gate passed -- only now drop the losing take
    # candidates that were kept for a possible reassembly pass (see
    # qwen_pipeline.synth_lines / cleanup_takes).
    cleanup_takes(work_dir, log)
    # The per-line voices, the background bed and the speaker references stay.
    # Rewriting one line and re-speaking only that line needs all three, and a
    # rewrite is the normal thing to do after watching the dub back (user
    # decision 2026-08-24, reversing the 0.3.6 cleanup). They cost disk, so
    # app/api/_launch.py's check_space refuses a job that would not fit, and
    # app/room.py asks again before each stage. cleanup_intermediates() is
    # still here, though only its tests call it.
    log("   keeping the per-line audio so single lines can be redone")


# What a finished stage leaves behind for "Resume" (user, 2026-09-23): a
# dub that stopped half way picks up from the first stage without a result,
# instead of starting over. A cloud (Perso) stage's result is a file here
# too, so resuming never asks Perso -- or spends its credits -- twice.
# Translation and voices already leave files (translated.srt, qwen_line_N.wav);
# these two record the earlier stages.
SEPARATED_NAME = "separated.json"
TRANSCRIPT_NAME = "transcript.json"


def _usable_file(path: Optional[str]) -> bool:
    return bool(path) and os.path.isfile(path) and os.path.getsize(path) > 44


def _save_json(work_dir: str, name: str, data) -> None:
    tmp = os.path.join(work_dir, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, default=str)
    os.replace(tmp, os.path.join(work_dir, name))


def _load_json(work_dir: str, name: str):
    try:
        with open(os.path.join(work_dir, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _saved_separation(work_dir: str):
    """The two files by name, inside this folder only: a record that points
    anywhere else is not trusted (review 2026-09-23), and a moved workspace
    still resumes."""
    d = _load_json(work_dir, SEPARATED_NAME)
    if not isinstance(d, dict):
        return None
    paths = []
    for key in ("vocals", "background"):
        name = os.path.basename(str(d.get(key) or ""))
        path = os.path.join(work_dir, name)
        if not name or not _usable_file(path):
            return None
        paths.append(path)
    return paths[0], paths[1]


def _saved_transcript(work_dir: str):
    d = _load_json(work_dir, TRANSCRIPT_NAME)
    if isinstance(d, dict) and isinstance(d.get("cues"), list) and d["cues"]:
        return d
    return None


def _duration_or_none(video_path):
    """The video's length, measured once, up front, so the heavy local stages
    (separation, transcription, diarization, the nonverbal gate) can scale
    their subprocess timeouts to the video instead of a fixed wall that
    ignores length -- long videos used to die on it (issue: 21 occurrences).
    A failed probe (corrupt file, ffprobe missing, ...) must never fail the
    dub over a timeout number, so it gives None: every stage then uses
    today's fixed default, same as before this change."""
    try:
        return _video_duration(video_path)
    except Exception:
        return None


def _separate_or_reuse(video_path, work_dir, resume, sep_engine, perso_client, cancel_check, on_notice, log,
                       video_duration=None):
    """Stage 1/6, or the separation the earlier run saved (SEPARATED_NAME)
    when resuming. Returns (vocals_path, background_path, perso_client,
    model, reused)."""
    saved = _saved_separation(work_dir) if resume else None
    if saved:
        _log_stage(log, "separate", "Separated audio from the earlier run, reused")
        vocals_path, background_path = saved
        model = (_load_json(work_dir, SEPARATED_NAME) or {}).get("model")
        return vocals_path, background_path, perso_client, model, True
    vocals_path, background_path, perso_client, model = _stage_separate(
        video_path, work_dir, sep_engine, perso_client, cancel_check, on_notice, log,
        video_duration=video_duration)
    _save_json(work_dir, SEPARATED_NAME, _separation_note(vocals_path, background_path, model))
    return vocals_path, background_path, perso_client, model, False


def _transcribe_or_reuse(video_path, work_dir, reuse, vocals_path, stt_engine, source_language_code,
                         diar_engine, num_speakers, perso_client, cancel_check, on_notice, log,
                         video_duration=None):
    """Stage 2/6, or the transcript the earlier run saved (TRANSCRIPT_NAME)
    when `reuse`. Perso cloud STT if the user picked it, else local Whisper.
    Whisper auto-detects the source language, and that code comes back so
    the result can surface it; Perso STT reports no language, so it stays
    None. Returns (src_cues, perso_cues, detected_code, perso_client,
    reused)."""
    saved = _saved_transcript(work_dir) if reuse else None
    if saved:
        _log_stage(log, "transcribe",
                   "Transcript from the earlier run, reused (%d lines)" % len(saved["cues"]))
        src_cues = saved["cues"]
        perso_cues = src_cues if saved.get("perso") else None
        return src_cues, perso_cues, saved.get("detected"), perso_client, True
    detected_code = None
    perso_cues = None
    if stt_engine == "perso":
        perso_cues, perso_client = _stage_transcribe_perso(
            video_path, perso_client, cancel_check, on_notice, log, video_duration=video_duration)
    if perso_cues is None:
        src_cues, detected_code, diar_engine = _stage_transcribe_local(
            video_path, source_language_code, diar_engine, log, video_duration=video_duration,
            vocals_path=vocals_path, cancel_check=cancel_check)
    else:
        src_cues = perso_cues
    # A machine transcript can start a line before its speech (Whisper
    # did by 0.15 s or more on 15 of 49 lines): the dub would speak before
    # the mouth moves. Saved moved, so a Resume reads the same starts.
    moved = snap_starts(src_cues, vocals_path)
    if moved:
        log("   %d line start(s) moved to where the speech begins" % moved)
    _stage_diarize(diar_engine, vocals_path, src_cues, num_speakers, log, video_duration=video_duration)
    _save_json(work_dir, TRANSCRIPT_NAME,
               {"cues": src_cues, "perso": perso_cues is not None, "detected": detected_code})
    return src_cues, perso_cues, detected_code, perso_client, False


def _translate_or_reuse(reuse, srt_path, source_cues, language, translate_engine, translator,
                        work_dir, on_notice, log, cancel_check=None):
    """Stage 3/6, or the translation the earlier run finished when `reuse`
    (translated.srt is only ever written whole). Returns (segments,
    auto_translated, reused)."""
    kept_translation = os.path.join(work_dir, "translated.srt")
    if reuse and _usable_file(kept_translation):
        _log_stage(log, "translate", "Translation from the earlier run, reused")
        with open(kept_translation, encoding="utf-8-sig") as f:
            segments = parse_srt(f.read())
        log(f"   {len(segments)} dialogue lines prepared")
        return segments, True, True
    segments, auto_translated = _stage_translate(
        srt_path, source_cues, language, translate_engine, translator,
        work_dir, on_notice, log, cancel_check=cancel_check)
    return segments, auto_translated, False


def _result_of(job_id, out_path, video_path, work_dir, segments, auto_translated, detected_code,
               perso_client, sep_model) -> dict:
    """What run_dub returns for a finished dub."""
    # Lines the assembly cut short (ran into the next line, or past the end of
    # the video -- app/qwen_assemble.place_lines), for the UI to show later.
    # Absent only for a job whose synthesis stage never reached place_lines at
    # all, which _stage_synthesize would already have failed on.
    clipped_info = _load_json(work_dir, "clipped_lines.json") or {"clipped": [], "clipped_count": 0}
    return {
        "job_id": job_id,
        "out_path": out_path,
        "num_segments": len(segments),
        "auto_translated": auto_translated,
        "detected_source_language": detected_code,
        # For the usage count: what the job spent on Perso (None when no stage
        # went there) and how long the video was. The probe just succeeded in
        # _stage_finish, so asking again is safe.
        "perso_credits": getattr(perso_client, "credits_used", None),
        "duration": _video_duration(video_path),
        # What separated the voice from the background, onto the record the
        # same way (None when a reused separation did not say).
        "separation_model": sep_model,
        "clipped": clipped_info["clipped"],
        "clipped_count": clipped_info["clipped_count"],
    }


def run_dub(
    video_path: str,
    out_path: str,
    srt_path: Optional[str] = None,
    source_srt_path: Optional[str] = None,
    language: str = "English",
    language_code: str = "en",
    num_speakers: Optional[int] = None,
    translate_engine: Optional[str] = None,
    stt_engine: Optional[str] = None,
    # "perso" sends the voice/background split through Perso cloud; anything
    # else (the default) runs local Demucs. Same no-silent-fallback rule as
    # stt_engine.
    sep_engine: Optional[str] = None,
    # Whisper language hint from the UI's source-language dropdown; None keeps
    # the old auto-detect behavior (server callers don't pass it).
    source_language_code: Optional[str] = None,
    diar_engine: Optional[str] = None,
    qwen_engine=None,
    n_takes: Optional[int] = None,
    perso_client: Optional[PersoClient] = None,
    translator: Optional[TranslationEngine] = None,
    log: Optional[Callable[[str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    on_notice: Optional[Callable[[dict], None]] = None,
    resume: bool = False,
) -> dict:
    """Dub a single video and save it to out_path.

    resume: pick up in this folder from the first stage that left no result
    (see SEPARATED_NAME above) -- the Resume button on a stopped job.

    If srt_path is given, use those translated subtitles as is.
    If not, transcribe -> translate with the engine the job names -> dub.
    Voice synthesis always runs through our own Qwen3-TTS sidecar
    (app/qwen_pipeline.run_qwen_dub) -- it is the app's only TTS engine.
    n_takes sets how many candidate takes per line the best-of-N selection
    scores before picking a winner; None uses the QWEN_N_TAKES config default
    (app.config).
    Background/vocals separation always runs locally (app/separate.py, local
    Demucs, no container round-trip). There is no fallback: if local
    separation fails, the job fails with a clear error instead of silently
    degrading to an unlicensed engine.
    stt_engine picks the transcription source: "perso" for cloud STT+diarization
    (a Perso failure FAILS the job -- no silent local fallback, user decision
    2026-08-06); anything else (the default) goes straight to local Whisper
    (app/stt_local.transcribe_local). Local Whisper sets no speaker_id, so it
    also forces diar_engine to "campplus" unless already set.
    Progress is reported via log(msg). cancel_check, if given, is polled at
    stage boundaries (see _check_cancel above); a True result raises
    JobCancelled and stops the job before the next stage starts. on_notice,
    if given, is called with a structured {"type", "message", "link"} dict
    for events the caller may want to surface outside the plain log stream
    ("perso_credit_exhausted", "perso_duration_limit", "perso_plan_required", "perso_invalid_key", "perso_unavailable",
    "gemini_quota_exhausted", "gemini_invalid_key", "gemini_unavailable" -- see app/api/dub.py,
    which wires it to JobStore.append_notice so the job status JSON carries it
    for the UI).
    """
    log = log or (lambda m: None)

    # The job's folder (uuid tag for scratch filenames; nothing is uploaded),
    # then the stages in app/stages.py's order: separate, transcribe, translate,
    # synthesize, check, build.
    job_id = uuid.uuid4().hex[:8]
    work_dir = os.path.dirname(out_path) or tempfile.gettempdir()
    os.makedirs(work_dir, exist_ok=True)

    _check_cancel(cancel_check, log)
    video_duration = _duration_or_none(video_path)

    def checkpoint():
        # Between two stages: stop if Cancel was pressed, or if the rest of
        # the job will not fit on the disk.
        _check_cancel(cancel_check, log)
        _check_room(work_dir, video_path, video_duration)

    # Each stage sits between START and DONE lines in the job's file, which
    # the screen never reads (_timed_stage); its "N/6" lines are as before.
    _check_room(work_dir, video_path, video_duration)
    with _timed_stage(log, "separate", sep_engine=sep_engine, resume=resume,
                      duration=None if video_duration is None else round(video_duration, 1)):
        vocals_path, background_path, perso_client, sep_model, sep_reused = _separate_or_reuse(
            video_path, work_dir, resume, sep_engine, perso_client, cancel_check, on_notice, log,
            video_duration=video_duration)

    checkpoint()

    # Each reuse holds only while everything before it was reused too: a stage
    # made again can change the lines, and a later stage's files from the
    # earlier run would then belong to different lines (review 2026-09-23).
    # Named as they will run: local Whisper unless Perso was asked for, the
    # language found by itself, and the speakers named by CAM++ after Whisper
    # (_stage_transcribe_local) or by Perso's own transcript.
    with _timed_stage(log, "transcribe", stt_engine=stt_engine or "whisper", source=source_language_code or "auto",
                      diar_engine=diar_engine or ("perso" if stt_engine == "perso" else "campplus"),
                      num_speakers=num_speakers):
        src_cues, perso_cues, detected_code, perso_client, tx_reused = _transcribe_or_reuse(
            video_path, work_dir, sep_reused, vocals_path, stt_engine, source_language_code,
            diar_engine, num_speakers, perso_client, cancel_check, on_notice, log,
            video_duration=video_duration)
        source_cues = _pick_source_cues(source_srt_path, perso_cues, src_cues)

    checkpoint()

    # Translated subtitles (provided or auto-translated)
    with _timed_stage(log, "translate", translate_engine=translate_engine, lines=len(source_cues),
                      target=language, source=source_language_code or detected_code, srt_given=bool(srt_path)):
        segments, auto_translated, translation_reused = _translate_or_reuse(
            tx_reused and srt_path is None, srt_path, source_cues, language, translate_engine, translator,
            work_dir, on_notice, log, cancel_check=cancel_check)

        # Preserve emotion & speaker -- the reference lines the Qwen path builds its
        # per-speaker voice samples from. (If source subtitles exist, their timing is
        # more accurate, so prefer them.)
        ref_cues = source_cues or src_cues
        # The voice samples are cut from the transcript's own lines when no script
        # was given: the merged lines run past the 7 s a sample may be, and in a
        # Shuka lecture the only one short enough was its last, which the end of
        # the video cut off mid-sentence (2026-10-04).
        sample_cues = None if source_srt_path else src_cues

        # A script the app translated itself may be written again once its lines
        # are voiced, by the same translator, to fit each slot at the speaker's
        # real pace (app/qwen_pipeline.fit_to_pace). Never a script the user gave.
        pace_tr = None
        if config.PACE_FIT and auto_translated:
            pace_tr = _ready_translator(translator, translate_engine, work_dir, cancel_check, log)
            if not getattr(pace_tr, "length_rules", True):
                log("   pace fit off: %s does not follow a length" % (getattr(pace_tr, "display_name", "") or "this translator"))
                pace_tr = None

    checkpoint()
    reuse_lines = bool(resume and (translation_reused or srt_path))
    # The voices are cloned from the reference lines' speakers: the script's
    # own lines (parse_srt) carry none.
    with _timed_stage(log, "synthesize", lines=len(segments), n_takes=n_takes,
                      speakers=len({cue_speaker(c) for c in ref_cues if cue_speaker(c)}) or None,
                      resume=reuse_lines):
        audio_wav = _stage_synthesize(
            segments, ref_cues, work_dir, vocals_path, background_path,
            language, n_takes, qwen_engine, on_notice, log, video_duration=video_duration,
            reuse_lines=reuse_lines, cancel_check=cancel_check,
            translator=pace_tr, sample_cues=sample_cues)

    checkpoint()

    # The check stage: catch original speech bleeding through the dub.
    with _timed_stage(log, "check"):
        audio_wav = leakage_gate(audio_wav, vocals_path,
                                 os.path.join(work_dir, "nonverbal_manifest.json"),
                                 work_dir, log)

    _check_room(work_dir, video_path, video_duration)
    with _timed_stage(log, "build"):
        _stage_finish(video_path, audio_wav, out_path, work_dir, log)
    log("Done!")
    return _result_of(job_id, out_path, video_path, work_dir, segments, auto_translated, detected_code,
                      perso_client, sep_model)


_INTERMEDIATE = re.compile(
    r"^(vocals|background|qwen_dub_48k|qwen_line_\d+|qwen_ref_.*)\.wav$"
)


def cleanup_intermediates(work_dir, log=None):
    # type: (str, Optional[Callable[[str], None]]) -> int
    """Delete the audio a finished job no longer needs. Returns how many went.

    Call ONLY after the job succeeded -- a failed or cancelled job keeps
    everything, because that is what tells us what went wrong. Measured on a
    real job (2026-08-21): about 61% of a 31MB folder. The dubbed video, the
    source video and every .srt are never touched.
    """
    log = log or (lambda m: None)
    if not os.path.isdir(work_dir):
        return 0
    removed = 0
    for name in os.listdir(work_dir):
        if _INTERMEDIATE.match(name):
            os.remove(os.path.join(work_dir, name))
            removed += 1
    if removed:
        log("   cleaned up %d intermediate audio file(s)" % removed)
    return removed
