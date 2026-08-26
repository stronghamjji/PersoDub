"""Raw PCM primitives: format conversion, gain ramps, peak limiting.

Bytes in, bytes out. No network, no filesystem, no app imports -- deliberately
the deepest layer, so everything else may depend on it and it depends on
nothing.

These lived in app/qwen_assemble.py, which other modules had quietly turned into
a shared library: company_gate.py and nonverbal.py each imported ten
underscore-prefixed names out of it, and two scripts (check_leakage,
suppress_vocal_echo) imported its resampler. The underscore was advertising
"private" while four modules depended on them.

Stdlib only (audioop + struct), matching the policy in qwen_assemble's header:
the app's own venv needs no numpy, and the streaming callers never load a whole
track as a float array. NOTE audioop is removed in Python 3.13 -- when that
migration happens, this module is the single place it has to be dealt with.
"""
import audioop
import struct
from math import log10 as _log10
from typing import Callable, Optional

SR = 48000
SAMPWIDTH = 2   # 16-bit PCM (input lines/background, and final output)
MIX_WIDTH = 4   # 32-bit PCM used only while accumulating, so sums don't clip early
NCHANNELS = 2   # stereo output
PEAK_CEILING = 0.99  # headroom left before hard-clipping on the final downconvert

_STRUCT_CODE = {2: "h", 4: "i"}  # struct format per sample width, '<' = portable size


def resample_chunk_to_48k_stereo(data: bytes, framerate: int, sampwidth: int,
                                 nchannels: int, state):
    """Convert to 48kHz/16-bit/stereo, threading audioop.ratecv's state.

    Threading the state lets a caller streaming a file chunk by chunk get one
    continuous resample instead of a seam/click at every chunk boundary.
    Returns (data, new_state); pass state=None for the first chunk.
    """
    if nchannels not in (1, 2):
        raise ValueError("only mono or stereo wavs are supported, got %d channels" % nchannels)
    if sampwidth != SAMPWIDTH:
        data = audioop.lin2lin(data, sampwidth, SAMPWIDTH)
    if framerate != SR:
        data, state = audioop.ratecv(data, SAMPWIDTH, nchannels, framerate, SR, state)
    if nchannels == 1:
        data = audioop.tostereo(data, SAMPWIDTH, 1, 1)
    return data, state


def to_48k_stereo_pcm16(data: bytes, framerate: int, sampwidth: int, nchannels: int) -> bytes:
    """Convert raw PCM audio to 48kHz / 16-bit / stereo (pure audio transform)."""
    out, _ = resample_chunk_to_48k_stereo(data, framerate, sampwidth, nchannels, None)
    return out


def peak_guard(mix: bytes, ceiling: float = PEAK_CEILING,
               log: Optional[Callable[[str], None]] = None) -> bytes:
    """Scale a MIX_WIDTH-PCM buffer under `ceiling` of 16-bit full scale, then
    downconvert to SAMPWIDTH. A no-op scale-wise (just the width conversion) for
    ordinary levels -- it only activates when the true summed peak would clip on
    the final 16-bit downconvert. Activation is a GLOBAL scale-down of the whole
    mix, so it is logged when `log` is given (observability only)."""
    if not mix:
        return b""
    peak = audioop.max(mix, MIX_WIDTH)
    out_full_scale = (1 << (8 * SAMPWIDTH - 1)) - 1
    limit = ceiling * out_full_scale * (1 << (8 * (MIX_WIDTH - SAMPWIDTH)))
    if peak > limit:
        if log is not None:
            log("   Warning: peak guard engaged: summed mix peaked %.2fdB over the "
                "%.2f ceiling -- whole mix scaled by %.3fx"
                % (20 * _log10(peak / limit), ceiling, limit / peak))
        mix = audioop.mul(mix, MIX_WIDTH, limit / peak)
    return audioop.lin2lin(mix, MIX_WIDTH, SAMPWIDTH)


def apply_ramp(buf: bytearray, byte_offset: int, n_frames: int, nchannels: int,
               weight_at: Callable[[int], float]) -> None:
    """In place: multiply each sample of n_frames frames starting at byte_offset
    (within a MIX_WIDTH-PCM buffer) by weight_at(frame_index_within_range), a
    0.0-1.0 gain. Reads the original values straight out of buf, so a byte range
    must not be ramped twice."""
    if n_frames <= 0:
        return
    n_samples = n_frames * nchannels
    fmt = "<%d%s" % (n_samples, _STRUCT_CODE[MIX_WIDTH])
    n_bytes = n_samples * MIX_WIDTH
    samples = list(struct.unpack(fmt, bytes(buf[byte_offset:byte_offset + n_bytes])))
    for f in range(n_frames):
        w = weight_at(f)
        if w == 1.0:
            continue
        base = f * nchannels
        for c in range(nchannels):
            samples[base + c] = int(round(samples[base + c] * w))
    buf[byte_offset:byte_offset + n_bytes] = struct.pack(fmt, *samples)
