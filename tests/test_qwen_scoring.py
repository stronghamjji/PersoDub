"""app/qwen_scoring.py: subprocess bridge to the CAM++/whisper take scorer.

All subprocess.run calls are monkeypatched (no real interpreter, no GPU, no
network) -- this only tests the graceful-degradation contract: any failure
returns None instead of raising.
"""
import json
import os

from app import qwen_scoring as qsc


def _write_output(work_dir, payload):
    with open(os.path.join(work_dir, "qwen_scorer_output.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)


def test_score_takes_returns_none_when_interpreter_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", "/no/such/python")
    logs = []
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path), log=logs.append)
    assert result is None
    assert any("interpreter not found" in m for m in logs)


def test_score_takes_returns_none_when_script_missing(monkeypatch, tmp_path):
    # A real, executable interpreter (any python works) but a nonexistent script path.
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", "/no/such/script.py")
    logs = []
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path), log=logs.append)
    assert result is None
    assert any("script missing" in m for m in logs)


def test_score_takes_returns_none_on_nonzero_exit(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", sys.executable)  # any existing file is fine

    class _R:
        returncode = 1
        stderr = "boom"

    monkeypatch.setattr(qsc.subprocess, "run", lambda *a, **k: _R())
    logs = []
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path), log=logs.append)
    assert result is None
    assert any("exited with an error" in m for m in logs)


def test_score_takes_returns_none_on_subprocess_exception(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", sys.executable)

    def boom(*a, **k):
        raise TimeoutError("timed out")

    monkeypatch.setattr(qsc.subprocess, "run", boom)
    logs = []
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path), log=logs.append)
    assert result is None
    assert any("failed to run" in m for m in logs)


def test_score_takes_returns_none_when_scorer_reports_failure(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout):
        _write_output(str(tmp_path), {"ok": False, "error": "campplus.onnx not found"})
        return _R()

    monkeypatch.setattr(qsc.subprocess, "run", fake_run)
    logs = []
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path), log=logs.append)
    assert result is None
    assert any("reported an error" in m for m in logs)


def test_score_takes_returns_none_on_invalid_json_output(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    def fake_run(cmd, capture_output, text, timeout):
        with open(os.path.join(str(tmp_path), "qwen_scorer_output.json"), "w") as f:
            f.write("{not json")
        return _R()

    monkeypatch.setattr(qsc.subprocess, "run", fake_run)
    result = qsc.score_takes({"A": "/ref/a.wav"}, [], "Korean", str(tmp_path))
    assert result is None


def test_score_takes_parses_successful_output(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(qsc, "QWEN_SCORER_PYTHON", sys.executable)
    monkeypatch.setattr(qsc, "SCRIPT_PATH", sys.executable)

    class _R:
        returncode = 0
        stderr = ""

    captured_input = {}

    def fake_run(cmd, capture_output, text, timeout):
        with open(cmd[cmd.index("--input") + 1], encoding="utf-8") as f:
            captured_input.update(json.load(f))
        _write_output(str(tmp_path), {
            "ok": True,
            "lines": {"0": [{"k": 0, "sim": 0.8, "sim_other": 0.1, "asr": 0.9,
                             "dur": 1.5, "usable": 2.0, "spk": "A", "emb": [1.0, 0.0]}]},
        })
        return _R()

    monkeypatch.setattr(qsc.subprocess, "run", fake_run)
    lines_payload = [{"i": 0, "spk": "A", "usable": 2.0, "text": "hi",
                      "takes": [{"k": 0, "path": "/x/take0.wav"}]}]
    result = qsc.score_takes({"A": "/ref/a.wav"}, lines_payload, "Korean", str(tmp_path))
    assert result == {0: [{"k": 0, "sim": 0.8, "sim_other": 0.1, "asr": 0.9,
                           "dur": 1.5, "usable": 2.0, "spk": "A", "emb": [1.0, 0.0]}]}
    # language is normalized to a short code, and the payload actually reaches the script
    assert captured_input["language"] == "ko"
    assert captured_input["speakers"] == {"A": "/ref/a.wav"}


# --- CAM++ model path resolution (v3: cwd-independent -- the v2 rebuild regression
# was the default relative path silently failing under a different cwd, which
# disabled best-of-N selection for the whole job) ---

from app.scripts.qwen_score_takes import DEFAULT_CAMPPLUS, REPO_ROOT, resolve_campplus_model


def test_resolve_campplus_explicit_payload_path_wins(monkeypatch):
    monkeypatch.setenv("PERSODUB_CAMPPLUS_MODEL", "/env/persodub.onnx")
    assert resolve_campplus_model("/payload/model.onnx") == "/payload/model.onnx"


def test_resolve_campplus_persodub_env_wins_over_legacy_env(monkeypatch):
    monkeypatch.setenv("PERSODUB_CAMPPLUS_MODEL", "/env/persodub.onnx")
    monkeypatch.setenv("QWEN_CAMPPLUS_MODEL", "/env/legacy.onnx")
    assert resolve_campplus_model(None) == "/env/persodub.onnx"


def test_resolve_campplus_legacy_env_still_honored(monkeypatch):
    monkeypatch.delenv("PERSODUB_CAMPPLUS_MODEL", raising=False)
    monkeypatch.setenv("QWEN_CAMPPLUS_MODEL", "/env/legacy.onnx")
    assert resolve_campplus_model(None) == "/env/legacy.onnx"


def test_resolve_campplus_cwd_hit_used_when_no_env(monkeypatch, tmp_path):
    monkeypatch.delenv("PERSODUB_CAMPPLUS_MODEL", raising=False)
    monkeypatch.delenv("QWEN_CAMPPLUS_MODEL", raising=False)
    model = tmp_path / DEFAULT_CAMPPLUS
    model.parent.mkdir(parents=True)
    model.write_bytes(b"onnx")
    monkeypatch.chdir(tmp_path)
    assert resolve_campplus_model(None) == str(model)


def test_resolve_campplus_falls_back_to_repo_root_not_bare_relative(monkeypatch, tmp_path):
    # cwd has no models/ dir (exactly the v2 rebuild situation): the resolved path
    # must be anchored to the repo root, never the bare relative default.
    monkeypatch.delenv("PERSODUB_CAMPPLUS_MODEL", raising=False)
    monkeypatch.delenv("QWEN_CAMPPLUS_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)
    resolved = resolve_campplus_model(None)
    assert os.path.isabs(resolved)
    assert resolved == os.path.join(REPO_ROOT, DEFAULT_CAMPPLUS)


# --- v3.1: timeouts must scale with take count (measured: two concurrent 88-take
# jobs pushed the fixed 600s ASR batch over its limit -> every asr came back 0,
# collapsing selection to a single best-margin take per line) ---

from app.scripts.qwen_score_takes import _asr_batch_timeout


def test_asr_batch_timeout_scales_with_file_count():
    assert _asr_batch_timeout(10) == 600          # small batches keep the old floor
    assert _asr_batch_timeout(88) == 88 * 15 + 300  # big batches scale


def test_score_takes_subprocess_timeout_scales_with_total_takes(monkeypatch, tmp_path):
    captured = {}

    def fake_run(cmd, capture_output=True, text=True, timeout=None):
        captured["timeout"] = timeout
        class R:
            returncode = 1
            stderr = "boom"
        return R()

    monkeypatch.setattr(qsc.subprocess, "run", fake_run)
    monkeypatch.setattr(qsc.os.path, "exists", lambda p: True)
    monkeypatch.setattr(qsc.os, "access", lambda p, m: True)
    lines = [{"i": i, "spk": "A", "usable": 1.0, "text": "t",
              "takes": [{"k": k, "path": "p"} for k in range(4)]} for i in range(22)]
    qsc.score_takes({"A": "/ref.wav"}, lines, "Korean", str(tmp_path))
    assert captured["timeout"] == 88 * 15 + 900   # 88 takes -> scaled past the fixed 900


# --- Mac CPUs run slower than the server's: ASR_BATCH_TIMEOUT_PER_FILE is
# env-overridable (PERSODUB_SCORER_ASR_TIMEOUT) so a Mac install isn't stuck
# with a server-tuned per-file budget ---

def test_asr_timeout_per_file_honours_env_override(monkeypatch):
    import importlib

    from app.scripts import qwen_score_takes as qst

    monkeypatch.setenv("PERSODUB_SCORER_ASR_TIMEOUT", "42")
    importlib.reload(qst)
    try:
        assert qst.ASR_BATCH_TIMEOUT_PER_FILE == 42.0
    finally:
        monkeypatch.undo()
        importlib.reload(qst)


def test_asr_timeout_per_file_garbage_env_falls_back_to_default(monkeypatch):
    import importlib

    from app.scripts import qwen_score_takes as qst

    monkeypatch.setenv("PERSODUB_SCORER_ASR_TIMEOUT", "banana")
    importlib.reload(qst)
    try:
        assert qst.ASR_BATCH_TIMEOUT_PER_FILE == 15.0
    finally:
        monkeypatch.undo()
        importlib.reload(qst)


# --- C1: the parent (qwen_scoring.score_takes) subprocess timeout must read the
# SAME PERSODUB_SCORER_ASR_TIMEOUT env var as the child, not hardcode 15 -- for
# n>=14 takes a mismatched (mac.env sets 60) parent timeout killed the scorer
# before the child's own budget expired, causing a silent take-0 fallback ---

def test_scorer_asr_timeout_per_take_defaults_to_15():
    assert qsc._scorer_asr_timeout_per_take() == 15.0


def test_scorer_asr_timeout_per_take_honours_env_override(monkeypatch):
    monkeypatch.setenv("PERSODUB_SCORER_ASR_TIMEOUT", "60")
    assert qsc._scorer_asr_timeout_per_take() == 60.0


def test_scorer_asr_timeout_per_take_garbage_env_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("PERSODUB_SCORER_ASR_TIMEOUT", "banana")
    assert qsc._scorer_asr_timeout_per_take() == 15.0


def test_score_takes_subprocess_timeout_honours_asr_timeout_env(monkeypatch, tmp_path):
    # mac.env sets PERSODUB_SCORER_ASR_TIMEOUT=60 for slower Mac CPUs -- the
    # parent's own subprocess timeout must scale with that, not a hardcoded 15,
    # or it kills the child before the child's own (larger) budget expires.
    captured = {}

    def fake_run(cmd, capture_output=True, text=True, timeout=None):
        captured["timeout"] = timeout
        class R:
            returncode = 1
            stderr = "boom"
        return R()

    monkeypatch.setenv("PERSODUB_SCORER_ASR_TIMEOUT", "60")
    monkeypatch.setattr(qsc.subprocess, "run", fake_run)
    monkeypatch.setattr(qsc.os.path, "exists", lambda p: True)
    monkeypatch.setattr(qsc.os, "access", lambda p, m: True)
    lines = [{"i": i, "spk": "A", "usable": 1.0, "text": "t",
              "takes": [{"k": k, "path": "p"} for k in range(4)]} for i in range(22)]
    qsc.score_takes({"A": "/ref.wav"}, lines, "Korean", str(tmp_path))
    assert captured["timeout"] == 88 * 60 + 900
