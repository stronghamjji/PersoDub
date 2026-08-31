# -*- coding: utf-8 -*-
"""Turn a finished Perso dub into a locally editable job.

Perso serves everything the app's own edit/remake machinery reads: the script
(original + translated + timings + speakers), one audio file per sentence, and
the background bed. This module downloads them ONCE and writes exactly the
files a locally-dubbed job leaves behind -- after that, editing a line,
remaking its voice and rebuilding the video all run through the code paths
that already exist, with no Perso re-billing.

Verified live 2026-08-31 (project 409873): script via /script, per-sentence
audio via each sentence's audioUrl, background via download?target=backgroundAudio.
"""
import json
import os
import shutil
import subprocess

from app.text.srt import build_srt


def _ffmpeg_to_wav(src: str, dest: str) -> None:
    """Any downloaded audio -> PCM wav the assembler can read (48 kHz)."""
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-ar", "48000", dest],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("could not convert %s: %s" % (os.path.basename(src),
                                                         (r.stderr or "").strip()[-120:]))


def materialize(pc, project_seq: int, work_dir: str, language: str,
                to_wav=None, log=None) -> dict:
    """Download a Perso dub's parts and write the local job files.

    Idempotent: audio already on disk is not fetched again, and the script
    files are simply rewritten with the same content. Never touches
    edited.srt -- a user's edits survive a re-run.
    """
    to_wav = to_wav or _ffmpeg_to_wav
    log = log or (lambda m: None)
    os.makedirs(work_dir, exist_ok=True)

    log("Reading the script from Perso…")
    sents = pc.get_project_script(project_seq).get("sentences") or []

    cues_t, cues_o, spans, lines = [], [], [], []
    for n, s in enumerate(sents):
        start = (s.get("offsetMs") or 0) / 1000.0
        end = start + (s.get("durationMs") or 0) / 1000.0
        idx = s.get("speakerOrderIndex")
        spk = "S%s" % (idx if idx is not None else 0)
        cues_t.append({"start": start, "end": end, "text": s.get("translatedText") or ""})
        cues_o.append({"start": start, "end": end, "text": s.get("originalText") or ""})
        spans.append({"start": start, "end": end, "speaker": spk})
        lines.append({"i": n, "start": start, "gain": None, "speaker": spk})

        wav = os.path.join(work_dir, "qwen_line_%d.wav" % n)
        if not os.path.exists(wav) and s.get("audioUrl"):
            log("Fetching line %d of %d…" % (n + 1, len(sents)))
            src = os.path.join(work_dir, "perso_line_%d.src" % n)
            pc.download_media(s["audioUrl"], src)
            to_wav(src, wav)
            try:
                os.remove(src)
            except OSError:
                pass

    bg = os.path.join(work_dir, "background.wav")
    if not os.path.exists(bg):
        log("Fetching the background bed…")
        src = os.path.join(work_dir, "perso_background.src")
        pc.download_target(project_seq, "backgroundAudio", src)
        to_wav(src, bg)
        try:
            os.remove(src)
        except OSError:
            pass

    with open(os.path.join(work_dir, "translated.srt"), "w", encoding="utf-8") as f:
        f.write(build_srt(cues_t))
    with open(os.path.join(work_dir, "original.srt"), "w", encoding="utf-8") as f:
        f.write(build_srt(cues_o))
    with open(os.path.join(work_dir, "speakers.json"), "w", encoding="utf-8") as f:
        json.dump(spans, f, ensure_ascii=False)
    with open(os.path.join(work_dir, "lines.json"), "w", encoding="utf-8") as f:
        json.dump({"language": language, "lines": lines}, f, ensure_ascii=False)

    # One reference per speaker, for cloning that voice again on a remake:
    # the speaker's LONGEST line is its clearest sample.
    refs = {}
    best = {}
    for n, s in enumerate(sents):
        idx = s.get("speakerOrderIndex")
        spk = "S%s" % (idx if idx is not None else 0)
        if spk not in best or (s.get("durationMs") or 0) > (sents[best[spk]].get("durationMs") or 0):
            best[spk] = n
    for spk, n in best.items():
        ref = os.path.join(work_dir, "qwen_ref_%s.wav" % spk)
        line_wav = os.path.join(work_dir, "qwen_line_%d.wav" % n)
        if not os.path.exists(ref) and os.path.exists(line_wav):
            shutil.copyfile(line_wav, ref)
        refs[spk] = {"ref_text": sents[n].get("translatedText") or ""}
    with open(os.path.join(work_dir, "speaker_refs.json"), "w", encoding="utf-8") as f:
        json.dump(refs, f, ensure_ascii=False)

    log("This dub is editable now.")
    return {"lines": len(lines), "speakers": len(best)}
