#!/usr/bin/env python3
"""Mandatory leakage verification gate: how much ORIGINAL speech is still
audible in a finished dub mix?

Born from the 2026-07-30 delivery rejection: the original voice was audibly
present under the dubbed voice in all four videos (a mid-development shallow
duck, STT-missed dialogue passing un-gated at full level, a line overrunning
its gate, and Demucs bed residue). Every future dub must run this check
before delivery and pass.

Method (stdlib only, same dependency policy as app/qwen_assemble.py):
- Restrict to 100ms windows (50ms hop) where the vocals stem carries speech
  (energy VAD -- app.qwen_assemble.detect_speech_regions) at >= -45dBFS.
- Per window, g = lag-0 least-squares projection of the vocals stem onto the
  mix: g = <mix, voc> / <voc, voc>. The TTS is uncorrelated with the original
  vocals, so E[g] is exactly the level at which the original leaks through.
  A shifted-lag null test (|g| must exceed 3x the median |g| at +-0.7/1.4/2.1s
  lags) rejects chance TTS-vs-vocals correlation.
- residual_db = vocals window RMS + 20log10|g|  (absolute dBFS of the leak)
  rel_db      = residual_db - mix window RMS    (how loud vs the finished mix)
- FAIL when residual_db > ABS_FLOOR_DB (audible at all) AND rel_db >
  REL_BAR_DB (not masked by the mix) on MIN_CONSEC_WINDOWS consecutive
  windows. The persistence rule matters: the dub voice is timbre-cloned from
  the original speaker and often speaks cognate words (names, "Dent") at the
  same instant the original did, which genuinely correlates with the original
  waveform for a window or two (verified on edit60s line 3: the correlated
  audio was the dub itself, with the gated vocals measured at -40dB and no
  copied audio anywhere in the line wav). Real un-gated dialogue lasts
  hundreds of ms; a 1-2 window blip is reported as "suspect" but not a
  failure.

Pass bar rationale: a leak 35dB under the mix is inaudible under any dub
line; the -50dBFS absolute floor keeps silent-gap windows (tiny residue over
a tiny mix -> huge ratio) from false-failing. The 40dB speech duck puts gated
dialogue at roughly -60dBFS -- comfortably under both bars.

CLI:
  python3 -m app.scripts.check_leakage FINAL(.wav|.mp4) VOCALS.wav [NONVERBAL.json]
Exit code 0 = PASS, 1 = FAIL. An .mp4 final is extracted with ffmpeg first.

NONVERBAL.json (optional): the nonverbal-whitelist manifest written by
app/nonverbal.py (its "kept" spans are laughter/breath segments a local-
whisper veto verified contain NO words, deliberately copied back into the mix
at original volume). Those spans are BY DESIGN perfectly correlated with the
vocals stem (g = 0dB), so this gate skips every measurement window that
overlaps one -- and prints exactly what it excluded, with each span's whisper
transcript, so the exclusion is auditable. Everything outside the kept spans
is still measured at full strictness; without a manifest, behavior is
unchanged.

The manifest is NOT blindly trusted (a bogus span list could otherwise blank
the whole gate): every kept span must carry its whisper transcript field,
last at most MAX_NONVERBAL_SPAN_SEC, and the spans together may exclude at
most max(MAX_NONVERBAL_TOTAL_SEC, 10% of the mix) -- any violation FAILs the
gate outright (exit 1) with the reason printed.
"""
import json
import struct
import subprocess
import sys
import tempfile
import wave
from math import log10
from typing import List, Optional, Sequence, Tuple

from app.qwen_assemble import (
    SR,
    _resample_chunk_to_48k_stereo,
    detect_speech_regions,
)

REL_BAR_DB = -35.0      # leak must sit at least this far under the mix
ABS_FLOOR_DB = -50.0    # ...unless it's below this absolute level (inaudible)
WIN_SEC = 0.100
HOP_SEC = 0.050
SPEECH_MIN_DB = -45.0   # only windows where the original speech is this loud
NULL_LAGS_SEC = (-2.1, -1.4, -0.7, 0.7, 1.4, 2.1)
SIGNIFICANCE = 3.0      # |g| must exceed this multiple of the null level
STRIDE = 4              # subsample dot products 4x (statistically identical)
MAX_NONVERBAL_SPAN_SEC = 3.0   # a whitelisted laugh/breath span may last at most this
MAX_NONVERBAL_TOTAL_SEC = 5.0  # ...and all spans together at most max(this, 10% of mix)
MIN_CONSEC_WINDOWS = 5  # a leak must persist >= this many consecutive windows
# to fail. A blip of true duration d smears across ~(d + WIN_SEC)/HOP_SEC
# windows, so 5 windows ~= a real event longer than ~120ms -- long enough to
# reject dub-vs-original phonetic/pitch coincidences (a word-onset blip, see
# module docstring), short enough that any actual un-gated stretch of
# dialogue (hundreds of ms at minimum) still fails. Blips are reported as
# suspects either way.


def _load_mono_48k(path: str) -> List[int]:
    """A wav file (any rate/width/channels) as a mono 48kHz sample list."""
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        data, _ = _resample_chunk_to_48k_stereo(
            raw, w.getframerate(), w.getsampwidth(), w.getnchannels(), None)
    stereo = struct.unpack("<%dh" % (len(data) // 2), data)
    return [(stereo[i] + stereo[i + 1]) // 2 for i in range(0, len(stereo) - 1, 2)]


def _db(x: float) -> float:
    return 20 * log10(max(abs(x), 1e-12))


def _dot(a: Sequence[int], b: Sequence[int], a0: int, b0: int, n: int) -> float:
    s = 0.0
    for i in range(0, n, STRIDE):
        s += a[a0 + i] * b[b0 + i]
    return s


def measure_leakage(final_path: str, vocals_path: str,
                    rel_bar_db: float = REL_BAR_DB,
                    abs_floor_db: float = ABS_FLOOR_DB,
                    speech_regions: Optional[Sequence[Tuple[float, float]]] = None,
                    exclude_spans: Optional[Sequence[Tuple[float, float]]] = None) -> dict:
    """Measure original-speech leakage of `final_path` against the vocals stem.

    speech_regions: optional [start, end) second spans to check (defaults to
    energy-VAD detection on the vocals stem).
    exclude_spans: optional [start, end) second spans (verified nonverbal
    whitelist copies); any window OVERLAPPING one is skipped entirely -- a
    window merely straddling the boundary still partially correlates with the
    approved copy and would show up as a permanent suspect blip.
    Returns a dict:
      pass          -- True when no PERSISTENT leak (see MIN_CONSEC_WINDOWS)
      n_windows     -- speech windows measured
      n_fail        -- windows over both bars in persistent runs
      max_rel_db    -- worst leak relative to the mix (-120 if none measured)
      max_resid_db  -- worst absolute leak level (dBFS)
      fail_windows  -- [{t, v_rms_db, g_db, resid_db, mix_db, rel_db}, ...]
                       (only windows belonging to persistent runs)
      suspect_windows -- over-bar windows in sub-persistence blips (likely
                       dub-vs-original phonetic coincidence, not a leak)
    """
    f = _load_mono_48k(final_path)
    v = _load_mono_48k(vocals_path)
    n = min(len(f), len(v))
    if speech_regions is None:
        speech_regions = detect_speech_regions(vocals_path)

    win = int(WIN_SEC * SR)
    hop = int(HOP_SEC * SR)
    full = 32767.0
    n_windows = 0
    fails = []
    max_rel = -120.0
    max_resid = -120.0
    for a, b in speech_regions:
        w0 = max(0, int(a * SR))
        w_end = min(n - win, int(b * SR))
        for pos in range(w0, w_end + 1, hop):
            if exclude_spans and any(pos / SR < e and (pos + win) / SR > s
                                     for s, e in exclude_spans):
                continue
            vv = _dot(v, v, pos, pos, win)
            if vv <= 0.0:
                continue
            n_sub = (win + STRIDE - 1) // STRIDE
            v_rms_db = _db((vv / n_sub) ** 0.5 / full)
            if v_rms_db < SPEECH_MIN_DB:
                continue
            n_windows += 1
            g = _dot(f, v, pos, pos, win) / vv
            nulls = []
            for lag_sec in NULL_LAGS_SEC:
                lp = pos + int(lag_sec * SR)
                if lp >= 0 and lp + win <= n:
                    nulls.append(abs(_dot(f, v, lp, pos, win) / vv))
            nulls.sort()
            null_level = nulls[len(nulls) // 2] if nulls else 0.0
            if abs(g) <= SIGNIFICANCE * null_level:
                continue
            ff = _dot(f, f, pos, pos, win)
            mix_db = _db((ff / n_sub) ** 0.5 / full)
            resid_db = v_rms_db + _db(g)
            rel_db = resid_db - mix_db
            if resid_db > max_resid:
                max_resid = resid_db
            if resid_db > abs_floor_db and rel_db > max_rel:
                max_rel = rel_db
            if resid_db > abs_floor_db and rel_db > rel_bar_db:
                fails.append({
                    "t": pos / SR, "v_rms_db": v_rms_db, "g_db": _db(g),
                    "resid_db": resid_db, "mix_db": mix_db, "rel_db": rel_db,
                })
    # persistence rule: only runs of >= MIN_CONSEC_WINDOWS adjacent over-bar
    # windows count as real leaks; shorter blips are phonetic coincidences
    persistent, suspects = [], []
    run: List[dict] = []
    max_gap = HOP_SEC * 1.5
    for w in fails + [None]:
        if w is not None and (not run or w["t"] - run[-1]["t"] <= max_gap):
            run.append(w)
            continue
        (persistent if len(run) >= MIN_CONSEC_WINDOWS else suspects).extend(run)
        run = [w] if w is not None else []
    return {
        "pass": not persistent,
        "n_windows": n_windows,
        "n_fail": len(persistent),
        "max_rel_db": max_rel,
        "max_resid_db": max_resid,
        "fail_windows": persistent,
        "suspect_windows": suspects,
    }


def _validate_manifest_spans(kept: Sequence[dict], mix_dur_sec: float,
                             mode: Optional[str] = None) -> Optional[str]:
    """Reason string when a whitelist manifest is NOT acceptable, else None.
    Every kept span must carry its whisper transcript ("text" -- the audit
    trail that it was actually verified), be a sane forward span of at most
    MAX_NONVERBAL_SPAN_SEC, and all spans together may exclude at most
    max(MAX_NONVERBAL_TOTAL_SEC, 10% of the mix).

    mode="company" (the manifest's own "mode" marker, written by
    app/company_gate.py): the TOTAL cap is waived -- the company ambience
    layer deliberately keeps every whisper-verified nonverbal span at 0dB, and
    a laugh-heavy clip can legitimately verify more than the whitelist-mode
    cap allows. The caps themselves are NOT weakened: the per-span 3s cap and
    the transcript requirement still apply to every span, and a manifest
    without the explicit marker keeps the original total cap unchanged."""
    total = 0.0
    for k in kept:
        if "text" not in k:
            return "kept span %r has no whisper transcript field" % (k,)
        try:
            s, e = float(k["start"]), float(k["end"])
        except (KeyError, TypeError, ValueError):
            return "kept span %r has no usable start/end" % (k,)
        if e <= s:
            return "kept span %.2f-%.2fs is not a forward span" % (s, e)
        if e - s > MAX_NONVERBAL_SPAN_SEC:
            return ("kept span %.2f-%.2fs lasts %.2fs, over the %.1fs per-span cap"
                    % (s, e, e - s, MAX_NONVERBAL_SPAN_SEC))
        total += e - s
    cap = max(MAX_NONVERBAL_TOTAL_SEC, 0.10 * mix_dur_sec)
    if total > cap and mode != "company":
        return ("whitelist excludes %.2fs in total, over the %.2fs cap "
                "(max of %.1fs and 10%% of the %.1fs mix)"
                % (total, cap, MAX_NONVERBAL_TOTAL_SEC, mix_dur_sec))
    return None


def _extract_audio(mp4: str, out_wav: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", mp4, "-vn",
                    "-acodec", "pcm_s16le", "-ar", str(SR), "-ac", "2", out_wav],
                   check=True)


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    final_path, vocals_path = argv[0], argv[1]
    if final_path.endswith(".mp4"):
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        _extract_audio(final_path, tmp.name)
        final_path = tmp.name
    exclude_spans = None
    if len(argv) >= 3:
        # UTF-8 to match the writers (app/nonverbal.py, app/audio/ambience.py)
        # and the in-process reader in app/pipeline.py.
        manifest = json.load(open(argv[2], encoding="utf-8"))
        kept = manifest["kept"]
        mode = manifest.get("mode")
        if mode == "company":
            print("manifest mode marker: company (ambience layer -- total-cap waived, "
                  "per-span/transcript checks unchanged)")
        with wave.open(final_path, "rb") as w:
            mix_dur = w.getnframes() / float(w.getframerate())
        reason = _validate_manifest_spans(kept, mix_dur, mode=mode)
        if reason is not None:
            print("whitelist manifest REJECTED: %s" % reason)
            print("RESULT: FAIL")
            return 1
        for k in kept:
            print("excluding whitelisted nonverbal span %.2f-%.2fs (whisper: %r)"
                  % (k["start"], k["end"], k.get("text", "")))
        exclude_spans = [(float(k["start"]), float(k["end"])) for k in kept]
    r = measure_leakage(final_path, vocals_path, exclude_spans=exclude_spans)
    print("leakage gate: %d speech windows, %d failing" % (r["n_windows"], r["n_fail"]))
    print("  worst leak: %.1f dB relative to mix (bar %.1f), %.1f dBFS absolute (floor %.1f)"
          % (r["max_rel_db"], REL_BAR_DB, r["max_resid_db"], ABS_FLOOR_DB))
    for w in r["fail_windows"][:40]:
        print("  FAIL t=%7.2fs  orig %.1f dB  g %.1f dB  leak %.1f dBFS  mix %.1f dB  rel %+.1f dB"
              % (w["t"], w["v_rms_db"], w["g_db"], w["resid_db"], w["mix_db"], w["rel_db"]))
    if len(r["fail_windows"]) > 40:
        print("  ... and %d more" % (len(r["fail_windows"]) - 40))
    for w in r["suspect_windows"][:10]:
        print("  suspect (blip, not counted) t=%7.2fs rel %+.1f dB" % (w["t"], w["rel_db"]))
    print("RESULT: %s" % ("PASS" if r["pass"] else "FAIL"))
    return 0 if r["pass"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
