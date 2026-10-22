"""The New project screen's holding area, server side: fetch a link into a holding folder, play
it back, then save all of it or a stretch of it where the user wants.

yt-dlp and ffmpeg are both replaced: the fetch writes bytes and reports
percent the way source_fetch.fetch does through its log callback, and the
cut is a recorder. What these pin down is the record the screen polls, where
the file lands, what it is called, and that nothing is written over."""
import os
import shutil
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

    def fake_run(cmd, capture_output=True, text=True, **_kw):
        calls.append(cmd)
        open(cmd[-1], "wb").close()
        class R:
            returncode = 0
            stderr = ""
        return R()
    monkeypatch.setattr(dl.media.subprocess, "run", fake_run)
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

    def fake_run(cmd, capture_output=True, text=True, **_kw):
        calls.append(cmd)
        open(cmd[-1], "wb").close()
        class R:
            returncode = 0
            stderr = ""
        return R()
    monkeypatch.setattr(dl.media.subprocess, "run", fake_run)
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


def test_save_with_no_folder_goes_into_the_download_folder_picked_while_it_is_there(monkeypatch, tmp_path):
    # The Download dialog's Change writes the folder into kit.env (the desktop
    # shell's downloadsIpc.js), and the day and title folders go inside it.
    _wire(monkeypatch, tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    kit, picked = tmp_path / "kit", tmp_path / "Work SSD"
    kit.mkdir()
    picked.mkdir()
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    (kit / "kit.env").write_text("PERSODUB_DOWNLOAD_DIR=%s\n" % picked, encoding="utf-8")

    def saved_in():
        return os.path.dirname(client.post(f"/api/downloads/{did}/save", json={}).json()["path"])
    day, stem = time.strftime("%Y-%m-%d"), "Teach You a Lesson - es tu vida - vívela (17-17)"
    assert saved_in() == os.path.join(str(picked), day, stem)
    # Gone, like a drive taken out: Downloads, as with none picked.
    shutil.rmtree(picked)
    assert saved_in() == os.path.join(str(tmp_path), "Downloads", day, stem)
    # Default again (the line left empty) beats the folder the engine started
    # with in its environment: kit.env is read at every save.
    picked.mkdir()
    monkeypatch.setenv("PERSODUB_DOWNLOAD_DIR", str(picked))
    (kit / "kit.env").write_text("PERSODUB_DOWNLOAD_DIR=\n", encoding="utf-8")
    assert saved_in() == os.path.join(str(tmp_path), "Downloads", day, stem)


# --- Export on a draft: several kept parts joined, and the sound alone ------

def _held(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    monkeypatch.setattr(dl.media, "video_duration", lambda p: 46.0)
    monkeypatch.setattr(dl.media, "has_audio", lambda p: True)
    did = client.post("/api/downloads", json={"url": "https://youtu.be/x"}).json()["id"]
    _wait(did)
    return did


def _record_ffmpeg(monkeypatch, returncode=0, stderr=""):
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        open(cmd[-1], "wb").close()
        class R:
            pass
        R.returncode, R.stderr = returncode, stderr
        return R()
    monkeypatch.setattr(dl.media.subprocess, "run", fake_run)
    return calls


STEM = "Teach You a Lesson - es tu vida - vívela (17-17)"


def test_save_several_kept_parts_joins_them_into_one_video(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    calls = _record_ffmpeg(monkeypatch)
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "D"), "ranges": [[0, 3], [10, 14.5]]})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    assert os.path.basename(path) == STEM + " (2 parts).mp4"
    assert r.json()["seconds"] == 7.5
    graph = calls[-1][calls[-1].index("-filter_complex") + 1]
    assert graph.endswith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
    assert calls[-1][-1] == path


def test_one_kept_part_sent_as_ranges_is_the_stretch_it_always_was(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    calls = _record_ffmpeg(monkeypatch)
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "D"), "ranges": [[3, 21]]})
    assert os.path.basename(r.json()["path"]) == STEM + " (3s-21s).mp4"
    assert calls[-1][calls[-1].index("-t") + 1] == "18.000"


def test_audio_only_saves_the_kept_parts_sound_as_mp3_or_wav(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    calls = _record_ffmpeg(monkeypatch)
    dest = str(tmp_path / "D")
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": dest, "ranges": [[0, 3], [10, 14.5]], "audio": "mp3"})
    assert r.status_code == 200, r.text
    assert os.path.basename(r.json()["path"]) == STEM + " (2 parts).mp3"
    cmd = calls[-1]
    assert cmd[cmd.index("-filter_complex") + 1].endswith("[a0][a1]concat=n=2:v=0:a=1[a]")
    assert cmd[cmd.index("-c:a") + 1] == "libmp3lame"
    # The whole video's sound, as a wav.
    r = client.post(f"/api/downloads/{did}/save", json={"dir": dest, "audio": "wav"})
    assert os.path.basename(r.json()["path"]) == STEM + ".wav"
    cmd = calls[-1]
    assert "-vn" in cmd and cmd[cmd.index("-c:a") + 1] == "pcm_s16le"


# --- The Ratio button's shape on an export (app/ratio.py) --------------------

def test_kept_parts_are_saved_in_the_picked_ratio_in_the_same_pass(monkeypatch, tmp_path):
    from app import ratio
    did = _held(monkeypatch, tmp_path)
    calls = _record_ffmpeg(monkeypatch)
    monkeypatch.setattr(ratio, "video_size", lambda path: (1920, 1080))
    pad = "pad=1920:3414:(ow-iw)/2:(oh-ih)/2:black"
    # Several parts: joined, then put in the canvas, in one encode.
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "D"), "ranges": [[0, 3], [10, 14.5]], "ratio": "9:16"})
    assert r.status_code == 200, r.text
    assert os.path.basename(r.json()["path"]) == STEM + " (2 parts).mp4"
    assert len(calls) == 1 and calls[0][-1] == r.json()["path"]
    graph = calls[0][calls[0].index("-filter_complex") + 1]
    assert graph.endswith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vj][a];[vj]%s[v]" % pad)
    # One part: the stretch it always was, through the same filter.
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "D"), "ranges": [[3, 21]], "ratio": "9:16"})
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    assert calls[1][calls[1].index("-vf") + 1] == pad and calls[1][calls[1].index("-t") + 1] == "18.000"
    # "original" is no ratio at all: the commands are the ones sent without it.
    for body in ({"ranges": [[0, 3], [10, 14.5]]}, {"ranges": [[3, 21]]}):
        del calls[:]
        client.post(f"/api/downloads/{did}/save", json={"dir": str(tmp_path / "P"), **body})
        client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "P"), "ratio": "original", **body})
        assert len(calls) == 2 and calls[0][:-1] == calls[1][:-1]
        assert not any("pad=" in str(a) for a in calls[0])
    # A shape the app does not know is refused before anything is written.
    del calls[:]
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(tmp_path / "X"), "ranges": [[0, 3], [10, 14]], "ratio": "7:3"})
    assert r.status_code == 422 and calls == []


def test_audio_only_ignores_the_ratio(monkeypatch, tmp_path):
    from app import ratio
    did = _held(monkeypatch, tmp_path)
    calls = _record_ffmpeg(monkeypatch)

    def no_probe(path):
        raise AssertionError("the sound has no picture to measure")
    monkeypatch.setattr(ratio, "video_size", no_probe)
    dest = str(tmp_path / "D")
    plain = client.post(f"/api/downloads/{did}/save",
                        json={"dir": dest, "ranges": [[0, 3], [10, 14.5]], "audio": "mp3"})
    with_ratio = client.post(f"/api/downloads/{did}/save",
                             json={"dir": dest, "ranges": [[0, 3], [10, 14.5]], "audio": "mp3",
                                   "ratio": "9:16"})
    assert plain.status_code == 200 and with_ratio.status_code == 200, with_ratio.text
    assert with_ratio.json()["path"].endswith(".mp3")
    assert len(calls) == 2 and calls[0][:-1] == calls[1][:-1]
    assert not any("pad=" in str(a) for a in calls[1])
    # The whole video's sound too.
    r = client.post(f"/api/downloads/{did}/save", json={"dir": dest, "audio": "wav", "ratio": "1:1"})
    assert r.status_code == 200 and len(calls) == 3 and "-vn" in calls[2]


def test_audio_only_refuses_another_format_and_a_silent_video(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    r = client.post(f"/api/downloads/{did}/save", json={"dir": str(tmp_path), "audio": "ogg"})
    assert r.status_code == 422
    monkeypatch.setattr(dl.media, "has_audio", lambda p: False)
    r = client.post(f"/api/downloads/{did}/save", json={"dir": str(tmp_path), "audio": "mp3"})
    assert r.status_code == 422 and r.json()["detail"] == "This video has no sound."


def test_save_refuses_bad_kept_parts_and_a_stretch_beside_them(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    def post(body):
        return client.post(f"/api/downloads/{did}/save", json={"dir": str(tmp_path), **body})
    assert post({"ranges": [[5, 9], [2, 4]]}).status_code == 400      # out of order
    assert post({"ranges": [[0, 3], [40, 60]]}).status_code == 400    # past the end
    assert post({"ranges": [[0, 3]], "start": 0, "end": 3}).status_code == 422


def test_a_failed_join_says_so_and_leaves_no_file(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    _record_ffmpeg(monkeypatch, returncode=1, stderr="/private/x/in.mp4: Invalid data\n")
    dest = tmp_path / "D"
    r = client.post(f"/api/downloads/{did}/save",
                    json={"dir": str(dest), "ranges": [[0, 3], [10, 14]]})
    assert r.status_code == 503
    assert r.json()["detail"] == "Could not join the kept parts: in.mp4: Invalid data"
    assert os.listdir(dest) == []


def test_a_failed_stretch_says_why_without_folders_and_leaves_no_file(monkeypatch, tmp_path):
    did = _held(monkeypatch, tmp_path)
    src = dl.download_store.get(did).path
    # The recorder writes the output before failing, as an encoder that dies
    # part way through does.
    _record_ffmpeg(monkeypatch, returncode=1, stderr=src + ": Invalid data found when processing input\n")
    dest = tmp_path / "D"
    r = client.post(f"/api/downloads/{did}/save", json={"dir": str(dest), "start": 1, "end": 5})
    assert r.status_code == 503
    assert r.json()["detail"] == "ffmpeg could not cut this video: source.mp4: Invalid data found when processing input"
    assert os.listdir(dest) == []
    # Nothing on stderr: the sentence alone.
    _record_ffmpeg(monkeypatch, returncode=1, stderr="")
    r = client.post(f"/api/downloads/{did}/save", json={"dir": str(dest), "start": 1, "end": 5})
    assert r.json()["detail"] == "ffmpeg could not cut this video."


def test_a_kept_draft_video_is_held_again_after_a_restart(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.post("/api/downloads/upload",
                    files={"video": ("draft.mp4", b"draft bytes", "video/mp4")},
                    data={"duration_sec": "12"})
    did = r.json()["id"]
    # Still held: the same record comes back, and nothing is made twice.
    again = client.post(f"/api/downloads/{did}/hold", json={})
    assert again.status_code == 200 and again.json()["id"] == did
    # The app restarts: the record is gone, the file is not.
    monkeypatch.setattr(dl, "download_store", dl.DownloadStore())
    assert client.get(f"/api/downloads/{did}/video").status_code == 404
    r = client.post(f"/api/downloads/{did}/hold", json={"title": "draft", "duration_sec": 12})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready" and r.json()["title"] == "draft" and r.json()["duration_sec"] == 12
    assert client.get(f"/api/downloads/{did}/video").content == b"draft bytes"


def test_holding_a_video_that_is_gone_or_was_never_one_is_refused(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    assert client.post("/api/downloads/0a1b2c3d/hold", json={}).status_code == 404
    # Not an id this store makes: never turned into a path.
    assert client.post("/api/downloads/..%2F..%2Fx/hold", json={}).status_code == 404


def test_a_link_whose_page_gives_no_length_is_measured_off_the_file(monkeypatch, tmp_path):
    # Instagram reels: yt-dlp's info has no duration (2026-10-08), and the
    # project opened at 00:00 with an empty timeline.
    _wire(monkeypatch, tmp_path)
    monkeypatch.setattr(dl, "probe_source", lambda url: dict(PROBE, duration_sec=None))
    monkeypatch.setattr(dl.media, "video_duration", lambda path: 11.1)
    did = client.post("/api/downloads", json={"url": "https://www.instagram.com/reel/x/"}).json()["id"]
    rec = _wait(did)
    assert rec["status"] == "ready" and rec["duration_sec"] == 11.1
