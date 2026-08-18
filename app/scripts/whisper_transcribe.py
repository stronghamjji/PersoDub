#!/usr/bin/env python3
"""Local Whisper transcription worker (runs OUTSIDE the app's Python 3.8 venv,
inside the dedicated STT venv -- see app/stt_local.py, STT_PYTHON).

Uses faster-whisper (CTranslate2 backend) against a local model directory --
no network access needed at runtime, matching the offline-firewall constraint
(HuggingFace CDN is blocked for weight downloads from this host). The model
directory holds the faster-whisper-large-v3 weights the installer downloads
into the kit (WHISPER_MODEL_DIR in kit.env).

Usage:
  python whisper_transcribe.py --audio in.wav --output out.json [--language en] [--word-timestamps]

Reads WHISPER_MODEL_DIR (falls back to DEFAULT_MODEL_DIR) for the model path.
Writes JSON to --output: {"ok": true, "language": "en",
  "segments": [{"start": float, "end": float, "text": str}, ...]}
or {"ok": false, "error": "..."} with a non-zero exit code on any failure.
Never raises past main() -- same convention as app/scripts/qwen_score_takes.py.

Batch mode (--audio-list instead of --audio): loads the model ONCE and
transcribes every path in a JSON list file, instead of one process (and one
full model load) per file. app/scripts/qwen_score_takes.py uses this for
best-of-N take scoring -- scoring dozens of short takes by spawning this
script once per take was reloading the whisper-large-v3 weights from disk
every single time (~18s/call, almost all of it model load), which at
realistic take counts (e.g. 13 lines x 4 takes = 52 calls) blew past the
scorer's own subprocess timeout and silently disabled best-of-N selection
for the whole job. Writes {"ok": true, "results": {<path>: {"ok": true,
"language": .., "segments": [...]} or {"ok": false, "error": ..}, ...}} --
one path failing doesn't stop the rest.
"""
import argparse
import json
import os
import re
import sys

# Default location of the copied faster-whisper-large-v3 weights, relative to
# the process working directory (see app/docs/INTEGRATION_SPEC.md for how this
# was obtained). Set WHISPER_MODEL_DIR for an absolute path.
DEFAULT_MODEL_DIR = "models/whisper/faster-whisper-large-v3"

# Force offline mode -- we always load from a local directory, but this
# belt-and-suspenders setting stops any library from trying the network.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def _load_model():
    from faster_whisper import WhisperModel

    model_dir = os.environ.get("WHISPER_MODEL_DIR", DEFAULT_MODEL_DIR)
    if not os.path.isdir(model_dir):
        raise RuntimeError("WHISPER_MODEL_DIR not found: %s" % model_dir)
    return WhisperModel(model_dir, device="cpu", compute_type="int8")


# Whisper only writes sentence marks when the prompt shows it that style. With
# no prompt it returns CJK speech as one unpunctuated run for the whole clip --
# the pipeline then sees a single 24s "line", translation cannot length-fit it,
# and TTS synthesizes 2 lines instead of 15. Latin-script languages come back
# punctuated already, so they never reach the retry in _transcribe_with.
SENTENCE_PROMPTS = {
    "ko": "넌 꿈이 뭐니? 앞으로 어떻게 살 작정이야. 계획이 있긴 하니?",
    "ja": "あなたの夢は何ですか。これからどう生きるつもりですか。計画はありますか。",
    "zh": "你的梦想是什么？以后打算怎么生活？你有计划吗？",
}

_SENTENCE_MARK = re.compile(r"[.?!…。？！]")


def needs_split(cues):
    """True when Whisper returned the whole clip as one unpunctuated run."""
    return len(cues) == 1 and not _SENTENCE_MARK.search(cues[0]["text"])


def split_by_sentence(words):
    """Cut a flat word list into one cue per sentence, timed from the words."""
    lines, cur = [], []
    for w in words:
        cur.append(w)
        if _SENTENCE_MARK.search(w.word.strip()[-1:]):
            lines.append(cur)
            cur = []
    if cur:
        lines.append(cur)
    return [
        {
            "start": round(ln[0].start, 3),
            "end": round(ln[-1].end, 3),
            "text": "".join(w.word for w in ln).strip(),
        }
        for ln in lines
    ]


def _cues_from(segments, word_timestamps):
    cues = []
    for seg in segments:
        cue = {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()}
        if word_timestamps and seg.words:
            cue["words"] = [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word}
                for w in seg.words
            ]
        cues.append(cue)
    return cues


def _transcribe_with(model, audio_path, language, word_timestamps, allow_split=True):
    segments, info = model.transcribe(
        audio_path, language=language, word_timestamps=word_timestamps,
    )
    cues = _cues_from(segments, word_timestamps)

    if allow_split and needs_split(cues) and info.language in SENTENCE_PROMPTS:
        segments, info = model.transcribe(
            audio_path, language=info.language, word_timestamps=True,
            initial_prompt=SENTENCE_PROMPTS[info.language],
        )
        split = split_by_sentence([w for s in segments for w in (s.words or [])])
        if len(split) > 1:
            cues = split
    return cues, info.language


def transcribe(audio_path, language, word_timestamps):
    model = _load_model()
    return _transcribe_with(model, audio_path, language, word_timestamps)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio")
    ap.add_argument("--audio-list", help="JSON file: a list of audio paths to "
                     "transcribe with a single model load (batch mode)")
    ap.add_argument("--output", required=True)
    ap.add_argument("--language", default=None)
    ap.add_argument("--word-timestamps", action="store_true")
    a = ap.parse_args()

    if a.audio_list:
        try:
            with open(a.audio_list, encoding="utf-8") as f:
                paths = json.load(f)
            model = _load_model()
            results = {}
            for p in paths:
                try:
                    if not os.path.exists(p):
                        raise RuntimeError("audio file not found: %s" % p)
                    # Take scoring compares text only; the extra prompted pass
                    # would just slow the batch down (see module docstring).
                    cues, detected_language = _transcribe_with(
                        model, p, a.language, a.word_timestamps, allow_split=False
                    )
                    results[p] = {"ok": True, "language": detected_language, "segments": cues}
                except Exception as e:
                    results[p] = {"ok": False, "error": str(e)[:300]}
            result = {"ok": True, "results": results}
        except Exception as e:
            result = {"ok": False, "error": str(e)[:500]}
            with open(a.output, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
            print("__WHISPER_TRANSCRIBE_ERROR__ %s" % str(e)[:200], file=sys.stderr)
            sys.exit(1)
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        print("__WHISPER_TRANSCRIBE_DONE__")
        return

    if not a.audio:
        ap.error("one of --audio or --audio-list is required")

    try:
        if not os.path.exists(a.audio):
            raise RuntimeError("audio file not found: %s" % a.audio)
        cues, detected_language = transcribe(a.audio, a.language, a.word_timestamps)
        result = {"ok": True, "language": detected_language, "segments": cues}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:500]}
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        print("__WHISPER_TRANSCRIBE_ERROR__ %s" % str(e)[:200], file=sys.stderr)
        sys.exit(1)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("__WHISPER_TRANSCRIBE_DONE__")


if __name__ == "__main__":
    main()
