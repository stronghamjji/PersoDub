# -*- coding: utf-8 -*-
"""Speaker-identity quality gate: catch "this line was synthesized in the
WRONG speaker's voice" (e.g. speaker A's line rendered with speaker B's clone --
the defect class that shipped undetected in the 2026-07-30 borrow_time merge
until a human ear caught it).

For every synthesized line wav (qwen_line_N.wav) in a job workdir, a CAM++
speaker embedding is computed and cosine-compared against EVERY per-speaker
reference clip (qwen_ref_<Speaker>.wav):

  PASS  the line's assigned speaker is the best-matching reference, or is
        within --margin of the best (clone voices drift; see calibration).
  FAIL  a DIFFERENT speaker's reference beats the assigned one by more than
        --margin, and the line is long enough to trust the embedding.
  WARN  the same mismatch, but the line is shorter than --min-dur seconds.
        Very short clips (<~0.6s) embed poorly, so instead of padding or
        widening from the placed mix (which would blend in background audio
        and other speakers), sub-floor mismatches are downgraded to WARN --
        they are reported but do not gate. Documented policy choice.

Line->speaker assignment comes from the job's own record, in order of trust:
  1. qwen_scorer_input.json  ("lines": [{"i": N, "spk": "Name", ...}]) --
     written by the actual synthesis run, so it IS the assignment used.
  2. translated.srt + source_cues.json, recomputed with the same
     app.qwen_pipeline.map_segments_to_speakers call the pipeline uses.

Embeddings are computed by app/scripts/campplus_embed_files.py in ONE
subprocess under DIAR_PYTHON (app/config.py) with the model from
PERSODUB_CAMPPLUS_MODEL -- the exact conventions of
app/diar_campplus_client.py. No absolute paths are hardcoded here.

CLI:
  python -m app.scripts.check_speaker_identity <job_workdir>
      [--margin 0.05] [--min-dur 0.6] [--json report.json]
Exit codes: 0 = all PASS (WARNs allowed), 1 = any FAIL, 2 = setup/input error.

Threshold calibration (2026-07-30, v1 rebuild jobs work_gemma_v1 +
work_vertex_v1: 35 lines, two-speaker Qwen3-TTS timbre clones vs the
reference clips, CAM++ campplus.onnx):
  same-speaker pairs (line vs its assigned ref): mean 0.406  min 0.203  max 0.589
  cross-speaker pairs (line vs the other ref):   mean 0.227  min 0.109  max 0.383
  per-line gap (sim_assigned - sim_other):       mean 0.180  min -0.026 max 0.344
The two similarity distributions OVERLAP in absolute terms (same-gender male
clones), so the rule is margin-based per line, not an absolute floor. One
correctly-assigned line (work_vertex_v1 line 9) scored 0.026 BELOW the other
speaker, so any margin < 0.026 would false-FAIL a good job. Margin sweep on
these 35 lines + their 35 deliberately-swapped counterparts:
  margin 0.03 -> 0 false FAILs, 33/35 (94%) swaps caught (headroom 0.004)
  margin 0.05 -> 0 false FAILs, 31/35 (89%) swaps caught (headroom 0.024)
  margin 0.10 -> 0 false FAILs, 26/35 (74%) swaps caught
DEFAULT_MARGIN=0.05: zero false alarms with ~2x headroom over the worst
correct line, while still failing 89% of individual swapped lines -- and a
whole-job voice swap trips on many lines at once, so job-level detection is
effectively certain. Honest limitation: a SINGLE swapped line has a ~1-in-9
chance of slipping through when the two voices are this close; re-calibrate
if a closer voice pair (or different TTS) shows a smaller gap.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile

from app.config import DIAR_PYTHON

# Same env override + default as app/diar_campplus_client.py.
CAMPPLUS_MODEL = os.environ.get(
    "PERSODUB_CAMPPLUS_MODEL", "models/campplus/campplus.onnx"
)

EMBED_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "campplus_embed_files.py")

DEFAULT_MARGIN = 0.05   # see calibration note in the module docstring
DEFAULT_MIN_DUR = 0.6   # seconds; below this a mismatch is WARN, not FAIL

LINE_RE = re.compile(r"^qwen_line_(\d+)\.wav$")
REF_RE = re.compile(r"^qwen_ref_(.+)\.wav$")


# --------------------------------------------------------------------------
# pure logic (unit-testable without ONNX / subprocess)
# --------------------------------------------------------------------------

def cosine(a, b):
    """Cosine similarity of two vectors (plain python, no numpy)."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / ((na * nb) or 1e-9)


def score_lines(line_embs, ref_embs):
    """sims[i][speaker] = cosine(line i, that speaker's reference).

    line_embs : list of vectors, ref_embs : {speaker: vector}.
    """
    return [{spk: cosine(e, r) for spk, r in ref_embs.items()}
            for e in line_embs]


def evaluate(assignments, sims, durations,
             margin=DEFAULT_MARGIN, min_dur=DEFAULT_MIN_DUR):
    """Judge each line. Pure.

    assignments : [(line_idx, assigned_speaker), ...]
    sims        : per line {speaker: similarity} (same order)
    durations   : per line seconds (same order)

    Returns a list of dicts: {"idx", "assigned", "assigned_sim", "best",
    "best_sim", "duration", "status", "sims"}. Raises KeyError-free ValueError
    if a line's assigned speaker has no reference in sims.
    """
    results = []
    for (idx, spk), s, dur in zip(assignments, sims, durations):
        if spk not in s:
            raise ValueError(
                "line %s is assigned to %r but no qwen_ref_%s.wav reference "
                "was found" % (idx, spk, spk))
        best = max(s, key=lambda k: s[k])
        mismatch = (best != spk) and (s[best] - s[spk] > margin)
        if not mismatch:
            status = "PASS"
        elif dur < min_dur:
            status = "WARN"  # too short to trust the embedding; report only
        else:
            status = "FAIL"
        results.append({
            "idx": idx, "assigned": spk, "assigned_sim": s[spk],
            "best": best, "best_sim": s[best], "duration": dur,
            "status": status, "sims": dict(s),
        })
    return results


def format_table(results):
    """Fixed-width per-line report table (one string)."""
    speakers = sorted(results[0]["sims"]) if results else []
    head = "line  status  dur(s)  assigned      best-match    " + \
        "  ".join("sim[%s]" % s for s in speakers)
    rows = [head, "-" * len(head)]
    for r in results:
        rows.append(
            "%4d  %-6s  %6.2f  %-12s  %-12s  %s" % (
                r["idx"], r["status"], r["duration"],
                r["assigned"], r["best"],
                "  ".join("%8.3f" % r["sims"][s] for s in speakers)))
    return "\n".join(rows)


# --------------------------------------------------------------------------
# job-workdir loading
# --------------------------------------------------------------------------

def load_refs(workdir):
    """{speaker: abs wav path} from qwen_ref_<Speaker>.wav files."""
    refs = {}
    for name in sorted(os.listdir(workdir)):
        m = REF_RE.match(name)
        if m:
            refs[m.group(1)] = os.path.join(workdir, name)
    return refs


def load_assignments(workdir):
    """[(line_idx, speaker), ...] for every qwen_line_N.wav present, sorted.

    Prefers the synthesis run's own record (qwen_scorer_input.json); falls
    back to recomputing from translated.srt + source_cues.json with the same
    mapping function the pipeline uses. Raises ValueError when neither source
    can name a line's speaker.
    """
    present = {}
    for name in os.listdir(workdir):
        m = LINE_RE.match(name)
        if m:
            present[int(m.group(1))] = os.path.join(workdir, name)
    if not present:
        raise ValueError("no qwen_line_N.wav files in %s" % workdir)

    spk_by_idx = {}
    scorer_in = os.path.join(workdir, "qwen_scorer_input.json")
    if os.path.exists(scorer_in):
        with open(scorer_in, encoding="utf-8") as f:
            data = json.load(f)
        for ln in data.get("lines") or []:
            if "i" in ln and ln.get("spk"):
                spk_by_idx[int(ln["i"])] = ln["spk"]

    missing = [i for i in present if i not in spk_by_idx]
    if missing:
        srt_path = os.path.join(workdir, "translated.srt")
        cues_path = os.path.join(workdir, "source_cues.json")
        if os.path.exists(srt_path) and os.path.exists(cues_path):
            from app.qwen_pipeline import map_segments_to_speakers
            from app.text.srt import parse_srt
            with open(srt_path, encoding="utf-8-sig") as f:
                segments = parse_srt(f.read())
            with open(cues_path, encoding="utf-8") as f:
                cues = json.load(f)
            speakers = sorted({c.get("speaker_id") or c.get("speaker")
                               for c in cues if c.get("speaker_id") or c.get("speaker")})
            mapped = map_segments_to_speakers(segments, cues, speakers)
            for i, spk in enumerate(mapped):
                spk_by_idx.setdefault(i, spk)
        still = [i for i in present if i not in spk_by_idx]
        if still:
            raise ValueError(
                "no speaker assignment found for line(s) %s (need "
                "qwen_scorer_input.json or translated.srt+source_cues.json)"
                % still)

    return [(i, spk_by_idx[i]) for i in sorted(present)], \
        [present[i] for i in sorted(present)]


# --------------------------------------------------------------------------
# embedding bridge (one subprocess, DIAR_PYTHON -- as diar_campplus_client)
# --------------------------------------------------------------------------

def embed_files(wav_paths, timeout=600):
    """Embed a batch of wav files in ONE DIAR_PYTHON subprocess call.

    Returns (embeddings, durations) in input order.
    Raises RuntimeError on any bridge failure (missing/broken interpreter,
    crash, bad JSON, worker-reported error) -- same contract as
    app.diar_campplus_client.diarize.
    """
    py = DIAR_PYTHON
    if not (os.path.exists(py) and os.access(py, os.X_OK)):
        raise RuntimeError(
            "speaker-identity check needs the heavy interpreter: set "
            "DIAR_PYTHON to a python with onnxruntime/torch/torchaudio "
            "(current: %s)" % py)
    if not os.path.exists(EMBED_SCRIPT):
        raise RuntimeError("embedding worker script missing (%s)" % EMBED_SCRIPT)

    with tempfile.TemporaryDirectory(prefix="persodub_spkid_") as work:
        in_path = os.path.join(work, "embed_input.json")
        out_path = os.path.join(work, "embed_output.json")
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump({"wav_paths": list(wav_paths),
                       "campplus_model": CAMPPLUS_MODEL}, f)
        try:
            r = subprocess.run(
                [py, EMBED_SCRIPT, "--input", in_path, "--output", out_path],
                capture_output=True, text=True, timeout=timeout)
        except Exception as e:
            raise RuntimeError("embedding worker failed to run (%s)" % str(e)[:120])
        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError("embedding worker exited with an error (%s)"
                               % (r.stderr.strip()[-200:] or "no output produced"))
        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("embedding worker produced invalid output (%s)"
                               % str(e)[:120])
    if not result.get("ok"):
        raise RuntimeError("embedding worker reported an error (%s)"
                           % str(result.get("error"))[:200])
    embs, durs = result.get("embeddings"), result.get("durations")
    if not embs or len(embs) != len(wav_paths) or len(durs) != len(wav_paths):
        raise RuntimeError("embedding worker returned mismatched results")
    return embs, durs


# --------------------------------------------------------------------------
# gate runner
# --------------------------------------------------------------------------

def run_gate(workdir, margin=DEFAULT_MARGIN, min_dur=DEFAULT_MIN_DUR,
             embedder=None):
    """Full check for one job workdir. Returns (results, refs).

    `embedder` is injectable for tests (same signature as embed_files);
    None means the module-level embed_files (resolved at call time so tests
    can monkeypatch it).
    Raises ValueError/RuntimeError on setup problems (missing refs, broken
    bridge); those are setup errors, not line verdicts.
    """
    if embedder is None:
        embedder = embed_files
    refs = load_refs(workdir)
    if not refs:
        raise ValueError("no qwen_ref_<Speaker>.wav references in %s" % workdir)
    assignments, line_paths = load_assignments(workdir)
    for _, spk in assignments:
        if spk not in refs:
            raise ValueError(
                "assigned speaker %r has no reference clip "
                "(qwen_ref_%s.wav) in %s" % (spk, spk, workdir))

    ref_names = sorted(refs)
    all_paths = line_paths + [refs[s] for s in ref_names]
    embs, durs = embedder(all_paths)
    line_embs, line_durs = embs[:len(line_paths)], durs[:len(line_paths)]
    ref_embs = {s: e for s, e in zip(ref_names, embs[len(line_paths):])}

    sims = score_lines(line_embs, ref_embs)
    return evaluate(assignments, sims, line_durs, margin, min_dur), refs


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="python -m app.scripts.check_speaker_identity",
        description="Speaker-identity gate: verify each synthesized line "
                    "actually sounds like its assigned speaker.")
    ap.add_argument("workdir", help="job workdir with qwen_line_N.wav, "
                    "qwen_ref_<Speaker>.wav (+ assignment json/srt)")
    ap.add_argument("--margin", type=float, default=DEFAULT_MARGIN,
                    help="another speaker must beat the assigned one by more "
                         "than this to FAIL (default %(default)s)")
    ap.add_argument("--min-dur", type=float, default=DEFAULT_MIN_DUR,
                    help="lines shorter than this (s) WARN instead of FAIL "
                         "(default %(default)s)")
    ap.add_argument("--json", dest="json_out", default=None,
                    help="also write the full per-line report to this path")
    a = ap.parse_args(argv)

    if not os.path.isdir(a.workdir):
        print("ERROR: workdir not found: %s" % a.workdir, file=sys.stderr)
        return 2
    try:
        results, _ = run_gate(a.workdir, margin=a.margin, min_dur=a.min_dur)
    except (ValueError, RuntimeError) as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 2

    print(format_table(results))
    n_fail = sum(1 for r in results if r["status"] == "FAIL")
    n_warn = sum(1 for r in results if r["status"] == "WARN")
    print("\nspeaker-identity: %d line(s), %d FAIL, %d WARN (margin=%.3f, "
          "min-dur=%.2fs)" % (len(results), n_fail, n_warn, a.margin, a.min_dur))

    if a.json_out:
        with open(a.json_out, "w", encoding="utf-8") as f:
            json.dump({"workdir": os.path.abspath(a.workdir),
                       "margin": a.margin, "min_dur": a.min_dur,
                       "results": results}, f, ensure_ascii=False, indent=1)
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
