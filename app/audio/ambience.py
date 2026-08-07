"""Ambience layer for QWEN_GATE_MODE="company".

Professional dubs restore laughter by adding a "speech-erased
original-vocals layer" to the background: final bed = separated background +
the original vocals with ONLY speech fully erased. This module builds that
layer on top of a finished safe-mode mix.

The MUTE set (TRUE ZERO -- no ducking anywhere -- with 60-80ms raised-cosine
crossfades at every boundary) is the union of:
  (a) original speech cue spans, padded +-0.3s (nonverbal.SPEECH_PAD_SEC);
  (b) energetic VAD regions on the vocals stem that are NOT whisper-verified
      nonverbal (reuses app/nonverbal.py candidate discovery + veto,
      fail-closed: an unverifiable energetic region stays muted);
  (c) placed dub-line spans, padded +-0.1s (nonverbal.DUB_PAD_SEC) -- original
      sound is never laid under dub speech.
Everything else stays at FULL original volume: whisper-verified laughter/
breaths AND quiet room tone below the VAD threshold.

In company mode the safe-mode whitelist overlay (QWEN_KEEP_NONVERBAL) is
auto-disabled by the caller (app/qwen_pipeline.run_qwen_dub) -- the layer
already carries the verified nonverbal content at 0dB; overlaying it again
would double the audio (clipping/echo).

apply_company_ambience also emits the gate-exclusion manifest json in the
format app/scripts/check_leakage.py expects ({"kept": [{start, end, text}],
...} + a "mode": "company" marker): the whisper-verified energetic non-speech
spans that legitimately stay correlated with the vocals stem. Spans longer
than check_leakage's 3s per-span cap are split at quiet energy dips
(split_span_at_dips) so each manifest span validates individually.

Same stdlib-only audio policy as app/qwen_assemble.py (wave/audioop/struct).
"""
import audioop
import json
import math
import wave
from typing import Callable, List, Optional, Sequence, Tuple

from app.audio.pcm import (
    MIX_WIDTH,
    NCHANNELS,
    SAMPWIDTH,
    SR,
    apply_ramp,
    peak_guard,
    to_48k_stereo_pcm16,
)
from app.audio.spans import merge_spans, pad_spans, subtract_spans
from app.audio.wavio import read_wav
from app.nonverbal import (
    DUB_PAD_SEC,
    SPEECH_PAD_SEC,
    Veto,
    extract_nonverbal_segments,
    whisper_veto,
)
from app.qwen_assemble import detect_speech_regions

CROSSFADE_SEC = 0.07          # raised-cosine crossfade at each mute boundary (60-80ms band)
MAX_MANIFEST_SPAN_SEC = 3.0   # check_leakage's per-span cap -- longer kept spans are split
DIP_HOP_SEC = 0.02            # RMS envelope hop used to find quiet split points




def compute_mute_set(vocals_path: str,
                     speech_spans: Sequence[Sequence[float]],
                     dub_spans: Sequence[Sequence[float]],
                     veto: Optional[Veto] = None,
                     log: Optional[Callable[[str], None]] = None):
    """The company-mode MUTE set + the whisper verdicts backing it.

    Returns (mute_regions, verdicts): mute_regions = merged [start, end) spans
    to erase to true zero; verdicts = the whisper veto's per-candidate dicts
    ({"start", "end", "keep", "text", ...}) -- kept ones are the spans that
    stay at 0dB inside otherwise-energetic territory, and feed the manifest.

    Fail-closed: candidates the veto rejects (or cannot verify -- whisper
    unavailable) stay inside the mute set.
    """
    log = log or (lambda m: None)
    candidates = extract_nonverbal_segments(vocals_path, speech_spans, dub_spans)
    verdicts: List[dict] = []
    if candidates:
        verdicts = (veto or whisper_veto)(vocals_path, candidates)
        for v in verdicts:
            log("   company gate %6.2f-%6.2fs %-7s %r"
                % (v["start"], v["end"], "KEEP" if v["keep"] else "MUTE", v.get("text", "")))
        if any(v.get("error") for v in verdicts):
            log("   ERROR: whisper veto unavailable -- all %d energetic candidate(s) "
                "muted fail-closed; check NONVERBAL_WHISPER_PYTHON" % len(candidates))
    kept = [(v["start"], v["end"]) for v in verdicts if v["keep"]]
    union = merge_spans(
        pad_spans(speech_spans, SPEECH_PAD_SEC)
        + pad_spans(dub_spans, DUB_PAD_SEC)
        + list(detect_speech_regions(vocals_path))
    )
    # kept spans were carved out of the VAD regions AWAY from the padded
    # speech/dub spans (extract_nonverbal_segments), so punching them back out
    # of the union can never re-open audio under a cue or a dub line.
    return subtract_spans(union, kept), verdicts


def build_ambience_layer(vocals_path: str,
                         mute_regions: Sequence[Sequence[float]],
                         fade_sec: float = CROSSFADE_SEC) -> bytes:
    """The whole vocals stem as 48kHz stereo MIX_WIDTH PCM with every mute
    region erased to TRUE ZERO and a raised-cosine crossfade of fade_sec at
    each boundary (ramps live in the KEPT side, so the mute interior is exact
    digital silence). No ducking anywhere: everything outside the mute set is
    bit-identical to the stem."""
    data, sr, width, ch = read_wav(vocals_path)
    layer = bytearray(audioop.lin2lin(
        to_48k_stereo_pcm16(data, sr, width, ch), SAMPWIDTH, MIX_WIDTH))
    bytes_per_frame = MIX_WIDTH * NCHANNELS
    n_frames = len(layer) // bytes_per_frame
    fade = int(round(fade_sec * SR))

    regs = [
        (max(0, int(round(s * SR))), min(n_frames, int(round(e * SR))))
        for s, e in merge_spans(mute_regions)
    ]
    regs = [(a, b) for a, b in regs if b > a]
    for a, b in regs:
        layer[a * bytes_per_frame:b * bytes_per_frame] = b"\x00" * ((b - a) * bytes_per_frame)

    def cos_up(f: int, n: int) -> float:      # 0 -> 1 raised cosine over n frames
        return 0.5 - 0.5 * math.cos(math.pi * (f + 1) / (n + 1))

    # Kept gaps between mute regions get the boundary ramps. A gap shorter than
    # two full fades gets ONE combined ramp (min of the up and down weights) so
    # no byte range is ever ramped twice (_apply_ramp reads original values).
    bounds = [0] + [x for a, b in regs for x in (a, b)] + [n_frames]
    for i in range(0, len(bounds), 2):
        g0, g1 = bounds[i], bounds[i + 1]
        if g1 <= g0:
            continue
        fade_in = i > 0                      # gap preceded by a mute region
        fade_out = i + 2 < len(bounds)       # gap followed by a mute region
        if not fade_in and not fade_out:
            continue
        gap = g1 - g0
        need = (fade if fade_in else 0) + (fade if fade_out else 0)
        if gap >= need:
            if fade_in:
                apply_ramp(layer, g0 * bytes_per_frame, fade, NCHANNELS,
                            lambda f: cos_up(f, fade))
            if fade_out:
                apply_ramp(layer, (g1 - fade) * bytes_per_frame, fade, NCHANNELS,
                            lambda f: cos_up(fade - 1 - f, fade))
        else:
            apply_ramp(layer, g0 * bytes_per_frame, gap, NCHANNELS,
                        lambda f: min(cos_up(f, fade) if fade_in else 1.0,
                                      cos_up(gap - 1 - f, fade) if fade_out else 1.0))
    return bytes(layer)


def split_span_at_dips(vocals_path: str, start: float, end: float,
                       max_len: float = MAX_MANIFEST_SPAN_SEC) -> List[Tuple[float, float]]:
    """Split one [start, end) span into contiguous pieces of at most max_len
    seconds, cutting at the quietest 20ms hop in the middle 60% of whatever
    piece is still too long (a laugh's quiet dip, not mid-burst). Pure
    recursion on the hop-RMS envelope; the pieces tile the span exactly."""
    if end - start <= max_len:
        return [(start, end)]
    with wave.open(vocals_path, "rb") as w:
        sr, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        a = max(0, min(w.getnframes(), int(round(start * sr))))
        b = max(a, min(w.getnframes(), int(round(end * sr))))
        w.setpos(a)
        raw = w.readframes(b - a)
    hop = max(1, int(round(DIP_HOP_SEC * sr)))
    hop_bytes = hop * width * ch
    env = [audioop.rms(raw[h * hop_bytes:(h + 1) * hop_bytes], width)
           for h in range(len(raw) // hop_bytes)]

    def rec(s_hop: int, e_hop: int) -> List[Tuple[int, int]]:
        dur_hops = e_hop - s_hop
        if dur_hops * hop / sr <= max_len:
            return [(s_hop, e_hop)]
        lo = s_hop + max(1, int(0.2 * dur_hops))
        hi = s_hop + max(2, int(0.8 * dur_hops))
        cut = min(range(lo, hi), key=lambda h: env[h])
        return rec(s_hop, cut) + rec(cut, e_hop)

    n_hops = len(env)
    if n_hops < 2:
        return [(start, end)]
    pieces_hops = rec(0, n_hops)
    pieces = []
    for i, (sh, eh) in enumerate(pieces_hops):
        pa = start if i == 0 else pieces[-1][1]
        pb = end if i == len(pieces_hops) - 1 else start + eh * hop / sr
        pieces.append((pa, pb))
    return pieces


def apply_company_ambience(mix_path: str, vocals_path: str,
                           speech_spans: Sequence[Sequence[float]],
                           dub_spans: Sequence[Sequence[float]],
                           out_path: Optional[str] = None,
                           veto: Optional[Veto] = None,
                           manifest_path: Optional[str] = None,
                           log: Optional[Callable[[str], None]] = None) -> dict:
    """Full company-mode pass over a finished safe-mode mix (in place by
    default): compute the mute set, build the speech-erased ambience layer and
    sum it into the mix (32-bit accumulate + the same peak guard as
    place_lines), then write the gate-exclusion manifest.

    Returns (and optionally writes) the manifest: {"mode": "company",
    "kept": [...], "rejected": [...], "muted_regions": [...]} where kept spans
    (split to <= 3s each, transcripts attached) are exactly what
    check_leakage's 3-arg mode excludes from measurement.
    """
    log = log or (lambda m: None)
    mute_regions, verdicts = compute_mute_set(vocals_path, speech_spans, dub_spans,
                                              veto=veto, log=log)
    layer = build_ambience_layer(vocals_path, mute_regions)

    data, sr, width, ch = read_wav(mix_path)
    mix = bytearray(audioop.lin2lin(
        to_48k_stereo_pcm16(data, sr, width, ch), SAMPWIDTH, MIX_WIDTH))
    if len(layer) > len(mix):
        mix.extend(b"\x00" * (len(layer) - len(mix)))
    mix[:len(layer)] = audioop.add(bytes(mix[:len(layer)]), layer, MIX_WIDTH)
    out_pcm = peak_guard(bytes(mix), log=log)
    with wave.open(out_path or mix_path, "wb") as out:
        out.setnchannels(NCHANNELS)
        out.setsampwidth(SAMPWIDTH)
        out.setframerate(SR)
        out.writeframes(out_pcm)

    kept_split: List[dict] = []
    rejected: List[dict] = []
    for v in verdicts:
        if not v["keep"]:
            rejected.append(v)
            continue
        for a, b in split_span_at_dips(vocals_path, v["start"], v["end"]):
            kept_split.append({"start": a, "end": b, "keep": True,
                               "text": v.get("text", "")})
    log("   company ambience: %d mute region(s), %d verified span(s) kept at 0dB"
        % (len(mute_regions), len(kept_split)))
    manifest = {
        "mode": "company",
        "candidates": len(verdicts),
        "kept": kept_split,
        "rejected": rejected,
        "muted_regions": [[round(a, 3), round(b, 3)] for a, b in mute_regions],
    }
    if manifest_path:
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
    return manifest
