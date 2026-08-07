"""Ultra-short-line handling for the Qwen dub path (app/qwen_pipeline.synth_lines).

A translated line whose time slot is very short (e.g. "Where's Dent?" / "덴트는?"
in a 0.3s cue) gives Qwen3-TTS too little room and the output can come out
audibly truncated mid-word. The fix ported here from lab experiments: instead
of synthesizing that line alone, merge its text onto the end of the PREVIOUS
line (same speaker, adjacent in time) and synthesize both together in one TTS
call -- the model speaks the pair naturally in one breath, with no truncation
pressure on the short line. The resulting audio is then split back into one
wav per original line at the quiet "energy valley" between the two sentences,
so every line downstream (scoring, gain matching, placement) still gets its
own wav file exactly as before.

Two pure, independently testable pieces:
  group_merge_units  -- decides WHICH lines merge with their predecessor
                         (grouping rule only, no audio).
  split_unit_audio    -- given one already-synthesized merged-unit wav and the
                         member lines' texts, cuts it back into one wav per
                         member at the quietest point near each expected
                         boundary (RMS envelope, stdlib audioop -- same
                         convention as app/qwen_assemble.py).

If a line doesn't qualify for merging (different speaker, no previous line,
gap too large, or missing cue timing) it is simply its own one-line unit --
the existing best-of-N extra-takes mechanism (app/qwen_select.py, already
active whenever n_takes>1) and place_lines' overlap-fade (app/qwen_assemble.py)
remain the fallbacks for those lines, unchanged by this module.
"""
import audioop
import wave
from typing import List, Optional

from app import config

HOP_SECONDS = 0.02                  # 20ms RMS envelope frame (matches qwen_score_takes.speech_dur's convention)
MIN_BOUNDARY_GAP_SECONDS = 0.03     # two chosen split points must be at least this far apart
VALLEY_RADIUS_FRACTION = 0.4        # search window radius = this fraction of the smaller neighboring expected segment
VALLEY_RADIUS_MIN_SECONDS = 0.05
VALLEY_RADIUS_MAX_SECONDS = 0.6


def _char_weight(text: str) -> int:
    """Non-space character count, floored at 1 -- same "how long is this line"
    proxy app.text.cues.ref_text_from_spans uses (REF_LINE_MIN_CHARS), reused
    here to guess each merged member's share of the combined audio."""
    return max(1, len("".join((text or "").split())))


def group_merge_units(
    segments: List[dict],
    seg_speakers: List[Optional[str]],
    usable_slots: List[float],
    threshold: Optional[float] = None,
    max_gap: Optional[float] = None,
) -> List[List[int]]:
    """Partition line indices [0..len(segments)) into ordered merge units (pure function).

    A unit is a list of consecutive original indices meant to be synthesized
    together as one TTS call. Line i joins the unit ending at line i-1 (which
    may itself already be a merged unit -- this lets a chain of consecutive
    ultra-short lines all merge together) when ALL of:
      - usable_slots[i] < threshold (its own slot is ultra-short)
      - seg_speakers[i] == seg_speakers[i-1] (same speaker as the immediately
        preceding line -- never merge across a speaker change)
      - both segments[i] and segments[i-1] carry real "start"/"end" cue
        timing (without it, adjacency/gap can't be judged -- skip merging
        rather than guess)
      - segments[i]["start"] - segments[i-1]["end"] <= max_gap (too large a
        silence baked into one continuous take would sound unnatural)
    The first line (i==0) never merges (no predecessor). threshold/max_gap
    default to app.config.QWEN_SHORT_LINE_SEC / QWEN_MERGE_MAX_GAP_SEC (read
    at call time, so tests can monkeypatch the config module directly).
    """
    threshold = config.QWEN_SHORT_LINE_SEC if threshold is None else threshold
    max_gap = config.QWEN_MERGE_MAX_GAP_SEC if max_gap is None else max_gap

    units: List[List[int]] = []
    for i, seg in enumerate(segments):
        prev = segments[i - 1] if i > 0 else None
        has_timing = (
            prev is not None
            and seg.get("start") is not None and seg.get("end") is not None
            and prev.get("start") is not None and prev.get("end") is not None
        )
        is_short = i < len(usable_slots) and usable_slots[i] < threshold
        same_speaker = (
            i > 0 and i < len(seg_speakers) and (i - 1) < len(seg_speakers)
            and seg_speakers[i] is not None and seg_speakers[i] == seg_speakers[i - 1]
        )
        gap_ok = has_timing and (seg["start"] - prev["end"]) <= max_gap

        if has_timing and is_short and same_speaker and gap_ok:
            units[-1].append(i)
        else:
            units.append([i])
    return units


def _read_pcm(path: str):
    with wave.open(path, "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate(), w.getsampwidth(), w.getnchannels()


def _write_pcm(path: str, framerate: int, sampwidth: int, nchannels: int, data: bytes) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(data)


def _rms_envelope(data: bytes, sampwidth: int, nchannels: int, framerate: int):
    """20ms-hop RMS envelope of a PCM buffer. Returns (env: List[int], hop_frames: int)."""
    bytes_per_frame = sampwidth * nchannels
    hop_frames = max(1, int(round(HOP_SECONDS * framerate)))
    hop_bytes = hop_frames * bytes_per_frame
    n_hops = len(data) // hop_bytes
    env = [audioop.rms(data[h * hop_bytes:(h + 1) * hop_bytes], sampwidth) for h in range(n_hops)]
    return env, hop_frames


def _valley_frame(env: List[int], hop_frames: int, center_sec: float, radius_sec: float, framerate: int) -> Optional[int]:
    """Frame index of the quietest envelope hop within [center-radius, center+radius]
    seconds, or None if the envelope has no hops in range at all.

    When several hops tie for quietest (the common case: a real silence gap
    between sentences is many consecutive near-zero-RMS hops), the middle of
    that run is picked -- landing the cut solidly inside the silence instead
    of right at its edge, which just barely clips the tail/head of a burst."""
    if not env:
        return None
    hop_sec = hop_frames / float(framerate)
    center_hop = center_sec / hop_sec
    radius_hops = max(1, int(round(radius_sec / hop_sec)))
    lo = max(0, int(round(center_hop)) - radius_hops)
    hi = min(len(env) - 1, int(round(center_hop)) + radius_hops)
    if lo > hi:
        return None
    window = env[lo:hi + 1]
    min_val = min(window)
    candidates = [lo + j for j, v in enumerate(window) if v == min_val]
    best_h = candidates[len(candidates) // 2]
    return best_h * hop_frames


def split_unit_audio(wav_path: str, member_texts: List[str], out_paths: List[str]) -> bool:
    """Split one merged-unit wav into len(member_texts) pieces, one per out_paths
    entry (same order), cut at the quietest point near each member's expected
    boundary. Expected boundaries are placed proportionally to each member's
    non-space character count (a stand-in for expected speaking duration);
    the actual cut is the minimum-RMS point in a window around that estimate,
    so the cut lands in real silence between sentences rather than mid-word.

    Returns False (nothing written) if the audio is too short/silent to find
    distinct boundaries for every member -- the caller should fall back to
    synthesizing each member individually instead of using a bad cut.
    """
    if len(member_texts) != len(out_paths) or len(member_texts) < 2:
        return False

    data, framerate, sampwidth, nchannels = _read_pcm(wav_path)
    bytes_per_frame = sampwidth * nchannels
    if bytes_per_frame <= 0 or framerate <= 0:
        return False
    total_frames = len(data) // bytes_per_frame
    total_dur = total_frames / float(framerate)
    if total_frames < 2 or total_dur <= 0:
        return False

    env, hop_frames = _rms_envelope(data, sampwidth, nchannels, framerate)
    if not env:
        return False

    weights = [_char_weight(t) for t in member_texts]
    total_w = sum(weights)
    seg_durs = [total_dur * w / total_w for w in weights]

    boundary_frames: List[int] = []
    cum_w = 0
    prev_frame = 0
    min_gap_frames = int(round(MIN_BOUNDARY_GAP_SECONDS * framerate))
    for j in range(len(member_texts) - 1):
        cum_w += weights[j]
        center_sec = total_dur * cum_w / total_w
        radius_sec = min(VALLEY_RADIUS_MAX_SECONDS, max(
            VALLEY_RADIUS_MIN_SECONDS, VALLEY_RADIUS_FRACTION * min(seg_durs[j], seg_durs[j + 1])
        ))
        frame = _valley_frame(env, hop_frames, center_sec, radius_sec, framerate)
        if frame is None:
            return False
        frame = max(frame, prev_frame + min_gap_frames)
        frame = min(frame, total_frames - 1)
        if frame <= prev_frame:
            return False  # no room left for a distinct boundary -- caller falls back
        boundary_frames.append(frame)
        prev_frame = frame

    bounds = [0] + boundary_frames + [total_frames]
    for j in range(len(member_texts)):
        a, b = bounds[j], bounds[j + 1]
        if b <= a:
            return False
        chunk = data[a * bytes_per_frame: b * bytes_per_frame]
        _write_pcm(out_paths[j], framerate, sampwidth, nchannels, chunk)
    return True
