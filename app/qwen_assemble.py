"""Assemble the Qwen3-TTS dub track: place per-line wavs over the Demucs background,
with each line gained to match the loudness the original actor had at that moment,
plus the original vocals track ducked (attenuated, not hard-muted -- see
QWEN_GATE_DUCK_DB) during dialogue (place_lines' vocals_path/speech_regions args --
see gate_vocals_chunks) so laughter/breaths/room tone between lines survive instead
of a stark digital-silence hole, and per-line overlap prevention (a line that would
run past the next line's start fades out instead of summing with it).

Resample each line 24kHz mono (Qwen's native output) up to 48kHz stereo with the
stdlib audioop module, gain it to match the original vocals' RMS in that cue's time
span (match_line_gains), lay it at its cue start time over the background (no_vocals)
track, and write the result as a 48kHz stereo wav. Mixing accumulates in 32-bit PCM
so gained lines summed over the background don't hard-clip before the final peak
guard runs (orig_rms/dub_rms gain matching, 0.99-ceiling peak guard), in stdlib
int PCM instead of numpy float. Deliberately dependency-free (wave + audioop + struct, all in the
Python 3.8 standard library) so this needs no new package in the app's venv --
the vocals-gating stream also never loads a whole file as a float array (unlike a
numpy port, which costs ~13.8GB per hour of video); see gate_vocals_chunks.
"""
import audioop
import struct
import wave
from math import log10 as _log10
from typing import Callable, List, Optional, Sequence, Tuple

from app.audio.pcm import (
    _STRUCT_CODE,
    MIX_WIDTH,
    NCHANNELS,
    SAMPWIDTH,
    SR,
)

# Aliased on purpose: these moved to app/audio/, but the names stay bound in this
# module's namespace so every call site below AND every monkeypatch target in
# tests/test_qwen_assemble.py keeps resolving. Renaming them here would not fail
# loudly -- it would make the fakes stop applying and the tests would silently
# start exercising real audio paths.
from app.audio.pcm import apply_ramp as _apply_ramp
from app.audio.pcm import peak_guard as _peak_guard
from app.audio.pcm import resample_chunk_to_48k_stereo as _resample_chunk_to_48k_stereo
from app.audio.pcm import to_48k_stereo_pcm16 as _to_48k_stereo_pcm16
from app.audio.spans import pad_and_merge
from app.audio.wavio import read_span_48k as _read_vocals_span_48k
from app.audio.wavio import read_wav as _read_wav
from app.config import (
    QWEN_GAIN_STEP_MAX,
    QWEN_GATE_BED_RESIDUE,
    QWEN_GATE_DUCK_DB,
    QWEN_GATE_KEEP_NONSPEECH,
    QWEN_GATE_MODE,
    QWEN_GATE_PAD_SEC,
    QWEN_GATE_SPEECH_DUCK_DB,
    QWEN_GATE_VAD,
    QWEN_TRIM_LEAD_SEC,
)

GAIN_MIN = 0.25
GAIN_MAX = 4.0

XFADE_SECONDS = 0.06         # 60ms crossfade at each dialogue-span boundary (vocals gating)
FADE_SECONDS = 0.08          # 80ms fade-out on a line's tail if it would run past the next line
END_HEADROOM_SECONDS = 0.03  # keep 30ms of clearance before the next line starts
GATE_CHUNK_FRAMES = SR * 5   # stream the vocals track 5s at a time -- bounded memory regardless of file length

TRIM_HOP_SECONDS = 0.02      # 20ms RMS envelope hop -- matches qwen_score_takes.speech_dur's convention
TRIM_THRESHOLD_FRAC = 0.06   # a hop counts as "voiced" once its RMS exceeds 6% of the buffer's peak hop


def _voiced_bounds(data: bytes, sampwidth: int, nchannels: int, framerate: int) -> Tuple[float, float]:
    """[start, end) seconds of the audible part of a PCM buffer: a 20ms-hop RMS
    envelope, thresholded at 6% of its own peak (same convention as
    qwen_score_takes.speech_dur), trimmed down to the first/last hop above
    threshold. (0.0, total_duration) -- i.e. nothing trimmed -- if the buffer
    is silent, too short to have a full hop, or has no framerate."""
    bytes_per_frame = sampwidth * nchannels
    if bytes_per_frame <= 0 or framerate <= 0:
        return 0.0, 0.0
    total_frames = len(data) // bytes_per_frame
    total_dur = total_frames / float(framerate)
    hop_frames = max(1, int(round(TRIM_HOP_SECONDS * framerate)))
    hop_bytes = hop_frames * bytes_per_frame
    n_hops = len(data) // hop_bytes
    if n_hops == 0:
        return 0.0, total_dur
    env = [audioop.rms(data[h * hop_bytes:(h + 1) * hop_bytes], sampwidth) for h in range(n_hops)]
    peak = max(env)
    if peak <= 0:
        return 0.0, total_dur
    thr = TRIM_THRESHOLD_FRAC * peak
    on = next((h for h, e in enumerate(env) if e > thr), 0)
    off = next((h for h in range(n_hops - 1, -1, -1) if env[h] > thr), n_hops - 1)
    start_sec = on * hop_frames / float(framerate)
    end_sec = min(total_dur, (off + 1) * hop_frames / float(framerate))
    return start_sec, end_sec


def _voiced_rms(data: bytes, sampwidth: int, nchannels: int, framerate: int) -> float:
    """RMS of just the envelope-thresholded audible part of a PCM buffer (see
    _voiced_bounds) -- so a measurement isn't diluted by silence padding
    around the actual voice (e.g. a subtitle cue span that's wider than the
    speech it times, or a TTS take's lead/tail dead air)."""
    bytes_per_frame = sampwidth * nchannels
    if bytes_per_frame <= 0 or not data:
        return 0.0
    start_sec, end_sec = _voiced_bounds(data, sampwidth, nchannels, framerate)
    a = int(round(start_sec * framerate)) * bytes_per_frame
    b = int(round(end_sec * framerate)) * bytes_per_frame
    seg = data[a:b]
    return audioop.rms(seg, sampwidth) if seg else 0.0


def _rms_span(data: bytes, framerate: int, sampwidth: int, nchannels: int,
             start: float, end: float) -> float:
    """RMS of the voiced/active part of one [start, end) time span (seconds)
    inside a PCM buffer -- envelope-thresholded (see _voiced_bounds) so a cue
    span's silence (e.g. the subtitle's timing is wider than the actual
    dialogue within it) doesn't drag the measurement down and distort
    match_line_gains' ratio. 0.0 if the span is empty, outside the buffer, or
    has no audible content."""
    bytes_per_frame = sampwidth * nchannels
    a = max(0, int(round(start * framerate))) * bytes_per_frame
    b = min(len(data), int(round(end * framerate)) * bytes_per_frame)
    if b <= a:
        return 0.0
    return _voiced_rms(data[a:b], sampwidth, nchannels, framerate)


def _cap_gain_steps(gains: List[float], step_max: float) -> List[float]:
    """Limit how much a line's gain can jump from the previous (already-capped)
    line's gain, to at most step_max x up or down (cue order) -- two lines'
    gains are each individually "correct" for matching their own cue span's
    loudness, but independent per-line RMS measurements can still swing
    sharply from one line to the next, audible as a jarring loud/quiet step
    even though neither gain alone looks wrong. Re-clamps to
    [GAIN_MIN, GAIN_MAX] since a capped step can otherwise walk past it."""
    if step_max <= 0 or len(gains) < 2:
        return list(gains)
    out = [max(GAIN_MIN, min(GAIN_MAX, gains[0]))]
    for g in gains[1:]:
        prev = out[-1]
        if prev <= 0 or g <= 0:
            out.append(g)
            continue
        capped = min(prev * step_max, max(prev / step_max, g))
        out.append(max(GAIN_MIN, min(GAIN_MAX, capped)))
    return out


def _trim_lead_tail_silence(data: bytes, sampwidth: int, nchannels: int, framerate: int,
                            lead_cap_sec: Optional[float] = None) -> bytes:
    """Drop leading/trailing near-silence from a synthesized line's PCM audio
    (see _voiced_bounds) before it's measured (match_line_gains) or placed
    (place_lines). Qwen's TTS output can start with real dead air (observed up
    to ~0.6s), which otherwise (a) opens a silent gap at the start of the
    line's cue slot, (b) drags its RMS down with silence instead of voice,
    understating how loud the line actually is, and (c) makes the line sound
    longer than its real speech, causing more overlap truncations against the
    next line.

    lead_cap_sec (default app.config.QWEN_TRIM_LEAD_SEC) bounds how much lead
    time is ever trimmed, in case a quiet/noisy take's envelope peak isn't
    really voice. Returns the original buffer unchanged if there's nothing
    voiced to isolate (degenerate/silent input)."""
    bytes_per_frame = sampwidth * nchannels
    if bytes_per_frame <= 0 or not data:
        return data
    start_sec, end_sec = _voiced_bounds(data, sampwidth, nchannels, framerate)
    cap = QWEN_TRIM_LEAD_SEC if lead_cap_sec is None else lead_cap_sec
    start_sec = min(start_sec, max(0.0, cap))
    a = int(round(start_sec * framerate)) * bytes_per_frame
    b = int(round(end_sec * framerate)) * bytes_per_frame
    trimmed = data[a:b]
    return trimmed if trimmed else data


def match_line_gains(vocals_wav: str, cues: List[dict], line_wavs: List[Optional[str]],
                     gain_step_max: Optional[float] = None) -> List[float]:
    """Per-line gain so each dubbed line matches the loudness the original actor had
    at that moment (pure function apart from reading the wav files off disk).

    For line i: RMS of the voiced part of the original vocals in cues[i]'s
    [start, end) span (see _rms_span/_voiced_rms -- the track's sample rate and
    channel count don't matter here, only relative level does) versus
    the RMS of the dubbed line wav with its lead/tail silence trimmed (see
    _trim_lead_tail_silence -- the same trimmed audio place_lines actually
    places), gain = orig_rms / dub_rms, clamped to [GAIN_MIN, GAIN_MAX] so a
    near-silent original or line never produces an absurd gain. A silent/
    out-of-range original span or a missing line (None, e.g. a failed synth)
    falls back to gain 1.0 -- leave the line as synthesized instead of
    guessing. Same orig_rms/dub_rms formula as above, plus an
    adjacent-line gain-step cap (see _cap_gain_steps, gain_step_max default
    app.config.QWEN_GAIN_STEP_MAX).
    """
    v_data, v_sr, v_w, v_ch = _read_wav(vocals_wav)
    gains = []
    for cue, path in zip(cues, line_wavs):
        if path is None:
            gains.append(1.0)
            continue
        orig_rms = _rms_span(v_data, v_sr, v_w, v_ch, cue["start"], cue["end"])
        if orig_rms <= 0:
            gains.append(1.0)
            continue
        l_data, l_sr, l_w, l_ch = _read_wav(path)
        l_data = _trim_lead_tail_silence(l_data, l_w, l_ch, l_sr)
        dub_rms = audioop.rms(l_data, l_w) if l_data else 0.0
        if dub_rms <= 0:
            gains.append(1.0)
            continue
        gains.append(max(GAIN_MIN, min(GAIN_MAX, orig_rms / dub_rms)))
    step_max = QWEN_GAIN_STEP_MAX if gain_step_max is None else gain_step_max
    return _cap_gain_steps(gains, step_max)


def _fade_tail(buf: bytes, fade_frames: int, nchannels: int = NCHANNELS) -> bytes:
    """A truncated line's tail, faded linearly to 0 over its last fade_frames
    frames instead of stopping abruptly (avoids a click). MIX_WIDTH PCM in/out."""
    bytes_per_frame = MIX_WIDTH * nchannels
    total_frames = len(buf) // bytes_per_frame
    n = min(fade_frames, total_frames)
    if n <= 0:
        return buf
    out = bytearray(buf)
    off = (total_frames - n) * bytes_per_frame
    _apply_ramp(out, off, n, nchannels,
               lambda f: (1.0 - f / (n - 1)) if n > 1 else 1.0)
    return bytes(out)


def _gate_chunk(chunk: bytes, chunk_start_frame: int, n_frames: int,
                regions_frames: Sequence[Tuple[int, int]], xfade_frames: int,
                nchannels: int, duck_factor: float = 0.0) -> bytes:
    """One MIX_WIDTH-PCM chunk (n_frames frames starting at the absolute 48kHz
    frame index chunk_start_frame) with any dialogue span in regions_frames
    (absolute frame index pairs) that overlaps this chunk ducked to
    duck_factor (0.0 = old hard-mute behavior; e.g. 0.126 = -18dB), with a
    linear crossfade of xfade_frames at each boundary (ramping between 1.0
    and duck_factor, not necessarily 1.0 and 0.0). Only the ~xfade_frames
    around each boundary needs a per-sample ramp; everything else is either
    passed through unchanged or scaled with a plain audioop.mul on the whole
    span, so cost scales with the number of dialogue-span boundaries, not
    chunk size."""
    bytes_per_frame = MIX_WIDTH * nchannels
    chunk_end_frame = chunk_start_frame + n_frames
    out = bytearray(chunk)
    for a, b in regions_frames:
        ra, rb = a - xfade_frames, b + xfade_frames
        if rb <= chunk_start_frame or ra >= chunk_end_frame:
            continue  # this dialogue span has no effect on this chunk at all

        # duck the dialogue span's body
        ms, me = max(a, chunk_start_frame), min(b, chunk_end_frame)
        if me > ms:
            off = (ms - chunk_start_frame) * bytes_per_frame
            ln = (me - ms) * bytes_per_frame
            if duck_factor <= 0.0:
                out[off:off + ln] = b"\x00" * ln
            else:
                out[off:off + ln] = audioop.mul(bytes(out[off:off + ln]), MIX_WIDTH, duck_factor)

        if xfade_frames <= 0:
            continue
        n = xfade_frames
        # ramp down into the span: weight 1.0 -> duck_factor over [ra, a)
        s, e = max(ra, chunk_start_frame), min(a, chunk_end_frame)
        if e > s:
            off = (s - chunk_start_frame) * bytes_per_frame
            base = s - ra
            _apply_ramp(out, off, e - s, nchannels,
                       lambda f, base=base: (1.0 - (1.0 - duck_factor) * (base + f) / (n - 1)) if n > 1 else 1.0)
        # ramp up out of the span: weight duck_factor -> 1.0 over [b, rb)
        s, e = max(b, chunk_start_frame), min(rb, chunk_end_frame)
        if e > s:
            off = (s - chunk_start_frame) * bytes_per_frame
            base = s - b
            _apply_ramp(out, off, e - s, nchannels,
                       lambda f, base=base: (duck_factor + (1.0 - duck_factor) * (base + f) / (n - 1)) if n > 1 else duck_factor)
    return bytes(out)


# Moved to app/audio/spans.py -- pure span algebra, no audio bytes. Kept as an
# alias because company_gate and nonverbal import this name from here, and the
# tests patch module attributes by name; they move in a later step.
_pad_and_merge_regions = pad_and_merge


# Energy-VAD parameters (detect_speech_regions). Hop matches the trim/score
# envelope convention; the rest are speech-shaped margins: a real line lasts
# at least VAD_MIN_SPEECH_SEC, trailing consonants/reverb hang on for up to
# VAD_HANGOVER_SEC, and VAD_PAD_SEC of safety is added to each edge.
VAD_HOP_SECONDS = 0.02
VAD_FLOOR_PERCENTILE = 0.20   # noise floor = this fraction into the sorted hop-RMS list
VAD_MARGIN_DB = 12.0          # speech = envelope above floor + margin...
VAD_ABS_MIN_DB = -55.0        # ...but never below this absolute level (dBFS)
VAD_MIN_SPEECH_SEC = 0.10     # a burst shorter than this is a click, not speech
VAD_HANGOVER_SEC = 0.30       # keep the region open this long after the envelope drops
VAD_PAD_SEC = 0.10            # widen each detected region by this much per side

BED_RESIDUE_FRAC = 0.35       # duck the bed in a speech region once the vocals-
# correlated component explains at least this fraction of the bed's energy there
BED_RESIDUE_MIN_DB = -60.0    # ...and only if the bed is even audible there (dBFS)


def detect_speech_regions(vocals_path: str,
                          margin_db: float = VAD_MARGIN_DB,
                          abs_min_db: float = VAD_ABS_MIN_DB,
                          min_speech_sec: float = VAD_MIN_SPEECH_SEC,
                          hangover_sec: float = VAD_HANGOVER_SEC,
                          pad_sec: float = VAD_PAD_SEC) -> List[Tuple[float, float]]:
    """[start, end) seconds of probable SPEECH on the Demucs vocals stem, from
    a 20ms-hop RMS envelope thresholded relative to the stem's own noise floor
    (the VAD_FLOOR_PERCENTILE-th percentile of hop RMS, + margin_db, but never
    below abs_min_db dBFS). A run must last min_speech_sec to open a region;
    the region stays open through envelope dips shorter than hangover_sec;
    each region is then padded by pad_sec per side and overlaps merged.

    Purpose: transcribed cue spans alone are NOT a safe gate for the original
    vocals -- STT can miss a line entirely (observed: a 2.5s stretch of
    dialogue with no cue at all) or time it tighter than the real speech.
    This detector works on the audio itself, so missed dialogue still gets
    gated. Deliberately errs toward detecting MORE (breaths/laughter near the
    threshold count as speech): leaking original dialogue is far worse than
    over-ducking a breath. Caveat: on a stem that is wall-to-wall speech with
    no quiet hops, the percentile floor rises to speech level and nothing
    exceeds floor+margin -- detection then finds nothing and gating falls back
    to the transcribed spans, which is no worse than before.

    Streams the file (any rate/width/channels) in ~5s reads; holds only the
    hop envelope in memory (a few floats per 20ms of audio).
    """
    with wave.open(vocals_path, "rb") as w:
        sr, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        hop_frames = max(1, int(round(VAD_HOP_SECONDS * sr)))
        env: List[float] = []
        leftover = b""
        while True:
            raw = w.readframes(sr * 5)
            if not raw:
                break
            raw = leftover + raw
            n_hops = len(raw) // (hop_frames * width * ch)
            hop_bytes = hop_frames * width * ch
            for h in range(n_hops):
                env.append(audioop.rms(raw[h * hop_bytes:(h + 1) * hop_bytes], width))
            leftover = raw[n_hops * hop_bytes:]
    if not env:
        return []
    full_scale = float((1 << (8 * width - 1)) - 1)

    def to_db(r):
        return 20 * _log10(max(r / full_scale, 1e-12))

    env_db = [to_db(r) for r in env]
    floor = sorted(env_db)[int(VAD_FLOOR_PERCENTILE * (len(env_db) - 1))]
    thr = max(floor + margin_db, abs_min_db)

    hop_sec = hop_frames / float(sr)
    min_hops = max(1, int(round(min_speech_sec / hop_sec)))
    hang_hops = max(0, int(round(hangover_sec / hop_sec)))

    regions: List[Tuple[float, float]] = []
    run_start = None   # index where the current above-threshold run began
    open_start = None  # index where the currently open region began
    last_above = None
    for i, e in enumerate(env_db):
        if e > thr:
            if run_start is None:
                run_start = i
            last_above = i
            if open_start is None and i - run_start + 1 >= min_hops:
                open_start = run_start
        else:
            run_start = None
            if open_start is not None and last_above is not None and i - last_above > hang_hops:
                regions.append((open_start * hop_sec, (last_above + 1) * hop_sec))
                open_start = None
    if open_start is not None and last_above is not None:
        regions.append((open_start * hop_sec, (last_above + 1) * hop_sec))
    return _pad_and_merge_regions(regions, pad_sec)


def _region_dots(bed: bytes, voc: bytes) -> Tuple[float, float, float]:
    """(<v,v>, <b,v>, <b,b>) over two equal-layout MIX_WIDTH PCM buffers,
    subsampled 4x (every 4th sample) -- plenty for a correlation-energy
    estimate, at a quarter of the pure-Python cost."""
    n = min(len(bed), len(voc)) // MIX_WIDTH
    fmt = "<%d%s" % (n, _STRUCT_CODE[MIX_WIDTH])
    b = struct.unpack(fmt, bed[:n * MIX_WIDTH])
    v = struct.unpack(fmt, voc[:n * MIX_WIDTH])
    vv = bv = bb = 0.0
    for i in range(0, n, 4):
        vi, bi = v[i], b[i]
        vv += vi * vi
        bv += bi * vi
        bb += bi * bi
    return vv, bv, bb


def _duck_bed_residue(bed: bytearray, vocals_path: str,
                      speech_regions: Sequence[Tuple[float, float]],
                      duck_factor: float,
                      log: Callable[[str], None]) -> None:
    """In place: duck the bed (background stem) to duck_factor inside each
    detected-speech region whose bed content is mostly vocal RESIDUE -- Demucs
    leaves a bleed of the original dialogue in the background stem, which no
    vocals-stem gating can remove. Residue test per region: the lag-0
    projection of the vocals onto the bed must explain >= BED_RESIDUE_FRAC of
    the bed's energy there (genuine music/effects don't correlate with the
    vocals at lag 0), and the bed must be audible at all (BED_RESIDUE_MIN_DB).
    """
    bytes_per_frame = MIX_WIDTH * NCHANNELS
    xfade_frames = int(round(XFADE_SECONDS * SR))
    to_duck: List[Tuple[int, int]] = []
    for start_sec, end_sec in speech_regions:
        a = max(0, int(round(start_sec * SR)))
        b = min(len(bed) // bytes_per_frame, int(round(end_sec * SR)))
        if b <= a:
            continue
        bed_span = bytes(bed[a * bytes_per_frame:b * bytes_per_frame])
        voc_span = _read_vocals_span_48k(vocals_path, start_sec, end_sec)
        vv, bv, bb = _region_dots(bed_span, voc_span)
        if vv <= 0.0 or bb <= 0.0:
            continue
        n_sub = max(1, (min(len(bed_span), len(voc_span)) // MIX_WIDTH + 3) // 4)
        full_scale = float((1 << (8 * SAMPWIDTH - 1)) - 1) * (1 << (8 * (MIX_WIDTH - SAMPWIDTH)))
        bed_rms_db = 20 * _log10(max((bb / n_sub) ** 0.5 / full_scale, 1e-12))
        if bed_rms_db < BED_RESIDUE_MIN_DB:
            continue
        resid_frac = (bv * bv / vv) / bb
        if resid_frac >= BED_RESIDUE_FRAC:
            to_duck.append((a, b))
            log("   bed residue duck %.2f-%.2fs (%.0f%% of the bed there is "
                "vocal bleed)" % (start_sec, end_sec, 100 * resid_frac))
    if to_duck:
        gated = _gate_chunk(bytes(bed), 0, len(bed) // bytes_per_frame,
                            sorted(to_duck), xfade_frames, NCHANNELS, duck_factor)
        bed[:] = gated


def gate_vocals_chunks(vocals_path: str, speech_regions: Sequence[Sequence[float]],
                       chunk_frames: int = GATE_CHUNK_FRAMES,
                       gate_pad_sec: Optional[float] = None,
                       gate_duck_db: Optional[float] = None,
                       extra_regions: Optional[Sequence[Sequence[float]]] = None,
                       deep_regions: Optional[Sequence[Sequence[float]]] = None,
                       speech_duck_db: Optional[float] = None):
    """Stream the original vocals track (any input rate/width/channel count) as
    successive (chunk_start_frame, chunk_bytes) pairs -- 48kHz stereo MIX_WIDTH
    PCM -- with each dialogue span in speech_regions ([start, end) seconds)
    ducked and a 60ms linear crossfade at each boundary. Demucs' 'vocals' stem
    captures laughter/breaths/coughs along with dialogue; gating instead of
    dropping the whole stem keeps those between-line sounds while the dub
    replaces the actual speech.

    Each region is padded by gate_pad_sec on both sides (default
    app.config.QWEN_GATE_PAD_SEC) and overlapping regions are merged before
    gating -- see _pad_and_merge_regions. extra_regions (optional, e.g. a
    dub line's actual placed playback span) are unioned in AFTER padding,
    unpadded -- unlike speech_regions they're exact known spans, not
    approximate STT timing, so they don't need the same slack.

    The gated span is attenuated by gate_duck_db dB (default
    app.config.QWEN_GATE_DUCK_DB) rather than hard-muted to true silence --
    pass float("inf") for the old hard-mute behavior. A dialogue-heavy clip's
    gated spans can cover most of the clip, and the vocals stem often carries
    room tone/breaths along with the dialogue -- hard-muting turns all of that
    into a stark silent gap; ducking lets it bleed through at a low level
    instead.

    deep_regions + speech_duck_db (default app.config.QWEN_GATE_SPEECH_DUCK_DB):
    two-tier ducking. Spans the energy VAD flagged as actual SPEECH (see
    detect_speech_regions) are ducked all the way to speech_duck_db -- they are
    original-language dialogue, the one thing that must never stay audible --
    while the rest of the gated area keeps the gentler gate_duck_db ambience
    duck. Implemented as a second attenuation pass (the extra
    speech_duck_db - gate_duck_db dB) on top of the first, each pass with its
    own 60ms boundary crossfades; a speech_duck_db at or below gate_duck_db is
    a no-op (never RAISES the gated level), as is hard-mute mode.

    Reads and resamples the input file chunk_frames output-frames at a time
    (default 5s) instead of ever holding the whole track as one array, so
    memory stays bounded regardless of file length -- a numpy whole-file float
    approach costs roughly 13.8GB per hour of video; this holds at most one
    chunk (a few MB) no matter how long the video is.
    """
    pad = QWEN_GATE_PAD_SEC if gate_pad_sec is None else gate_pad_sec
    duck_db = QWEN_GATE_DUCK_DB if gate_duck_db is None else gate_duck_db
    duck_factor = 0.0 if duck_db == float("inf") else 10 ** (-duck_db / 20.0)
    speech_db = QWEN_GATE_SPEECH_DUCK_DB if speech_duck_db is None else speech_duck_db
    padded_regions = _pad_and_merge_regions(speech_regions, pad)
    if extra_regions:
        padded_regions = _pad_and_merge_regions(list(padded_regions) + list(extra_regions), 0.0)
    xfade_frames = int(round(XFADE_SECONDS * SR))
    regions_frames = sorted(
        (max(0, int(round(s * SR))), int(round(e * SR)))
        for s, e in padded_regions
    )
    # second-tier pass: the EXTRA attenuation that takes an already-ducked
    # speech span from duck_db down to speech_db. Only deepens spans the first
    # pass gated (intersection with the gate union) -- with the VAD union
    # extension off (QWEN_GATE_KEEP_NONSPEECH=1), detected-only regions stay
    # fully un-gated rather than getting a stealth deep duck. No-op when
    # there's nothing deeper to take away (hard mute, or speech duck not
    # deeper than the base).
    deep_frames: List[Tuple[int, int]] = []
    deep_factor = 1.0
    if deep_regions and duck_factor > 0.0 and speech_db > duck_db:
        deep_factor = 10 ** (-(speech_db - duck_db) / 20.0)
        merged_deep = (
            (max(0, int(round(s * SR))), int(round(e * SR)))
            for s, e in _pad_and_merge_regions(deep_regions, 0.0)
        )
        deep_frames = sorted(
            (max(da, ga), min(db, gb))
            for da, db in merged_deep
            for ga, gb in regions_frames
            if min(db, gb) > max(da, ga)
        )
    with wave.open(vocals_path, "rb") as w:
        src_sr, src_w, src_ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        native_read = max(1, int(round(chunk_frames * src_sr / SR)))  # native frames per read, ~chunk_frames after resampling
        state = None
        out_frame = 0
        while True:
            raw = w.readframes(native_read)
            if not raw:
                break
            data, state = _resample_chunk_to_48k_stereo(raw, src_sr, src_w, src_ch, state)
            chunk32 = audioop.lin2lin(data, SAMPWIDTH, MIX_WIDTH)
            n_frames = len(chunk32) // (MIX_WIDTH * NCHANNELS)
            if n_frames == 0:
                continue
            gated = _gate_chunk(chunk32, out_frame, n_frames, regions_frames, xfade_frames, NCHANNELS, duck_factor)
            if deep_frames:
                gated = _gate_chunk(gated, out_frame, n_frames, deep_frames, xfade_frames, NCHANNELS, deep_factor)
            yield out_frame, gated
            out_frame += n_frames


LEAD_BORROW_MAX_SEC = 0.8       # a line may start at most this much before its cue start
LEAD_BORROW_MIN_GAP_SEC = 0.12  # ...but must keep this gap after the previous line's audio end
LEAD_BORROW_TRIGGER_SEC = 0.05  # only overshoots >= this trigger a borrow (rounding noise below)
LEAD_BORROW_PASSES = 5          # chain effects: an earlier shift can unblock the next line


def line_play_durations(line_paths: List[Optional[str]]) -> List[float]:
    """Each line wav's PLACED playback duration in seconds: lead/tail silence
    trimmed exactly like place_lines will trim it (see _trim_lead_tail_silence).
    0.0 for missing (None) or unreadable lines -- they are never placed."""
    durs = []
    for p in line_paths:
        if p is None:
            durs.append(0.0)
            continue
        try:
            data, sr, w, ch = _read_wav(p)
        except (OSError, EOFError, wave.Error):
            durs.append(0.0)
            continue
        data = _trim_lead_tail_silence(data, w, ch, sr)
        durs.append((len(data) // (w * ch)) / float(sr) if sr else 0.0)
    return durs


def borrow_lead_starts(starts: List[float], durs: List[float],
                       max_borrow: float = LEAD_BORROW_MAX_SEC,
                       min_gap: float = LEAD_BORROW_MIN_GAP_SEC,
                       headroom: float = END_HEADROOM_SECONDS,
                       log: Optional[Callable[[str], None]] = None) -> List[float]:
    """Leading-pause borrow (pure function; port of the 2026-07-30 v3 emergency
    reassembly fix into the real pipeline): a line whose audio would be
    truncated by the next placed line's start (place_lines' anti-overlap cut)
    may start up to max_borrow seconds BEFORE its cue start -- dialogue almost
    always has a breath pause before a cue, so starting slightly early is
    inaudible while a mid-word cut is not.

    durs[i] is the line's placed (silence-trimmed) duration -- see
    line_play_durations; 0.0/None-duration lines are never placed, so they
    neither borrow nor block a neighbor. Constraints: a shift never exceeds
    max_borrow total per line, never moves a line before min_gap after the
    previous placed line's (possibly already shifted) audio end, and never
    delays a line. Multi-pass (LEAD_BORROW_PASSES) so a shift that moves one
    line's tail earlier can unblock the following line's borrow. Returns the
    new starts list (same length/order); no audio is modified -- callers hand
    the result to place_lines, so there is still no time-stretch anywhere.
    """
    log = log or (lambda m: None)
    new = list(starts)
    placed = [j for j, (s, d) in enumerate(zip(starts, durs))
              if s is not None and s >= 0 and d and d > 0]
    order = sorted(placed, key=lambda j: (starts[j], j))
    for _ in range(LEAD_BORROW_PASSES):
        changed = False
        for idx, j in enumerate(order):
            if idx + 1 >= len(order):
                continue  # last placed line is never truncated by a neighbor
            nxt = order[idx + 1]
            over = (new[j] + durs[j]) - (new[nxt] - headroom)
            if over < LEAD_BORROW_TRIGGER_SEC:
                continue
            budget = max_borrow - (starts[j] - new[j])  # total borrow cap per line
            want = min(budget, over)
            if want <= 1e-9:
                continue
            prev_end = (new[order[idx - 1]] + durs[order[idx - 1]]) if idx > 0 else 0.0
            cand = max(new[j] - want, prev_end + min_gap, 0.0)
            if cand < new[j] - 1e-6:
                log("   lead borrow line %d: start %.3f -> %.3f (%.3fs earlier, tail was "
                    "%.2fs over the next line's start)" % (j, new[j], cand, new[j] - cand, over))
                new[j] = cand
                changed = True
        if not changed:
            break
    return new


def place_lines(background_path: str, line_paths: List[Optional[str]],
                starts: List[float], out_path: str,
                gains: Optional[List[float]] = None,
                vocals_path: Optional[str] = None,
                speech_regions: Optional[Sequence[Sequence[float]]] = None,
                log: Optional[Callable[[str], None]] = None,
                gate_pad_sec: Optional[float] = None,
                gate_duck_db: Optional[float] = None) -> str:
    """Lay each line wav at its cue start time (seconds) over the background track.

    background_path: the Demucs 'no_vocals' track (any sample rate/width/channel
    count -- typically 44.1kHz stereo straight out of the container).
    line_paths[i] (or None to skip a line, e.g. a failed synth) is placed at
    starts[i] seconds, gained by gains[i] (default 1.0, i.e. unchanged -- see
    match_line_gains for how real gains are computed).

    Each line's own lead/tail silence is trimmed before it's placed (see
    _trim_lead_tail_silence) -- Qwen's TTS output can start with real dead air,
    which would otherwise open a silent gap right after the cue start instead
    of the dub speaking immediately, and would make the line sound longer than
    its real speech (more overlap truncations against the next line).

    Anti-overlap: a line must never sound past the next line's start (by cue
    start time, stable-sorted so two lines sharing the exact same start are
    still resolved deterministically -- unlike the desktop-app reference this
    was ported from, whose strict `>` comparison let equal-start pairs collide
    unbounded). If a line would run past its neighbor's start minus a 30ms
    headroom, it is truncated and its tail is faded out (no time-stretch); if
    there is no room for it at all, the line is skipped -- logged as a warning
    (via `log`, not silently dropped) rather than summed with the next line.

    vocals_path + speech_regions (optional): if given, the original vocals
    track (any sample rate/width/channel count) is mixed in too, gated (see
    gate_duck_db) during the UNION of (speech_regions -- the source-language
    cue spans, padded by gate_pad_sec per side and merged), (speech the energy
    VAD detected directly on the stem -- see detect_speech_regions; STT-missed
    dialogue must be gated too; disable the union extension with
    QWEN_GATE_KEEP_NONSPEECH=1 or all detection with QWEN_GATE_VAD=0) and
    (each placed line's actual post-trim/post-truncation playback span, so a
    line running past its padded cue span doesn't leave the original vocals
    audible underneath it), with a 60ms crossfade at each boundary, streamed
    in bounded chunks (gate_vocals_chunks). Two-tier duck: VAD-detected
    speech is ducked to QWEN_GATE_SPEECH_DUCK_DB (near-silent -- it's
    original-language dialogue); the rest of the gated area keeps the gentler
    gate_duck_db ambience duck, preserving laughter/breaths/room tone between
    lines instead of a vacuum-silence bed. The bed itself is also checked for
    Demucs vocal residue inside detected-speech regions and ducked where it's
    mostly leaked voice (QWEN_GATE_BED_RESIDUE -- see _duck_bed_residue) --
    this residue check runs BEFORE any dub line below is summed into the bed,
    since it doesn't depend on placement and running it after would duck
    freshly-placed dub speech right along with the residue. QWEN_GATE_MODE=
    "preserve" hard-mutes detected speech instead of ducking it to
    QWEN_GATE_SPEECH_DUCK_DB (the default "safe" mode never reaches this
    vocals-mixing code at all -- see app/qwen_pipeline.run_qwen_dub).

    All placement/gating is summed in 32-bit PCM (MIX_WIDTH) so it has headroom
    to not clip before the final peak guard runs; the result is downconverted
    to 16-bit only at the very end. Returns out_path.
    """
    log = log or (lambda m: None)
    bg_data, bg_sr, bg_w, bg_ch = _read_wav(background_path)
    bed = bytearray(audioop.lin2lin(
        _to_48k_stereo_pcm16(bg_data, bg_sr, bg_w, bg_ch), SAMPWIDTH, MIX_WIDTH))
    bytes_per_frame = MIX_WIDTH * NCHANNELS

    fade_frames = int(round(FADE_SECONDS * SR))
    head_frames = int(round(END_HEADROOM_SECONDS * SR))

    # Bed (background) residue duck: must run BEFORE any dub line is summed
    # into `bed` below -- it only depends on the background + original
    # vocals, not on placement, and running it after placement let it crush
    # freshly-placed dub speech down to the speech-duck depth right along
    # with the residue it's meant to clean up (see
    # the leakage-analysis note, 2026-07-30).
    # QWEN_GATE_MODE="preserve" hard-mutes detected speech (inf dB) instead
    # of the configured QWEN_GATE_SPEECH_DUCK_DB -- "safe" mode (the
    # default) never reaches here at all since the caller passes
    # vocals_path=None in that mode.
    speech_db = float("inf") if QWEN_GATE_MODE == "preserve" else QWEN_GATE_SPEECH_DUCK_DB
    detected: List[Tuple[float, float]] = []
    if vocals_path is not None:
        if QWEN_GATE_VAD:
            detected = detect_speech_regions(vocals_path)
            if detected:
                log("   VAD: %d speech region(s) detected on the vocals stem" % len(detected))
        if detected and QWEN_GATE_BED_RESIDUE:
            _duck_bed_residue(bed, vocals_path, detected, 10 ** (-speech_db / 20.0), log)

    entries = [
        (i, p, s) for i, (p, s) in enumerate(zip(line_paths, starts))
        if p is not None and s is not None and s >= 0
    ]
    order = sorted(entries, key=lambda e: (e[2], e[0]))
    next_start = {}
    for idx, (i, _p, _s) in enumerate(order):
        next_start[i] = order[idx + 1][2] if idx + 1 < len(order) else None

    placed_spans: List[Tuple[float, float]] = []
    for i, path, start in order:
        data, sr, w, ch = _read_wav(path)
        data = _trim_lead_tail_silence(data, w, ch, sr)
        line = audioop.lin2lin(_to_48k_stereo_pcm16(data, sr, w, ch), SAMPWIDTH, MIX_WIDTH)

        # Stretch watchdog (2026-07-30 calibration): this app has no time-stretch/atempo code
        # anywhere -- the resample just above only changes the sample RATE, never playback
        # speed, so its duration must always match the source line's own (measured before any
        # later overlap truncation, which is a legitimate content cut, not a stretch, and is
        # already warned about separately below). Any deviation past rounding is a regression
        # signal that speed manipulation snuck in somewhere.
        if sr:
            src_dur = (len(data) // (w * ch)) / float(sr)
            placed_dur = (len(line) // bytes_per_frame) / float(SR)
            if src_dur > 0:
                stretch_rate = placed_dur / src_dur
                log("   stretch_rate line %d: %.4f (source %.3fs -> %.3fs)"
                    % (i, stretch_rate, src_dur, placed_dur))
                if abs(stretch_rate - 1.0) > 0.001:
                    log("   Warning: STRETCH WATCHDOG line %d: stretch_rate=%.4f != 1.000 -- "
                        "time-stretch is banned in this app, this should never happen"
                        % (i, stretch_rate))

        gain = gains[i] if gains is not None else 1.0
        if gain != 1.0:
            line = audioop.mul(line, MIX_WIDTH, gain)

        pos_frame = int(round(start * SR))
        nxt = next_start[i]
        if nxt is not None:
            limit_frame = int(round(nxt * SR)) - head_frames
            maxlen_frames = limit_frame - pos_frame
            if maxlen_frames <= 0:
                log("   Warning: line %d at %.3fs collides with the next line's start (%.3fs) -- "
                    "skipped to avoid overlap" % (i, start, nxt))
                continue
            line_frames = len(line) // bytes_per_frame
            if line_frames > maxlen_frames:
                line = _fade_tail(line[:maxlen_frames * bytes_per_frame], fade_frames)

        line_frames = len(line) // bytes_per_frame
        placed_spans.append((pos_frame / float(SR), (pos_frame + line_frames) / float(SR)))

        pos = pos_frame * bytes_per_frame
        end = pos + len(line)
        if end > len(bed):
            bed.extend(b"\x00" * (end - len(bed)))
        bed[pos:end] = audioop.add(bytes(bed[pos:end]), line, MIX_WIDTH)

    if vocals_path is not None:
        extra = list(placed_spans)
        if detected and not QWEN_GATE_KEEP_NONSPEECH:
            extra += detected
        for chunk_start_frame, chunk in gate_vocals_chunks(vocals_path, speech_regions or [],
                                                            gate_pad_sec=gate_pad_sec,
                                                            gate_duck_db=gate_duck_db,
                                                            extra_regions=extra,
                                                            deep_regions=detected,
                                                            speech_duck_db=speech_db):
            pos = chunk_start_frame * bytes_per_frame
            end = pos + len(chunk)
            if end > len(bed):
                bed.extend(b"\x00" * (end - len(bed)))
            bed[pos:end] = audioop.add(bytes(bed[pos:end]), chunk, MIX_WIDTH)

    out_pcm = _peak_guard(bytes(bed), log=log)

    with wave.open(out_path, "wb") as out:
        out.setnchannels(NCHANNELS)
        out.setsampwidth(SAMPWIDTH)
        out.setframerate(SR)
        out.writeframes(out_pcm)
    return out_path
