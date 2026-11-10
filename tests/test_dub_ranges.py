"""Dubbing only the parts kept on the timeline: POST /api/dub/start `ranges`.

One kept part is a trim and goes down the trim's own path. Several are cut
out and joined into one video before the job starts (app/media.py
cut_ranges), and that joined video is the job's original -- the held or
uploaded file itself is never touched. The last tests run the real ffmpeg on
a tiny generated video.
"""
import json
import os
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, media, state
from app.api import _launch as launch_api
from app.api import dub as dub_api
from app.main import app
from tests.marks import needs_ffmpeg

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _ready(monkeypatch):
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])
    for name in ("gemma", "hunyuan", "qwen"):
        monkeypatch.setattr(engines_status, f"{name}_available", lambda: True)
        monkeypatch.setattr(engines_status, f"{name}_status", lambda: "available")
    monkeypatch.setattr(engines_status, "gemini_available", lambda: True)
    monkeypatch.setattr(engines_status, "perso_available", lambda: True)
    # A 10-second video, as far as the length check can tell.
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)


def _wait_done(jid, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/api/dub/jobs/{jid}").json()["status"]
        if status in ("done", "error", "cancelled"):
            return status
        time.sleep(0.02)
    raise AssertionError("job never finished")


def _job_files(name="input.mp4"):
    return [os.path.join(root, f) for root, _d, files in os.walk(state.WORKSPACE)
            for f in files if f == name]


def _start(ranges, **extra):
    data = {"language_code": "ko", "language": "Korean", "ranges": json.dumps(ranges), **extra}
    return client.post("/api/dub/start", files={"video": ("a.mp4", b"0" * 10, "video/mp4")},
                       data=data)


# --- checking what was sent ------------------------------------------------

@pytest.mark.parametrize("raw", [
    [[3, 5], [1, 2]],            # out of order
    [[0, 3], [2, 5]],            # overlapping
    [[0, 3], [3, 3.05]],         # a sliver
    [[0, 0.2], [1, 1.2]],        # under half a second in all
    [[-1, 2]],                   # before the start
    [],                          # nothing kept
    [[0]],                       # not a pair
    "0-5",                       # not a list
])
def test_broken_ranges_are_refused_before_anything_is_saved(monkeypatch, raw):
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda *a, **kw: pytest.fail("must not cut"))
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: pytest.fail("must not dub"))
    r = _start(raw)
    assert r.status_code == 400
    assert "kept parts" in r.json()["detail"]
    assert _job_files() == []


def test_infinity_and_nan_are_refused():
    for raw in ('[[0, Infinity]]', '[[NaN, 2]]'):
        r = client.post("/api/dub/start", files={"video": ("a.mp4", b"0", "video/mp4")},
                        data={"language_code": "ko", "ranges": raw})
        assert r.status_code == 400


def test_ranges_and_a_trim_together_are_refused():
    r = _start([[0, 2], [4, 6]], trim_start="0", trim_end="5")
    assert r.status_code == 400
    assert "not both" in r.json()["detail"]


def test_parts_past_the_end_of_the_video_are_refused(monkeypatch):
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda *a, **kw: pytest.fail("must not cut"))
    r = _start([[0, 2], [8, 12]])
    assert r.status_code == 400
    assert "past the end" in r.json()["detail"]
    assert _job_files() == []


# --- one part is a trim ----------------------------------------------------

def test_one_kept_part_is_exactly_a_trim(monkeypatch):
    cuts = []
    monkeypatch.setattr(dub_api, "_cut_video", lambda p, a, b: cuts.append((a, b)))
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda *a, **kw: pytest.fail("a trim, not a join"))
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: None)
    r = _start([[2, 8]])
    assert r.status_code == 200, r.text
    assert cuts == [(2.0, 8.0)]
    job = client.get(f"/api/dub/jobs/{r.json()['job_id']}").json()
    assert job["trim"] == {"start": 2.0, "end": 8.0}
    assert "ranges" not in job


# --- several parts are joined before the job starts --------------------------

def test_several_parts_are_joined_into_the_jobs_own_copy(monkeypatch):
    joined = []

    def fake_join(path, ranges, on_cut=None):
        joined.append((path, ranges))
        with open(path, "wb") as f:
            f.write(b"JOINED")

    seen = {}

    def fake_run_dub(**kw):
        seen["input"] = open(kw["video_path"], "rb").read()
        return

    monkeypatch.setattr(dub_api, "_cut_ranges", fake_join)
    monkeypatch.setattr(dub_api, "_cut_video", lambda *a, **kw: pytest.fail("not a trim"))
    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    r = _start([[0, 2.5], [4, 9.5]])
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    _wait_done(jid)
    job = state.job_store.get(jid)
    assert joined == [(os.path.join(job["work_dir"], "input.mp4"), [[0.0, 2.5], [4.0, 9.5]])]
    assert seen["input"] == b"JOINED"
    assert job["ranges"] == [[0.0, 2.5], [4.0, 9.5]]
    assert job["ranges_pending"] is False
    assert job["trim"] is None


def test_a_held_video_is_never_changed(monkeypatch, tmp_path):
    from app.api import downloads as dl
    held = dl.download_store.add_file(str(tmp_path / "ws"), "Cats", 10,
                                      lambda dest: open(dest, "wb").write(b"HELD"))

    def fake_join(path, ranges, on_cut=None):
        with open(path, "wb") as f:
            f.write(b"JOINED")

    monkeypatch.setattr(dub_api, "_cut_ranges", fake_join)
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: None)
    r = client.post("/api/dub/start", data={"language_code": "ko", "download_id": held.id,
                                            "ranges": json.dumps([[0, 2], [3, 5]])})
    assert r.status_code == 200, r.text
    assert open(held.path, "rb").read() == b"HELD"


def test_a_failed_join_answers_with_a_sentence_and_leaves_no_folder(monkeypatch):
    def boom(path, ranges, on_cut=None):
        raise RuntimeError("Could not join the kept parts: moov atom not found")

    monkeypatch.setattr(dub_api, "_cut_ranges", boom)
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: pytest.fail("must not dub"))
    r = _start([[0, 2], [4, 6]])
    assert r.status_code == 400
    assert "Could not join" in r.json()["detail"]
    assert _job_files() == []


def test_a_link_is_joined_inside_the_job_after_the_download(monkeypatch):
    order = []

    def fake_fetch(url, dest, log=None, cancel_check=None):
        order.append("fetch")
        open(dest, "wb").write(b"WHOLE")

    def fake_join(path, ranges, on_cut=None):
        order.append(("join", ranges))
        on_cut()

    monkeypatch.setattr(dub_api, "fetch_source", fake_fetch)
    monkeypatch.setattr(dub_api, "_cut_ranges", fake_join)
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: order.append("dub"))
    r = client.post("/api/dub/start", data={"language_code": "ko", "source_url": "https://youtu.be/x",
                                            "ranges": json.dumps([[0, 1], [2, 3]])})
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    _wait_done(jid)
    assert order == ["fetch", ("join", [[0.0, 1.0], [2.0, 3.0]]), "dub"]
    assert state.job_store.get(jid)["ranges_pending"] is False


def test_try_again_reuses_the_joined_video(monkeypatch):
    def fake_join(path, ranges, on_cut=None):
        with open(path, "wb") as f:
            f.write(b"JOINED")

    monkeypatch.setattr(dub_api, "_cut_ranges", fake_join)

    def fail(**kw):
        raise RuntimeError("no dub today")

    monkeypatch.setattr(dub_api, "run_dub", fail)
    jid = _start([[0, 2], [4, 6]]).json()["job_id"]
    assert _wait_done(jid) == "error"

    monkeypatch.setattr(dub_api, "_cut_ranges", lambda *a, **kw: pytest.fail("joined already"))
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200, r.text
    new = state.job_store.get(r.json()["job_id"])
    assert open(os.path.join(new["work_dir"], "input.mp4"), "rb").read() == b"JOINED"
    assert new["ranges"] == [[0.0, 2.0], [4.0, 6.0]] and new["ranges_pending"] is False
    _wait_done(new["id"])


def test_resume_works_on_the_joined_video_in_place(monkeypatch):
    def fake_join(path, ranges, on_cut=None):
        with open(path, "wb") as f:
            f.write(b"JOINED")

    monkeypatch.setattr(dub_api, "_cut_ranges", fake_join)
    seen = []

    def fail(**kw):
        seen.append(open(kw["video_path"], "rb").read())
        raise RuntimeError("no dub today")

    monkeypatch.setattr(dub_api, "run_dub", fail)
    jid = _start([[0, 2], [4, 6]]).json()["job_id"]
    assert _wait_done(jid) == "error"
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda *a, **kw: pytest.fail("joined already"))
    monkeypatch.setattr(dub_api, "_require_voice_engine_running", lambda voice=None: None)
    r = client.post(f"/api/dub/jobs/{jid}/resume")
    assert r.status_code == 200, r.text
    _wait_done(jid)
    assert seen == [b"JOINED", b"JOINED"]


# --- the ffmpeg command -----------------------------------------------------

def test_the_join_command_cuts_each_part_exactly_and_encodes_once():
    argv = media.cut_ranges_command("/v/in.mp4", "/v/out.mp4", [[0, 1.5], [3, 4.25]])
    graph = argv[argv.index("-filter_complex") + 1]
    assert "[0:v]trim=start=0.000:end=1.500,setpts=PTS-STARTPTS[v0]" in graph
    assert "[0:a]atrim=start=3.000:end=4.250,asetpts=PTS-STARTPTS[a1]" in graph
    assert graph.endswith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
    assert "copy" not in argv, "a copy-cut lands on keyframes, seconds away"
    assert argv[argv.index("-c:v") + 1] == "libx264"
    assert argv[-1] == "/v/out.mp4"
    # No sound track: the picture alone is joined.
    silent = media.cut_ranges_command("/v/in.mp4", "/v/out.mp4", [[0, 1], [2, 3]], audio=False)
    assert "[a]" not in " ".join(silent)
    assert silent[silent.index("-filter_complex") + 1].endswith("concat=n=2:v=1:a=0[v]")


# --- the real thing ----------------------------------------------------------

def _make_video(path, seconds=4, audio=True):
    argv = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
            f"testsrc=size=160x90:rate=25:duration={seconds}"]
    if audio:
        argv += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-shortest"]
    argv += ["-c:v", "libx264", "-pix_fmt", "yuv420p", path]
    subprocess.run(argv, check=True, capture_output=True)


def _real_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(out.stdout.strip().rstrip(","))


@needs_ffmpeg
@pytest.mark.parametrize("audio", [True, False])
def test_a_real_join_is_as_long_as_the_parts_kept(monkeypatch, tmp_path, audio):
    monkeypatch.undo()   # the real ffprobe, not the 10-second stand-in
    video = str(tmp_path / "input.mp4")
    _make_video(video, audio=audio)
    size_before = os.path.getsize(video)
    recorded = []
    media.cut_ranges(video, [[0.0, 1.0], [2.0, 3.5]], on_cut=lambda: recorded.append(True))
    assert abs(_real_duration(video) - 2.5) <= 0.1
    assert media.video_size(video) == (160, 90)
    assert media.has_audio(video) is audio
    assert recorded == [True]
    assert os.path.getsize(video) != size_before
    assert not os.path.exists(video + ".cut.mp4")


# --- the sound alone (Export's "Audio only") ---------------------------------

def test_the_audio_command_joins_the_kept_parts_sound_and_drops_the_picture():
    argv = media.audio_command("/v/in.mp4", "/v/out.mp3", "mp3", [[0, 1.5], [3, 4.25]])
    graph = argv[argv.index("-filter_complex") + 1]
    assert graph == ("[0:a]atrim=start=0.000:end=1.500,asetpts=PTS-STARTPTS[a0];"
                     "[0:a]atrim=start=3.000:end=4.250,asetpts=PTS-STARTPTS[a1];"
                     "[a0][a1]concat=n=2:v=0:a=1[a]")
    assert argv[argv.index("-c:a") + 1] == "libmp3lame" and argv[-1] == "/v/out.mp3"
    whole = media.audio_command("/v/in.mp4", "/v/out.wav", "wav")
    assert "-vn" in whole and "-filter_complex" not in whole
    assert whole[whole.index("-c:a") + 1] == "pcm_s16le"


@needs_ffmpeg
@pytest.mark.parametrize("fmt", ["mp3", "wav"])
def test_a_real_audio_save_is_as_long_as_the_parts_kept(monkeypatch, tmp_path, fmt):
    monkeypatch.undo()
    video = str(tmp_path / "input.mp4")
    _make_video(video)
    out = str(tmp_path / ("sound." + fmt))
    media.run_new_file(media.audio_command(video, out, fmt, [[0.0, 1.0], [2.0, 3.5]]),
                       2.5, "Could not save the audio")
    assert abs(_real_duration(out) - 2.5) <= 0.1
    assert media.has_audio(out)
    whole = str(tmp_path / ("whole." + fmt))
    media.run_new_file(media.audio_command(video, whole, fmt), 4, "Could not save the audio")
    assert abs(_real_duration(whole) - 4.0) <= 0.1


@needs_ffmpeg
def test_a_failed_save_leaves_no_file_and_names_no_folder(monkeypatch, tmp_path):
    monkeypatch.undo()
    bad = str(tmp_path / "not-a-video.mp4")
    with open(bad, "wb") as f:
        f.write(b"nope")
    out = str(tmp_path / "sound.mp3")
    with pytest.raises(RuntimeError) as e:
        media.run_new_file(media.audio_command(bad, out, "mp3"), 0, "Could not save the audio")
    assert str(e.value).startswith("Could not save the audio")
    assert str(tmp_path) not in str(e.value)
    assert not os.path.exists(out)
