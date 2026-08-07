#!/usr/bin/env python3
"""Cancel original-voice ECHO that lives inside the dub lines themselves.

Discovered on the 2026-07-30 rebuild: the Qwen sidecar can bleed a low-level
copy of the speaker-reference prompt audio into the head of a synthesized
line. The reference clip is cut from the clip's own vocals stem, so when a
line is placed inside the reference span's stretch of the timeline, that
echo is the ORIGINAL language landing at nearly its original time -- inside
the dub audio itself, where vocals-stem gating cannot touch it (verified:
moon_gemini line 5, ref span 9.0-14.8s, echo at 11.3-11.6s with the gated
vocals independently at -40dB).

Fix: adaptive least-squares cancellation, applied ONLY where the leakage
gate (app.scripts.check_leakage) found a PERSISTENT leak run -- per 50ms
sub-window (50% overlap, triangular overlap-add so window seams are smooth),
subtract g * vocals from the mix, where g = <mix, vocals> / <vocals, vocals>
is exactly the component of the original present in the mix. Windows where
the correlation is coincidence subtract almost nothing (g is tiny), so the
dub itself is not audibly altered; a true aligned echo loses 10-20dB.

CLI: python3 -m app.scripts.suppress_vocal_echo MIX.wav VOCALS.wav OUT.wav
Prints the treated runs; exits 0. Library use: suppress_vocal_echo(...) ->
number of treated runs (0 = clean input, output identical to input).
"""
import struct
import sys
import wave
from typing import List, Tuple

from app.audio.pcm import SR, resample_chunk_to_48k_stereo
from app.scripts.check_leakage import HOP_SEC, WIN_SEC, measure_leakage

SUB_WIN = int(0.050 * SR)   # cancellation window (samples)
G_MAX = 1.5                 # sanity clamp on the projection coefficient


def _load_pcm16(path: str) -> Tuple[List[int], int]:
    """(interleaved 48kHz stereo samples, nchannels=2)."""
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        data, _ = resample_chunk_to_48k_stereo(
            raw, w.getframerate(), w.getsampwidth(), w.getnchannels(), None)
    return list(struct.unpack("<%dh" % (len(data) // 2), data)), 2


def _runs_from_fail_windows(fail_windows, max_gap: float) -> List[Tuple[float, float]]:
    runs: List[Tuple[float, float]] = []
    for w in fail_windows:
        t0, t1 = w["t"], w["t"] + WIN_SEC
        if runs and t0 - runs[-1][1] <= max_gap:
            runs[-1] = (runs[-1][0], t1)
        else:
            runs.append((t0, t1))
    return runs


def suppress_vocal_echo(mix_path: str, vocals_path: str, out_path: str,
                        exclude_spans=None) -> int:
    """Write out_path = mix with persistent original-voice leak runs cancelled.
    Returns the number of treated runs (0 = nothing to do; output == input).
    exclude_spans: verified nonverbal-whitelist copies ([start, end) seconds) --
    they are original voice ON PURPOSE, so without excluding them here the
    canceller would erase the very laughs/breaths the whitelist kept."""
    report = measure_leakage(mix_path, vocals_path, exclude_spans=exclude_spans)
    runs = _runs_from_fail_windows(report["fail_windows"], max_gap=HOP_SEC * 1.5)

    m, ch = _load_pcm16(mix_path)
    if runs:
        v, _ = _load_pcm16(vocals_path)
        n_frames = min(len(m), len(v)) // ch
        for t0, t1 in runs:
            # extend one analysis window each side so the echo's edges are
            # covered, then cancel with 50%-overlap triangular windows
            a = max(0, int((t0 - WIN_SEC) * SR))
            b = min(n_frames, int((t1 + WIN_SEC) * SR))
            hop = SUB_WIN // 2
            adj = [0.0] * ((b - a) + SUB_WIN)
            for w0 in range(a, b, hop):
                vv = mv = 0.0
                for i in range(w0, min(w0 + SUB_WIN, n_frames)):
                    vs = (v[i * ch] + v[i * ch + 1]) * 0.5
                    ms = (m[i * ch] + m[i * ch + 1]) * 0.5
                    vv += vs * vs
                    mv += ms * vs
                if vv <= 0.0:
                    continue
                g = max(-G_MAX, min(G_MAX, mv / vv))
                for i in range(w0, min(w0 + SUB_WIN, n_frames)):
                    k = i - w0
                    # triangular weight; halves sum to 1 at 50% overlap
                    wgt = 1.0 - abs(k - SUB_WIN / 2.0) / (SUB_WIN / 2.0)
                    vs = (v[i * ch] + v[i * ch + 1]) * 0.5
                    adj[i - a] += wgt * g * vs
            for i in range(a, b):
                d = adj[i - a]
                if d:
                    for c in range(ch):
                        s = m[i * ch + c] - int(round(d))
                        m[i * ch + c] = max(-32768, min(32767, s))

    with wave.open(out_path, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack("<%dh" % len(m), *m))
    return len(runs)


def main(argv: List[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    n = suppress_vocal_echo(argv[0], argv[1], argv[2])
    print("suppress_vocal_echo: %d persistent leak run(s) treated -> %s" % (n, argv[2]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
