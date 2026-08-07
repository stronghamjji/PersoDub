"""Laughter/breath WHITELIST for safe mode (QWEN_GATE_MODE=safe).

Safe mode never mixes the original vocals stem into the output, which also
throws away laughter, breaths and sighs. This module finds non-speech vocal
segments on the stem and copies ONLY verified ones into the finished mix at
ORIGINAL volume -- a copy of approved pieces, not ducking (no volume-reduction
gating of any kind).

Three stages, each fail-closed:
1. extract_nonverbal_segments -- candidates = energy on the vocals stem
   (app.qwen_assemble.detect_speech_regions) minus every padded original-speech
   cue span (+-0.3s) and every padded placed-dub-line span (+-0.1s); anything
   shorter than 0.15s after trimming is dropped.
2. Whisper veto -- each candidate is cut to a temp clip (silence-padded to
   >= 1.0s) and transcribed by a local openai-whisper in ONE subprocess (model
   loaded once for the whole batch). KEEP only when the transcript is empty or
   pure laughter/breath tokens (classify_transcript); ANY real word in any
   language rejects the candidate (it is speech STT missed -- copying it would
   be the leakage disaster safe mode exists to prevent), as do known whisper
   near-silence hallucinations ("Thank you", "MBC 뉴스", ...). If whisper
   itself fails, every candidate is rejected.
3. overlay_segments -- kept spans are copied from the stem into the mix at
   original amplitude with ~70ms raised-cosine fades on both ends. No other
   processing.

Same stdlib-only audio policy as app/qwen_assemble.py (wave/audioop/struct).
"""
import audioop
import json
import math
import os
import re
import subprocess
import tempfile
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
from app.audio.spans import pad_spans, subtract_spans
from app.audio.wavio import read_span_48k, read_wav
from app.config import NONVERBAL_WHISPER_MODEL, NONVERBAL_WHISPER_PYTHON
from app.qwen_assemble import detect_speech_regions

SPEECH_PAD_SEC = 0.3   # original-speech cue spans padded this much per side
DUB_PAD_SEC = 0.1      # placed dub-line spans padded this much per side
MIN_SEGMENT_SEC = 0.15  # a trimmed candidate must last at least this long
MIN_RMS_DBFS = -45.0   # a candidate must be at least this loud on the stem --
# below that it's noise floor, nothing audible to preserve (checker finding:
# a -51dBFS sliver was whitelisted although it added nothing over safe mode)
FADE_SEC = 0.07        # raised-cosine fade at each end of a copied segment
MIN_CLIP_SEC = 1.0     # whisper temp clips are silence-padded to at least this

Veto = Callable[[str, Sequence[Tuple[float, float]]], List[dict]]




def _span_rms_db(vocals_path: str, start: float, end: float) -> float:
    """RMS (dBFS) of one [start, end) span of the vocals stem, native format."""
    with wave.open(vocals_path, "rb") as w:
        sr, width = w.getframerate(), w.getsampwidth()
        a = max(0, min(w.getnframes(), int(round(start * sr))))
        b = max(a, min(w.getnframes(), int(round(end * sr))))
        w.setpos(a)
        raw = w.readframes(b - a)
    if not raw:
        return -120.0
    full = float((1 << (8 * width - 1)) - 1)
    return 20 * math.log10(max(audioop.rms(raw, width) / full, 1e-12))


def extract_nonverbal_segments(vocals_path: str,
                               speech_spans: Sequence[Sequence[float]],
                               dub_spans: Sequence[Sequence[float]],
                               speech_pad_sec: float = SPEECH_PAD_SEC,
                               dub_pad_sec: float = DUB_PAD_SEC,
                               min_dur_sec: float = MIN_SEGMENT_SEC) -> List[Tuple[float, float]]:
    """Candidate non-speech vocal segments ([start, end) seconds) on the stem:
    every energy-VAD region minus (a) padded original-speech cue spans and
    (b) padded placed-dub-line spans, keeping only pieces >= min_dur_sec (c).
    These are only CANDIDATES -- nothing is copied without the whisper veto."""
    exclusions = sorted(pad_spans(speech_spans, speech_pad_sec) +
                        pad_spans(dub_spans, dub_pad_sec))
    out = subtract_spans(list(detect_speech_regions(vocals_path)), exclusions)
    return [(a, b) for a, b in out
            if b - a >= min_dur_sec and _span_rms_db(vocals_path, a, b) >= MIN_RMS_DBFS]


# --- whisper-veto decision rule -------------------------------------------

# Bracketed tags whose content is explicitly non-verbal -- dropped before the
# word check. Any OTHER tag (e.g. "(speaking korean)") keeps its words and is
# rejected by the pattern rule below.
_NV_TAG_RE = re.compile(
    r"[\(\[][^)\]]*(?:laugh|chuckl|giggl|sigh|breath|exhal|inhal|snif|cough|"
    r"grunt|gasp|웃음|한숨|숨|기침)[^)\]]*[\)\]]", re.IGNORECASE)

# ONLY punctuation/whitespace is stripped -- an explicit whitelist, so any
# OTHER character (Japanese/Chinese/Cyrillic scripts, digits, ...) survives to
# the pattern check below and rejects the transcript. The old normalizer
# deleted everything non-latin/non-hangul, which silently turned e.g.
# 'ありがとうございます' into "empty transcript = KEEP" (fail-OPEN).
_PUNCT_RE = re.compile(
    "[\\s.,!?~\\-–—…·:;'\"“”‘’`´()\\[\\]{}<>*+/\\\\|@#%&^_=$"
    "♪♫ㅣㆍ、。，！？「」『』（）]+")

# The WHOLE normalized transcript must be one repeated laugh pattern:
#   latin:  (ha|he|ho|hi) repeated 2+ ("haha", "hohoho", "ehehe"), or a single
#           closed laugh syllable "hah"/"heh"/"hoh" -- never "hue"/"hoe"/"he"
#   hangul: laugh syllables 하호후흐헤히 repeated 2+, or ㅋ/ㅎ jamo walls --
#           never single syllables or vowel words ("오후", "아우", "음")
_LAUGH_LATIN_RE = re.compile(r"e?(?:ha|he|ho|hi){2,}h*|h[aeo]h+")
_LAUGH_HANGUL_RE = re.compile(r"[하호후흐헤히]{2,}|[ㅋㅎ]{2,}")


def classify_transcript(text: str) -> bool:
    """True = KEEP: the transcript is empty (after stripping whitespace,
    whitelisted punctuation and known non-verbal tags) or is, in its ENTIRETY,
    one repeated laugh pattern. False = REJECT: everything else -- real words
    in any language, foreign scripts, digits, breath-ish single tokens,
    whisper hallucinations ("Thank you", ...) all fail closed."""
    t = _NV_TAG_RE.sub(" ", text.strip().lower())
    norm = _PUNCT_RE.sub("", t)
    if not norm:
        return True
    return bool(_LAUGH_LATIN_RE.fullmatch(norm) or _LAUGH_HANGUL_RE.fullmatch(norm))


# --- whisper batch transcription (one subprocess, model loaded once) -------

_WHISPER_RUNNER = """
import json, sys
import whisper
model_name, in_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
model = whisper.load_model(model_name)
texts = []
for p in json.load(open(in_path)):
    r = model.transcribe(p, fp16=False, temperature=0.0,
                         condition_on_previous_text=False)
    texts.append(r.get("text", ""))
json.dump(texts, open(out_path, "w"))
"""


def _cut_clip(vocals_path: str, start: float, end: float, out_path: str) -> None:
    """One [start, end) span of the stem as its own wav, silence-padded on both
    sides to at least MIN_CLIP_SEC (whisper is unreliable on sub-second input)."""
    with wave.open(vocals_path, "rb") as w:
        sr, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        a = max(0, min(w.getnframes(), int(round(start * sr))))
        b = max(a, min(w.getnframes(), int(round(end * sr))))
        w.setpos(a)
        raw = w.readframes(b - a)
    need = int(MIN_CLIP_SEC * sr) - (b - a)
    if need > 0:
        pad = (need // 2 + 1) * width * ch
        raw = b"\x00" * pad + raw + b"\x00" * pad
    with wave.open(out_path, "wb") as out:
        out.setnchannels(ch)
        out.setsampwidth(width)
        out.setframerate(sr)
        out.writeframes(raw)


def whisper_veto(vocals_path: str, candidates: Sequence[Tuple[float, float]],
                 python_bin: Optional[str] = None, model: Optional[str] = None) -> List[dict]:
    """Transcribe every candidate span in ONE whisper subprocess and decide
    KEEP/REJECT per classify_transcript. Fail-closed: if whisper cannot run or
    returns garbage, every candidate is rejected."""
    python_bin = python_bin or NONVERBAL_WHISPER_PYTHON
    model = model or NONVERBAL_WHISPER_MODEL
    with tempfile.TemporaryDirectory(prefix="nonverbal_") as td:
        clips = []
        for k, (a, b) in enumerate(candidates):
            p = os.path.join(td, "cand_%d.wav" % k)
            _cut_clip(vocals_path, a, b, p)
            clips.append(p)
        in_path = os.path.join(td, "in.json")
        out_path = os.path.join(td, "out.json")
        with open(in_path, "w") as f:
            json.dump(clips, f)
        try:
            r = subprocess.run([python_bin, "-c", _WHISPER_RUNNER, model, in_path, out_path],
                               capture_output=True, text=True, timeout=1800)
            if r.returncode != 0:
                raise RuntimeError(r.stderr[-300:])
            texts = json.load(open(out_path))
            if len(texts) != len(candidates):
                raise RuntimeError("whisper returned %d texts for %d clips"
                                   % (len(texts), len(candidates)))
        except Exception as exc:  # fail-closed: no verified transcript, no copy
            return [{"start": a, "end": b, "keep": False, "error": True,
                     "text": "<whisper unavailable: %s>" % exc} for a, b in candidates]
    return [{"start": a, "end": b, "text": txt.strip(), "keep": classify_transcript(txt)}
            for (a, b), txt in zip(candidates, texts)]


# --- overlay ----------------------------------------------------------------

def overlay_segments(mix_path: str, vocals_path: str,
                     segments: Sequence[Tuple[float, float]], out_path: str,
                     fade_sec: float = FADE_SEC,
                     log: Optional[Callable[[str], None]] = None) -> str:
    """Copy each [start, end) span of the vocals stem into the mix at ORIGINAL
    amplitude (sum, gain 1.0) with a raised-cosine fade of fade_sec at both
    ends so there are no clicks. Accumulates in 32-bit PCM and runs the same
    peak guard as place_lines before writing 16-bit output."""
    data, sr, width, ch = read_wav(mix_path)
    mix = bytearray(audioop.lin2lin(
        to_48k_stereo_pcm16(data, sr, width, ch), SAMPWIDTH, MIX_WIDTH))
    bytes_per_frame = MIX_WIDTH * NCHANNELS
    for a, b in segments:
        seg = bytearray(read_span_48k(vocals_path, a, b))
        n_frames = len(seg) // bytes_per_frame
        if n_frames == 0:
            continue
        fade = min(int(round(fade_sec * SR)), n_frames // 2)
        if fade > 0:
            apply_ramp(seg, 0, fade, NCHANNELS,
                        lambda f: 0.5 - 0.5 * math.cos(math.pi * (f + 1) / (fade + 1)))
            apply_ramp(seg, (n_frames - fade) * bytes_per_frame, fade, NCHANNELS,
                        lambda f: 0.5 - 0.5 * math.cos(math.pi * (fade - f) / (fade + 1)))
        pos = max(0, int(round(a * SR))) * bytes_per_frame
        end = pos + len(seg)
        if end > len(mix):
            mix.extend(b"\x00" * (end - len(mix)))
        mix[pos:end] = audioop.add(bytes(mix[pos:end]), bytes(seg), MIX_WIDTH)
    out_pcm = peak_guard(bytes(mix), log=log)
    with wave.open(out_path, "wb") as out:
        out.setnchannels(NCHANNELS)
        out.setsampwidth(SAMPWIDTH)
        out.setframerate(SR)
        out.writeframes(out_pcm)
    return out_path


def apply_nonverbal_whitelist(mix_path: str, vocals_path: str,
                              speech_spans: Sequence[Sequence[float]],
                              dub_spans: Sequence[Sequence[float]],
                              out_path: Optional[str] = None,
                              veto: Optional[Veto] = None,
                              manifest_path: Optional[str] = None,
                              log: Optional[Callable[[str], None]] = None) -> dict:
    """Full whitelist pass over a finished safe-mode mix (in place by default):
    discover candidates, run the veto (whisper by default, injectable for
    tests), overlay only the kept segments. Returns (and optionally writes)
    the manifest: {"kept": [...], "rejected": [...]} with per-candidate
    timestamps, transcript and verdict."""
    log = log or (lambda m: None)
    candidates = extract_nonverbal_segments(vocals_path, speech_spans, dub_spans)
    kept: List[dict] = []
    rejected: List[dict] = []
    if candidates:
        verdicts = (veto or whisper_veto)(vocals_path, candidates)
        for v in verdicts:
            (kept if v["keep"] else rejected).append(v)
            log("   nonverbal %6.2f-%6.2fs %-7s %r"
                % (v["start"], v["end"], "KEEP" if v["keep"] else "REJECT", v.get("text", "")))
        if any(v.get("error") for v in verdicts):
            # dropping is the fail-closed CORRECT behavior, but it must be
            # loud: with a broken whisper setup the whitelist silently does
            # nothing and the laughter stays lost (Important-3)
            log("   ERROR: whisper veto unavailable -- all %d nonverbal candidate(s) "
                "dropped fail-closed; check NONVERBAL_WHISPER_PYTHON" % len(candidates))
        if kept:
            overlay_segments(mix_path, vocals_path,
                             [(v["start"], v["end"]) for v in kept],
                             out_path or mix_path, log=log)
    log("   nonverbal whitelist: %d candidate(s), %d kept, %d rejected"
        % (len(candidates), len(kept), len(rejected)))
    manifest = {"candidates": len(candidates), "kept": kept, "rejected": rejected}
    if manifest_path:
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
    return manifest
