"""Best-of-N take selection for the Qwen dub path -- a fixed-priority coherence
rule over per-take scores (ASR intelligibility, target-speaker similarity
margin, duration fit).

Pure logic on plain dicts: no numpy/torch/onnxruntime, so this module can be
imported and unit-tested straight from the app's Python 3.8 venv (the scoring
subprocess -- app/scripts/qwen_score_takes.py + app/qwen_scoring.py -- is what
actually needs the heavy embedding/ASR deps; it hands back plain float lists).

Rule (fixed priority):
  0) eligibility per line: asr >= ASR_MIN AND (sim - sim_other) > MARGIN_MIN
     AND dur <= usable + DUR_TOL. Falls back to the single best-margin take
     when nothing clears all three (keeps a pick even on a fully-missed line).
  1) baseline pick per line: asr floor (fallback: all candidates) -> maximize
     sim - LAMBDA * max(0, dur - usable). This seeds the coherence rounds.
  2) coherence rounds (COHERENCE_ROUNDS, default 3): per speaker, take the
     mean embedding (centroid) of that speaker's current picks, then re-pick
     each line from its eligible pool maximizing
     COS_WEIGHT * cos(take_emb, centroid) + SIM_WEIGHT * sim.
     Fit-first amendment: within a line's eligible pool, if any candidate's
     dur <= usable (fits its slot exactly, not just within DUR_TOL), the
     re-pick is restricted to those -- countering a measured slot-fit
     regression (95.5% -> 90.9%) that coherence-only re-picking caused.
"""
import math
from typing import Dict, List

ASR_MIN = 0.70
MARGIN_MIN = 0.02
DUR_TOL = 0.15
LAMBDA = 0.5
COHERENCE_ROUNDS = 3
COS_WEIGHT = 0.7
SIM_WEIGHT = 0.3
# Duration-fit final pass (2026-07-30 v3): takes whose coherence score is within
# this band of the line's best are considered quality-equal; among them the one
# whose duration is closest to the line's usable window wins. Measured problem:
# calibrated translations often land SHORT of their slot (v2: up to 7 dead-air
# holes/60s), and take durations vary enough between seeds to claw some back.
FIT_QUALITY_BAND = 0.03


def cosine(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two plain float vectors (pure Python, no numpy)."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb + 1e-9)


def eligible_takes(cands: List[dict]) -> List[dict]:
    """Coherence candidate pool for one line (see module docstring, rule 0)."""
    ok = [
        c for c in cands
        if c["asr"] >= ASR_MIN
        and (c["sim"] - c["sim_other"]) > MARGIN_MIN
        and c["dur"] <= c["usable"] + DUR_TOL
    ]
    if ok:
        return ok
    return [max(cands, key=lambda c: c["sim"] - c["sim_other"])]


def baseline_pick(cands: List[dict]) -> dict:
    """Per-line baseline pick (see module docstring, rule 1)."""
    ok = [c for c in cands if c["asr"] >= ASR_MIN] or cands
    return max(ok, key=lambda c: c["sim"] - LAMBDA * max(0.0, c["dur"] - c["usable"]))


def _fit_first(pool: List[dict]) -> List[dict]:
    """Fit-first amendment: restrict to takes with dur<=usable when any exist."""
    fits = [c for c in pool if c["dur"] <= c["usable"]]
    return fits or pool


def pick_coherence(lines: Dict[int, List[dict]], rounds: int = COHERENCE_ROUNDS) -> Dict[int, dict]:
    """Full selection: baseline seed + coherence re-pick rounds (rule 2).

    `lines` maps a line index to its list of candidate take dicts. Each
    candidate must carry: asr, sim, sim_other, dur, usable, spk, emb
    (emb = list[float], the take's own speaker embedding).
    Returns {line_index: winning_candidate_dict}.
    """
    if not lines:
        return {}

    picks: Dict[int, dict] = {}
    spk_of: Dict[int, str] = {}
    for i, cs in lines.items():
        p = baseline_pick(cs)
        picks[i] = p
        spk_of[i] = p["spk"]

    by_spk: Dict[str, List[int]] = {}
    for i, spk in spk_of.items():
        by_spk.setdefault(spk, []).append(i)

    # Eligibility pools don't depend on the current picks, so compute once.
    pools = {i: _fit_first(eligible_takes(cs)) for i, cs in lines.items()}

    for _ in range(rounds):
        centroids: Dict[str, List[float]] = {}
        for spk, idxs in by_spk.items():
            embs = [picks[i]["emb"] for i in idxs]
            dim = len(embs[0])
            centroids[spk] = [sum(e[d] for e in embs) / len(embs) for d in range(dim)]
        new_picks: Dict[int, dict] = {}
        for i, pool in pools.items():
            centroid = centroids[spk_of[i]]
            new_picks[i] = max(
                pool,
                key=lambda c: COS_WEIGHT * cosine(c["emb"], centroid) + SIM_WEIGHT * c["sim"],
            )
        picks = new_picks

    # Duration-fit final pass (see FIT_QUALITY_BAND): within each line's pool,
    # takes scoring within the band of the best are quality-equal -- among them
    # pick the duration closest to the usable window (fills dead-air holes when
    # translations land short; the pool's eligibility/fit-first rules already
    # keep overshooting takes out, so this never re-introduces cuts).
    centroids = {}
    for spk, idxs in by_spk.items():
        embs = [picks[i]["emb"] for i in idxs]
        dim = len(embs[0])
        centroids[spk] = [sum(e[d] for e in embs) / len(embs) for d in range(dim)]
    for i, pool in pools.items():
        centroid = centroids[spk_of[i]]

        def q(c, centroid=centroid):
            return COS_WEIGHT * cosine(c["emb"], centroid) + SIM_WEIGHT * c["sim"]

        best_q = max(q(c) for c in pool)
        band = [c for c in pool if q(c) >= best_q - FIT_QUALITY_BAND]
        picks[i] = min(band, key=lambda c: (abs(c["dur"] - c["usable"]), -q(c)))
    return picks
