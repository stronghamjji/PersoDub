# -*- coding: utf-8 -*-
"""Unit tests for the speaker-identity gate
(app/scripts/check_speaker_identity.py). No ONNX / no DIAR_PYTHON here:
embeddings are injected as plain vectors, mirroring how test_diar_campplus.py
stays independent of the heavy interpreter.

Covers the four required behaviors:
  * correct assignment PASSes,
  * swapped assignment FAILs (clear margin),
  * short-line (< min-dur) mismatch is WARN, not FAIL,
  * missing reference for an assigned speaker is a setup ERROR (exit 2),
plus the CLI wiring (exit codes 0/1/2, table output).
"""
import json
import os

import pytest

from app.scripts import check_speaker_identity as csi

# Distinct unit vectors: BAT-like and JOK-like "voices" plus blends.
BAT = [1.0, 0.0, 0.0]
JOK = [0.0, 1.0, 0.0]


def near(v, other, w=0.9):
    """A vector mostly like v with a little of `other` mixed in."""
    return [w * a + (1 - w) * b for a, b in zip(v, other)]


# --------------------------------------------------------------------------
# pure logic: evaluate / score_lines
# --------------------------------------------------------------------------

def test_correct_assignment_passes():
    sims = csi.score_lines([near(BAT, JOK), near(JOK, BAT)],
                           {"Batman": BAT, "Joker": JOK})
    res = csi.evaluate([(0, "Batman"), (1, "Joker")], sims, [2.0, 2.0])
    assert [r["status"] for r in res] == ["PASS", "PASS"]
    assert res[0]["best"] == "Batman" and res[1]["best"] == "Joker"


def test_swapped_assignment_fails():
    # Line 0 SOUNDS like Batman but is assigned to Joker -> FAIL.
    sims = csi.score_lines([near(BAT, JOK)], {"Batman": BAT, "Joker": JOK})
    res = csi.evaluate([(0, "Joker")], sims, [2.0])
    assert res[0]["status"] == "FAIL"
    assert res[0]["best"] == "Batman"
    assert res[0]["best_sim"] > res[0]["assigned_sim"]


def test_within_margin_passes():
    # Another speaker is best, but only barely -> PASS under the margin rule.
    sims = [{"Batman": 0.40, "Joker": 0.42}]
    res = csi.evaluate([(0, "Batman")], sims, [2.0], margin=0.05)
    assert res[0]["status"] == "PASS"


def test_short_line_mismatch_is_warn_not_fail():
    sims = csi.score_lines([near(BAT, JOK)], {"Batman": BAT, "Joker": JOK})
    warn = csi.evaluate([(0, "Joker")], sims, [0.4])   # below 0.6s floor
    fail = csi.evaluate([(0, "Joker")], sims, [0.61])  # above the floor
    assert warn[0]["status"] == "WARN"
    assert fail[0]["status"] == "FAIL"


def test_missing_ref_in_evaluate_raises():
    sims = [{"Batman": 0.5}]
    with pytest.raises(ValueError, match="Ghost"):
        csi.evaluate([(0, "Ghost")], sims, [2.0])


# --------------------------------------------------------------------------
# workdir loading + run_gate with an injected embedder
# --------------------------------------------------------------------------

def make_workdir(tmp_path, assignments, speakers=("Batman", "Joker")):
    """Create a fake job workdir: empty line/ref wavs + scorer-input json.

    assignments: {line_idx: speaker}. Wav contents are never read because
    the embedder is injected in these tests.
    """
    d = tmp_path / "work"
    d.mkdir()
    for spk in speakers:
        (d / ("qwen_ref_%s.wav" % spk)).write_bytes(b"")
    lines = []
    for i, spk in sorted(assignments.items()):
        (d / ("qwen_line_%d.wav" % i)).write_bytes(b"")
        lines.append({"i": i, "spk": spk})
    (d / "qwen_scorer_input.json").write_text(
        json.dumps({"lines": lines}), encoding="utf-8")
    return str(d)


def fake_embedder(vec_by_basename, dur=2.0):
    """Embedder returning a canned vector per wav basename."""
    def embed(paths, timeout=600):
        embs = [vec_by_basename[os.path.basename(p)] for p in paths]
        return embs, [dur] * len(paths)
    return embed


def test_run_gate_pass_and_fail(tmp_path):
    wd = make_workdir(tmp_path, {0: "Batman", 1: "Joker", 2: "Joker"})
    # Line 2 is assigned Joker but SOUNDS like Batman -> the merged-cue bug.
    emb = fake_embedder({
        "qwen_ref_Batman.wav": BAT, "qwen_ref_Joker.wav": JOK,
        "qwen_line_0.wav": near(BAT, JOK),
        "qwen_line_1.wav": near(JOK, BAT),
        "qwen_line_2.wav": near(BAT, JOK),
    })
    results, refs = csi.run_gate(wd, embedder=emb)
    assert sorted(refs) == ["Batman", "Joker"]
    assert [r["status"] for r in results] == ["PASS", "PASS", "FAIL"]
    assert results[2]["assigned"] == "Joker" and results[2]["best"] == "Batman"


def test_run_gate_missing_ref_errors(tmp_path):
    wd = make_workdir(tmp_path, {0: "Ghost"})  # no qwen_ref_Ghost.wav
    with pytest.raises(ValueError, match="Ghost"):
        csi.run_gate(wd, embedder=fake_embedder({}))


def test_run_gate_no_lines_errors(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    (d / "qwen_ref_Batman.wav").write_bytes(b"")
    with pytest.raises(ValueError, match="qwen_line"):
        csi.run_gate(str(d), embedder=fake_embedder({}))


# --------------------------------------------------------------------------
# CLI: exit codes + table
# --------------------------------------------------------------------------

def test_main_exit_0_on_pass_and_writes_json(tmp_path, monkeypatch, capsys):
    wd = make_workdir(tmp_path, {0: "Batman"})
    monkeypatch.setattr(csi, "embed_files", fake_embedder({
        "qwen_ref_Batman.wav": BAT, "qwen_ref_Joker.wav": JOK,
        "qwen_line_0.wav": near(BAT, JOK)}))
    report = str(tmp_path / "report.json")
    rc = csi.main([wd, "--json", report])
    out = capsys.readouterr().out
    assert rc == 0
    assert "PASS" in out and "0 FAIL" in out
    data = json.load(open(report, encoding="utf-8"))
    assert data["results"][0]["status"] == "PASS"


def test_main_exit_1_on_fail(tmp_path, monkeypatch, capsys):
    wd = make_workdir(tmp_path, {0: "Joker"})  # sounds like Batman
    monkeypatch.setattr(csi, "embed_files", fake_embedder({
        "qwen_ref_Batman.wav": BAT, "qwen_ref_Joker.wav": JOK,
        "qwen_line_0.wav": near(BAT, JOK)}))
    rc = csi.main([wd])
    assert rc == 1
    assert "FAIL" in capsys.readouterr().out


def test_main_exit_2_on_setup_error(tmp_path, monkeypatch, capsys):
    assert csi.main([str(tmp_path / "nope")]) == 2  # missing workdir
    wd = make_workdir(tmp_path, {0: "Ghost"})       # missing reference
    monkeypatch.setattr(csi, "embed_files", fake_embedder({}))
    assert csi.main([wd]) == 2
    assert "ERROR" in capsys.readouterr().err
