"""Remaking one line is a real remake: every press rolls a new seed, so the
voice can come out differently (user decision 2026-08-28). Before, the seed
was fixed per line, and pressing remake on unchanged words gave back the
same voice."""
import json

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

    monkeypatch.setattr("app.engines.engine_for", lambda voice: FakeEngine())

    def fake_synth(engine, seg, voice_id, language, seed, out_path, log, label, **_later):
        seeds.append(seed)
        return out_path

    monkeypatch.setattr(qwen_pipeline, "_synth_one", fake_synth)
    monkeypatch.setattr(qwen_pipeline, "_check_fast_lines", lambda *a, **k: set())
    entry = {"i": 3, "speaker": "SPK1"}
    for _ in range(5):
        qwen_pipeline.resynth_one_line(work_dir, entry, "Wild!", "English")

    assert len(seeds) == 5
    assert len(set(seeds)) > 1, "remaking kept handing back the same seed"
    assert all(isinstance(s, int) and s > 0 for s in seeds)


def test_a_remade_line_is_heard_back_like_a_first_made_one(monkeypatch, tmp_path):
    # A remake skipped the Fast check (2026-10-03): a stray "어/아" the first
    # pass would have cut or made again stayed in a line the user or the Dub
    # Agent remade. It now goes through the same check, for that line alone.
    work_dir = _job_dir(tmp_path)

    class FakeEngine:
        def clone(self, ref_wav, ref_text):
            return "voice"

    monkeypatch.setattr("app.engines.engine_for", lambda voice: FakeEngine())
    monkeypatch.setattr(qwen_pipeline, "_synth_one", lambda engine, seg, voice_id, language, seed, out_path, *a, **k: out_path)
    checked = {}

    def fake_check(engine, segments, seg_speakers, voice_ids, language, work_dir, paths, slots, log, stats,
                   takes=None, remake_seed=None):
        checked.update(segments=segments, speakers=seg_speakers, voices=voice_ids, paths=paths, slots=slots,
                       remake_seed=remake_seed)
        return set()

    monkeypatch.setattr(qwen_pipeline, "_check_fast_lines", fake_check)
    entry = {"i": 2, "speaker": "SPK1", "start": 1.0, "end": 3.5}
    out = qwen_pipeline.resynth_one_line(work_dir, entry, "Wild!", "English")

    assert checked["paths"] == [None, None, out]
    assert checked["segments"][2] == {"text": "Wild!"}
    assert checked["speakers"][2] == "SPK1" and checked["voices"] == {"SPK1": "voice"}
    assert checked["slots"][2] == 2.5
    assert checked["remake_seed"] is not None    # its own new tries are new as well


def test_a_line_that_could_not_be_made_is_not_checked(monkeypatch, tmp_path):
    work_dir = _job_dir(tmp_path)

    class FakeEngine:
        def clone(self, ref_wav, ref_text):
            return "voice"

    monkeypatch.setattr("app.engines.engine_for", lambda voice: FakeEngine())
    monkeypatch.setattr(qwen_pipeline, "_synth_one", lambda *a, **k: None)
    monkeypatch.setattr(qwen_pipeline, "_check_fast_lines", lambda *a, **k: (_ for _ in ()).throw(AssertionError("checked")))
    assert qwen_pipeline.resynth_one_line(work_dir, {"i": 0, "speaker": "SPK1"}, "Hi", "English") is None


def test_a_remade_line_the_check_makes_again_comes_out_new_too(monkeypatch, tmp_path):
    # The check's own new tries used the first pass's fixed seeds, so a remade
    # line it judged wrong came back as the very take the first pass had kept
    # (2026-10-03): pressing remake changed nothing.
    seeds = []

    def fake_synth(engine, seg, voice_id, language, seed, out_path, *a, **k):
        seeds.append(seed)
        open(out_path, "wb").write(b"RIFF")
        return out_path

    monkeypatch.setattr(qwen_pipeline, "_synth_one", fake_synth)
    monkeypatch.setattr(qwen_pipeline, "_edge_cut_copy", lambda p, text, language: None)
    monkeypatch.setattr(qwen_pipeline, "_speech_seconds", lambda p: 1.0)
    monkeypatch.setattr(qwen_pipeline, "transcribe_batch", lambda paths, lang: dict.fromkeys(paths, "nothing like it"))
    first = tmp_path / "qwen_line_0.wav"
    first.write_bytes(b"RIFF")
    qwen_pipeline._check_fast_lines(None, [{"text": "hello there"}], ["A"], {"A": "v"}, "English", str(tmp_path),
                                    [str(first)], [2.0], lambda m: None, [], remake_seed=777)
    assert seeds == [778, 779]
