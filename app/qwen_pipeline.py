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

Voice-clone mode (app.config.QWEN_VOICE_MODE, default "timbre"): "timbre" clones the
speaker from the reference audio alone (no transcript needed, so build_speaker_refs
skips assembling ref_text); "icl" keeps the original in-context-learning clone, which
needs a transcript of the reference span.
"""
import json
import os
import random
import re
import shutil
import wave
from typing import Callable, Dict, List, Optional

from app.audio.ambience import apply_company_ambience
from app.audio.merge import group_merge_units, split_unit_audio
from app.config import QWEN_GATE_MODE, QWEN_KEEP_NONVERBAL, QWEN_VOICE_MODE
from app.engines.base import SynthesisRequest
from app.nonverbal import apply_nonverbal_whitelist
from app.perso_client import _safe_name
from app.qwen_assemble import (
    _trim_lead_tail_silence,
    borrow_lead_starts,
    line_play_durations,
    match_line_gains,
    place_lines,
)
from app.qwen_scoring import score_takes
from app.qwen_select import pick_coherence
from app.text.cues import (
    cue_speaker,
    cut_vocals_span_local,
    effective_slots,
    match_cue_index,
    ref_text_from_spans,
)

REF_MIN_DUR = 4.0
REF_MAX_DUR = 7.0
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
    Prefers spans whose duration lands in [min_dur, max_dur] seconds; among those, the
    one containing the most actual speech (least silence) wins. If no window reaches
    min_dur, falls back to the single longest same-speaker run available, capped to
    max_dur (best effort, still one contiguous clip).
    Returns {"start": float, "end": float} or None if the speaker has no cues at all.
    """
    ordered = sorted(cues, key=lambda c: c["start"])
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
    best_speech = -1.0
    for run in speaker_runs:
        for j in range(len(run)):
            for k in range(j, len(run)):
                start, end = run[j]["start"], run[k]["end"]
                dur = end - start
                if dur < min_dur or dur > max_dur:
                    continue
                speech = speech_secs(run[j:k + 1])
                if speech > best_speech:
                    best_speech = speech
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
    (ref_text, via the existing >=50%-coverage rule) -- speakers whose span
    yields no usable ref_text are skipped, as before.
    mode="timbre": ref_text is not assembled at all (the clone step uses the
    audio alone); only the span/audio checks apply.

    Speakers with no usable span (too little dialogue, or -- in icl mode -- an
    empty resulting script) are simply absent from the returned dict; the
    caller logs how many were skipped.
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
        ref_text = None
        if resolved_mode == "icl":
            ref_text = ref_text_from_spans(ref_cues, spans)
            if not ref_text.strip():
                continue
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
            "ref_wav": "qwen_ref_%s.wav" % _safe_name(spk),
            "span": {"start": s, "end": e},
            "duration": round(e - s, 3) if s is not None and e is not None else None,
            "lines": lines,
            "ref_text": ref.get("ref_text"),
        }
    path = os.path.join(work_dir, "speaker_refs.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return path


def register_speaker_voices(engine, refs: Dict[str, dict], work_dir: str,
                            mode: Optional[str] = None) -> Dict[str, str]:
    """POST /clone once per speaker reference (via engine.clone). Returns {speaker: voice_id}."""
    voice_ids = {}
    for spk, ref in refs.items():
        path = os.path.join(work_dir, "qwen_ref_%s.wav" % _safe_name(spk))
        with open(path, "wb") as f:
            f.write(ref["wav_bytes"])
        voice_ids[spk] = engine.clone(path, ref["ref_text"], mode=mode)
    return voice_ids


def _synth_one(engine, seg: dict, voice_id: Optional[str], language: str, seed: int,
               out_path: str, log: Callable[[str], None], err_label: str) -> Optional[str]:
    """One engine.synthesize() call, written to out_path. None (+ logged warning) on failure."""
    req = SynthesisRequest(text=seg.get("text", ""), language=language, voice_id=voice_id, seed=seed)
    try:
        res = engine.synthesize(req)
    except Exception as e:
        log("   %s: Qwen synth failed (%s) - skipping" % (err_label, str(e)[:80]))
        return None
    with open(out_path, "wb") as f:
        f.write(res.audio_bytes)
    return out_path


def _synth_merged_unit(
    engine, segments: List[dict], seg_speakers: List[str], voice_ids: Dict[str, str],
    language: str, work_dir: str, unit: List[int], seed: int, out_paths: List[str],
    log: Callable[[str], None],
) -> bool:
    """One TTS call for a merge unit's combined text, then split the result back
    into out_paths[j] (same order as `unit`) at the energy valley between
    members (app.audio.merge.split_unit_audio). Returns True iff every member's
    wav was produced; on any failure returns False and writes nothing to
    out_paths, so the caller falls back to synthesizing each member alone.
    """
    i0 = unit[0]
    voice_id = voice_ids.get(seg_speakers[i0]) if i0 < len(seg_speakers) else None
    merged_text = " ".join(segments[i].get("text", "") for i in unit)
    tmp_path = os.path.join(work_dir, "qwen_unit_%d_seed%d.wav" % (i0, seed))
    unit_wav = _synth_one(engine, {"text": merged_text}, voice_id, language, seed, tmp_path,
                          log, "merged unit @line %d (+%d follower(s))" % (i0, len(unit) - 1))
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


def synth_lines(
    engine, segments: List[dict], seg_speakers: List[str], voice_ids: Dict[str, str],
    language: str, work_dir: str, n_takes: int = 1, log: Optional[Callable[[str], None]] = None,
    usable_slots: Optional[List[float]] = None, speaker_ref_paths: Optional[Dict[str, str]] = None,
    on_notice: Optional[Callable[[dict], None]] = None,
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
    units = group_merge_units(segments, seg_speakers, resolved_usable)

    if n_takes <= 1:
        paths: List[Optional[str]] = [None] * len(segments)
        for unit in units:
            if len(unit) == 1:
                i = unit[0]
                voice_id = voice_ids.get(seg_speakers[i]) if i < len(seg_speakers) else None
                p = os.path.join(work_dir, "qwen_line_%d.wav" % i)
                paths[i] = _synth_one(engine, segments[i], voice_id, language, 1000 * i, p, log, "line %d" % i)
                continue
            out_paths = [os.path.join(work_dir, "qwen_line_%d.wav" % i) for i in unit]
            merged_ok = _synth_merged_unit(engine, segments, seg_speakers, voice_ids, language,
                                           work_dir, unit, 1000 * unit[0], out_paths, log)
            if merged_ok:
                for i, p in zip(unit, out_paths):
                    paths[i] = p
            else:
                for i in unit:
                    voice_id = voice_ids.get(seg_speakers[i]) if i < len(seg_speakers) else None
                    p = os.path.join(work_dir, "qwen_line_%d.wav" % i)
                    paths[i] = _synth_one(engine, segments[i], voice_id, language, 1000 * i, p, log, "line %d" % i)
        return paths

    take_paths: List[Optional[List[Optional[str]]]] = [None] * len(segments)
    for unit in units:
        if len(unit) == 1:
            i = unit[0]
            voice_id = voice_ids.get(seg_speakers[i]) if i < len(seg_speakers) else None
            row = []
            for k in range(n_takes):
                p = os.path.join(work_dir, "qwen_line_%d_t%d.wav" % (i, k))
                row.append(_synth_one(engine, segments[i], voice_id, language, 1000 * i + k, p, log,
                                      "line %d take %d" % (i, k)))
            take_paths[i] = row
            continue
        rows: Dict[int, List[Optional[str]]] = {i: [] for i in unit}
        for k in range(n_takes):
            out_paths = [os.path.join(work_dir, "qwen_line_%d_t%d.wav" % (i, k)) for i in unit]
            merged_ok = _synth_merged_unit(engine, segments, seg_speakers, voice_ids, language,
                                           work_dir, unit, 1000 * unit[0] + k, out_paths, log)
            if merged_ok:
                for i, p in zip(unit, out_paths):
                    rows[i].append(p)
            else:
                for i in unit:
                    voice_id = voice_ids.get(seg_speakers[i]) if i < len(seg_speakers) else None
                    p = os.path.join(work_dir, "qwen_line_%d_t%d.wav" % (i, k))
                    rows[i].append(_synth_one(engine, segments[i], voice_id, language, 1000 * i + k, p, log,
                                              "line %d take %d (merge fallback)" % (i, k)))
        for i in unit:
            take_paths[i] = rows[i]

    winners = _score_and_select(take_paths, segments, seg_speakers, resolved_usable,
                                speaker_ref_paths, language, work_dir, log)
    if winners is None:
        msg = ("take scoring UNAVAILABLE - best-of-%d selection skipped, take 0 used for "
               "every line (quality degraded: no speaker-similarity or slot-fit choice). "
               "Check QWEN_SCORER_PYTHON and PERSODUB_CAMPPLUS_MODEL." % n_takes)
        log("   " + msg)
        if on_notice:
            on_notice({"type": "take_scoring_unavailable", "message": msg})
        winners = {}

    final_paths: List[Optional[str]] = []
    for i, row in enumerate(take_paths):
        k = winners.get(i, 0)
        chosen = row[k] if k < len(row) and row[k] is not None else next((p for p in row if p is not None), None)
        final_path = os.path.join(work_dir, "qwen_line_%d.wav" % i)
        if chosen is not None:
            # COPY (not move) the winner: all takes stay on disk for a possible
            # reassembly pass -- see the docstring's disk-tradeoff note; the
            # caller runs cleanup_takes() after final assembly + gates pass.
            shutil.copyfile(chosen, final_path)
            log("   line %d: chose take %d" % (i, k))
        else:
            final_path = None
        final_paths.append(final_path)
    return final_paths


def run_qwen_dub(
    engine, segments: List[dict], ref_cues: List[dict], work_dir: str,
    vocals_path: str, background_path: str,
    language: str = "Korean", n_takes: int = 1, log: Optional[Callable[[str], None]] = None,
    voice_mode: Optional[str] = None, on_notice: Optional[Callable[[dict], None]] = None,
) -> str:
    """Full Qwen3-TTS dub-audio path. Returns the path to the assembled 48kHz wav
    (background + our synthesized lines, each gained to match the original line's
    loudness -- see match_line_gains) -- muxing onto the original video is the
    caller's job (app/pipeline.py already has _mux/ensure_video_length for that).

    vocals_path / background_path (local Demucs -- app/separate.py) are required:
    the caller (app/pipeline.py) always separates locally first and fails the job
    before reaching here if that fails, so this function never talks to a container.
    """
    log = log or (lambda m: None)
    speakers = speakers_in(ref_cues)
    if speakers:
        seg_speakers = map_segments_to_speakers(segments, ref_cues, speakers)
    else:
        # No speaker labels anywhere -- treat the whole transcript as one speaker.
        ref_cues = [dict(c, speaker_id=DEFAULT_SPEAKER) for c in ref_cues]
        speakers = [DEFAULT_SPEAKER]
        seg_speakers = [DEFAULT_SPEAKER] * len(segments)

    refs = build_speaker_refs(ref_cues, speakers, vocals_path, mode=voice_mode)
    log("   %d/%d speaker reference(s) built (4-7s contiguous span)" % (len(refs), len(speakers)))
    voice_ids = register_speaker_voices(engine, refs, work_dir, mode=voice_mode)
    write_speaker_refs_manifest(refs, ref_cues, work_dir)
    # register_speaker_voices writes each reference to exactly this path -- reuse it as the
    # scorer's speaker-embedding source (best-of-N selection compares takes against these).
    speaker_ref_paths = {spk: os.path.join(work_dir, "qwen_ref_%s.wav" % _safe_name(spk)) for spk in refs}
    usable_slots = effective_slots(segments)

    line_paths = synth_lines(engine, segments, seg_speakers, voice_ids, language, work_dir,
                             n_takes=n_takes, log=log,
                             usable_slots=usable_slots, speaker_ref_paths=speaker_ref_paths,
                             on_notice=on_notice)
    n_ok = sum(1 for p in line_paths if p is not None)
    log("   %d/%d lines synthesized" % (n_ok, len(segments)))
    if segments and n_ok == 0:
        # Every line failed (most commonly: the TTS sidecar isn't running).
        # Failing here beats reporting "done" on a speech-less video.
        raise RuntimeError(
            "No voice lines could be synthesized (0/%d) - is the TTS engine "
            "running? See the raw log for per-line errors." % len(segments)
        )

    # Per-line loudness matching (always on -- restores the original's emotional
    # dynamics: a scream stays loud, a whisper stays quiet). segments carry the
    # original cue timing (dub placement is anchored to it), so they double as the
    # cue spans to measure the original vocals' loudness against.
    gains = match_line_gains(vocals_path, segments, line_paths)

    # Leading-pause borrow (see qwen_assemble.borrow_lead_starts): shift a line
    # that would be mid-word truncated by its neighbor up to 0.8s earlier into
    # the breath pause before its cue. Everything downstream (placement AND the
    # gate/dub spans below) uses the borrowed starts, so the ambience gate still
    # mutes the original voice under the borrowed lead.
    starts = borrow_lead_starts([s["start"] for s in segments],
                                line_play_durations(line_paths), log=log)
    out_wav = os.path.join(work_dir, "qwen_dub_48k.wav")

    def _placed_dub_spans(trimmed=False):
        # trimmed=False: spans from each line's full (untrimmed) length --
        # slightly wider than what place_lines really played, which only errs
        # toward excluding/muting MORE around the dub, never less. Right for
        # the safe-mode whitelist (wider exclusion = fewer candidates).
        # trimmed=True: the line's ACTUAL placed playback length
        # (place_lines trims lead/tail silence before placing -- see
        # _trim_lead_tail_silence). Company mode uses this: its mute set
        # already pads dub spans +-0.1s, and muting a line's dead-air tail on
        # top of that needlessly erases ambience right after the line (a
        # laugh's first 0.3s, measured on edit60s line 5).
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

    # What redoing ONE line later needs. starts and gains are computed here and
    # nowhere else -- without them a freshly spoken line lands at the wrong
    # moment and at the wrong volume. Written before assembly so a job that dies
    # in the gates still leaves it behind.
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

    if QWEN_GATE_MODE == "safe":
        # Default: the original vocals track never reaches place_lines, so
        # leaking the original actor's voice is structurally impossible --
        # background is the separated no_vocals stem only (see
        # app/config.QWEN_GATE_MODE).
        place_lines(background_path, line_paths, starts, out_wav, gains=gains, log=log)
        if QWEN_KEEP_NONVERBAL:
            # Laughter whitelist (app/nonverbal.py): copy back ONLY the
            # non-speech vocal segments a local-whisper veto verified contain
            # no words, at original volume.
            speech_spans = [(c["start"], c["end"]) for c in ref_cues]
            apply_nonverbal_whitelist(out_wav, vocals_path, speech_spans, _placed_dub_spans(),
                                      manifest_path=os.path.join(work_dir, "nonverbal_manifest.json"),
                                      log=log)
    elif QWEN_GATE_MODE == "company":
        # Company-style: safe assembly (vocals never reach place_lines), then
        # the speech-erased original-vocals ambience layer on top (see
        # app/company_gate.py). The whitelist overlay is AUTO-DISABLED here
        # regardless of QWEN_KEEP_NONVERBAL -- the layer already carries the
        # verified nonverbal content at 0dB; overlaying it again would double
        # the audio (clipping/echo).
        place_lines(background_path, line_paths, starts, out_wav, gains=gains, log=log)
        speech_spans = [(c["start"], c["end"]) for c in ref_cues]
        apply_company_ambience(out_wav, vocals_path, speech_spans,
                               _placed_dub_spans(trimmed=True),
                               manifest_path=os.path.join(work_dir, "gate_exclusion_manifest.json"),
                               log=log)
    else:
        # Opt-in "preserve": original speech spans (source-language cue
        # times) gate the original vocals to silence, preserving laughter/
        # breaths between lines instead of discarding the whole vocals stem
        # the way a background-only bed would.
        speech_regions = [(c["start"], c["end"]) for c in ref_cues]
        place_lines(background_path, line_paths, starts, out_wav, gains=gains,
                   vocals_path=vocals_path, speech_regions=speech_regions, log=log)
    return out_wav


def resynth_one_line(work_dir, entry, text, language):
    # type: (str, dict, str, str) -> Optional[str]
    """Speak one line again with the same voice, over the top of its old wav.

    The speaker's reference wav and speaker_refs.json survive a finished job, so
    the voice can be cloned again rather than approximated.
    """
    from app.engines.base import get_engine

    i = int(entry["i"])
    spk = entry.get("speaker") or DEFAULT_SPEAKER
    ref_wav = os.path.join(work_dir, "qwen_ref_%s.wav" % _safe_name(spk))
    refs_path = os.path.join(work_dir, "speaker_refs.json")
    if not os.path.exists(ref_wav) or not os.path.exists(refs_path):
        raise FileNotFoundError(
            "This job has no reference audio for the speaker - remake the whole job.")
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
    return _synth_one(engine, {"text": text}, voice_id, language, seed,
                      out_path, lambda m: None, "line %d" % i)


def rebuild_dub(work_dir, data, video_path, out_path):
    # type: (str, dict, str, Optional[str]) -> str
    """Lay every line back over the background bed and remake the video.

    Deliberately the plain assembly: the nonverbal/company gates are skipped
    here because they read the original vocals track, which a finished job no
    longer keeps. What comes out is the same mix minus those overlays.
    """
    from app.pipeline import _mux, _video_duration, ensure_video_length

    lines = data.get("lines") or []
    line_paths = []
    for e in lines:
        p = os.path.join(work_dir, "qwen_line_%d.wav" % int(e["i"]))
        line_paths.append(p if os.path.exists(p) else None)
    starts = [e.get("start") for e in lines]
    gains = [e.get("gain") for e in lines]

    background = os.path.join(work_dir, "background.wav")
    if not os.path.exists(background):
        raise FileNotFoundError(
            "This job has no background audio - remake the whole job.")

    out_wav = os.path.join(work_dir, "qwen_dub_48k.wav")
    place_lines(background, line_paths, starts, out_wav, gains=gains, log=lambda m: None)

    out_path = out_path or os.path.join(work_dir, "dubbed.mp4")
    r = _mux(video_path, out_wav, out_path, _video_duration(video_path))
    if r.returncode != 0:
        raise RuntimeError("mux failed: %s" % r.stderr[-200:])
    ensure_video_length(video_path, out_path, lambda m: None)
    return out_path
