"""The automatic leakage gate (pipeline stage 5/6).

check_leakage / suppress_vocal_echo existed only as hand-run CLI tools, so the
desktop app shipped FAIL-grade mixes with no warning (README calls the check
mandatory before delivery, but a desktop user cannot run a CLI). The pipeline
now measures every dub before the final mux, cancels persistent echo runs when
it finds them, and re-checks.

The underlying measurement/cancellation math has its own tests
(test_leakage_check.py / test_suppress_vocal_echo.py); these tests cover the
gate's wiring: pass-through, suppress-and-recheck, still-failing warning,
whitelist exclusions, and the guarantee that a broken checker never kills a dub.
"""
import json

from app import config, pipeline


class GateStub:
    """Scriptable stand-ins for measure_leakage / suppress_vocal_echo."""

    def __init__(self, monkeypatch, reports):
        self.reports = list(reports)  # one dict per measure_leakage call
        self.measure_calls = []
        self.suppress_calls = []
        monkeypatch.setattr(pipeline, "measure_leakage", self._measure)
        monkeypatch.setattr(pipeline, "suppress_vocal_echo", self._suppress)

    def _measure(self, mix, vocals, exclude_spans=None):
        self.measure_calls.append({"mix": mix, "exclude_spans": exclude_spans})
        return self.reports.pop(0)

    def _suppress(self, mix, vocals, out, exclude_spans=None):
        self.suppress_calls.append({"mix": mix, "out": out, "exclude_spans": exclude_spans})
        with open(out, "w") as f:
            f.write("fixed")
        return 1


PASS = {"pass": True, "n_windows": 10, "n_fail": 0, "max_rel_db": -120.0}
FAIL = {"pass": False, "n_windows": 10, "n_fail": 3, "max_rel_db": -8.0}


def test_clean_mix_passes_through(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [PASS])
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=lambda m: None)
    assert out == str(tmp_path / "mix.wav")
    assert stub.suppress_calls == []


def test_failing_mix_is_suppressed_and_rechecked(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [FAIL, PASS])
    logs = []
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=logs.append)
    assert out == str(tmp_path / "dub_leakfix.wav")
    assert len(stub.suppress_calls) == 1
    assert len(stub.measure_calls) == 2
    assert any("cancell" in m or "suppress" in m for m in logs)


def test_still_failing_after_suppression_warns_but_delivers(tmp_path, monkeypatch):
    GateStub(monkeypatch, [FAIL, FAIL])
    logs = []
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=logs.append)
    assert out == str(tmp_path / "dub_leakfix.wav")  # cleaned copy is still the better file
    assert any("Warning:" in m for m in logs)


def test_whitelisted_nonverbal_spans_are_excluded(tmp_path, monkeypatch, wav_factory):
    # Kept laugh/breath spans are literal original-voice copies; measuring them
    # would flag them as leaks and suppression would erase the laughs.
    stub = GateStub(monkeypatch, [PASS])
    mix = wav_factory(tmp_path / "mix.wav", seconds=30.0)
    manifest = tmp_path / "nonverbal_manifest.json"
    manifest.write_text(json.dumps(
        {"kept": [{"start": 1.0, "end": 2.5, "text": ""}]}), encoding="utf-8")
    pipeline.leakage_gate(mix, "vocals.wav", str(manifest), str(tmp_path), log=lambda m: None)
    assert stub.measure_calls[0]["exclude_spans"] == [(1.0, 2.5)]


def test_invalid_manifest_measures_at_full_strictness(tmp_path, monkeypatch, wav_factory):
    stub = GateStub(monkeypatch, [PASS])
    mix = wav_factory(tmp_path / "mix.wav", seconds=30.0)
    manifest = tmp_path / "nonverbal_manifest.json"
    manifest.write_text(json.dumps(
        {"kept": [{"start": 5.0, "end": 1.0, "text": ""}]}), encoding="utf-8")  # not a forward span
    logs = []
    pipeline.leakage_gate(mix, "vocals.wav", str(manifest), str(tmp_path), log=logs.append)
    assert stub.measure_calls[0]["exclude_spans"] is None
    assert any("manifest" in m for m in logs)


def test_checker_crash_never_kills_the_dub(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("checker exploded")

    monkeypatch.setattr(pipeline, "measure_leakage", boom)
    logs = []
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=logs.append)
    assert out == str(tmp_path / "mix.wav")
    assert any("Warning:" in m for m in logs)


# --- PERSODUB_LEAKAGE_GATE: staged-rollout mode flag (app/config.py) -- the
# gate is new/unvalidated on Mac, so it needs a kill switch ("off") and a
# dark-launch mode ("measure") on top of today's "on" behavior. ---

def test_off_mode_skips_the_stage_and_returns_the_original_mix(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [])  # empty -- measure_leakage must never be called
    monkeypatch.setattr(config, "PERSODUB_LEAKAGE_GATE", "off")
    logs = []
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=logs.append)
    assert out == str(tmp_path / "mix.wav")
    assert stub.measure_calls == []
    assert stub.suppress_calls == []
    assert any("skipped (PERSODUB_LEAKAGE_GATE=off)" in m for m in logs)


def test_measure_mode_with_failing_measurement_leaves_the_mix_untouched(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [FAIL])  # single measurement -- never rechecked
    monkeypatch.setattr(config, "PERSODUB_LEAKAGE_GATE", "measure")
    logs = []
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=logs.append)
    assert out == str(tmp_path / "mix.wav")
    assert len(stub.measure_calls) == 1
    assert stub.suppress_calls == []
    assert any("measure-only mode (PERSODUB_LEAKAGE_GATE=measure)" in m for m in logs)


def test_on_mode_with_failing_measurement_still_rewrites(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [FAIL, PASS])
    monkeypatch.setattr(config, "PERSODUB_LEAKAGE_GATE", "on")
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=lambda m: None)
    assert out == str(tmp_path / "dub_leakfix.wav")
    assert len(stub.suppress_calls) == 1


def test_invalid_mode_value_is_treated_as_on(tmp_path, monkeypatch):
    stub = GateStub(monkeypatch, [FAIL, PASS])
    monkeypatch.setattr(config, "PERSODUB_LEAKAGE_GATE", "banana")
    out = pipeline.leakage_gate(str(tmp_path / "mix.wav"), "vocals.wav", None,
                                str(tmp_path), log=lambda m: None)
    assert out == str(tmp_path / "dub_leakfix.wav")
    assert len(stub.suppress_calls) == 1
