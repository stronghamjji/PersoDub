"""Qwen3-TTS dub path: the app's own clone + synthesize + assemble.

Called by app/pipeline.py's run_dub(), which drives STT (Perso/local Whisper) and
local Demucs separation (app/separate.py) upstream and hands this module the
resulting vocals/background tracks directly -- no third-party container involved
anywhere in this app (removed: CC-BY-NC weights + AGPL studio, incompatible with
a commercial product).

Flow: pick one clean contiguous 4-7s reference span per speaker -> register it once via
the sidecar's /clone -> synthesize each translated line with that speaker's voice_id ->
place the lines over the Demucs background track, each gained to match the original
line's loudness (app/qwen_assemble.match_line_gains + place_lines), plus the original
vocals track gated to silence during the source-language dialogue spans so laughter/
breaths between lines survive (place_lines' vocals_path/speech_regions args).

Voice-clone mode (app.config.QWEN_VOICE_MODE, default "icl" since 2026-10-03): "icl"
clones from the reference audio and the transcript of its span, which kept the stray
"어/아" off the start of lines; "timbre" clones from the audio alone (no transcript, so
build_speaker_refs skips assembling ref_text). A speaker whose span has no usable
transcript is cloned with timbre either way.
"""
import dataclasses
import json
import os
import random
import re
import shutil
import statistics
import time
import unicodedata
import wave
from difflib import SequenceMatcher
from typing import Callable, Dict, List, Optional

from app import i18n, media
from app.audio.ambience import apply_company_ambience
from app.audio.lead_burst import (
    cut_edge_sounds,
    cut_lead_burst,
    edge_pieces,
    edge_sound_too_close,
    fade_edges,
    piece_wav,
    tidy_reference,
)
from app.audio.merge import group_merge_units, split_unit_audio
from app.config import QWEN_GATE_MODE, QWEN_KEEP_NONVERBAL, QWEN_VOICE_MODE
from app.engines.base import (
    SynthesisCut,
    SynthesisRequest,
    SynthesisTimeout,
    VoiceEngineDown,
    ref_wav_path,
)
from app.jobs import JobCancelled, raise_if_cancelled, shown_error
from app.nonverbal import apply_nonverbal_whitelist
from app.qwen_assemble import (
    _trim_lead_tail_silence,
    _voiced_bounds,
    line_play_durations,
    match_line_gains,
    place_lines,
)
from app.qwen_scoring import score_takes, whisper_code
from app.qwen_select import cosine, pick_coherence
from app.scripts.check_speaker_identity import embed_files as _embed_files
from app.stt_local import transcribe_batch
from app.text.cues import (
    cue_speaker,
    cut_vocals_span_local,
    effective_slots,
    match_cue_index,
    ref_text_from_spans,
)
from app.text.numbers import spoken_numbers
from app.text.pace_fit import (
    ROUNDS,
    ask_rewrites,
    measure_pace,
    pick_lines,
    source_for,
    target_count,
    usable_rewrite,
    worse_voice,
)
from app.text.speech import speech_text
from app.text.srt import _count_syllables, build_srt

REF_MIN_DUR = 4.0
REF_MAX_DUR = 7.0
# A line that ends a sentence: its last mark, before any closing quote.
_SENTENCE_END = re.compile(r"[.?!。？！…][\"'”’)\]]*\s*$")
DEFAULT_SPEAKER = "SPEAKER_ALL"  # used when the transcript carries no speaker labels at all


def pick_speaker_ref_span(
    cues: List[dict], speaker: str, min_dur: float = REF_MIN_DUR, max_dur: float = REF_MAX_DUR,
) -> Optional[dict]:
    """Pick the best contiguous audio span ([start, end], one time range) for one
    speaker's voice, out of a list of transcript cues (pure function).

    'Contiguous' means: a run of consecutive cues (in time) that belong ONLY to this
    speaker -- no other speaker's line falls inside the range. Concatenating separate,
    non-adjacent pieces was measured to break pronunciation, so this never happens here;
    every candidate is a single cut from the vocals track.
    Prefers spans whose duration lands in [min_dur, max_dur] seconds; among those, one
    that stops before the transcript's last line, then one that ends a sentence, then
    the one containing the most actual speech (least silence) wins. A reference that
    stops mid-sentence makes the clone say the rest first: three dubs whose reference
    ran to the end of a video cut mid-sentence ("...아파트들이", "...신도시가", "...it
    always will") began 4-6 of 8 lines with those words or an "아/가" (2026-10-04); a
    reference ending a sentence, none. If no window reaches min_dur, falls back to the
    single longest same-speaker run available, capped to max_dur (best effort, still
    one contiguous clip).
    Returns {"start": float, "end": float} or None if the speaker has no cues at all.
    """
    ordered = sorted(cues, key=lambda c: c["start"])
    last = ordered[-1] if ordered else None
    runs: List[List[dict]] = []
    for c in ordered:
        if runs and cue_speaker(c) == cue_speaker(runs[-1][-1]):
            runs[-1].append(c)
        else:
            runs.append([c])
    speaker_runs = [r for r in runs if cue_speaker(r[0]) == speaker]
    if not speaker_runs:
        return None

    def speech_secs(run: List[dict]) -> float:
        return sum(c["end"] - c["start"] for c in run)

    best_span = None
    best_key = None
    for run in speaker_runs:
        for j in range(len(run)):
            for k in range(j, len(run)):
                start, end = run[j]["start"], run[k]["end"]
                dur = end - start
                if dur < min_dur or dur > max_dur:
                    continue
                key = (run[k] is not last, bool(_SENTENCE_END.search(run[k].get("text") or "")),
                       speech_secs(run[j:k + 1]))
                if best_key is None or key > best_key:
                    best_key = key
                    best_span = (start, end)
    if best_span:
        return {"start": best_span[0], "end": best_span[1]}

    # No window landed in [min_dur, max_dur] -- best effort: the single longest run.
    longest = max(speaker_runs, key=lambda r: r[-1]["end"] - r[0]["start"])
    start, end = longest[0]["start"], longest[-1]["end"]
    if end - start > max_dur:
        end = start + max_dur
    return {"start": start, "end": end}


def speakers_in(cues: List[dict]) -> List[str]:
    """Sorted, de-duplicated list of speaker labels found in cues (pure function).

    Empty (no labels at all) means the transcript never distinguished speakers --
    the caller should fall back to treating everyone as DEFAULT_SPEAKER.
    """
    return sorted({s for s in (cue_speaker(c) for c in cues) if s})


def map_segments_to_speakers(segments: List[dict], ref_cues: List[dict], speakers: List[str]) -> List[str]:
    """For each translated segment, find which speaker (from `speakers`) it belongs
    to by time-overlap with ref_cues (pure function, reuses quality.match_cue_index).

    Falls back to the first speaker when no cue overlaps a line, so every line still
    gets voiced instead of silently dropped.
    """
    default = speakers[0] if speakers else None
    out = []
    for s in segments:
        idx = match_cue_index(s, ref_cues) if ref_cues else None
        spk = cue_speaker(ref_cues[idx]) if idx is not None else None
        out.append(spk if spk in speakers else default)
    return out


def build_speaker_refs(ref_cues: List[dict], speakers: List[str],
                       vocals_path: str, mode: Optional[str] = None) -> Dict[str, dict]:
    """For each speaker, cut one clean contiguous reference clip from the local
    Demucs vocals track (vocals_path -- app/separate.py). The clip's audio quality
    still matters in every mode, so span selection (contiguous 4-7s, most speech)
    always runs.

    mode="icl" (or config.QWEN_VOICE_MODE): also builds the reference script
    (ref_text, via the existing >=50%-coverage rule); a speaker whose span
    yields no usable ref_text keeps the reference with ref_text None and is
    cloned from its sound (TTSEngine.assign_voices). The clip is cut to its
    speech in every mode (app/audio/lead_burst.py tidy_reference).
    mode="timbre": ref_text is not assembled at all (the clone step uses the
    audio alone); only the span/audio checks apply.

    Speakers with no usable span (too little dialogue) are simply absent from
    the returned dict; the caller logs how many were skipped.
    Returns {speaker: {"wav_bytes": bytes, "ref_text": Optional[str], "span": {...}}}.
    """
    resolved_mode = mode or QWEN_VOICE_MODE
    refs = {}
    for spk in speakers:
        span = pick_speaker_ref_span(ref_cues, spk)
        if span is None:
            continue
        spans = [[span["start"], span["end"]]]
        wav = cut_vocals_span_local(vocals_path, spans)
        if len(wav) < 1000:
            continue
        wav = tidy_reference(wav)
        ref_text = None
        if resolved_mode == "icl":
            ref_text = ref_text_from_spans(ref_cues, spans).strip() or None
        refs[spk] = {"wav_bytes": wav, "ref_text": ref_text, "span": span}
    return refs


def write_speaker_refs_manifest(refs: Dict[str, dict], ref_cues: List[dict],
                                work_dir: str) -> str:
    """Record which audio each speaker's voice was cloned from, as speaker_refs.json.

    build_speaker_refs already picks one span per speaker, but nothing persisted
    it -- so a cloned voice that came out wrong could not be traced back to the
    audio it was cut from. Writes {speaker: {ref_wav, span, duration, lines,
    ref_text}}, where lines are that speaker's transcript lines overlapping the
    span. Returns the path written.
    """
    manifest = {}
    for spk, ref in refs.items():
        span = ref.get("span") or {}
        s, e = span.get("start"), span.get("end")
        lines = []
        if s is not None and e is not None:
            lines = [
                {"start": c["start"], "end": c["end"], "text": c.get("text", "")}
                for c in ref_cues
                if cue_speaker(c) == spk and c["start"] < e and c["end"] > s
            ]
        manifest[spk] = {
            "ref_wav": os.path.basename(ref_wav_path(work_dir, spk)),
            "span": {"start": s, "end": e},
            "duration": round(e - s, 3) if s is not None and e is not None else None,
            "lines": lines,
            "ref_text": ref.get("ref_text"),
        }
    path = os.path.join(work_dir, "speaker_refs.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return path


# A line that took longer than this is worth a line in the log even though
# it came out fine: it is the kind of thing that turns into a hang next time.
SLOW_LINE_SECONDS = 30.0


def _slot_words(slot: Optional[float]) -> str:
    return "slot %.1fs" % slot if slot else "slot unknown"


def _engine_alive(engine, tries: int = 3) -> bool:
    """Whether the voice engine still answers at all: up to three 5s probes a
    few seconds apart, so a moment of load is not taken for a crash. An
    engine without a probe is taken to be alive: it is the fakes in tests."""
    probe = getattr(engine, "is_available", None)
    if probe is None:
        return True
    for attempt in range(tries):
        if probe():
            return True
        if attempt + 1 < tries:
            time.sleep(ENGINE_PROBE_PAUSE)
    return False


ENGINE_PROBE_PAUSE = 3.0


def _note(stats: Optional[list], label: str, took: float, ok: bool) -> None:
    if stats is not None:
        stats.append((label, took, ok))


def _voice_of(voice_ids: Dict[str, str], seg_speakers: List[str], i: int) -> Optional[str]:
    """Line i's voice: its speaker's voice_id, None when it has neither."""
    return voice_ids.get(seg_speakers[i]) if i < len(seg_speakers) else None


def _synth_one(engine, seg: dict, voice_id: Optional[str], language: str, seed: int,
               out_path: str, log: Callable[[str], None], err_label: str,
               slot: Optional[float] = None, stats: Optional[list] = None) -> Optional[str]:
    """One engine.synthesize() call, written to out_path. None (+ logged line)
    when the line could not be made; the job goes on without it.

    `slot` is the seconds the line has on screen: it sets the line's speech
    cap and waiting time (app/engines/qwen_tts.py). Three ways to fail, each
    said plainly in the job log with its numbers (user, 2026-09-23):
      ran away  -- the engine hit the speech cap; the audio is not kept
      no answer -- waited the line's time; one more try if the engine still
                   answers a probe, and VoiceEngineDown if it does not, which
                   stops the job at once instead of waiting on every line
      failed    -- anything else the engine said
    """
    text = speech_text(seg.get("text", ""))
    if getattr(engine, "needs_spoken_numbers", False):
        # Qwen3-TTS reads "천구백구십년대", not "1990년대" (app/text/numbers.py);
        # the Whisper checks keep comparing against the digits.
        text = spoken_numbers(text, language)
    req = SynthesisRequest(text=text, language=language, voice_id=voice_id, seed=seed, duration=slot)
    started = time.monotonic()
    res = None
    for attempt in (1, 2):
        try:
            res = engine.synthesize(req)
            break
        except SynthesisCut as e:
            log("   %s: ran away, cut at %.1fs (%s), skipped" % (err_label, e.cut_at, _slot_words(slot)))
            _note(stats, err_label, time.monotonic() - started, False)
            return None
        except SynthesisTimeout as e:
            if not _engine_alive(engine):
                raise VoiceEngineDown(err_label) from e
            if attempt == 1:
                log("   %s: no answer in %.0fs, retrying" % (err_label, e.waited))
                # Not the identical request again: the same seed makes about the
                # same tokens, and it waits behind the one abandoned. A new
                # seed, and twice the time (review 2026-09-23).
                req = dataclasses.replace(req, seed=(seed or 0) + 7919, wait=2 * e.waited)
                continue
            log("   %s: no answer in %.0fs again, skipped" % (err_label, e.waited))
            _note(stats, err_label, time.monotonic() - started, False)
            return None
        except Exception as e:
            # A crashed engine answers every later line with a connection
            # error: without this the job ran on, skipping them all, and
            # finished with most of its dialogue missing (review 2026-09-23).
            if not _engine_alive(engine):
                raise VoiceEngineDown(err_label) from e
            log("   %s: %s synth failed (%s) - skipping"
                % (err_label, getattr(engine, "log_name", "Qwen"), str(e)[:80]))
            _note(stats, err_label, time.monotonic() - started, False)
            return None
    took = time.monotonic() - started
    wav = res.audio_bytes
    if getattr(engine, "adds_stray_sounds", False):
        wav, cut = cut_lead_burst(wav, text)
        if cut:
            log("   %s: cut a stray sound before the sentence (%.2fs)" % (err_label, cut))
        wav = fade_edges(wav)
    # Whole or not at all: Resume reuses any line file it finds, so a write
    # the app was closed in the middle of must not leave one behind.
    tmp = out_path + ".part"
    with open(tmp, "wb") as f:
        f.write(wav)
    os.replace(tmp, out_path)
    if took > SLOW_LINE_SECONDS:
        audio = "audio %.1fs" % res.duration if res.duration else "audio ?"
        log("   %s: made in %.0fs (%s, %s)" % (err_label, took, audio, _slot_words(slot)))
    _note(stats, err_label, took, True)
    return out_path


def _log_synth_summary(log: Callable[[str], None], stats: list, paths: List[Optional[str]],
                       silent: int) -> None:
    """One line at the end of the voice stage: how many lines were made, how
    many skipped, and how long they took -- the numbers a hang shows up in."""
    made = sum(1 for p in paths if p is not None)
    skipped = len(paths) - made - silent
    tail = ""
    if stats:
        tooks = [t for _, t, _ in stats]
        slowest = max(stats, key=lambda x: x[1])
        tail = ", median %.1fs/line, slowest %.0fs (%s)" % (statistics.median(tooks), slowest[1], slowest[0])
    log("   voices done: %d lines, %d made, %d skipped%s" % (len(paths), made, skipped, tail))


# Fast mode makes each line once. Measured 2026-10-01: 6 of 139 Qwen lines in
# finished dubs said words their text does not have ("Get, get, get, get, get
# going", "G-G-G-G..."), and nothing looked. Now every made line is heard
# back; one that differs a lot from its text, or runs past 1.6x its slot, is
# made again with a new seed, at most FAST_REMAKES times, and the closest
# try is kept. The match is the High quality scorer's (SequenceMatcher over
# lowercased letters and digits).
FAST_REMAKES = 2
FAST_MIN_MATCH = 0.8
# The voice engine keeps memory it no longer uses: about 8-12 GB more per 50
# lines on an M4 (2026-10-06/07), so a second video pushed a 24 GB computer
# into swap and a third stopped it. Until the leak itself is found, an engine
# holding more than this is started again between two lines (QwenTTSEngine.
# restart): the model's load time once in a while, instead of the computer.
ENGINE_RESTART_MB = 10 * 1024


def _rest_engine(engine, log: Callable[[str], None]) -> None:
    mb = getattr(engine, "memory_mb", lambda: None)()
    if mb is None or mb <= ENGINE_RESTART_MB:
        return
    log("   voice engine holds %.1f GB: starting it again before the next line" % (mb / 1024.0))
    engine.restart()
FAST_EXTRA_LETTERS = 6     # heard this many more letters than the text: words were added
FAST_MAX_OVER_SLOT = 1.6
# A line with under FAST_SHORT_SLOT_S of slot is made FAST_SHORT_TAKES times
# (new seeds) before it is heard back, and the take kept is the one that says
# its text, then fits (within FAST_SHORT_MAX_OVER of the slot), then lands
# closest to the slot: a short line has no room for a stutter or a slow take.
FAST_SHORT_SLOT_S = 2.0
FAST_SHORT_TAKES = 3
# Each made line is also compared with its speaker's voice reference (CAM++,
# the speaker-identity check's embedder). The anchor briefing came out as
# different people line by line while every line said its words (2026-10-06):
# over 160 lines, the ones that had drifted measured 0.07-0.49 against the
# reference and the rest 0.52-0.81. A line under FAST_MIN_LIKENESS is made
# again like a line that said the wrong words.
FAST_MIN_LIKENESS = 0.5


# A voice sample's language, from its script, when that cannot be the line's
# own: Hangul, kana, Han. Latin-script samples are left to the words check,
# which hears them in a Latin-script line's language well enough.
_SCRIPTS = (("ko", re.compile("[\uac00-\ud7a3]")), ("ja", re.compile("[\u3040-\u30ff]")),
            ("zh", re.compile("[\u4e00-\u9fff]")))
# Letters the piece must share in a row with the end of the sample's words:
# "입니다" against "…보입니다" is three; Whisper's made-up "감사합니다" in a
# quiet piece shares only "니다" (2026-10-06).
LEAK_MIN_LETTERS = 3
LEAK_TAIL_LETTERS = 6


def _script_language(text: str) -> Optional[str]:
    return next((code for code, rx in _SCRIPTS if rx.search(text or "")), None)


def _sample_word_leaks(tries, seg_speakers: List[str], work_dir: str, language: str) -> Dict[str, str]:
    """{made file: what was heard} for lines with a piece set apart at their
    start or end (edge_pieces) that says the end of their speaker's voice
    sample in the sample's own language: the clone saying the sample's last
    words, which the words check -- in the line's language -- cannot hear
    (Sebasi line 8 opened with "(보)입니다", 2026-10-06)."""
    try:
        with open(os.path.join(work_dir, "speaker_refs.json"), encoding="utf-8") as f:
            refs = json.load(f)
    except (OSError, ValueError):
        return {}
    target = whisper_code(language)
    pieces = []
    for i, p in tries:
        spk = seg_speakers[i] if i < len(seg_speakers) else None
        sample = (refs.get(spk) or {}).get("ref_text") or ""
        lang = _script_language(sample)
        if not lang or lang == target:
            continue
        with open(p, "rb") as f:
            wav = f.read()
        for k, (a, b) in enumerate(edge_pieces(wav)):
            q = "%s_p%d.wav" % (p[:-4], k)
            with open(q, "wb") as f:
                f.write(piece_wav(wav, a, b))
            pieces.append((p, q, lang, _letters(sample)[-LEAK_TAIL_LETTERS:]))
    leaks = {}
    try:
        for lang in {x[2] for x in pieces}:
            heard = transcribe_batch([q for _, q, l, _ in pieces if l == lang], lang) or {}
            for p, q, l, tail in pieces:
                got = heard.get(q, "") if l == lang else ""
                m = SequenceMatcher(None, _letters(got), tail).find_longest_match(0, len(_letters(got)), 0, len(tail))
                if m.size >= LEAK_MIN_LETTERS:
                    leaks[p] = got.strip()
    finally:
        for _, q, _, _ in pieces:
            os.remove(q)
    return leaks


def _voice_likeness(tries, seg_speakers: List[str], work_dir: str, log: Callable[[str], None]) -> Dict[str, float]:
    """{made file: likeness to its speaker's reference} for the (line, file)
    tries whose speaker has a reference in work_dir; {} when CAM++ cannot
    run, and the log says so."""
    refs = {}
    for i, _ in tries:
        spk = seg_speakers[i] if i < len(seg_speakers) else None
        ref = ref_wav_path(work_dir, spk) if spk else None
        if ref and os.path.exists(ref):
            refs[spk] = ref
    files = [(p, seg_speakers[i]) for i, p in tries if i < len(seg_speakers) and seg_speakers[i] in refs]
    if not files:
        return {}
    try:
        embs, _ = _embed_files(list(refs.values()) + [p for p, _ in files])
    except Exception as e:
        log("   voice check skipped: %s" % str(e)[:80])
        return {}
    ref_emb = dict(zip(refs, embs))
    return {p: cosine(e, ref_emb[spk]) for (p, spk), e in zip(files, embs[len(refs):])}
FAST_SHORT_MAX_OVER = 1.1
# A short sound before or after the sentence (app/audio/lead_burst.
# cut_edge_sounds), heard as "아!" or a stutter (2026-10-02): every try is
# also heard without it, and the cut is kept when Whisper hears the line at
# least as well. When it hears less, the sound is part of a word said with a
# gap in it ("있 ... 어요"), and the line is made again like a wrong one.


def _letters(text: str) -> str:
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFC", text or "").lower())


# Whisper must hear the line's first and last letters (all but this many):
# a try that lost its opening word to the lead cut still matched 0.97
# ("We'll start" heard as "Start", "Comparing" as "Paring", 2026-10-07).
FAST_EDGE_LETTERS = 2


def _edges_heard(text: str, got: str) -> bool:
    """True when the heard letters reach both ends of the text's letters."""
    blocks = [b for b in SequenceMatcher(None, text, got).get_matching_blocks() if b.size]
    if not text or not blocks:
        return False
    return blocks[0].a <= FAST_EDGE_LETTERS and blocks[-1].a + blocks[-1].size >= len(text) - FAST_EDGE_LETTERS


def _edge_too_close(path: str, text: str, language: str) -> bool:
    with open(path, "rb") as f:
        return edge_sound_too_close(f.read(), text, language)


def _edge_cut_copy(path: str, text: str, language: str) -> Optional[str]:
    """The line without the sound before or after its sentence, written next
    to it, or None when it has neither."""
    with open(path, "rb") as f:
        cut = cut_edge_sounds(f.read(), text, language)
    if cut is None:
        return None
    out = path[:-4] + "_e.wav"
    with open(out, "wb") as f:
        f.write(fade_edges(cut[0]))
    return out


def _speech_seconds(path: str) -> float:
    with wave.open(path, "rb") as w:
        data = w.readframes(w.getnframes())
        sw, ch, sr = w.getsampwidth(), w.getnchannels(), w.getframerate()
    start, end = _voiced_bounds(data, sw, ch, sr)
    return end - start


def _words_of(seg: dict) -> str:
    """The words the line check listens for: the line's text as its voice
    reads it."""
    return speech_text(seg.get("text", ""))


def _judge_try(i: int, p: str, text: str, heard: Dict[str, str], cut: Optional[str], close: bool,
               leak: Optional[str], like: Optional[float], slot: float, log: Callable[[str], None]) -> tuple:
    """How one try of line i came out, as (key, path, match, seconds, stray,
    likeness, edges heard): the key ranks a line's tries, and its first item
    says the try is right. `text` is the line's letters. `cut` is the try
    without a stray sound at its edges: it replaces the try, in place, when
    Whisper hears the line at least as well without that sound, and is
    deleted otherwise. `close` marks a sound too close to the sentence to
    cut, `leak` the voice sample's own words heard in the try."""
    got = _letters(heard.get(p, ""))
    match = SequenceMatcher(None, text, got).ratio()
    stray = cut is not None or close
    cut_kept = False
    if cut is not None:
        got_cut = _letters(heard.get(cut, ""))
        match_cut = SequenceMatcher(None, text, got_cut).ratio()
        if match_cut >= match and _edges_heard(text, got_cut):
            os.replace(cut, p)
            got, match, stray, cut_kept = got_cut, match_cut, False, True
            log("   line %d: cut a stray sound next to the sentence" % i)
        else:
            os.remove(cut)
    if leak is not None and not cut_kept:
        stray = True
        # How much, not what: the job log goes out with a failure report, and
        # docs/privacy.md promises the logs never record what was said.
        log("   line %d: the voice sample's own words were heard (%d characters)" % (i, len(leak)))
    edges = _edges_heard(text, got)
    text_ok = match >= FAST_MIN_MATCH and len(got) - len(text) < FAST_EXTRA_LETTERS and edges
    secs = _speech_seconds(p)
    fits = not slot or secs <= FAST_MAX_OVER_SLOT * slot
    voice_ok = like is None or like >= FAST_MIN_LIKENESS
    # A right voice ranks above a wrong one; among wrong ones, the closer.
    voice = 1.0 if voice_ok else like
    if slot and slot < FAST_SHORT_SLOT_S:
        key = (text_ok and fits and not stray and voice_ok, text_ok, voice,
               secs <= FAST_SHORT_MAX_OVER * slot, -abs(secs - slot) if text_ok else match)
    else:
        key = (text_ok and fits and not stray and voice_ok, text_ok, voice, -secs if text_ok else match)
    return key, p, match, secs, stray, like, edges


def _hear_tries(tries: List[tuple], segments: List[dict], seg_speakers: List[str], language: str,
                work_dir: str, slots: List[float], log: Callable[[str], None]) -> Optional[List[tuple]]:
    """One round of the line check: every (line, file) try heard by Whisper,
    with and without a stray sound at its edges, and judged (_judge_try).
    Returns (line, judgement) per try, in order; None when Whisper did not
    run."""
    cuts = {p: _edge_cut_copy(p, _words_of(segments[i]), language) for i, p in tries}
    cuts = {p: q for p, q in cuts.items() if q}
    # A sound too close to the sentence to cut (a word's own first
    # syllable looks the same, lead_burst.CUT_GAP_MIN_SEC): the line is
    # made again rather than cut into "Paring" (2026-10-07).
    close = {p for i, p in tries if _edge_too_close(p, _words_of(segments[i]), language)}
    heard = transcribe_batch([p for _, p in tries] + list(cuts.values()), whisper_code(language))
    if heard is None:
        for q in cuts.values():
            os.remove(q)
        log("   line check skipped: Whisper did not run")
        return None
    likeness = _voice_likeness(tries, seg_speakers, work_dir, log)
    leaks = _sample_word_leaks(tries, seg_speakers, work_dir, language)
    judged = []
    for i, p in tries:
        judged.append((i, _judge_try(i, p, _letters(_words_of(segments[i])), heard, cuts.get(p), p in close,
                                     leaks.get(p), likeness.get(p), slots[i], log)))
    return judged


def _why_again(best: tuple, slot: float) -> str:
    """Why a line's best try so far is not right, for the line in the log
    that says it is made again."""
    key, _, match, secs, stray, like, edges = best
    return ("its first or last word was not heard" if not edges and match >= FAST_MIN_MATCH
            else "heard %.2f of its text" % match if not key[1]
            else "a sound set apart at its start or end" if stray
            else "its voice is unlike the speaker's (%.2f)" % like if key[2] < 1.0
            else "%.1fs for a %.1fs slot" % (secs, slot))


def _keep_best(best: Dict[int, tuple], paths: List[Optional[str]], extra_files: List[str],
               log: Callable[[str], None]) -> set:
    """Each line's best try copied over its file, every other try deleted.
    Returns the lines no try came out right for."""
    wrong = set()
    for i, (key, p, match, secs, _, like, _) in best.items():
        if p != paths[i]:
            shutil.copyfile(p, paths[i])
        if not key[0]:
            wrong.add(i)
            log("   line %d: no try came out right, kept the closest (heard %.2f of its text, %.1fs%s)"
                % (i, match, secs, ", voice %.2f" % like if like is not None else ""))
    for p in extra_files:
        os.remove(p)
    return wrong


def _check_fast_lines(engine, segments: List[dict], seg_speakers: List[str], voice_ids: Dict[str, str],
                      language: str, work_dir: str, paths: List[Optional[str]], slots: List[float],
                      log: Callable[[str], None], stats: list,
                      takes: Optional[Dict[int, List[str]]] = None,
                      remake_seed: Optional[int] = None) -> set:
    """Hear every made line back (see FAST_REMAKES) and replace, in place,
    each that came out wrong with the best of up to FAST_REMAKES new tries.
    `takes` holds a short line's other takes (FAST_SHORT_TAKES): they are
    heard with the rest and the best of them all is kept.
    The new tries' seeds are fixed per line, so the same script makes the
    same dub; a remade line passes `remake_seed` instead, so its new tries
    differ from the first pass's too (remake_seed + 1, + 2, ...).
    Without a working Whisper the lines stay as made, and the log says so.
    Returns the lines no try came out right for."""
    tries = [(i, p) for i, p in enumerate(paths) if p]
    extra_files = []
    for i, more in (takes or {}).items():
        tries += [(i, p) for p in more]
        extra_files += more
    best: Dict[int, tuple] = {}   # line -> its best try so far, as _judge_try says it
    for round_no in range(FAST_REMAKES + 1):
        judged = _hear_tries(tries, segments, seg_speakers, language, work_dir, slots, log)
        if judged is None:
            break
        for i, judgement in judged:
            if i not in best or judgement[0] > best[i][0]:
                best[i] = judgement
        again = [] if round_no == FAST_REMAKES else sorted({i for i, _ in tries if not best[i][0][0]})
        tries = []
        if again:
            _rest_engine(engine, log)
        for i in again:
            log("   line %d: %s - made again" % (i, _why_again(best[i], slots[i])))
            p = os.path.join(work_dir, "qwen_line_%d_r%d.wav" % (i, round_no + 1))
            seed = (remake_seed + round_no + 1) if remake_seed is not None else 1000 * i + 100 * (round_no + 1)
            made = _synth_one(engine, segments[i], _voice_of(voice_ids, seg_speakers, i), language, seed, p,
                              log, "line %d try %d" % (i, round_no + 2), slot=slots[i], stats=stats)
            if made:
                tries.append((i, made))
                extra_files.append(made)
        if not tries:
            break
    return _keep_best(best, paths, extra_files, log)


def _synth_merged_unit(
    engine, segments: List[dict], seg_speakers: List[str], voice_ids: Dict[str, str],
    language: str, work_dir: str, unit: List[int], seed: int, out_paths: List[str],
    log: Callable[[str], None], slot: Optional[float] = None, stats: Optional[list] = None,
) -> bool:
    """One TTS call for a merge unit's combined text, then split the result back
    into out_paths[j] (same order as `unit`) at the energy valley between
    members (app.audio.merge.split_unit_audio). Returns True iff every member's
    wav was produced; on any failure returns False and writes nothing to
    out_paths, so the caller falls back to synthesizing each member alone.
    """
    i0 = unit[0]
    voice_id = _voice_of(voice_ids, seg_speakers, i0)
    merged_text = " ".join(segments[i].get("text", "") for i in unit)
    tmp_path = os.path.join(work_dir, "qwen_unit_%d_seed%d.wav" % (i0, seed))
    unit_wav = _synth_one(engine, {"text": merged_text}, voice_id, language, seed, tmp_path,
                          log, "merged unit @line %d (+%d follower(s))" % (i0, len(unit) - 1),
                          slot=slot, stats=stats)
    if unit_wav is None:
        return False
    member_texts = [segments[i].get("text", "") for i in unit]
    try:
        split_ok = split_unit_audio(tmp_path, member_texts, out_paths)
    except (wave.Error, OSError, EOFError) as e:
        # split_unit_audio opens the unit wav with the `wave` module. Audio the
        # engine returned that is not a readable RIFF wav (a truncated response,
        # or an error body served as HTTP 200) used to raise straight out of
        # here -- through synth_lines and run_qwen_dub -- aborting the whole dub
        # after all the GPU work, and skipping the os.remove below so the
        # intermediate wav leaked as well. Degrade instead, so the caller falls
        # back to per-line synthesis: that is what this function's docstring and
        # synth_lines' both promise.
        log("   Warning: merged unit @line %d: unit audio unreadable (%s) - falling back to "
            "per-line synthesis" % (i0, str(e)[:80]))
        split_ok = False
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if not split_ok:
        log("   Warning: merged unit @line %d: could not split cleanly - falling back to per-line synthesis" % i0)
        return False
    log("   line %d: merged with %d ultra-short follower(s), split at the energy valley"
       % (i0, len(unit) - 1))
    return True


def _score_and_select(
    take_paths: List[List[Optional[str]]], segments: List[dict], seg_speakers: List[str],
    usable_slots: List[float], speaker_ref_paths: Optional[Dict[str, str]],
    language: str, work_dir: str, log: Callable[[str], None],
) -> Optional[Dict[int, int]]:
    """Score every generated take and run the coherence selection rule.

    Returns {line_index: winning_take_k}, or None if scoring is unavailable
    (missing scorer, subprocess failure, ...) -- callers fall back to take 0.
    """
    if not speaker_ref_paths:
        return None
    lines_payload = []
    for i, row in enumerate(take_paths):
        takes = [{"k": k, "path": p} for k, p in enumerate(row) if p is not None]
        if not takes:
            continue
        lines_payload.append({
            "i": i, "spk": seg_speakers[i] if i < len(seg_speakers) else None,
            "usable": usable_slots[i] if i < len(usable_slots) else 0.0,
            "text": segments[i].get("text", ""), "takes": takes,
        })
    if not lines_payload:
        return None

    scored = score_takes(speaker_ref_paths, lines_payload, language, work_dir, log=log)
    if scored is None:
        return None

    lines_for_select: Dict[int, List[dict]] = {}
    for entry in lines_payload:
        i = entry["i"]
        score_rows = scored.get(i)
        if not score_rows:
            continue
        by_k = {row["k"]: row for row in score_rows}
        cands = []
        for t in entry["takes"]:
            sc = by_k.get(t["k"])
            if not sc or sc.get("emb") is None:
                continue  # too-short audio (<0.4s) has no embedding -- can't join coherence
            cands.append({
                "k": t["k"], "spk": entry["spk"], "usable": entry["usable"],
                "sim": sc["sim"], "sim_other": sc["sim_other"], "asr": sc["asr"],
                "dur": sc["dur"], "emb": sc["emb"],
            })
        if cands:
            lines_for_select[i] = cands
    if not lines_for_select:
        return None

    picks = pick_coherence(lines_for_select)
    return {i: p["k"] for i, p in picks.items()}


def cleanup_takes(work_dir: str, log: Optional[Callable[[str], None]] = None) -> int:
    """Delete the per-take candidate wavs (qwen_line_<i>_t<k>.wav) from work_dir.

    Call ONLY after the job's final assembly + gates passed: until then the
    losing takes are deliberately kept on disk so a reassembly pass can
    re-pick takes without re-synthesis (see synth_lines). Returns how many
    files were removed. Winner files (qwen_line_<i>.wav) are never touched.
    """
    log = log or (lambda m: None)
    pat = re.compile(r"^qwen_line_\d+_t\d+\.wav$")
    removed = 0
    for name in os.listdir(work_dir):
        if pat.match(name):
            os.remove(os.path.join(work_dir, name))
            removed += 1
    if removed:
        log("   cleaned up %d losing take file(s)" % removed)
    return removed


@dataclasses.dataclass
class _LineSynth:
    """What every engine call for one job's lines shares (synth_lines): the
    engine, the lines with their speakers' voices and slots, Resume and
    Cancel, and the numbers the closing summary is made from."""
    engine: object
    segments: List[dict]
    seg_speakers: List[str]
    voice_ids: Dict[str, str]
    language: str
    work_dir: str
    slots: List[float]
    log: Callable[[str], None]
    reuse_lines: bool = False
    cancel_check: Optional[Callable[[], bool]] = None
    stats: list = dataclasses.field(default_factory=list)   # (label, seconds, ok) per engine call

    def next_unit(self) -> None:
        # Between lines, not only between stages: Cancel pressed during the
        # voices used to wait for every remaining line (2026-09-23).
        raise_if_cancelled(self.cancel_check, self.log)
        _rest_engine(self.engine, self.log)

    def kept(self, paths: List[str]) -> bool:
        # Resume: a line whose voice the earlier run finished is not made
        # again. A cut or failed line never wrote a file, so it is retried.
        return self.reuse_lines and all(os.path.isfile(q) and os.path.getsize(q) > 44 for q in paths)

    def line(self, i: int, seed: int, path: str, label: str) -> Optional[str]:
        """Line i made once, in its speaker's voice (_synth_one)."""
        return _synth_one(self.engine, self.segments[i], _voice_of(self.voice_ids, self.seg_speakers, i),
                          self.language, seed, path, self.log, label, slot=self.slots[i], stats=self.stats)

    def unit(self, unit: List[int], seed: int, out_paths: List[str]) -> bool:
        """A merge unit's lines made in one engine call (_synth_merged_unit)."""
        return _synth_merged_unit(self.engine, self.segments, self.seg_speakers, self.voice_ids, self.language,
                                  self.work_dir, unit, seed, out_paths, self.log,
                                  slot=sum(self.slots[i] for i in unit), stats=self.stats)


def _synth_fast_line(synth: _LineSynth, i: int, takes: Dict[int, List[str]]) -> Optional[str]:
    """One line made in Fast mode. On an engine with free retakes
    (Qwen3-TTS) a line with under FAST_SHORT_SLOT_S of slot is made
    FAST_SHORT_TAKES times; the takes after the first wait in takes[i] for
    the line check to choose from."""
    p = os.path.join(synth.work_dir, "qwen_line_%d.wav" % i)
    made = synth.line(i, 1000 * i, p, "line %d" % i)
    if getattr(synth.engine, "free_retakes", False) and 0 < synth.slots[i] < FAST_SHORT_SLOT_S:
        more = [synth.line(i, 1000 * i + k, os.path.join(synth.work_dir, "qwen_line_%d_s%d.wav" % (i, k)),
                           "line %d take %d" % (i, k + 1))
                for k in range(1, FAST_SHORT_TAKES)]
        more = [q for q in more if q]
        if made is None and more:
            os.replace(more.pop(0), p)
            made = p
        takes[i] = more
    return made


def _synth_fast(synth: _LineSynth, units: List[List[int]]) -> List[Optional[str]]:
    """Fast mode (synth_lines with n_takes <= 1): every line made once, a
    merge unit in one engine call, and on an engine with free retakes
    (Qwen3-TTS) every line heard back and the wrong ones made again
    (_check_fast_lines)."""
    paths: List[Optional[str]] = [None] * len(synth.segments)
    takes: Dict[int, List[str]] = {}   # a short line's other takes
    reused = 0
    for unit in units:
        synth.next_unit()
        unit_paths = [os.path.join(synth.work_dir, "qwen_line_%d.wav" % i) for i in unit]
        if synth.kept(unit_paths):
            for i, q in zip(unit, unit_paths):
                paths[i] = q
            reused += len(unit)
        elif len(unit) == 1:
            paths[unit[0]] = _synth_fast_line(synth, unit[0], takes)
        elif synth.unit(unit, 1000 * unit[0], unit_paths):
            for i, p in zip(unit, unit_paths):
                paths[i] = p
        else:
            for i, p in zip(unit, unit_paths):
                paths[i] = synth.line(i, 1000 * i, p, "line %d" % i)
    if reused:
        synth.log("   %d line(s) kept from the earlier run" % reused)
    if getattr(synth.engine, "free_retakes", False):
        _check_fast_lines(synth.engine, synth.segments, synth.seg_speakers, synth.voice_ids, synth.language,
                          synth.work_dir, paths, synth.slots, synth.log, synth.stats, takes)
    return paths


def _unit_takes(synth: _LineSynth, unit: List[int], n_takes: int):
    """n_takes takes of each line in a unit, as {line: [take file or None,
    ...]}, and how many of them an earlier run had made already. A merge
    unit makes each take in one engine call, and its lines one by one when
    that fails."""
    rows: Dict[int, List[Optional[str]]] = {i: [] for i in unit}
    reused = 0
    for k in range(n_takes):
        out_paths = [os.path.join(synth.work_dir, "qwen_line_%d_t%d.wav" % (i, k)) for i in unit]
        if synth.kept(out_paths):
            made = out_paths
            reused += len(unit)
        elif len(unit) == 1:
            made = [synth.line(unit[0], 1000 * unit[0] + k, out_paths[0], "line %d take %d" % (unit[0], k))]
        elif synth.unit(unit, 1000 * unit[0] + k, out_paths):
            made = out_paths
        else:
            made = [synth.line(i, 1000 * i + k, p, "line %d take %d (merge fallback)" % (i, k))
                    for i, p in zip(unit, out_paths)]
        for i, p in zip(unit, made):
            rows[i].append(p)
    return rows, reused


def _copy_winners(take_paths: List[List[Optional[str]]], winners: Dict[int, int], work_dir: str,
                  log: Callable[[str], None]) -> List[Optional[str]]:
    """Each line's winning take (take 0 when none was chosen, else the first
    take that was made) copied to qwen_line_<i>.wav; None for a line no take
    was made for."""
    final_paths: List[Optional[str]] = []
    for i, row in enumerate(take_paths):
        k = winners.get(i, 0)
        chosen = row[k] if k < len(row) and row[k] is not None else next((p for p in row if p is not None), None)
        final_path = os.path.join(work_dir, "qwen_line_%d.wav" % i)
        if chosen is not None:
            # COPY (not move) the winner: all takes stay on disk for a possible
            # reassembly pass -- see synth_lines' disk-tradeoff note; the
            # caller runs cleanup_takes() after final assembly + gates pass.
            shutil.copyfile(chosen, final_path)
            log("   line %d: chose take %d" % (i, k))
        else:
            final_path = None
        final_paths.append(final_path)
    return final_paths


def _synth_best_of(synth: _LineSynth, units: List[List[int]], n_takes: int,
                   speaker_ref_paths: Optional[Dict[str, str]],
                   on_notice: Optional[Callable[[dict], None]]) -> List[Optional[str]]:
    """High quality mode (synth_lines with n_takes > 1): n_takes takes of
    every line, scored, and each line's winner copied to qwen_line_<i>.wav;
    take 0 everywhere when the takes cannot be scored."""
    # An empty row, not None, for a line no unit covers (a silent one):
    # _copy_winners reads every row.
    take_paths: List[List[Optional[str]]] = [[] for _ in synth.segments]
    reused = 0   # takes, for High quality: each take is its own file
    for unit in units:
        synth.next_unit()
        rows, kept = _unit_takes(synth, unit, n_takes)
        for i in unit:
            take_paths[i] = rows[i]
        reused += kept
    if reused:
        synth.log("   %d take(s) kept from the earlier run" % reused)

    winners = _score_and_select(take_paths, synth.segments, synth.seg_speakers, synth.slots,
                                speaker_ref_paths, synth.language, synth.work_dir, synth.log)
    if winners is None:
        msg = ("take scoring UNAVAILABLE - best-of-%d selection skipped, take 0 used for "
               "every line (quality degraded: no speaker-similarity or slot-fit choice). "
               "Check QWEN_SCORER_PYTHON and PERSODUB_CAMPPLUS_MODEL." % n_takes)
        synth.log("   " + msg)
        if on_notice:
            # For the screen, in the user's language: what happened and what
            # it means for the voices. The settings to check are a
            # developer's, and stay in the log line above.
            on_notice({"type": "take_scoring_unavailable", "message": i18n.t(
                "The voice takes could not be compared, so each line uses its first take. "
                "The voices may sound less like the originals or fit their time less well.")})
        winners = {}
    return _copy_winners(take_paths, winners, synth.work_dir, synth.log)


def synth_lines(
    engine, segments: List[dict], seg_speakers: List[str], voice_ids: Dict[str, str],
    language: str, work_dir: str, n_takes: int = 1, log: Optional[Callable[[str], None]] = None,
    usable_slots: Optional[List[float]] = None, speaker_ref_paths: Optional[Dict[str, str]] = None,
    on_notice: Optional[Callable[[dict], None]] = None, reuse_lines: bool = False,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> List[Optional[str]]:
    """Synthesize each translated line with its speaker's cloned voice.

    seed = 1000*i + k is deterministic per (line, take). n_takes<=1 keeps the
    original one-take-per-line behavior unchanged (no scoring, no selection --
    this is also the graceful-degradation target: any failure below falls
    back to exactly this path's output, take 0).

    n_takes>1 generates n_takes candidates per line, scores them via the
    CAM++/whisper subprocess (app/qwen_scoring.score_takes) and picks a
    winner per line with the coherence rule (app/qwen_select.pick_coherence).
    usable_slots (line-index-aligned "usable" durations, see
    app.text.cues.effective_slots) and speaker_ref_paths ({speaker: ref_wav
    path}) are required for scoring; without them selection is skipped and
    take 0 is kept for every line -- same graceful fallback.

    Before any of that, lines are grouped into merge units (app.audio.merge.
    group_merge_units, using usable_slots): an ultra-short line (< config.
    QWEN_SHORT_LINE_SEC) merges into one TTS call with its previous
    same-speaker/adjacent line, then the result is split back into one wav
    per line (app.audio.merge.split_unit_audio) so everything below this
    point -- scoring, gain matching, placement -- still works one-wav-per-line
    as before. A unit that fails to synthesize or split falls back to
    synthesizing each of its lines individually (never aborts the job).
    The winner is COPIED to the original qwen_line_<i>.wav path so downstream
    assembly is unchanged, and every take file (qwen_line_<i>_t<k>.wav,
    winners and losers alike) is KEPT on disk until cleanup_takes() runs --
    the caller should call it only after the job's final assembly + gates
    pass, so a reassembly pass can re-pick takes without re-synthesis.
    Disk tradeoff: n_takes x one short mono 24kHz wav per line (~100-300KB
    each; a 22-line best-of-4 job keeps ~10-25MB extra until cleanup) --
    accepted, re-synthesis costs minutes of GPU time per pass.
    on_notice (optional): called with a structured dict when take scoring is
    unavailable while n_takes>1 -- that silently degrades quality (take 0
    everywhere), so it must surface in the job status, not just the log.
    Returns one wav path per segment (None where every take failed to
    synthesize -- skipped at assembly rather than aborting the whole job).
    """
    log = log or (lambda m: None)
    resolved_usable = usable_slots if usable_slots is not None else [
        max(0.01, s.get("end", 0) - s.get("start", 0)) for s in segments
    ]
    # A line with no words -- one the translator left untranslated
    # (app/text/dub_prompt.py UNTRANSLATED) -- is never sent to the engine, so its path
    # stays None: assembly already skips a None line, the same as a failed synth,
    # and the slot stays silent. Given no speaker, it neither joins a merge unit
    # nor lets the line after it join across it; its own unit is then dropped.
    silent = {i for i, s in enumerate(segments) if not s.get("text", "").strip()}
    merge_speakers = [None if i in silent else spk for i, spk in enumerate(seg_speakers)]
    units = [u for u in group_merge_units(segments, merge_speakers, resolved_usable)
             if u[0] not in silent]
    if silent:
        log("   %d line(s) have no words - left silent" % len(silent))
    synth = _LineSynth(engine, segments, seg_speakers, voice_ids, language, work_dir, resolved_usable, log,
                       reuse_lines, cancel_check)
    if n_takes <= 1:
        paths = _synth_fast(synth, units)
    else:
        paths = _synth_best_of(synth, units, n_takes, speaker_ref_paths, on_notice)
    _log_synth_summary(log, synth.stats, paths, len(silent))
    return paths


def fit_to_pace(engine, translator, segments: List[dict], seg_speakers: List[str],
                voice_ids: Dict[str, str], ref_cues: List[dict], language: str, work_dir: str,
                paths: List[Optional[str]], slots: List[float], log: Callable[[str], None],
                cancel_check: Optional[Callable[[], bool]] = None) -> None:
    """Write again, voice again, and keep when closer: the lines whose voice
    ends well before their slot or runs well past it (app/text/pace_fit.py),
    at most ROUNDS times. Kept lines replace their wav in `paths` and their
    words in `segments` and in translated.srt, so the script shows what is
    said. pace_fit.json records every rewrite, words included (the log gets
    none)."""
    started = time.monotonic()
    name = getattr(translator, "display_name", "") or type(translator).__name__
    texts = [s.get("text", "") for s in segments]
    spk = [seg_speakers[i] if i < len(seg_speakers) else None for i in range(len(segments))]
    durs = line_play_durations(paths)
    record = {"translator": name, "slots": slots, "first": list(durs), "rounds": []}
    for rnd in range(1, ROUNDS + 1):
        raise_if_cancelled(cancel_check, log)
        todo = pick_lines(texts, durs, slots)
        if not todo:
            break
        pace = measure_pace(texts, durs, spk, language)
        if rnd == 1:
            log("   pace per second of speech: %s" % ", ".join(
                "%s %.1f" % (s, pace[s]) for s in sorted(pace, key=str)))
        short = sum(1 for i in todo if durs[i] < slots[i])
        log("   pace round %d: %d of %d lines outside their slot (%d short, %d long), asking %s"
            % (rnd, len(todo), len(segments), short, len(todo) - short, name))
        sources = [source_for(segments[i], ref_cues) for i in todo]
        targets = [target_count(slots[i], pace[spk[i]], _count_syllables(texts[i], language)) for i in todo]
        try:
            answers = ask_rewrites(translator, sources, [texts[i] for i in todo], targets, language)
        except JobCancelled:
            raise
        except Exception as e:
            # The voices are all made: a translator that cannot answer now
            # (a usage limit, the network) leaves the lines as they are.
            log("   pace fit stopped: %s did not answer (%s)" % (name, type(e).__name__))
            break
        rows = []
        trial = [dict(s) for s in segments]
        new_paths: List[Optional[str]] = [None] * len(segments)
        for i, src, n, new in zip(todo, sources, targets, answers):
            row = {"i": i, "slot": slots[i], "before": durs[i], "target": n,
                   "source": src, "old": texts[i], "new": new}
            rows.append(row)
            row["why"] = usable_rewrite(texts[i], new, language)
            if row["why"]:
                continue
            trial[i]["text"] = new.strip()
            new_paths[i] = _synth_one(engine, trial[i], voice_ids.get(spk[i]), language, 1000 * i + 50 + rnd,
                                      os.path.join(work_dir, "qwen_line_%d_pace.wav" % i), log,
                                      "line %d rewrite" % i, slot=slots[i])
        wrong = (_check_fast_lines(engine, trial, spk, voice_ids, language, work_dir, new_paths, slots, log, [])
                 if any(new_paths) else set())
        new_durs = line_play_durations(new_paths)
        for row in rows:
            i = row["i"]
            p = new_paths[i]
            if row["why"] is None:
                row["after"] = new_durs[i]
                row["why"] = ("voice failed" if p is None else "voice came out wrong" if i in wrong
                              else worse_voice(durs[i], new_durs[i], slots[i]))
            row["kept"] = row["why"] is None
            if row["kept"]:
                os.replace(p, paths[i])
                texts[i] = segments[i]["text"] = trial[i]["text"]
                durs[i] = new_durs[i]
            elif p and os.path.exists(p):
                os.remove(p)
            now = " -> %.2fs" % row["after"] if "after" in row else ""
            log("   pace line %d: %.2fs in a %.2fs slot%s, %s"
                % (i, row["before"], slots[i], now, "kept" if row["kept"] else "not used (%s)" % row["why"]))
        record["rounds"].append(rows)
        if any(r["kept"] for r in rows):
            out_srt = os.path.join(work_dir, "translated.srt")
            with open(out_srt + ".part", "w", encoding="utf-8") as f:
                f.write(build_srt(segments))
            os.replace(out_srt + ".part", out_srt)
    record["seconds"] = round(time.monotonic() - started, 1)
    with open(os.path.join(work_dir, "pace_fit.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=1)
    kept = sum(r["kept"] for rows in record["rounds"] for r in rows)
    log("   pace fit: %d line(s) rewritten in %d round(s), %.0fs" % (kept, len(record["rounds"]), record["seconds"]))


def _speaker_plan(segments: List[dict], ref_cues: List[dict], sample_cues: List[dict]):
    """Who says what: (speakers, each line's speaker, ref_cues, sample_cues).
    A transcript with no speaker labels at all is one speaker,
    DEFAULT_SPEAKER, and its cues come back labelled with it."""
    speakers = speakers_in(ref_cues)
    if speakers:
        return speakers, map_segments_to_speakers(segments, ref_cues, speakers), ref_cues, sample_cues
    # No speaker labels anywhere -- treat the whole transcript as one speaker.
    ref_cues = [dict(c, speaker_id=DEFAULT_SPEAKER) for c in ref_cues]
    sample_cues = [dict(c, speaker_id=DEFAULT_SPEAKER) for c in sample_cues]
    return [DEFAULT_SPEAKER], [DEFAULT_SPEAKER] * len(segments), ref_cues, sample_cues


def _write_lines_manifest(work_dir: str, language: str, segments: List[dict], seg_speakers: List[str],
                          starts: List[float], gains: Optional[List[float]]) -> None:
    """lines.json: what redoing ONE line later needs. starts and gains are
    computed in run_qwen_dub and nowhere else -- without them a freshly
    spoken line lands at the wrong moment and at the wrong volume."""
    with open(os.path.join(work_dir, "lines.json"), "w", encoding="utf-8") as f:
        json.dump({
            "language": language,
            "lines": [
                {"i": i,
                 "start": starts[i] if i < len(starts) else None,
                 "gain": gains[i] if gains and i < len(gains) else None,
                 "speaker": seg_speakers[i] if i < len(seg_speakers) else None,
                 "text": segments[i].get("text", "")}
                for i in range(len(segments))
            ],
        }, f, ensure_ascii=False, indent=1)


def _write_clipped_lines(work_dir: str, clipped: List[dict]) -> None:
    """clipped_lines.json: the lines place_lines cut short, as
    {"clipped": [{"line": i, "cut_s": s}, ...], "clipped_count": n}."""
    with open(os.path.join(work_dir, "clipped_lines.json"), "w", encoding="utf-8") as f:
        json.dump({"clipped": clipped, "clipped_count": len(clipped)}, f, ensure_ascii=False, indent=1)


def _placed_dub_spans(segments: List[dict], line_paths: List[Optional[str]], starts: List[float],
                      trimmed: bool = False) -> List[tuple]:
    """(start, end) of every line placed in the dub, for the gates that work
    around it.

    trimmed=False: spans from each line's full (untrimmed) length --
    slightly wider than what place_lines really played, which only errs
    toward excluding/muting MORE around the dub, never less. Right for
    the safe-mode whitelist (wider exclusion = fewer candidates).
    trimmed=True: the line's ACTUAL placed playback length
    (place_lines trims lead/tail silence before placing -- see
    _trim_lead_tail_silence). Company mode uses this: its mute set
    already pads dub spans +-0.1s, and muting a line's dead-air tail on
    top of that needlessly erases ambience right after the line (a
    laugh's first 0.3s, measured on edit60s line 5).
    """
    spans = []
    for seg, p, s in zip(segments, line_paths, starts):
        if p is None or s is None:
            continue
        try:
            with wave.open(p, "rb") as w:
                data = w.readframes(w.getnframes())
                sr, sw, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
            if trimmed:
                data = _trim_lead_tail_silence(data, sw, ch, sr)
            end = s + (len(data) // (sw * ch)) / float(sr)
        except (OSError, wave.Error):
            end = seg.get("end", s)  # unreadable line wav: at least its cue span
        spans.append((s, end))
    return spans


def _assemble(segments: List[dict], line_paths: List[Optional[str]], starts: List[float],
              gains: Optional[List[float]], ref_cues: List[dict], vocals_path: str, background_path: str,
              work_dir: str, log: Callable[[str], None], video_duration: Optional[float]) -> str:
    """The dub audio, qwen_dub_48k.wav in work_dir: the lines laid over the
    background the way QWEN_GATE_MODE says, and clipped_lines.json beside
    it. Returns the wav's path."""
    out_wav = os.path.join(work_dir, "qwen_dub_48k.wav")
    # Lines cut short (run into the next line, or past the end of the video --
    # see place_lines) -- one place_lines call per QWEN_GATE_MODE branch below,
    # all sharing this same list. Written to work_dir so the caller can fold
    # it into the job's result data without place_lines' own return value
    # (out_wav, used elsewhere) having to change shape.
    clipped: List[dict] = []

    if QWEN_GATE_MODE == "safe":
        # Default: the original vocals track never reaches place_lines, so
        # leaking the original actor's voice is structurally impossible --
        # background is the separated no_vocals stem only (see
        # app/config.QWEN_GATE_MODE).
        place_lines(background_path, line_paths, starts, out_wav, gains=gains, log=log, clipped=clipped)
        if QWEN_KEEP_NONVERBAL:
            # Laughter whitelist (app/nonverbal.py): copy back ONLY the
            # non-speech vocal segments a local-whisper veto verified contain
            # no words, at original volume.
            speech_spans = [(c["start"], c["end"]) for c in ref_cues]
            apply_nonverbal_whitelist(out_wav, vocals_path, speech_spans,
                                      _placed_dub_spans(segments, line_paths, starts),
                                      manifest_path=os.path.join(work_dir, "nonverbal_manifest.json"),
                                      log=log, video_duration=video_duration)
    elif QWEN_GATE_MODE == "company":
        # Company-style: safe assembly (vocals never reach place_lines), then
        # the speech-erased original-vocals ambience layer on top (see
        # app/audio/ambience.py). The whitelist overlay is AUTO-DISABLED here
        # regardless of QWEN_KEEP_NONVERBAL -- the layer already carries the
        # verified nonverbal content at 0dB; overlaying it again would double
        # the audio (clipping/echo).
        place_lines(background_path, line_paths, starts, out_wav, gains=gains, log=log, clipped=clipped)
        speech_spans = [(c["start"], c["end"]) for c in ref_cues]
        apply_company_ambience(out_wav, vocals_path, speech_spans,
                               _placed_dub_spans(segments, line_paths, starts, trimmed=True),
                               manifest_path=os.path.join(work_dir, "gate_exclusion_manifest.json"),
                               log=log, video_duration=video_duration)
    else:
        # Opt-in "preserve": original speech spans (source-language cue
        # times) gate the original vocals to silence, preserving laughter/
        # breaths between lines instead of discarding the whole vocals stem
        # the way a background-only bed would.
        speech_regions = [(c["start"], c["end"]) for c in ref_cues]
        place_lines(background_path, line_paths, starts, out_wav, gains=gains,
                   vocals_path=vocals_path, speech_regions=speech_regions, log=log, clipped=clipped)

    _write_clipped_lines(work_dir, clipped)
    return out_wav


def run_qwen_dub(
    engine, segments: List[dict], ref_cues: List[dict], work_dir: str,
    vocals_path: str, background_path: str,
    language: str = "Korean", n_takes: int = 1, log: Optional[Callable[[str], None]] = None,
    voice_mode: Optional[str] = None, on_notice: Optional[Callable[[dict], None]] = None,
    video_duration: Optional[float] = None, reuse_lines: bool = False,
    cancel_check: Optional[Callable[[], bool]] = None, translator=None,
    sample_cues: Optional[List[dict]] = None,
) -> str:
    """Full Qwen3-TTS dub-audio path. Returns the path to the assembled 48kHz wav
    (background + our synthesized lines, each gained to match the original line's
    loudness -- see match_line_gains) -- muxing onto the original video is the
    caller's job (app/media.py has mux/ensure_video_length for that).

    vocals_path / background_path (local Demucs -- app/separate.py) are required:
    the caller (app/pipeline.py) always separates locally first and fails the job
    before reaching here if that fails, so this function never talks to a container.

    video_duration, when known, scales the whisper-veto subprocess timeout in
    the nonverbal-whitelist / company-ambience gate for long videos (see
    app.timeouts.scaled_timeout).

    Also writes work_dir/clipped_lines.json -- every line place_lines cut
    short (ran into the next line, or past the end of the video), as
    {"clipped": [{"line": i, "cut_s": s}, ...], "clipped_count": n}.
    app/pipeline.py's run_dub reads it back into the job's result data.

    translator (given only when the app translated the script itself): in
    Fast mode on Qwen3-TTS, lines far from their slot are written again with
    it after the first voicing (fit_to_pace).

    sample_cues: the lines the voice samples are cut from, when they are not
    ref_cues -- the transcript's own lines, shorter than the merged ones.
    """
    log = log or (lambda m: None)
    speakers, seg_speakers, ref_cues, sample_cues = _speaker_plan(segments, ref_cues, sample_cues or ref_cues)
    refs = build_speaker_refs(sample_cues, speakers, vocals_path, mode=voice_mode)
    log("   %d/%d speaker reference(s) built (4-7s contiguous span)" % (len(refs), len(speakers)))
    # A voice for every speaker (TTSEngine.assign_voices): Qwen3-TTS clones
    # each reference once.
    voice_ids = engine.assign_voices(refs, speakers, work_dir, log, mode=voice_mode)
    write_speaker_refs_manifest(refs, sample_cues, work_dir)
    # assign_voices writes each reference to ref_wav_path -- reuse it as the
    # scorer's speaker-embedding source (best-of-N selection compares takes against these).
    speaker_ref_paths = {spk: ref_wav_path(work_dir, spk) for spk in refs}
    usable_slots = effective_slots(segments)

    line_paths = synth_lines(engine, segments, seg_speakers, voice_ids, language, work_dir,
                             n_takes=n_takes, log=log,
                             usable_slots=usable_slots, speaker_ref_paths=speaker_ref_paths,
                             on_notice=on_notice, reuse_lines=reuse_lines,
                             cancel_check=cancel_check)
    if translator is not None and n_takes <= 1 and getattr(engine, "free_retakes", False):
        fit_to_pace(engine, translator, segments, seg_speakers, voice_ids, ref_cues, language, work_dir,
                    line_paths, usable_slots, log, cancel_check)
    n_ok = sum(1 for p in line_paths if p is not None)
    log("   %d/%d lines synthesized" % (n_ok, len(segments)))
    if segments and n_ok == 0:
        # Every line failed (most commonly: the TTS sidecar isn't running).
        # Failing here beats reporting "done" on a speech-less video.
        raise shown_error(*i18n.both(
            "No voice lines could be synthesized (0/{n}) - is the TTS engine "
            "running? See the raw log for per-line errors.", n=len(segments)))

    # Per-line loudness matching (always on -- restores the original's emotional
    # dynamics: a scream stays loud, a whisper stays quiet). segments carry the
    # original cue timing (dub placement is anchored to it), so they double as the
    # cue spans to measure the original vocals' loudness against.
    gains = match_line_gains(vocals_path, segments, line_paths)

    # Every line starts where its cue starts. A line that runs into the next
    # one is sped up a little and then cut (place_lines); it is never started
    # early: the owner heard the dub speak before the mouth moved and ruled
    # that out (2026-10-06).
    starts = [s["start"] for s in segments]
    # Written before assembly so a job that dies in the gates still leaves it behind.
    _write_lines_manifest(work_dir, language, segments, seg_speakers, starts, gains)
    return _assemble(segments, line_paths, starts, gains, ref_cues, vocals_path, background_path,
                     work_dir, log, video_duration)


def resynth_one_line(work_dir, entry, text, language):
    # type: (str, dict, str, str) -> Optional[str]
    """Speak one line again with the same voice, over the top of its old wav.

    The speaker's reference wav and speaker_refs.json survive a finished job, so
    the voice can be cloned again rather than approximated.
    """
    from app.engines.base import get_engine

    i = int(entry["i"])
    spk = entry.get("speaker") or DEFAULT_SPEAKER
    ref_wav = ref_wav_path(work_dir, spk)
    refs_path = os.path.join(work_dir, "speaker_refs.json")
    if not os.path.exists(ref_wav) or not os.path.exists(refs_path):
        raise FileNotFoundError(i18n.t(
            "This job has no reference audio for the speaker - remake the whole job."))
    with open(refs_path, encoding="utf-8") as f:
        refs = json.load(f)
    ref_text = (refs.get(spk) or {}).get("ref_text") or ""

    engine = get_engine("qwen3_tts")
    voice_id = engine.clone(ref_wav, ref_text)
    out_path = os.path.join(work_dir, "qwen_line_%d.wav" % i)
    # A fresh seed every time: a remake is asked for because the voice there
    # is not wanted, so it has to be able to come out differently. The fixed
    # per-line seed the first pass uses gave the same voice back for the same
    # words (user decision 2026-08-28).
    seed = random.randrange(1, 2**31)
    slot = max(0.0, float(entry.get("end", 0) or 0) - float(entry.get("start", 0) or 0)) or None
    made = _synth_one(engine, {"text": text}, voice_id, language, seed,
                      out_path, lambda m: None, "line %d" % i, slot=slot)
    if made:
        # Heard back like a line the first pass made: a stray sound next to the
        # sentence is cut, a wrong take made again (2026-10-03). Only line i is
        # in the lists the check walks.
        _check_fast_lines(engine, [{}] * i + [{"text": text}], [spk] * (i + 1), {spk: voice_id},
                          language, work_dir, [None] * i + [made], [0.0] * i + [slot or 0.0],
                          lambda m: None, [], remake_seed=seed)
    return made


def rebuild_dub(work_dir, data, video_path, out_path):
    # type: (str, dict, str, Optional[str]) -> str
    """Lay every line back over the background bed and remake the video.

    Deliberately the plain assembly: the nonverbal/company gates are skipped
    here because they read the original vocals track, which a finished job no
    longer keeps. What comes out is the same mix minus those overlays.
    """
    lines = data.get("lines") or []
    line_paths = []
    for e in lines:
        p = os.path.join(work_dir, "qwen_line_%d.wav" % int(e["i"]))
        line_paths.append(p if os.path.exists(p) else None)
    starts = [e.get("start") for e in lines]
    gains = [e.get("gain") for e in lines]

    background = os.path.join(work_dir, "background.wav")
    if not os.path.exists(background):
        raise FileNotFoundError(i18n.t(
            "This job has no background audio - remake the whole job."))

    out_wav = os.path.join(work_dir, "qwen_dub_48k.wav")
    clipped: List[dict] = []
    place_lines(background, line_paths, starts, out_wav, gains=gains, log=lambda m: None,
                clipped=clipped)
    # The lines cut short now, not as the first assembly left them: a remade
    # voice has a new length, and the script table reads this file.
    _write_clipped_lines(work_dir, clipped)

    out_path = out_path or os.path.join(work_dir, "dubbed.mp4")
    r = media.mux(video_path, out_wav, out_path, media.video_duration(video_path))
    if r.returncode != 0:
        raise RuntimeError("mux failed: %s" % r.stderr[-200:])
    media.ensure_video_length(video_path, out_path, lambda m: None)
    return out_path
