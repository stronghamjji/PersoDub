"""The New project screen's holding area, server side: fetch a link into a holding folder, play
it back, then save all of it or a stretch of it where the user wants.

yt-dlp and ffmpeg are both replaced: the fetch writes bytes and reports
percent the way source_fetch.fetch does through its log callback, and the
cut is a recorder. What these pin down is the record the screen polls, where
the file lands, what it is called, and that nothing is written over."""
import os
import time

from fastapi.testclient import TestClient

from app import state
from app.api import downloads as dl
from app.main import app
from app.source_fetch import FetchError

client = TestClient(app, base_url="http://127.0.0.1")

PROBE = {"title": "Teach You a Lesson: es tu vida / vívela (17/17)",
         "duration_sec": 46, "thumbnail_url": "https://i.ytimg.com/vi/x/hq.jpg",
         "site": "Youtube"}


def _wire(monkeypatch, tmp_path, fetch=None):
    monkeypatch.setattr(state, "WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setattr(dl, "probe_source", lambda url: dict(PROBE))

    def fake_fetch(url, dest, log=None, cancel_check=None):
        if log:
            log("0/6 Fetching video… 43%")
        with open(dest, "wb") as f:
            f.write(b"video bytes")
    monkeypatch.setattr(dl, "fetch_source", fetch or fake_fetch)


def _wait(did, status="ready"):
    for _ in range(200):
        rec = client.get(f"/api/downloads/{did}").json()
        if rec["status"] in (status, "failed"):
            return rec
        time.sleep(0.01)
    raise AssertionError("download never reached %s: %r" % (status, rec))


def test_a_link_is_fetched_into_a_holding_folder_and_played_back(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.post("/api/downloads", json={"url": "https://youtu.be/x"})
    assert r.status_code == 200
    did = r.json()["id"]
    rec = _wait(did)
    assert rec["status"] == "ready"
    assert rec["title"] == PROBE["title"] and rec["duration_sec"] == 46
    assert rec["site"] == "Youtube"
    assert rec["percent"] == 100
    # Playable straight from the holding folder, before anything is saved.
    v = client.get(f"/api/downloads/{did}/video")
    assert v.status_code == 200 and v.content == b"video bytes"
    assert rec["path"].startswith(str(tmp_path / "workspace"))


def test_progress_is_the_percent_the_fetch_reports(monkeypatch, tmp_path):
    seen = {}

    def slow_fetch(url, dest, log=None, cancel_check=None):
        log("0/6 Fetching video… 43%")
        # The fetch thread can outrun the POST that hands the id back.
        for _ in range(100):
            if seen["id"]:
                break
            time.sleep(0.01)
        seen["mid"] = client.get(f"/api/downloads/{seen['id']}").json()
        with open(dest, "wb") as f:
            f.write(b"v")
    _wire(monkeypatch, tmp_path, fetch=slow_fetch)
    seen["id"] = None
    r = client.post("/api/downloads", json={"url": "https://youtu.be/x"})
    seen["id"] = r.json()["id"]
    _wait(seen["id"])
    assert seen["mid"]["status"] == "downloading" and seen["mid"]["percent"] == 43


def test_a_failed_fetch_says_why_in_the_users_words(monkeypatch, tmp_path):
    def bad_fetch(url, dest, log=None, cancel_check=None):
        raise FetchError("login", "This video needs a sign-in, so it can't be fetched.")
    _wire(monkeypatch, tmp_path, fetch=bad_fetch)
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    rec = _wait(did)
    assert rec["status"] == "failed"
    assert rec["error"] == "This video needs a sign-in, so it can't be fetched."


def test_a_non_web_url_is_refused_at_once(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.post("/api/downloads", json={"url": "/etc/passwd"})
    assert r.status_code == 422


def test_save_whole_copies_the_file_under_the_title(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    dest = tmp_path / "Downloads"
    r = client.post(f"/api/downloads/{did}/save", json={"dir": str(dest)})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    # The title, with the characters a file name cannot hold swapped out.
    assert os.path.basename(path) == "Teach You a Lesson - es tu vida - vívela (17-17).mp4"
    assert open(path, "rb").read() == b"video bytes"
    # Saving again never writes over the first.
    r2 = client.post(f"/api/downloads/{did}/save", json={"dir": str(dest)})
    assert r2.json()["path"] != path and os.path.exists(r2.json()["path"])


def test_save_a_stretch_cuts_with_ffmpeg_and_names_the_stretch(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    calls = []

    def fake_run(cmd, capture_output=True, text=True):
        calls.append(cmd)
        open(cmd[-1], "wb").close()
        class R:
            returncode = 0
            stderr = ""
        return R()
    monkeypatch.setattr(dl.subprocess, "run", fake_run)
    monkeypatch.setattr(dl.media, "video_duration", lambda p: 46.0)
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    dest = tmp_path / "Downloads"
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(dest), "start": 3.0, "end": 21.0})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    # The stretch is tagged the way the agent's clip tool tags its cuts.
    assert os.path.basename(path) == "Teach You a Lesson - es tu vida - vívela (17-17) (3s-21s).mp4"
    assert r.json()["seconds"] == 18.0
    cmd = calls[-1]
    assert cmd[0] == "ffmpeg" and "-ss" in cmd and cmd[cmd.index("-ss") + 1] == "3.000"
    assert cmd[cmd.index("-t") + 1] == "18.000" and cmd[-1] == path


def test_save_refuses_a_backwards_stretch(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path), "start": 10, "end": 5})
    assert r.status_code == 422


def test_save_waits_for_a_download_that_is_not_there_yet(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.post("/api/downloads/nope/save", json={"dir": str(tmp_path)})
    assert r.status_code == 404


def test_a_dropped_file_is_held_like_a_link_and_saves_a_stretch(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    calls = []

    def fake_run(cmd, capture_output=True, text=True):
        calls.append(cmd)
        open(cmd[-1], "wb").close()
        class R:
            returncode = 0
            stderr = ""
        return R()
    monkeypatch.setattr(dl.subprocess, "run", fake_run)
    monkeypatch.setattr(dl.media, "video_duration", lambda p: 30.0)
    r = client.post("/api/downloads/upload",
                    files={"video": ("my clip: take 2.mov", b"dropped bytes", "video/quicktime")},
                    data={"duration_sec": "30"})
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["status"] == "ready" and rec["title"] == "my clip: take 2"
    v = client.get(f"/api/downloads/{rec['id']}/video")
    assert v.content == b"dropped bytes"
    r = client.post(f"/api/downloads/{rec['id']}/save",
                    json={"dir": str(tmp_path / "Downloads"), "start": 2, "end": 17})
    assert r.status_code == 200, r.text
    assert os.path.basename(r.json()["path"]) == "my clip - take 2 (2s-17s).mp4"
    assert calls[-1][calls[-1].index("-t") + 1] == "15.000"


def test_save_with_no_folder_goes_under_downloads_by_day_and_title(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    path = client.post(f"/api/downloads/{did}/save", json={}).json()["path"]
    stem = "Teach You a Lesson - es tu vida - vívela (17-17)"
    assert os.path.dirname(path) == os.path.join(str(tmp_path), "Downloads", time.strftime("%Y-%m-%d"), stem)
    assert os.path.basename(path) == stem + ".mp4"
