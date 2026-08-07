"""Auto speaker-count estimation over-splits single-narrator audio: k=2..4 is
always searched, so a single speaker with several transcript cues gets >=2
phantom speakers. _should_collapse() catches this after the fact: if every
pairwise cosine similarity between cluster centroids is at or above a
threshold, the clusters are really one speaker wearing different hats and
get collapsed back to SPK0 for every cue. _maybe_collapse() wires that into
the AUTO path only -- an explicit num_speakers always bypasses it.

Same stub/injection pattern as tests/test_campplus_input_name.py -- none of
the heavy deps (numpy, onnxruntime, torch, sklearn) live in the app venv
that runs this suite, so a small FakeNp stands in for the two numpy calls
_should_collapse actually needs (linalg.norm, dot).
"""
import importlib.util
import math
import os

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app", "scripts", "campplus_diarize.py",
)
_spec = importlib.util.spec_from_file_location("campplus_diarize", SCRIPT)
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)


class _FakeLinalg:
    @staticmethod
    def norm(v):
        return math.sqrt(sum(x * x for x in v))


class FakeNp:
    linalg = _FakeLinalg

    @staticmethod
    def dot(a, b):
        return sum(x * y for x, y in zip(a, b))


def _unit(angle_deg):
    r = math.radians(angle_deg)
    return [math.cos(r), math.sin(r)]


def _three_vectors_with_pairwise_sims(sim_ab, sim_ac, sim_bc):
    """Three unit vectors a/b/c whose pairwise cosine similarities are
    exactly sim_ab/sim_ac/sim_bc. Three independent pairwise constraints
    don't fit in 2D (fixing a-b and a-c leaves b-c fully determined by the
    other two, not free), so this solves the 3x3 Gram system in 3D: place a
    and b in the xy-plane at the given angle, then solve c's three
    coordinates from its two dot-product constraints plus unit length."""
    a = [1.0, 0.0, 0.0]
    b = [sim_ab, math.sqrt(1 - sim_ab ** 2), 0.0]
    c0 = sim_ac
    c1 = (sim_bc - sim_ab * c0) / b[1]
    c2 = math.sqrt(max(0.0, 1 - c0 ** 2 - c1 ** 2))
    return a, b, [c0, c1, c2]


# --- _should_collapse: pairwise centroid similarity ------------------------

def test_near_identical_centroids_collapse():
    a = [1.0, 0.0]
    b = [0.99, math.sqrt(1 - 0.99 ** 2)]  # cosine similarity ~0.99
    embs = [a, b]
    labels = ["SPK0", "SPK1"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.65) is True


def test_clearly_separated_centroids_no_collapse():
    a = [1.0, 0.0]
    b = [0.2, math.sqrt(1 - 0.2 ** 2)]  # cosine similarity exactly 0.2
    embs = [a, b]
    labels = ["SPK0", "SPK1"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.65) is False


def test_three_clusters_all_pairwise_above_threshold_collapse():
    # pairwise cosines: cos15=0.966, cos15=0.966, cos30=0.866 -- all >= 0.65
    embs = [_unit(0), _unit(15), _unit(30)]
    labels = ["SPK0", "SPK1", "SPK2"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.65) is True


def test_three_clusters_one_pair_below_threshold_no_collapse():
    # cos(0,15)=0.966 and cos(15,55)=0.766 clear the bar; cos(0,55)=0.574 does not.
    embs = [_unit(0), _unit(15), _unit(55)]
    labels = ["SPK0", "SPK1", "SPK2"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.65) is False


def test_centroid_is_the_mean_not_a_single_embedding():
    # cluster A: two embeddings symmetric around angle 0 (+/-80 deg) average
    # to angle 0 exactly; cluster B sits right at angle 0. A buggy
    # "centroid = first embedding" implementation would see 80 degrees apart
    # (cos ~= 0.17) and refuse to collapse; the correct mean-based centroid
    # sees a perfect match.
    embs = [_unit(80), _unit(-80), _unit(0)]
    labels = ["SPK0", "SPK0", "SPK1"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.99) is True


def test_single_label_is_trivially_collapsed():
    embs = [[1.0, 0.0], [0.0, 1.0]]  # unrelated directions, doesn't matter
    labels = ["SPK0", "SPK0"]
    assert cd._should_collapse(embs, labels, FakeNp, 0.99) is True


# --- _maybe_collapse: AUTO-path wiring, explicit override wins -------------

def test_auto_path_collapses_when_num_speakers_not_given():
    a = [1.0, 0.0]
    b = [0.999, math.sqrt(1 - 0.999 ** 2)]  # near-identical
    embs, labels = [a, b], ["SPK0", "SPK1"]
    out = cd._maybe_collapse(embs, labels, None, 2, FakeNp, 0.65)
    assert out == ["SPK0", "SPK0"]


def test_explicit_num_speakers_bypasses_collapse():
    a = [1.0, 0.0]
    b = [0.999, math.sqrt(1 - 0.999 ** 2)]  # same near-identical centroids
    embs, labels = [a, b], ["SPK0", "SPK1"]
    out = cd._maybe_collapse(embs, labels, 2, 2, FakeNp, 0.65)
    assert out == ["SPK0", "SPK1"]


def test_auto_path_with_k_below_2_is_left_alone():
    embs, labels = [[1.0, 0.0], [0.0, 1.0]], ["SPK0", "SPK0"]
    out = cd._maybe_collapse(embs, labels, None, 1, FakeNp, 0.0)
    assert out == ["SPK0", "SPK0"]


def test_auto_path_no_collapse_when_centroids_differ():
    a = [1.0, 0.0]
    b = [0.2, math.sqrt(1 - 0.2 ** 2)]
    embs, labels = [a, b], ["SPK0", "SPK1"]
    out = cd._maybe_collapse(embs, labels, None, 2, FakeNp, 0.65)
    assert out == ["SPK0", "SPK1"]


# --- Regression: job 4ec68328 (moon.mp4, real short/noisy Whisper cues) ----
# Real STT cues are much shorter (0.44-2.46s) than the clean 1.5-3s windows
# calibration used, so CAM++ embeddings are noisier: a real single-narrator
# job still split into 3 spurious clusters whose measured pairwise centroid
# similarities (0.6283 / 0.4964 / 0.4918) fell under the original 0.65
# default -- _should_collapse ran (confirmed via the real diarize() call,
# not inferred) and correctly said "no" at that threshold. These two tests
# pin the corrected default against both edges of its safety margin: it
# must still collapse this exact real case, and must still not collapse the
# measured cross-speaker case from the original calibration.

def test_real_moon_job_spurious_clusters_collapse_under_default():
    # The 3 spurious clusters' measured pairwise centroid sims (SPK0-SPK1
    # 0.6283, SPK0-SPK2 0.4964, SPK1-SPK2 0.4918), reproduced exactly via
    # _three_vectors_with_pairwise_sims rather than the real 192-dim
    # embeddings.
    a, b, c = _three_vectors_with_pairwise_sims(0.6283, 0.4964, 0.4918)
    embs = [a, b, c]
    labels = ["SPK0", "SPK1", "SPK2"]
    assert cd._should_collapse(embs, labels, FakeNp, cd.DIAR_MERGE_SIM_DEFAULT) is True


def test_default_threshold_does_not_collapse_measured_cross_speaker():
    a = [1.0, 0.0]
    b = [0.2154, (1 - 0.2154 ** 2) ** 0.5]  # measured cross-speaker centroid sim
    embs = [a, b]
    labels = ["SPK0", "SPK1"]
    assert cd._should_collapse(embs, labels, FakeNp, cd.DIAR_MERGE_SIM_DEFAULT) is False


# --- PERSODUB_DIAR_MERGE_SIM env parsing -------------------------------------

def test_merge_sim_env_unset_uses_default(monkeypatch):
    monkeypatch.delenv("PERSODUB_DIAR_MERGE_SIM", raising=False)
    assert cd._parse_diar_merge_sim() == cd.DIAR_MERGE_SIM_DEFAULT


def test_merge_sim_env_valid_float(monkeypatch):
    monkeypatch.setenv("PERSODUB_DIAR_MERGE_SIM", "0.7")
    assert cd._parse_diar_merge_sim() == 0.7


def test_merge_sim_env_garbage_uses_default(monkeypatch):
    monkeypatch.setenv("PERSODUB_DIAR_MERGE_SIM", "banana")
    assert cd._parse_diar_merge_sim() == cd.DIAR_MERGE_SIM_DEFAULT
