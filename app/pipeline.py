"""Dubbing pipeline orchestrator.

Video + translated subtitles (SRT) -> finished dubbed video (mp4).
If no subtitles are provided: transcribe -> Gemini translation -> dub (auto-translate mode).
Every stage runs locally or through our own Qwen3-TTS sidecar -- no third-party
container anywhere in this app.
"""
import os
import subprocess
import tempfile
import uuid
from typing import Callable, List, Optional

from app import config
from app.config import QWEN_N_TAKES
from app.diar_campplus_client import diarize
from app.engines.qwen_tts import QwenTTSEngine
from app.jobs import JobCancelled
from app.perso_client import (
    PersoClient,
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoUnavailableError,
    perso_to_cues,
)
from app.qwen_pipeline import cleanup_takes, run_qwen_dub
from app.scripts.check_leakage import _validate_manifest_spans, measure_leakage
from app.scripts.suppress_vocal_echo import suppress_vocal_echo
from app.separate import SeparationEngine
from app.stt_local import transcribe_local
from app.text.cues import cue_speaker, match_cue_index
from app.text.length_fit import fit_translate
from app.text.srt import (
    borrow_time,
    build_srt,
    parse_srt,
    split_cues_into_sentences,
)
from app.translate import (
    GeminiQuotaExhaustedError,
    GeminiUnavailableError,
    TranslationEngine,
    get_translator,
    script_ok,
)


def _check_cancel(cancel_check: Optional[Callable[[], bool]], log: Callable[[str], None]) -> None:
    """Cooperative cancellation checkpoint, called between pipeline stages.

    cancel_check is polled instead of killing the worker thread/subprocess
    mid-stage -- the safest form of interruption here (see
    app/jobs.py:JobStore.request_cancel). A stage already in flight (e.g. the
    Qwen3-TTS sidecar call) always finishes; cancellation takes effect at the
    next checkpoint.
    """
    if cancel_check is not None and cancel_check():
        log("⏹️ Cancelled by user request")
        raise JobCancelled("cancelled by user")


def _stream_duration(path: str, stream: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", "stream=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    # ffmpeg 7.x appends a trailing comma to csv output -> strip it and convert to number
    return float(out.stdout.strip().splitlines()[0].rstrip(","))


def _video_duration(path: str) -> float:
    return _stream_duration(path, "v:0")


def _mux(video: str, audio: str, out: str, dur: float) -> subprocess.CompletedProcess:
    """Re-mux a video track with an audio track, padding the audio to `dur` seconds.

    The video stream is copied untouched (-c:v copy); only the audio is (re)encoded.
    """
    return subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio,
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
         "-b:a", "256k", "-af", "apad", "-t", f"{dur:.3f}", out],
        capture_output=True, text=True,
    )


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
        log(f"   ⚠️ nonverbal manifest rejected ({reason}) — measuring at full strictness")
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
        log("5/6 Checking for original-voice leakage… skipped (PERSODUB_LEAKAGE_GATE=off)")
        return mix_wav
    log("5/6 Checking for original-voice leakage…")
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
            log(f"   ⚠️ leakage gate: still {r2['n_fail']} failing window(s) after "
                f"cancellation — delivering the cleaned mix, but listen before shipping")
        return fixed
    except Exception as e:
        log(f"   ⚠️ leakage gate skipped ({type(e).__name__}: {str(e)[:80]})")
        return mix_wav


def ensure_video_length(original_video: str, out_path: str, log: Callable[[str], None]) -> None:
    """🔒 Absolute guarantee: if the output video length differs from the original, rebuild using the original video untouched.

    The Qwen dub export can come out shorter than the video (audio ends first). In that
    case, re-mux the original video track + dubbed audio (silence-padded at the end)
    into a finished file where not a single video frame has been touched.
    """
    try:
        d_orig = _video_duration(original_video)
        d_out = _video_duration(out_path)
    except Exception as e:
        log(f"   ⚠️ Length check failed ({str(e)[:60]}) — using the export result as is")
        return
    if abs(d_orig - d_out) <= 0.02:
        return
    log(f"   Video length correction: {d_out:.3f}s → {d_orig:.3f}s (lossless rebuild from original video)")
    tmp = out_path + ".fix.mp4"
    r = _mux(original_video, out_path, tmp, d_orig)
    if r.returncode == 0 and os.path.exists(tmp):
        os.replace(tmp, out_path)
    else:
        log(f"   ⚠️ Length correction failed — keeping the export result ({r.stderr[-80:]})")


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
    close together (see app/len_fit.py; unifies what used to be a separate "too short"
    fill-the-slot pass here).
    """
    log = log or (lambda m: None)
    cues = [dict(c) for c in source_cues]
    texts = [c["text"] for c in cues]
    durations = [round(c["end"] - c["start"], 2) for c in cues]

    # Translate with an explicit per-line character budget, re-requesting only
    # out-of-window lines (too long or too short) for a closer rewrite.
    try:
        translated = fit_translate(
            translator, texts, target_lang, source_lang, durations, log=log
        )
    except ValueError as e:
        # If formatting keeps failing, fall back to the standard method (built-in line-count guarantee)
        log(f"   Length-fit translation failed ({str(e)[:60]}) — translating with the standard method")
        translated = translator.translate(texts, target_lang, source_lang, durations)

    # Final check: re-translate any line whose characters aren't the target language, whatever stage produced it (up to 2 times)
    # (this also catches cases where compress/fill re-translation pulled in the wrong language)
    for _ in range(2):
        bad = [i for i, t2 in enumerate(translated) if not script_ok(t2, target_lang)]
        if not bad:
            break
        log(f"   {len(bad)} lines not in the target language → re-translating")
        redo = translator.translate(
            [texts[i] for i in bad], target_lang, source_lang,
            [durations[i] for i in bad],
        )
        for i, t2 in zip(bad, redo):
            if script_ok(t2, target_lang):
                translated[i] = t2
    still_bad = [i for i, t2 in enumerate(translated) if not script_ok(t2, target_lang)]
    if still_bad:
        log(f"   ⚠️ {len(still_bad)} lines still not in the target language — output needs review")

    # Keep the source script before the next line overwrites it in place -- past this
    # point the source is gone, and app/dub_script.py needs it to show a line's source
    # next to its translation. Named original.srt, not source.srt: source.srt already
    # belongs to a caller-uploaded source script (app/main.py:388).
    with open(os.path.join(work_dir, "original.srt"), "w", encoding="utf-8") as f:
        f.write(build_srt(cues))

    for c, tr in zip(cues, translated):
        c["text"] = tr
    # Split translated blocks into sentences to fine-tune dubbing timing
    cues = split_cues_into_sentences(cues)
    # Sentences that don't fit even at 1.5x borrow time by merging with the next sentence
    cues = borrow_time(cues, target_lang)
    out_srt = os.path.join(work_dir, "translated.srt")
    with open(out_srt, "w", encoding="utf-8") as f:
        f.write(build_srt(cues))
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
) -> dict:
    """Dub a single video and save it to out_path.

    If srt_path is given, use those translated subtitles as is.
    If not, transcribe -> Gemini translation -> dub (auto-translate mode).
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
    ("perso_credit_exhausted", "perso_invalid_key", "perso_unavailable",
    "gemini_quota_exhausted", "gemini_unavailable" -- see app/main.py, which
    wires it to JobStore.append_notice so the job status JSON carries it for
    the UI).
    """
    log = log or (lambda m: None)

    # 1. Local job workspace (uuid tag for scratch filenames; nothing is uploaded)
    job_id = uuid.uuid4().hex[:8]
    work_dir = os.path.dirname(out_path) or tempfile.gettempdir()
    os.makedirs(work_dir, exist_ok=True)

    _check_cancel(cancel_check, log)

    # 1b. Local Demucs separation -- mandatory, no container fallback. A failure
    # here fails the whole job rather than silently falling back to a remote service.
    log("1/6 Separating background audio locally (Demucs)…")
    try:
        sep_paths = SeparationEngine().separate(video_path, work_dir)
    except Exception as e:
        raise RuntimeError(f"Local separation failed, aborting (no container fallback): {str(e)[:200]}")
    vocals_path, background_path = sep_paths["vocals"], sep_paths["background"]

    _check_cancel(cancel_check, log)

    # 2-0. Perso STT path: get diarization and timestamps from Perso. A failure
    # FAILS the job -- the user picked Perso, and silently substituting the
    # local engine meant paid-quality was quietly downgraded with only a log
    # line to show for it (user decision 2026-08-06: no fallback; say what is
    # wrong and how to fix it instead).
    # Whisper auto-detects the source language; capture it so the result can
    # surface it. Perso STT reports no language, so this stays None there.
    detected_language = {"code": None}
    perso_cues = None
    if stt_engine == "perso":
        try:
            log("2/6 Running Perso STT (diarization & timestamps)…")
            pc = perso_client or PersoClient()
            # Let Cancel interrupt the Perso progress wait (up to an hour of
            # polling); without this, "Cancelling…" hung until Perso finished.
            pc.cancel_check = cancel_check
            # Say which workspace is paying. A workspace picked in Settings
            # applies only after a restart, so the active one here can differ
            # from what the Settings screen shows -- this line is how the user
            # finds that out (billed the wrong-workspace confusion of
            # 2026-08-06). getattr: test fakes may not carry it.
            ws = getattr(pc, "describe_workspace", lambda: None)()
            if ws:
                name = ws.get("name") or f"workspace {ws.get('seq')}"
                log(f"   Perso workspace: {name} (#{ws.get('seq')})")
            perso_cues = perso_to_cues(pc.transcribe(video_path))
            if not perso_cues:
                raise RuntimeError("Perso result is empty")
            # What THIS job consumed (balance before minus after), not just the
            # remaining balance (user feedback 2026-08-06). Log-only: by this
            # point transcription has succeeded AND been billed, so a surprise
            # in the credits payload must never discard the paid result.
            try:
                if ws and ws.get("credits") is not None:
                    after = (getattr(pc, "describe_workspace", lambda: None)() or {}).get("credits")
                    if after is not None:
                        log(f"   Perso credits used: {int(ws['credits']) - int(after)} ({after} left)")
            except Exception:
                pass
        except JobCancelled:
            raise  # a user cancel is not a Perso failure -- don't rewrap it
        except PersoCreditExhaustedError as e:
            # Short on purpose (user feedback 2026-08-06): the sentence says
            # what happened, the notice's clickable Recharge link says where
            # to go -- the URL text itself stays out of the message.
            msg = "Perso credits are used up. Recharge to continue."
            log(f"   ❌ {msg} ({e.link})")
            if on_notice:
                on_notice({"type": "perso_credit_exhausted", "message": msg, "link": e.link})
            raise RuntimeError(msg) from e
        except PersoInvalidKeyError as e:
            # The fix lives in Settings, so the popup's button opens it (no
            # link in the notice -- the action is inside the app).
            msg = "Perso rejected the API key. Open Settings and check the key."
            log(f"   ❌ {msg}")
            if on_notice:
                on_notice({"type": "perso_invalid_key", "message": msg})
            raise RuntimeError(msg) from e
        except PersoUnavailableError as e:
            msg = "Perso's server is temporarily unavailable. Wait a few minutes, then run this job again."
            log(f"   ❌ {msg}")
            if on_notice:
                on_notice({"type": "perso_unavailable", "message": msg})
            raise RuntimeError(msg) from e
        except Exception as e:
            msg = (f"Perso STT failed ({str(e)[:80]}). Check Settings, "
                   f"or switch to Whisper (free, offline).")
            log(f"   ❌ {msg}")
            raise RuntimeError(msg) from e

    # 2. Local Whisper transcription (no container at all) -- skipped if Perso succeeded
    if perso_cues is None:
        log("2/6 Transcribing locally (Whisper, no container)…")
        try:
            # NEVER pass language_code here: it names the TARGET language, and
            # forcing it once made an en->ko job decode English speech as Korean
            # phonetic gibberish. Only the UI's explicit SOURCE pick
            # (source_language_code) may be given as a hint; None = auto-detect.
            src_cues = transcribe_local(
                video_path, language=source_language_code, log=log,
                on_language=lambda c: detected_language.__setitem__("code", c),
            )
        except Exception as e:
            log(f"   ❌ Local STT failed ({str(e)[:120]})")
            raise
        # Local Whisper sets no speaker_id -- CAM++ can still label the cues it produced.
        diar_engine = diar_engine or "campplus"
    else:
        src_cues = perso_cues

    # 2-1. Local CAM++ diarization (opt-in). pyannote-era labels could collapse
    # everyone to a single speaker; CAM++ re-labels each cue by clustering voice
    # embeddings straight off the local Demucs vocals track (diarize() resamples
    # internally, so no separate 16k extraction step is needed).
    # It has NO VAD -- it only labels the cue spans STT already produced.
    if diar_engine == "campplus" and src_cues:
        try:
            log("2/6 Diarizing locally with CAM++ (campplus)…")
            labeled = diarize(vocals_path, src_cues, num_speakers=num_speakers)
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
            log(f"   ⚠️ CAM++ diarization failed ({str(e)[:80]}) — keeping existing labels")

    # If source subtitles (a professional script) exist, their timing & sentences are
    # accurate, good for both translation and voice references. Otherwise use whatever
    # STT produced (Perso if it ran, else local Whisper).
    if source_srt_path is not None:
        with open(source_srt_path, encoding="utf-8-sig") as f:
            source_cues = parse_srt(f.read())
        # parse_srt returns bare {start,end,text} -- a script file carries no
        # speaker labels. Diarization has already labelled the transcript, so
        # carry those labels across by time; without this, ref_cues below has no
        # speakers at all and the Qwen path clones a single voice for the whole
        # video (app/qwen_pipeline.py falls back to DEFAULT_SPEAKER).
        _carry_speaker_labels(
            source_cues, perso_cues if perso_cues is not None else src_cues
        )
    else:
        source_cues = perso_cues if perso_cues is not None else src_cues

    _check_cancel(cancel_check, log)

    # 3. Prepare translated subtitles (provided or auto-translated)
    auto_translated = False
    if srt_path is None:
        tr = translator or get_translator(translate_engine)
        # Name the engine (and model) that translated -- a Gemini run and a
        # local Gemma run were indistinguishable in the log (user feedback
        # 2026-08-06). getattr: test fakes may carry neither attribute.
        tr_name = getattr(tr, "display_name", "") or type(tr).__name__
        tr_model = getattr(tr, "model", None)
        engine_label = f"{tr_name} — {tr_model}" if tr_model else tr_name
        log(f"3/6 Translating from source subtitles ({len(source_cues)} lines, {engine_label})…")
        # Same shape as the Perso credit handling above: a short sentence says
        # what happened, the structured notice carries it (plus a link when one
        # helps) to the UI popup. The raw HTTP error stays out of the screen.
        try:
            srt_path = _auto_translate_srt(
                source_cues, language, tr, work_dir, log=log,
            )
        except GeminiQuotaExhaustedError as e:
            msg = "Gemini quota is used up. Upgrade the key's plan, or try again after the daily reset."
            log(f"   ❌ {msg} ({e.link})")
            if on_notice:
                on_notice({"type": "gemini_quota_exhausted", "message": msg, "link": e.link})
            raise RuntimeError(msg) from e
        except GeminiUnavailableError as e:
            msg = "Google's Gemini server is temporarily overloaded. Wait a few minutes, then run this job again."
            log(f"   ❌ {msg}")
            if on_notice:
                on_notice({"type": "gemini_unavailable", "message": msg})
            raise RuntimeError(msg) from e
        auto_translated = True
    else:
        log("3/6 Using the provided translated subtitles")

    with open(srt_path, encoding="utf-8-sig") as f:
        segments = parse_srt(f.read())
    log(f"   {len(segments)} dialogue lines prepared")
    if not segments:
        # Without this the job runs to "done" and ships a video whose speech
        # was stripped by separation with no dub to replace it.
        raise RuntimeError("No dialogue lines were found in this video.")

    # Preserve emotion & speaker -- the reference lines the Qwen path builds its
    # per-speaker voice samples from. (If source subtitles exist, their timing is
    # more accurate, so prefer them.)
    ref_cues = source_cues or src_cues

    _check_cancel(cancel_check, log)

    # 4. Cloning & synthesis (Qwen3-TTS -- the app's only TTS engine)
    effective_n_takes = n_takes if n_takes is not None else QWEN_N_TAKES
    # Say which Voice-quality mode ran (user feedback 2026-08-06). <=1 is the
    # "fast" UI mode: best-of-N selection is disabled (see config.QWEN_N_TAKES).
    mode = ("fast, 1 take/line" if effective_n_takes <= 1
            else f"high quality, best of {effective_n_takes} takes")
    log(f"4/6 Cloning & synthesizing voices (Qwen3-TTS — {mode})…")
    engine = qwen_engine or QwenTTSEngine()
    # Say which device this is about to run on. Without it the only symptom of
    # a CPU fallback is the wait, and the user has no way to tell that from the
    # app being slow. Absent (not guessed) when the engine cannot say.
    device = getattr(engine, "device_label", lambda: None)()
    if device:
        log(f"   synthesis device: {device}")

    audio_wav = run_qwen_dub(engine, segments, ref_cues, work_dir,
                             vocals_path=vocals_path, background_path=background_path,
                             language=language, n_takes=effective_n_takes, log=log,
                             on_notice=on_notice)

    _check_cancel(cancel_check, log)

    audio_wav = leakage_gate(audio_wav, vocals_path,
                             os.path.join(work_dir, "nonverbal_manifest.json"),
                             work_dir, log)

    log("6/6 Building the finished file…")
    d_vid = _video_duration(video_path)
    r = _mux(video_path, audio_wav, out_path, d_vid)
    if r.returncode != 0:
        raise RuntimeError(f"Qwen dub mux failed: {r.stderr[-200:]}")
    ensure_video_length(video_path, out_path, log)
    # Final assembly + length gate passed -- only now drop the losing take
    # candidates that were kept for a possible reassembly pass (see
    # qwen_pipeline.synth_lines / cleanup_takes).
    cleanup_takes(work_dir, log)
    log("✅ Done!")
    return {
        "job_id": job_id,
        "out_path": out_path,
        "num_segments": len(segments),
        "auto_translated": auto_translated,
        "detected_source_language": detected_language["code"],
    }
