"""A video brought into a finished audio project and joined with its dubbed
sound (app/api/join.py).

Four files beside the job's result say everything: join.mp4 (the user's
bytes), join.json (its name, each lane's kept parts, the speed), joined.mp4
(the built file) and joined.json (what it was built from). The job's record
gains nothing, and dubbed.wav is only ever read.

ffprobe and ffmpeg are replaced: tests/conftest.py answers "video" for every
file, `lengths` answers how long each is, and `builds` stands in for
media.join_video. The last tests run the real ones on tiny files.
"""
import json
import os
import subprocess
from array import array

import pytest
from fastapi.testclient import TestClient

from app import media, media_preview, models, state
from app.jobs import JobStatus
from app.main import app
from tests.marks import needs_ffmpeg

client = TestClient(app, base_url="http://127.0.0.1")

# The real probe, kept before tests/conftest.py's every_file_is_a_video
# replaces it for each test.
real_media_kind = media.media_kind

AUDIO_ONLY = "Only for audio projects."
NO_VIDEO = "Bring in a video first."
BAD_RANGES = "The kept parts must be pairs of seconds, in order, each at least 0.1s and at least 0.5s in all."
BAD_TEMPO = "The audio speed must be 0.5, 1, 1.5, 2 or 3."
IN_USE = "The video is still in use. Try again in a moment."


@pytest.fixture
def lengths(monkeypatch):
    """How long ffprobe says each file is, by its name: a 12-second video
    (asked while it is still arriving, and after) and 10 seconds of dubbing."""
    seconds = {"join.mp4.part": 12.0, "join.mp4": 12.0, "dubbed.wav": 10.0}
    monkeypatch.setattr(media, "video_duration", lambda path: seconds[os.path.basename(path)])
    return seconds


@pytest.fixture
def builds(monkeypatch):
    """A stand-in for the ffmpeg work: it writes the file it is asked for
    and says what it was asked. Returns the list of what each build was."""
    made = []

    def fake_join_video(video, sound, out, video_ranges, sound_ranges, tempo=1.0, what=""):
        made.append({"video": video_ranges, "audio": sound_ranges, "tempo": tempo,
                     "from": (os.path.basename(video), os.path.basename(sound)), "what": what})
        with open(out, "wb") as f:
            f.write(b"JOINED %d" % len(made))

    monkeypatch.setattr(media, "join_video", fake_join_video)
    return made


def _job(**fields):
    """A finished audio project in the workspace: (id, folder)."""
    work = os.path.join(state.WORKSPACE, "2026-11-13", "talk_ko")
    os.makedirs(work)
    out = os.path.join(work, "dubbed.wav")
    with open(out, "wb") as f:
        f.write(b"DUBBED")
    jid = state.job_store.create()
    state.job_store.update(jid, **{"status": JobStatus.DONE, "media": "audio", "language_code": "ko",
                                   "work_dir": work, "result": {"out_path": out}, **fields})
    return jid, work


def _bring(jid, name="clip.mov", body=b"MOV-bytes"):
    return client.post(f"/api/dub/jobs/{jid}/join/video", files={"video": (name, body, "video/quicktime")})


def _put(jid, **body):
    return client.put(f"/api/dub/jobs/{jid}/join", json=body)


def _state(jid):
    return client.get(f"/api/dub/jobs/{jid}/join").json()


def _joined(jid, query=""):
    return client.get(f"/api/dub/result/{jid}/joined{query}")


def _files(work):
    return sorted(os.listdir(work))


# --- who may bring a video in -------------------------------------------------

def test_an_unknown_job_is_404_on_every_route():
    assert client.get("/api/dub/jobs/nope/join").status_code == 404
    assert _bring("nope").status_code == 404
    assert client.delete("/api/dub/jobs/nope/join/video").status_code == 404
    assert client.get("/api/dub/jobs/nope/join/video").status_code == 404
    assert _put("nope", tempo=2).status_code == 404
    assert _joined("nope").status_code == 404


def test_a_video_project_is_refused(lengths):
    jid, work = _job(media=None)
    r = _bring(jid)
    assert r.status_code == 409 and r.json()["detail"] == AUDIO_ONLY
    assert _files(work) == ["dubbed.wav"]
    # The page asks every project it opens; one with no video in says so.
    assert _state(jid) == {"video": None}
    for r in (_put(jid, tempo=2), _joined(jid)):
        assert r.status_code == 409 and r.json()["detail"] == AUDIO_ONLY
    # Taking out a video that was never in changes nothing.
    assert client.delete(f"/api/dub/jobs/{jid}/join/video").json() == {"video": None}
    assert _files(work) == ["dubbed.wav"]


def test_an_audio_project_that_is_not_finished_is_refused(lengths):
    jid, work = _job(status=JobStatus.RUNNING)
    r = _bring(jid)
    assert r.status_code == 409 and r.json()["detail"] == "Job not finished yet"
    assert _files(work) == ["dubbed.wav"] and _state(jid) == {"video": None}


def test_a_perso_dubbing_whose_sound_is_not_on_this_computer_is_refused(lengths):
    jid, work = _job(dub_mode="perso")
    os.remove(os.path.join(work, "dubbed.wav"))
    r = _bring(jid)
    assert r.status_code == 409 and r.json()["detail"] == "Result file not found"
    assert _files(work) == []
    # Nor when the record never had a result at all.
    state.job_store.update(jid, result=None)
    assert _bring(jid).status_code == 409


def test_an_audio_file_is_not_a_video_and_is_not_kept(lengths, monkeypatch):
    jid, work = _job()
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    r = _bring(jid, "song.mp3", b"ID3")
    assert r.status_code == 422 and r.json()["detail"] == "This tool takes video files only."
    assert _files(work) == ["dubbed.wav"] and _state(jid) == {"video": None}


def test_a_refused_file_leaves_the_video_already_in_as_it_was(lengths, monkeypatch):
    jid, work = _job()
    before = _bring(jid).json()
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    assert _bring(jid, "song.mp3", b"ID3").status_code == 422
    assert _state(jid) == before
    assert open(os.path.join(work, "join.mp4"), "rb").read() == b"MOV-bytes"
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4"]


def test_a_video_held_for_a_moment_is_replaced_once_it_is_let_go(lengths, hold):
    # Windows refuses to replace a file that is still open; the page lets go
    # of the picture a moment after it is asked to.
    jid, work = _job()
    _bring(jid)
    refused = hold("join.mp4", times=3)
    r = _bring(jid, "other.mp4", b"OTHER")
    assert r.status_code == 200 and r.json()["video"]["name"] == "other.mp4"
    assert refused == ["replace"] * 3
    assert open(os.path.join(work, "join.mp4"), "rb").read() == b"OTHER"
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4"]


def test_a_video_that_cannot_take_the_old_ones_place_changes_nothing(lengths, builds, hold):
    jid, work = _job()
    _bring(jid)
    before = _put(jid, video=[[0, 4]], tempo=2).json()
    _joined(jid)
    refused = hold("join.mp4")
    r = _bring(jid, "other.mp4", b"OTHER")
    assert r.status_code == 409 and r.json()["detail"] == IN_USE
    assert len(refused) == media.HOLD_TRIES + 1
    assert _state(jid) == before and _joined(jid).content == b"JOINED 1"
    assert open(os.path.join(work, "join.mp4"), "rb").read() == b"MOV-bytes"
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4", "joined.json", "joined.mp4"]


def test_a_file_with_no_length_is_not_a_video_either(lengths):
    jid, work = _job()
    lengths["join.mp4.part"] = 0.0
    r = _bring(jid)
    assert r.status_code == 422 and r.json()["detail"] == "That file does not look like a video."
    assert _files(work) == ["dubbed.wav"]


def test_a_full_disk_refuses_the_video_before_it_is_written(lengths, monkeypatch):
    jid, work = _job()
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 1024 ** 3)
    assert _bring(jid).status_code == 507
    assert _files(work) == ["dubbed.wav"]


def test_nothing_is_asked_of_a_project_with_no_video_in(lengths, builds):
    jid, work = _job()
    assert _state(jid) == {"video": None}
    for r in (_put(jid, tempo=2), _joined(jid)):
        assert r.status_code == 409 and r.json()["detail"] == NO_VIDEO
    assert client.get(f"/api/dub/jobs/{jid}/join/video").status_code == 404
    assert client.get(f"/api/media/join/{jid}/filmstrip").status_code == 404
    assert builds == [] and _files(work) == ["dubbed.wav"]


# --- the video, its kept parts and the speed ----------------------------------

def test_a_video_comes_in_whole_at_normal_speed(lengths):
    jid, work = _job()
    record = dict(state.job_store.get(jid))
    r = _bring(jid, "My Trip.mov")
    assert r.status_code == 200, r.text
    said = r.json()
    stamp = said.pop("stamp")
    assert said == {"video": {"name": "My Trip.mov", "seconds": 12.0}, "audio_seconds": 10.0,
                    "ranges": {"video": [[0.0, 12.0]], "audio": [[0.0, 10.0]]}, "tempo": 1.0}
    assert isinstance(stamp, str) and stamp
    assert _state(jid) == {**said, "stamp": stamp}
    # The user's bytes under a fixed name, and their name in join.json only:
    # the job's record, which its log and a failure report read, has not changed.
    assert open(os.path.join(work, "join.mp4"), "rb").read() == b"MOV-bytes"
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4"]
    assert state.job_store.get(jid) == record
    assert open(os.path.join(work, "dubbed.wav"), "rb").read() == b"DUBBED"


def test_only_the_files_own_name_is_kept_not_a_path(lengths):
    jid, _ = _job()
    assert _bring(jid, "/Users/me/Movies/clip.mp4").json()["video"]["name"] == "clip.mp4"


def test_the_picture_is_served_for_the_page_and_in_pieces(lengths):
    jid, _ = _job()
    _bring(jid, body=b"0123456789")
    r = client.get(f"/api/dub/jobs/{jid}/join/video")
    assert r.status_code == 200 and r.content == b"0123456789"
    assert r.headers["content-type"] == "video/mp4"
    r = client.get(f"/api/dub/jobs/{jid}/join/video", headers={"Range": "bytes=2-5"})
    assert r.status_code == 206 and r.content == b"2345"


def test_the_film_strip_route_draws_the_brought_in_video(lengths, monkeypatch, tmp_path):
    jid, work = _job()
    _bring(jid)
    strip = tmp_path / "strip.jpg"
    strip.write_bytes(b"JPEG")
    asked = []
    monkeypatch.setattr(media_preview, "filmstrip", lambda video: (asked.append(video), str(strip))[1])
    r = client.get(f"/api/media/join/{jid}/filmstrip")
    assert r.status_code == 200 and r.content == b"JPEG"
    assert asked == [os.path.join(work, "join.mp4")]


def test_kept_parts_and_speed_are_saved_and_read_back(lengths):
    jid, _ = _job()
    first = _bring(jid).json()
    r = _put(jid, video=[[0, 4], [6, 11.5]], audio=[[1, 9]], tempo=1.5)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["ranges"] == {"video": [[0.0, 4.0], [6.0, 11.5]], "audio": [[1.0, 9.0]]}
    assert saved["tempo"] == 1.5 and saved["video"] == first["video"] and saved["audio_seconds"] == 10.0
    assert saved["stamp"] != first["stamp"]
    assert _state(jid) == saved


def test_what_is_not_sent_stays_as_it_was(lengths):
    jid, _ = _job()
    _bring(jid)
    _put(jid, video=[[0, 4]], audio=[[1, 9]], tempo=2)
    # The speed control sends the speed alone, a cut on one lane that lane alone.
    assert _put(jid, tempo=3).json()["ranges"] == {"video": [[0.0, 4.0]], "audio": [[1.0, 9.0]]}
    after = _put(jid, audio=[[0, 10]]).json()
    assert after["ranges"] == {"video": [[0.0, 4.0]], "audio": [[0.0, 10.0]]} and after["tempo"] == 3.0


def test_a_save_that_changes_nothing_writes_nothing(lengths):
    jid, work = _job()
    _bring(jid)
    saved = _put(jid, video=[[0, 4]], tempo=2).json()
    path = os.path.join(work, "join.json")
    # A whole second: Windows keeps a file's time in steps of 100 ns.
    os.utime(path, ns=(10**9, 10**9))
    assert _put(jid, video=[[0, 4]], tempo=2).json() == saved
    assert _put(jid).json() == saved
    assert os.stat(path).st_mtime_ns == 10**9


@pytest.mark.parametrize("ranges", [
    {"video": [[3, 2]]},                    # backwards
    {"video": [[0, 4], [3, 8]]},            # overlapping
    {"video": [[0, 0.3]]},                  # under half a second in all
    {"audio": [[0, 5], [5.5, 5.55]]},       # a part under a tenth of a second
    {"audio": []},
    {"audio": "all of it"},
    {"video": [[0, "x"]]},
    {"video": [[-1, 4]]},
], ids=["backwards", "overlapping", "too-short", "sliver", "none", "words", "not-a-number", "before-zero"])
def test_kept_parts_that_make_no_sense_are_refused_and_nothing_changes(lengths, ranges):
    jid, _ = _job()
    before = _bring(jid).json()
    r = _put(jid, **ranges, tempo=2)
    assert r.status_code == 400 and r.json()["detail"] == BAD_RANGES
    assert _state(jid) == before


def test_each_lanes_parts_must_end_inside_its_own_file(lengths):
    jid, _ = _job()
    before = _bring(jid).json()
    # 11 seconds is inside the 12-second video and past the 10-second sound.
    assert _put(jid, video=[[0, 11]]).status_code == 200
    r = _put(jid, audio=[[0, 11]])
    assert r.status_code == 400 and "10.0s" in r.json()["detail"]
    r = _put(jid, video=[[0, 12.5]], audio=[[0, 5]])
    assert r.status_code == 400 and "12.0s" in r.json()["detail"]
    assert _state(jid)["ranges"] == {"video": [[0.0, 11.0]], "audio": before["ranges"]["audio"]}


@pytest.mark.parametrize("tempo", [1.25, 0, 4, -1, "fast", True, [2]])
def test_a_speed_that_is_not_one_of_the_five_is_refused(lengths, tempo):
    jid, _ = _job()
    before = _bring(jid).json()
    r = _put(jid, tempo=tempo, video=[[0, 4]])
    assert r.status_code == 422 and r.json()["detail"] == BAD_TEMPO
    assert _state(jid) == before


@pytest.mark.parametrize("tempo", [0.5, 1, 1.5, 2, 3])
def test_each_of_the_five_speeds_is_taken(lengths, tempo):
    jid, _ = _job()
    _bring(jid)
    assert _put(jid, tempo=tempo).json()["tempo"] == tempo


# --- the joined file: built when asked, and again only when something changed ---

def test_the_joined_video_is_built_on_first_ask_and_served(lengths, builds):
    jid, work = _job()
    _bring(jid)
    r = _joined(jid)
    assert r.status_code == 200 and r.content == b"JOINED 1"
    assert r.headers["content-type"] == "video/mp4" and "content-disposition" not in r.headers
    assert builds == [{"video": [[0.0, 12.0]], "audio": [[0.0, 10.0]], "tempo": 1.0,
                       "from": ("join.mp4", "dubbed.wav"), "what": "Could not make the dubbed video"}]
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4", "joined.json", "joined.mp4"]
    # Asked again, and to save it: the same file, named for the language.
    r = _joined(jid, "?download=1")
    assert r.content == b"JOINED 1" and len(builds) == 1
    assert r.headers["content-disposition"] == 'attachment; filename="dub_ko.mp4"'
    # A save that changes nothing does not make it old either.
    _put(jid, video=[[0, 12]], tempo=1)
    assert _joined(jid).content == b"JOINED 1"


def test_it_is_built_again_after_each_thing_that_changes_it(lengths, builds):
    jid, work = _job()
    _bring(jid)
    _joined(jid)
    stamps = [_state(jid)["stamp"]]

    def changed(n, **last):
        """The file is built an n-th time, with `last`, once and not twice."""
        assert _joined(jid).content == b"JOINED %d" % n
        assert _joined(jid).content == b"JOINED %d" % n and len(builds) == n
        assert {k: builds[-1][k] for k in last} == last
        stamps.append(_state(jid)["stamp"])

    _put(jid, video=[[0, 4], [6, 12]])
    changed(2, video=[[0.0, 4.0], [6.0, 12.0]], audio=[[0.0, 10.0]], tempo=1.0)
    _put(jid, audio=[[2, 9]])
    changed(3, video=[[0.0, 4.0], [6.0, 12.0]], audio=[[2.0, 9.0]])
    _put(jid, tempo=2)
    changed(4, tempo=2.0, audio=[[2.0, 9.0]])
    # A line remade: dubbed.wav is written again.
    sound = os.path.join(work, "dubbed.wav")
    os.utime(sound, ns=(os.stat(sound).st_atime_ns, os.stat(sound).st_mtime_ns + 1_000_000))
    changed(5, tempo=2.0)
    # Another video in its place: whole and at normal speed again, the old
    # joined file gone at once.
    lengths["join.mp4.part"] = lengths["join.mp4"] = 8.0
    assert _bring(jid, "other.mp4", b"OTHER").status_code == 200
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4"]
    changed(6, video=[[0.0, 8.0]], audio=[[0.0, 10.0]], tempo=1.0)
    # The address of the built file changes with each of them.
    assert len(set(stamps)) == len(stamps)


def test_a_save_that_arrives_during_a_build_makes_the_built_file_old(lengths, builds, monkeypatch):
    jid, _ = _job()
    _bring(jid)
    fake = media.join_video

    def slow_join_video(*args, **kw):
        if not builds:
            assert _put(jid, video=[[0, 5]]).status_code == 200
        fake(*args, **kw)

    monkeypatch.setattr(media, "join_video", slow_join_video)
    # The build that was running finishes with what it started from...
    assert _joined(jid).content == b"JOINED 1" and builds[0]["video"] == [[0.0, 12.0]]
    # ...and the next ask builds what was saved meanwhile.
    assert _joined(jid).content == b"JOINED 2" and builds[1]["video"] == [[0.0, 5.0]]
    assert _joined(jid).content == b"JOINED 2" and len(builds) == 2


def test_a_build_that_fails_says_why_and_is_tried_again_next_time(lengths, builds, monkeypatch):
    jid, work = _job()
    _bring(jid)
    _joined(jid)
    _put(jid, tempo=2)
    fake = media.join_video

    def broken(*args, **kw):
        raise RuntimeError("Could not make the dubbed video: join.mp4: Invalid data found")

    monkeypatch.setattr(media, "join_video", broken)
    r = _joined(jid)
    assert r.status_code == 503
    assert r.json()["detail"] == "Could not make the dubbed video: join.mp4: Invalid data found"
    # The file built before is not passed off as this one: going back to the
    # speed it was built at must not serve it without asking ffmpeg again.
    assert "joined.json" not in _files(work)
    monkeypatch.setattr(media, "join_video", fake)
    assert _joined(jid).content == b"JOINED 2" and builds[-1]["tempo"] == 2.0


def test_a_built_file_still_being_saved_is_kept_and_the_build_is_tried_again_next_time(lengths, builds, monkeypatch):
    # Windows refuses to replace joined.mp4 while a download still reads it
    # (media.join_video waits, then gives up: tests/test_media.py).
    jid, work = _job()
    _bring(jid)
    _joined(jid)
    _put(jid, tempo=2)
    fake = media.join_video

    def held(*args, **kw):
        raise PermissionError(13, "The process cannot access the file", os.path.join(work, "joined.mp4"))

    monkeypatch.setattr(media, "join_video", held)
    r = _joined(jid)
    assert r.status_code == 409 and r.json()["detail"] == IN_USE
    # The file built before is whole, and is not passed off as this one.
    assert open(os.path.join(work, "joined.mp4"), "rb").read() == b"JOINED 1"
    assert _files(work) == ["dubbed.wav", "join.json", "join.mp4", "joined.mp4"]
    monkeypatch.setattr(media, "join_video", fake)
    assert _joined(jid).content == b"JOINED 2" and builds[-1]["tempo"] == 2.0


def test_a_full_disk_refuses_the_build_and_an_already_built_file_is_still_served(lengths, builds, monkeypatch):
    jid, _ = _job()
    _bring(jid)
    _joined(jid)
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 1024 ** 3)
    assert _joined(jid).content == b"JOINED 1"
    _put(jid, tempo=2)
    assert _joined(jid).status_code == 507 and len(builds) == 1


def test_the_failure_is_said_in_korean_on_a_korean_computer(lengths, builds, monkeypatch):
    from app import i18n
    jid, _ = _job()
    _bring(jid)
    monkeypatch.setattr(i18n, "_language", "ko")
    _joined(jid)
    assert builds[0]["what"] == "더빙 영상을 만들지 못했어요"
    assert _put(jid, tempo=7).json()["detail"] == "오디오 속도는 0.5, 1, 1.5, 2, 3 중 하나여야 해요."
    client.delete(f"/api/dub/jobs/{jid}/join/video")
    assert _joined(jid).json()["detail"] == "먼저 영상을 가져와요."
    state.job_store.update(jid, media=None)
    assert _bring(jid).json()["detail"] == "오디오 프로젝트에서만 쓸 수 있어요."


def test_a_video_still_in_use_is_said_in_korean_on_a_korean_computer(lengths, hold, monkeypatch):
    from app import i18n
    jid, _ = _job()
    _bring(jid)
    monkeypatch.setattr(i18n, "_language", "ko")
    hold("join.mp4")
    assert _bring(jid).json()["detail"] == "영상을 아직 쓰고 있어요. 잠시 뒤에 다시 해 봐요."


# --- taking the video out -----------------------------------------------------

def test_taking_the_video_out_removes_its_files_and_nothing_else(lengths, builds):
    jid, work = _job()
    _bring(jid)
    _joined(jid)
    # What the timeline drew of it is kept beside it (app/media_preview.py).
    for name in ("join.mp4.filmstrip.jpg", "join.mp4.waveform.json", "input.mp4.waveform.json"):
        open(os.path.join(work, name), "wb").close()
    r = client.delete(f"/api/dub/jobs/{jid}/join/video")
    assert r.status_code == 200 and r.json() == {"video": None}
    assert _files(work) == ["dubbed.wav", "input.mp4.waveform.json"]
    assert open(os.path.join(work, "dubbed.wav"), "rb").read() == b"DUBBED"
    assert _state(jid) == {"video": None}
    assert _joined(jid).status_code == 409 and client.get(f"/api/dub/jobs/{jid}/join/video").status_code == 404
    # Asked twice, it is still out.
    assert client.delete(f"/api/dub/jobs/{jid}/join/video").json() == {"video": None}
    # And a video can come in again, whole.
    assert _bring(jid).json()["ranges"] == {"video": [[0.0, 12.0]], "audio": [[0.0, 10.0]]}


def test_a_video_that_cannot_be_taken_out_yet_stays_in_with_everything_it_had(lengths, builds, hold):
    # Windows refuses to delete a file the page is still playing. Its
    # join.json must not go without it: the page would say no video is in
    # while the file is there.
    jid, work = _job()
    _bring(jid)
    before = _put(jid, video=[[0, 4]], tempo=2).json()
    _joined(jid)
    for name in ("join.mp4.filmstrip.jpg", "join.mp4.waveform.json"):
        open(os.path.join(work, name), "wb").close()
    files = _files(work)
    refused = hold("join.mp4")
    r = client.delete(f"/api/dub/jobs/{jid}/join/video")
    assert r.status_code == 409 and r.json()["detail"] == IN_USE
    assert refused == ["remove"] * (media.HOLD_TRIES + 1)
    assert _files(work) == files and _state(jid) == before
    assert _joined(jid).content == b"JOINED 1" and len(builds) == 1


def test_a_video_held_for_a_moment_is_taken_out_once_it_is_let_go(lengths, builds, hold):
    jid, work = _job()
    _bring(jid)
    _joined(jid)
    refused = hold("join.mp4", times=3)
    r = client.delete(f"/api/dub/jobs/{jid}/join/video")
    assert r.status_code == 200 and r.json() == {"video": None}
    assert refused == ["remove"] * 3
    assert _files(work) == ["dubbed.wav"] and _state(jid) == {"video": None}


# --- the real thing -----------------------------------------------------------

def _ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True, capture_output=True)


def _streams(path, say="codec_type"):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=" + say, "-of", "json", path],
                         capture_output=True, text=True, check=True)
    return sorted(s[say] for s in json.loads(out.stdout)["streams"])


def _sound_of(path, start, end):
    """(loudness 0..1, pitch in Hz) of the file's sound between two moments."""
    rate = 8000
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(rate),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    part = samples[int(start * rate):int(end * rate)]
    loud = (sum(v * v for v in part) / len(part)) ** 0.5 / 32768
    crossings = sum(1 for a, b in zip(part, part[1:]) if (a < 0) != (b < 0))
    return loud, crossings / 2 / (end - start)


@pytest.fixture
def real_job(monkeypatch, tmp_path):
    """A finished audio project whose dubbed.wav is two seconds of a 440 Hz
    tone, with the real ffprobe. real_job.bring(sound=...) brings in a
    three-second video, with a 1 kHz tone of its own or silent, as H.264 in
    an MP4 unless told another codec and name."""
    monkeypatch.setattr(media, "media_kind", real_media_kind)

    class Job:
        jid, work = _job()
        sound = os.path.join(work, "dubbed.wav")

        @classmethod
        def bring(cls, sound=True, codec=("libx264", "yuv420p"), name="clip.mp4"):
            clip = str(tmp_path / name)
            own = ["-f", "lavfi", "-i", "sine=frequency=1000:duration=3", "-shortest"] if sound else []
            _ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=3", *own,
                    "-c:v", codec[0], "-pix_fmt", codec[1], clip)
            with open(clip, "rb") as f:
                cls.bytes = f.read()
            r = _bring(cls.jid, name, cls.bytes)
            assert r.status_code == 200, r.text
            return r.json()

        @classmethod
        def joined(cls):
            r = _joined(cls.jid)
            assert r.status_code == 200, r.text
            return os.path.join(cls.work, "joined.mp4")

    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "48000", "-ac", "2", Job.sound)
    with open(Job.sound, "rb") as f:
        Job.dubbed = f.read()
    yield Job
    # Whatever was built, the two files it was built from are as they came
    # and no scratch file is left beside them.
    assert open(Job.sound, "rb").read() == Job.dubbed
    assert open(os.path.join(Job.work, "join.mp4"), "rb").read() == Job.bytes
    assert _files(Job.work) == ["dubbed.wav", "join.json", "join.mp4", "joined.json", "joined.mp4"]


@needs_ffmpeg
@pytest.mark.parametrize("sound", [True, False], ids=["a-video-with-sound", "a-silent-video"])
def test_a_real_video_is_joined_with_the_dubbed_sound_alone_for_its_kept_length(real_job, sound):
    said = real_job.bring(sound)
    assert said["video"]["seconds"] == pytest.approx(3.0, abs=0.05)
    assert said["audio_seconds"] == pytest.approx(2.0, abs=0.01)
    built = real_job.joined()
    # One picture and one sound, the dubbed one: 440 Hz, not the video's own
    # 1 kHz. As long as the video, the last second silent.
    assert _streams(built) == ["audio", "video"]
    assert media.video_duration(built) == pytest.approx(3.0, abs=0.05)
    assert media.stream_duration(built, "a:0") == pytest.approx(3.0, abs=0.05)
    loud, pitch = _sound_of(built, 0.3, 1.7)
    assert loud > 0.05 and pitch == pytest.approx(440, rel=0.05)
    assert _sound_of(built, 2.3, 2.9)[0] < 0.005
    # Cut in the middle of both lanes: the picture's kept parts set the
    # length, and the sound's are laid end to end from the start.
    assert _put(real_job.jid, video=[[0.4, 1.2], [1.8, 2.6]], audio=[[0.2, 0.7], [1.0, 1.5]]
                ).status_code == 200
    built = real_job.joined()
    assert _streams(built) == ["audio", "video"]
    assert media.video_duration(built) == pytest.approx(1.6, abs=0.06)
    assert media.stream_duration(built, "a:0") == pytest.approx(1.6, abs=0.06)
    assert _sound_of(built, 0.1, 0.9)[0] > 0.05 and _sound_of(built, 1.2, 1.5)[0] < 0.005


@needs_ffmpeg
def test_real_double_speed_halves_the_sound_and_keeps_its_pitch(real_job):
    real_job.bring()
    assert _put(real_job.jid, tempo=2).status_code == 200
    built = real_job.joined()
    # Two seconds of tone play in one, at the pitch they had; the video is
    # as long as it was.
    assert media.video_duration(built) == pytest.approx(3.0, abs=0.05)
    loud, pitch = _sound_of(built, 0.2, 0.8)
    assert loud > 0.05 and pitch == pytest.approx(440, rel=0.05)
    assert _sound_of(built, 1.3, 2.9)[0] < 0.005
    # Three times as fast is two steps of the filter, and half speed one:
    # the tone ends at two thirds of a second, or fills the video.
    _put(real_job.jid, tempo=3)
    built = real_job.joined()
    loud, pitch = _sound_of(built, 0.1, 0.55)
    assert loud > 0.05 and pitch == pytest.approx(440, rel=0.05)
    assert _sound_of(built, 0.9, 2.9)[0] < 0.005
    _put(real_job.jid, tempo=0.5)
    built = real_job.joined()
    loud, pitch = _sound_of(built, 0.3, 2.8)
    assert loud > 0.05 and pitch == pytest.approx(440, rel=0.05)


@needs_ffmpeg
def test_a_real_mov_whose_picture_mp4_cannot_hold_is_encoded_and_joined(real_job):
    # ProRes, as a camera or an editing program writes it: copying it into
    # an MP4 fails, so the picture is encoded once and joined then.
    real_job.bring(codec=("prores_ks", "yuv422p10le"), name="clip.mov")
    built = real_job.joined()
    assert _streams(built, "codec_name") == ["aac", "h264"]
    assert media.video_duration(built) == pytest.approx(3.0, abs=0.05)
    assert _sound_of(built, 0.3, 1.7)[0] > 0.05
