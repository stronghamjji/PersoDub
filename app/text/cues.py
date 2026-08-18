"""Dubbing quality helpers used by the Qwen3-TTS dub path (app/qwen_pipeline.py).

Only the pure/local helpers the Qwen path actually uses live here. The
container-exec tooling that once sat alongside them -- and its /generate API
client -- has been removed entirely.
"""
import os
from typing import List, Optional

REF_PAD_SECONDS = 0.4


def _check_docker_allowed() -> None:
    """Containerless tripwire. Nothing in this app calls docker anymore, but this
    guard stays in place (default ON) so that any future
    docker/container call fails loudly instead of silently reintroducing an
    unlicensed dependency. Set PERSODUB_FORBID_DOCKER=0 to disable (debugging only)."""
    if os.environ.get("PERSODUB_FORBID_DOCKER", "1") != "0":
        raise RuntimeError("PERSODUB_FORBID_DOCKER: a container/docker call was attempted")


def cut_vocals_span_local(vocals_path: str, spans: List[List[float]], pad: float = REF_PAD_SECONDS) -> bytes:
    """Cut several time spans out of a local vocals wav and concatenate them into a
    reference wav (bytes), with silence (pad) appended at the end to fully block
    'uh' leakage. Used by app/qwen_pipeline.py (build_speaker_refs) on the vocals
    track produced by local Demucs separation (app/separate.py) -- no container.
    """
    import subprocess

    if not spans:
        return b""
    fmt = "aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=mono"
    parts = [
        f"[0:a]atrim={s}:{e},asetpts=PTS-STARTPTS,{fmt}[a{i}]"
        for i, (s, e) in enumerate(spans)
    ]
    parts.append(f"aevalsrc=0:d={pad}:s=24000,{fmt}[pad]")
    labels = "".join(f"[a{i}]" for i in range(len(spans))) + "[pad]"
    filt = ";".join(parts) + f";{labels}concat=n={len(spans) + 1}:v=0:a=1[out]"
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", vocals_path, "-filter_complex", filt,
         "-map", "[out]", "-f", "wav", "pipe:1"],
        capture_output=True, timeout=300,
    )
    return r.stdout


def match_cue_index(seg: dict, src_cues: List[dict], tol: float = 0.05) -> Optional[int]:
    """Find the source-line index whose time range contains the line's midpoint (pure function)."""
    mid = (seg["start"] + seg["end"]) / 2.0
    for k, c in enumerate(src_cues):
        if c["start"] - tol <= mid <= c["end"] + tol:
            return k
    return None


def cue_speaker(cue: dict) -> Optional[str]:
    """The speaker label of a transcript line. STT engines attach it as speaker_id (pure function)."""
    return cue.get("speaker_id") or cue.get("speaker")


def _overlap(start: float, end: float, spans: list) -> float:
    """Total overlap (seconds) between the interval [start,end] and spans ([[s,e],...])."""
    return sum(max(0.0, min(end, e) - max(start, s)) for s, e in spans)


REF_LINE_MIN_COVER = 0.5   # only lines at least this fraction contained in the reference audio go into the script
REF_LINE_MIN_CHARS = 12  # lines shorter than this many non-space chars are dropped from the reference script
REF_LINE_MIN_DUR = 0.8   # lines shorter than this many seconds are also dropped


def ref_text_from_spans(cues: List[dict], spans: list) -> str:
    """Concatenate the source lines that overlap the time spans the reference was cut from.

    Used as ref_text when cloning a speaker's voice -- an empty script was measured to
    silently disable cloning quality. A short interjection ("No, no. No.") was measured
    to leak straight out at the front of the output, so it is dropped from the script.
    If everything is dropped (only short lines), fall back to using them all as before.
    ★If a line is in the script but not actually in the audio, the model reads that whole sentence
    (measured: a line touching only 0.13s of the reference tail caused "Even to a guy like me..."
    to leak straight into the dub). That is why only lines at least half-contained in the audio are used.
    """
    hit = [
        c for c in cues
        if c.get("text", "").strip()
        and _overlap(c["start"], c["end"], spans) >= (c["end"] - c["start"]) * REF_LINE_MIN_COVER
    ]
    long_lines = [
        c for c in hit
        if len("".join(c["text"].split())) >= REF_LINE_MIN_CHARS
        and (c["end"] - c["start"]) >= REF_LINE_MIN_DUR
    ]
    use = long_lines or hit
    return " ".join(c["text"].strip() for c in use)


# Same rule as the previous assembly step (concise) -- we don't cut audio that can
# spill into the silence before the next line either (prevents clipped speech)
GAP_SPILL_BUFFER = 0.05  # headroom (seconds) kept so it doesn't overlap the next line
GAP_SPILL_MAX = 0.4      # maximum time (seconds) allowed to spill into the silence (aligned with srt_utils.BORROW_SPILL)


def effective_slots(segments: List[dict], total_dur: Optional[float] = None) -> List[float]:
    """Usable time per segment = its own slot + part of the silence before the next line (pure function).

    If total_dur (the full video length) is given, the last segment can also spill into the trailing silence.
    """
    slots = []
    for i, s in enumerate(segments):
        slot = s["end"] - s["start"]
        nxt = segments[i + 1]["start"] if i + 1 < len(segments) else total_dur
        if nxt is not None:
            gap = nxt - s["end"]
            if gap > GAP_SPILL_BUFFER:
                slot += min(gap - GAP_SPILL_BUFFER, GAP_SPILL_MAX)
        slots.append(round(slot, 3))
    return slots
