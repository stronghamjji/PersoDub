"""Pulling subtitles out of a plain video file, through Perso STT.

No network. PersoClient is replaced, and the duration probe is replaced --
what these pin down is the promise the two routes make to the agent tool:
say the price before spending, write the .srt next to the video, and never
write over a file that is already there.
"""
import math

from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")

# One 10-second segment, in Perso's scriptTimestamps shape.
SCRIPT_JSON = [{
    "order": 1,
    "speaker_name": "SPEAKER_00",
    "text_original": "안녕하세요",
    "words": [[{"start": 0.5, "end": 2.0}, {"start": 2.0, "end": 9.5}]],
}]


class _FakePerso:
    def __init__(self):
        self.transcribed = []

    def describe_workspace(self):
        return {"seq": 1, "name": "test", "credits": 100}

    def transcribe(self, video_path, space_seq=None):
        self.transcribed.append(video_path)
        return SCRIPT_JSON


def _wire(monkeypatch, tmp_path, duration=10.0):
    """A world where Perso works, the probe answers, and a video exists."""
    fake = _FakePerso()
    monkeypatch.setattr(main, "perso_available", lambda: True)
    monkeypatch.setattr(main, "PersoClient", lambda: fake)
    monkeypatch.setattr(main, "_video_duration", lambda p: duration)
    video = tmp_path / "쇼츠 3편.mp4"
    video.write_bytes(b"not really a video")
    return fake, video


def test_estimate_names_the_price_before_anything_is_spent(monkeypatch, tmp_path):
    fake, video = _wire(monkeypatch, tmp_path, duration=47.0)
    r = client.get("/api/subtitles/estimate", params={"video_path": str(video)})
    assert r.status_code == 200
    body = r.json()
    assert body["seconds"] == 47.0
    # Measured 2026-08-31: 2 credits for a 10s clip -- about 1 per 5 seconds.
    assert body["credits_estimate"] == math.ceil(47.0 / 5)
    assert body["credits_balance"] == 100
    assert fake.transcribed == []          # an estimate must never transcribe


def test_estimate_without_a_perso_key_is_a_422_not_a_surprise_later(monkeypatch, tmp_path):
    _, video = _wire(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "perso_available", lambda: False)
    r = client.get("/api/subtitles/estimate", params={"video_path": str(video)})
    assert r.status_code == 422
    assert "Perso" in r.json()["detail"]


def test_estimate_names_a_file_that_is_not_there(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.get("/api/subtitles/estimate",
                   params={"video_path": str(tmp_path / "없는파일.mp4")})
    assert r.status_code == 404


def test_estimate_calls_a_file_ffprobe_cannot_read_not_a_video(monkeypatch, tmp_path):
    _, video = _wire(monkeypatch, tmp_path)

    def broken(_):
        raise RuntimeError("no video stream")
    monkeypatch.setattr(main, "_video_duration", broken)
    r = client.get("/api/subtitles/estimate", params={"video_path": str(video)})
    assert r.status_code == 422


def test_extract_writes_the_srt_next_to_the_video(monkeypatch, tmp_path):
    fake, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/extract", json={"video_path": str(video)})
    assert r.status_code == 200
    body = r.json()
    assert body["lines"] == 1
    srt = tmp_path / "쇼츠 3편.srt"
    assert body["srt_path"] == str(srt)
    text = srt.read_text(encoding="utf-8")
    assert "안녕하세요" in text
    assert "00:00:00" in text
    assert fake.transcribed == [str(video)]


def test_extract_never_writes_over_an_existing_file(monkeypatch, tmp_path):
    _, video = _wire(monkeypatch, tmp_path)
    keep = tmp_path / "쇼츠 3편.srt"
    keep.write_text("이미 있던 자막", encoding="utf-8")
    r = client.post("/api/subtitles/extract", json={"video_path": str(video)})
    assert r.status_code == 200
    assert r.json()["srt_path"] == str(tmp_path / "쇼츠 3편-1.srt")
    assert keep.read_text(encoding="utf-8") == "이미 있던 자막"


def test_extract_relays_an_empty_result_as_a_failure(monkeypatch, tmp_path):
    fake, video = _wire(monkeypatch, tmp_path)
    fake.transcribe = lambda p, space_seq=None: []
    r = client.post("/api/subtitles/extract", json={"video_path": str(video)})
    assert r.status_code == 503


def test_extract_relays_perso_being_out_of_credits(monkeypatch, tmp_path):
    fake, video = _wire(monkeypatch, tmp_path)

    def broke(p, space_seq=None):
        raise main.PersoCreditExhaustedError("Perso credits are exhausted.")
    fake.transcribe = broke
    r = client.post("/api/subtitles/extract", json={"video_path": str(video)})
    assert r.status_code == 409
    assert "credit" in r.json()["detail"].lower()


def test_local_extraction_is_free_and_needs_no_perso(monkeypatch, tmp_path):
    _, video = _wire(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "perso_available", lambda: False)   # no key at all
    r = client.get("/api/subtitles/estimate",
                   params={"video_path": str(video), "engine": "local"})
    assert r.status_code == 200
    assert r.json()["credits_estimate"] == 0


def test_local_extraction_runs_whisper_on_this_machine(monkeypatch, tmp_path):
    fake, video = _wire(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "perso_available", lambda: False)
    heard = []

    def fake_whisper(path, **kw):
        heard.append(path)
        return [{"start": 0.5, "end": 2.0, "text": "안녕하세요"}]

    monkeypatch.setattr(main, "transcribe_local", fake_whisper)
    r = client.post("/api/subtitles/extract",
                    json={"video_path": str(video), "engine": "local"})
    assert r.status_code == 200
    assert heard == [str(video)]
    assert fake.transcribed == []          # Perso was never asked
    srt = tmp_path / "쇼츠 3편.srt"
    assert "안녕하세요" in srt.read_text(encoding="utf-8")


def test_extract_rejects_an_unknown_engine(monkeypatch, tmp_path):
    _, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/extract",
                    json={"video_path": str(video), "engine": "cloud9"})
    assert r.status_code == 422
