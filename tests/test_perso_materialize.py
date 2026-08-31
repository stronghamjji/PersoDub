"""Turning a finished Perso dub into a locally editable job (app/perso_materialize.py).

The materializer downloads what Perso serves (script, per-line audio, the
background bed) and writes exactly the files the existing edit/remake
machinery already reads: original/translated .srt, speakers.json, lines.json,
qwen_line_N.wav, background.wav and the speaker reference wavs.
"""
import json
import os

import pytest

from app import perso_materialize


class _FakeClient:
    space_seq = 999

    def get_project_script(self, seq, space_seq=None):
        return {"sentences": [
            {"seq": 11, "originalText": "안녕", "translatedText": "Hi there",
             "offsetMs": 270, "durationMs": 1500, "speakerOrderIndex": 1,
             "audioUrl": "/store/a1.bin"},
            {"seq": 12, "originalText": "잘 가", "translatedText": "Bye bye now",
             "offsetMs": 2000, "durationMs": 2500, "speakerOrderIndex": 2,
             "audioUrl": "/store/a2.bin"},
        ], "speakers": [{"speakerOrderIndex": 1}, {"speakerOrderIndex": 2}]}

    def download_target(self, seq, target, out_path, space_seq=None):
        assert target == "backgroundAudio"
        with open(out_path, "wb") as f:
            f.write(b"BG")
        return out_path

    def download_media(self, url, out_path):
        with open(out_path, "wb") as f:
            f.write(b"AUDIO:" + url.encode())
        return out_path


def _fake_to_wav(src, dest, **kw):
    # Stands in for the ffmpeg conversion: copies the marker bytes through.
    with open(src, "rb") as f, open(dest, "wb") as g:
        g.write(f.read())


def test_materialize_writes_every_file_the_editor_reads(tmp_path):
    work = str(tmp_path)
    perso_materialize.materialize(_FakeClient(), 409873, work, "en",
                                  to_wav=_fake_to_wav, log=lambda m: None)

    # the scripts, with the right lines in the right slots
    with open(os.path.join(work, "translated.srt"), encoding="utf-8") as f:
        dubbed = f.read()
    assert "Hi there" in dubbed and "Bye bye now" in dubbed
    with open(os.path.join(work, "original.srt"), encoding="utf-8") as f:
        assert "안녕" in f.read()

    # who speaks when
    with open(os.path.join(work, "speakers.json"), encoding="utf-8") as f:
        speakers = json.load(f)
    assert speakers[0]["speaker"] != speakers[1]["speaker"]
    assert speakers[0]["start"] == pytest.approx(0.27)

    # what the remake machinery needs
    with open(os.path.join(work, "lines.json"), encoding="utf-8") as f:
        data = json.load(f)
    assert [e["i"] for e in data["lines"]] == [0, 1]
    assert data["lines"][0]["start"] == pytest.approx(0.27)
    assert data["lines"][0]["speaker"] == speakers[0]["speaker"]

    # the audio: one wav per line, the background bed, one ref per speaker
    assert os.path.exists(os.path.join(work, "qwen_line_0.wav"))
    assert os.path.exists(os.path.join(work, "qwen_line_1.wav"))
    assert os.path.exists(os.path.join(work, "background.wav"))
    with open(os.path.join(work, "speaker_refs.json"), encoding="utf-8") as f:
        refs = json.load(f)
    for spk in refs:
        assert os.path.exists(os.path.join(work, "qwen_ref_%s.wav" % spk))
        assert refs[spk]["ref_text"]


def test_materialize_is_idempotent(tmp_path):
    work = str(tmp_path)
    perso_materialize.materialize(_FakeClient(), 409873, work, "en",
                                  to_wav=_fake_to_wav, log=lambda m: None)
    # a second run must not fail or duplicate anything
    perso_materialize.materialize(_FakeClient(), 409873, work, "en",
                                  to_wav=_fake_to_wav, log=lambda m: None)
    with open(os.path.join(work, "lines.json"), encoding="utf-8") as f:
        assert len(json.load(f)["lines"]) == 2
