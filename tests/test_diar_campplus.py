"""CAM++ local diarization tests.

Pure label logic and the subprocess-bridge contract (mocked subprocess, no
real interpreter/model needed) run everywhere. The real-audio integration
tests skip automatically when DIAR_PYTHON isn't a real heavy-dep interpreter,
the ONNX model, or the work-dir audio are missing (the CI venv has none of
these -- diarization now runs as a subprocess under app/scripts/
campplus_diarize.py, see app/diar_campplus_client.py).
"""
import json
import os
from collections import Counter

import pytest

from app import diar_campplus_client as dcc
from app.diar_campplus_client import relabel_by_size


def test_relabel_largest_cluster_is_spk0():
    # cluster 1 appears 3x (largest) -> SPK0; cluster 0 appears 2x -> SPK1
    labels = [0, 1, 1, 0, 1]
    assert relabel_by_size(labels) == ["SPK1", "SPK0", "SPK0", "SPK1", "SPK0"]


def test_relabel_three_speakers_ordered_by_size():
    # sizes: cluster 2 -> 4, cluster 0 -> 2, cluster 1 -> 1
    labels = [2, 2, 0, 2, 0, 2, 1]
    assert relabel_by_size(labels) == ["SPK0", "SPK0", "SPK1", "SPK0", "SPK1", "SPK0", "SPK2"]


def test_relabel_single_cluster():
    assert relabel_by_size([0, 0, 0]) == ["SPK0", "SPK0", "SPK0"]


def test_relabel_ties_broken_by_first_appearance():
    # both clusters size 1; cluster 5 appears first -> SPK0, cluster 3 -> SPK1
    assert relabel_by_size([5, 3]) == ["SPK0", "SPK1"]


MODEL = os.environ.get("PERSODUB_CAMPPLUS_MODEL", "models/campplus/campplus.onnx")
# Real-audio integration fixtures aren't shipped in the repo -- point these at a
# local dev copy via env vars. Tests below skip cleanly when they're unset/missing.
WORK_AUDIO = os.environ.get("PERSODUB_DIAR_WORK_AUDIO", "")
WORK_LINES = os.environ.get("PERSODUB_DIAR_WORK_LINES", "")


def _require_runtime():
    """Skip unless DIAR_PYTHON points at a real interpreter and the ONNX model
    is present. Diarization now runs as a subprocess (app/scripts/
    campplus_diarize.py) under DIAR_PYTHON, so there's nothing to import
    in-process any more -- just confirm the worker chain diarize() will exec
    is actually wired up (matches the os.path.exists/os.access check
    diarize() itself uses)."""
    if not (os.path.exists(dcc.DIAR_PYTHON) and os.access(dcc.DIAR_PYTHON, os.X_OK)):
        pytest.skip("DIAR_PYTHON not set to a real interpreter (%s)" % dcc.DIAR_PYTHON)
    if not os.path.exists(MODEL):
        pytest.skip("campplus.onnx not found at %s" % MODEL)


def test_diarize_adds_speaker_key_and_preserves_cues():
    _require_runtime()
    if not os.path.exists(WORK_AUDIO):
        pytest.skip("work audio not found: %s" % WORK_AUDIO)
    from app.diar_campplus_client import diarize
    cues = [
        {"start": 0.071, "end": 2.04, "text": "a"},
        {"start": 3.9, "end": 6.636, "text": "b"},
    ]
    out = diarize(WORK_AUDIO, cues, num_speakers=1)
    assert len(out) == 2
    assert all("speaker" in c for c in out)
    assert all(str(c["speaker"]).startswith("SPK") for c in out)
    # original cue fields survive
    assert out[0]["text"] == "a" and out[0]["start"] == 0.071
    # input cues are not mutated in place
    assert "speaker" not in cues[0]


def test_diarize_separates_two_speakers_on_joker_clip():
    """Real-audio integration: 44 Joker/Batman cues must split into 2 speakers
    with the minority (Batman, 7 lines) roughly recovered."""
    _require_runtime()
    if not (os.path.exists(WORK_AUDIO) and os.path.exists(WORK_LINES)):
        pytest.skip("work audio/lines not found")
    from app.diar_campplus_client import diarize
    with open(WORK_LINES, encoding="utf-8") as f:
        lines = json.load(f)
    cues = [{"start": o["start"], "end": o["end"], "text": o["text"]} for o in lines]
    out = diarize(WORK_AUDIO, cues, num_speakers=2)

    labels = [c["speaker"] for c in out]
    assert len(set(labels)) == 2, "must find exactly 2 speakers"

    # Batman is the minority (7 GT lines) -> the smaller cluster.
    counts = Counter(labels)
    minority_label = min(counts, key=lambda k: counts[k])
    batman_gt = {4, 9, 16, 32, 35, 38, 41}
    pred_minority = {lines[i]["idx"] for i, lbl in enumerate(labels)
                     if lbl == minority_label}
    # Accuracy: minority->BATMAN, majority->JOKER mapping, expect >= 40/44.
    correct = sum(
        1 for i, lbl in enumerate(labels)
        if (lines[i]["gt"] == "BATMAN") == (lbl == minority_label)
    )
    assert correct >= 40, "accuracy %d/44 below CAM++ benchmark" % correct
    # The recovered minority overlaps most of the true Batman set. The verified
    # gold-standard benchmark on this 16k clip (93_diarization/scripts/diar_campplus.py)
    # scores 42/44 and recovers Batman lines {4,32,35,38,41} -- lines 9 and 16 are its
    # two misses -- so exactly 5 of the 7 GT Batman lines land in the minority cluster.
    assert len(pred_minority & batman_gt) >= 5


# --- diarize() subprocess bridge (mocked subprocess -- no real interpreter,
# no model, no audio needed) ------------------------------------------------

def _write_worker_output(out_path, payload):
    """diarize() uses a fresh tempfile.TemporaryDirectory() per call, so tests
    can't know the path ahead of time -- write to whatever --output path the
    (mocked) subprocess.run call actually receives."""
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


CUES = [
    {"start": 0.0, "end": 1.0, "text": "a"},
    {"start": 1.0, "end": 2.0, "text": "b"},
    {"start": 2.0, "end": 3.0, "text": "c"},
]


def test_diarize_returns_empty_list_without_subprocess_when_no_cues(monkeypatch):
    called = []
    monkeypatch.setattr(dcc.subprocess, "run", lambda *a, **k: called.append(1))
    assert dcc.diarize("/fake/vocals.wav", []) == []
    assert called == []


def test_diarize_raises_when_interpreter_missing(monkeypatch):
    monkeypatch.setattr(dcc, "DIAR_PYTHON", "/no/such/python")
    with pytest.raises(RuntimeError, match="interpreter not found"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_when_script_missing(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", "/no/such/script.py")
    with pytest.raises(RuntimeError, match="script missing"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_on_nonzero_exit(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)  # any existing file is fine

    class _R:
        returncode = 1
        stderr = "boom"

    monkeypatch.setattr(dcc.subprocess, "run", lambda *a, **k: _R())
    with pytest.raises(RuntimeError, match="exited with an error"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_on_subprocess_exception(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)

    def boom(*a, **k):
        raise TimeoutError("timed out")

    monkeypatch.setattr(dcc.subprocess, "run", boom)
    with pytest.raises(RuntimeError, match="failed to run"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_when_worker_reports_failure(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout):
        _write_worker_output(cmd[cmd.index("--output") + 1], {"ok": False, "error": "campplus.onnx not found"})
        return _R()

    monkeypatch.setattr(dcc.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="reported an error"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_on_invalid_json_output(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout):
        with open(cmd[cmd.index("--output") + 1], "w") as f:
            f.write("{not json")
        return _R()

    monkeypatch.setattr(dcc.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="invalid output"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_raises_on_mismatched_speaker_count(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout):
        # worker reports ok, but only 2 labels for 3 cues
        _write_worker_output(cmd[cmd.index("--output") + 1], {"ok": True, "speakers": ["SPK0", "SPK1"]})
        return _R()

    monkeypatch.setattr(dcc.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="mismatched speaker labels"):
        dcc.diarize("/fake/vocals.wav", CUES)


def test_diarize_returns_cues_with_speaker_labels_on_success(monkeypatch):
    import sys
    monkeypatch.setattr(dcc, "DIAR_PYTHON", sys.executable)
    monkeypatch.setattr(dcc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    captured_input = {}
    captured_cmd = {}

    def fake_run(cmd, capture_output, text, timeout):
        captured_cmd["argv0"] = cmd[0]
        with open(cmd[cmd.index("--input") + 1], encoding="utf-8") as f:
            captured_input.update(json.load(f))
        _write_worker_output(cmd[cmd.index("--output") + 1], {"ok": True, "speakers": ["SPK0", "SPK1", "SPK0"]})
        return _R()

    monkeypatch.setattr(dcc.subprocess, "run", fake_run)
    out = dcc.diarize("/fake/vocals.wav", CUES, num_speakers=2)

    # label shape: same length, right labels, original fields preserved, no mutation
    assert [c["speaker"] for c in out] == ["SPK0", "SPK1", "SPK0"]
    assert [c["text"] for c in out] == ["a", "b", "c"]
    assert "speaker" not in CUES[0]

    # env override: the (possibly monkeypatched) DIAR_PYTHON is what actually got exec'd
    assert captured_cmd["argv0"] == sys.executable
    # the worker only needs start/end + the vocals path + num_speakers + model path
    assert captured_input["vocals_wav_path"] == "/fake/vocals.wav"
    assert captured_input["cues"] == [{"start": 0.0, "end": 1.0}, {"start": 1.0, "end": 2.0}, {"start": 2.0, "end": 3.0}]
    assert captured_input["num_speakers"] == 2
    assert captured_input["campplus_model"] == dcc.CAMPPLUS_MODEL


def test_campplus_model_path_is_cwd_independent(monkeypatch, tmp_path):
    """A bare relative default breaks the moment the app runs from elsewhere.

    app/scripts/qwen_score_takes.py already learned this the hard way -- its
    resolve_campplus_model docstring records the 2026-07-30 regression where the
    scorer was launched from a different working directory, the relative path did
    not exist there, and best-of-N selection silently fell back to take 0 for the
    whole job. This module carried the same bare default. Note the repo has no
    models/ directory of its own, so the relative form only ever resolved when
    the process happened to run from the parent directory.
    """
    import importlib

    from app import diar_campplus_client as dcc

    monkeypatch.delenv("PERSODUB_CAMPPLUS_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)          # a directory with no models/ under it
    importlib.reload(dcc)
    try:
        assert os.path.isabs(dcc.CAMPPLUS_MODEL), (
            "resolved to a bare relative path (%r) -- unusable from another cwd"
            % dcc.CAMPPLUS_MODEL
        )
    finally:
        monkeypatch.undo()
        importlib.reload(dcc)


def test_campplus_model_path_still_honours_the_env_override(monkeypatch):
    import importlib

    from app import diar_campplus_client as dcc

    monkeypatch.setenv("PERSODUB_CAMPPLUS_MODEL", "/models/custom.onnx")
    importlib.reload(dcc)
    try:
        assert dcc.CAMPPLUS_MODEL == "/models/custom.onnx"
    finally:
        monkeypatch.undo()
        importlib.reload(dcc)


# --- Mac CPUs run slower than the server's: the diarization subprocess
# timeout is env-overridable (PERSODUB_DIAR_TIMEOUT) so a Mac install isn't
# stuck with a server-tuned budget ---

def test_diar_timeout_honours_env_override(monkeypatch):
    import importlib

    from app import diar_campplus_client as dcc

    monkeypatch.setenv("PERSODUB_DIAR_TIMEOUT", "42")
    importlib.reload(dcc)
    try:
        assert dcc.PERSODUB_DIAR_TIMEOUT == 42.0
    finally:
        monkeypatch.undo()
        importlib.reload(dcc)


def test_diar_timeout_garbage_env_falls_back_to_default(monkeypatch):
    import importlib

    from app import diar_campplus_client as dcc

    monkeypatch.setenv("PERSODUB_DIAR_TIMEOUT", "banana")
    importlib.reload(dcc)
    try:
        assert dcc.PERSODUB_DIAR_TIMEOUT == 600.0
    finally:
        monkeypatch.undo()
        importlib.reload(dcc)
