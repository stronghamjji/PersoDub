"""Remaking one line is a real remake: every press rolls a new seed, so the
voice can come out differently (user decision 2026-08-28). Before, the seed
was fixed per line, and pressing remake on unchanged words gave back the
same voice."""
import json
import os

from app import qwen_pipeline


def _job_dir(tmp_path):
    d = tmp_path / "job"
    d.mkdir()
    (d / "qwen_ref_SPK1.wav").write_bytes(b"RIFF")
    (d / "speaker_refs.json").write_text(json.dumps({"SPK1": {"ref_text": "hi"}}), encoding="utf-8")
    return str(d)


def test_each_remake_rolls_a_new_seed(monkeypatch, tmp_path):
    work_dir = _job_dir(tmp_path)
    seeds = []

    class FakeEngine:
        def clone(self, ref_wav, ref_text):
            return "voice"

    monkeypatch.setattr("app.engines.base.get_engine", lambda name: FakeEngine())

    def fake_synth(engine, seg, voice_id, language, seed, out_path, log, label):
        seeds.append(seed)
        return out_path

    monkeypatch.setattr(qwen_pipeline, "_synth_one", fake_synth)
    entry = {"i": 3, "speaker": "SPK1"}
    for _ in range(5):
        qwen_pipeline.resynth_one_line(work_dir, entry, "Wild!", "English")

    assert len(seeds) == 5
    assert len(set(seeds)) > 1, "remaking kept handing back the same seed"
    assert all(isinstance(s, int) and s > 0 for s in seeds)
