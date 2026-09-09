"""The bridge to the subtitle eraser (app/eraser.py).

The eraser itself is a separate process under its own interpreter, so what is
worth pinning here is the conversation with that process, not the erasing: the
progress lines reaching the job's log, a cancel actually killing it rather than
waiting minutes for a stage that has no boundary, a failure carrying the last
thing the tool said, and the pack that is not installed being told apart from
one that ran and failed.

Both scripts are stood in for by a stub the tests write, run under this very
interpreter -- the real ones need paddleocr, a torch build and a 100 MB
detector, none of which belong in a unit test.
"""
import json
import os
import time

import pytest

from app import config, eraser
from app.jobs import JobCancelled

ERASE_STUB = '''
import argparse, json, os, shutil, sys, time
ap = argparse.ArgumentParser()
ap.add_argument("--vsr-dir", dest="vsr")
ap.add_argument("-i", "--input", dest="src")
ap.add_argument("-o", "--output", dest="out")
ap.add_argument("--area", nargs=4, type=int)
a = ap.parse_args()
print("a banner nobody reads", flush=True)
mode = os.environ.get("STUB_MODE", "ok")
if mode == "fail":
    print("a warning first", file=sys.stderr, flush=True)
    print("something went wrong deep inside", file=sys.stderr, flush=True)
    sys.exit(1)
for percent in (10, 55, 100):
    print("progress %d%%" % percent, flush=True)
if mode == "slow":
    time.sleep(30)
with open(a.out + ".args.json", "w") as f:
    json.dump({"vsr": a.vsr, "area": a.area, "check": os.environ.get(
        "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK")}, f)
shutil.copyfile(a.src, a.out)
print("done", flush=True)
'''

SUGGEST_STUB = '''
import argparse, json
ap = argparse.ArgumentParser()
ap.add_argument("--vsr-dir", dest="vsr")
ap.add_argument("-i", "--input", dest="src")
ap.parse_args()
print("a banner nobody reads")
print(json.dumps({"found": True, "area": [600, 800, 0, 500],
                  "width": 500, "height": 900, "frames": 9}))
'''

BAD_SUGGEST_STUB = '''
print("not json at all")
'''


@pytest.fixture
def installed(tmp_path, monkeypatch):
    """A pack that is "installed": this interpreter, a folder, and stubs in
    place of the two scripts."""
    import sys
    vsr = tmp_path / "vsr"
    vsr.mkdir()
    monkeypatch.setattr(config, "ERASER_PYTHON", sys.executable)
    monkeypatch.setattr(config, "ERASER_VSR_DIR", str(vsr))

    def use(name, source):
        path = tmp_path / name
        path.write_text(source, encoding="utf-8")
        monkeypatch.setattr(eraser, "ERASE_SCRIPT" if name == "erase.py" else "SUGGEST_SCRIPT",
                            str(path))

    use("erase.py", ERASE_STUB)
    use("suggest.py", SUGGEST_STUB)
    return tmp_path


def _video(tmp_path, name="input.mp4"):
    path = tmp_path / name
    path.write_bytes(b"video-bytes")
    return str(path)


def test_the_progress_lines_go_to_the_job_log(installed, tmp_path):
    lines = []
    out = str(tmp_path / "erased.mp4")
    eraser.run_erase(_video(tmp_path), out, (660, 800, 0, 608),
                     log=lines.append, cancel_check=lambda: False)
    assert lines == ["progress 10%", "progress 55%", "progress 100%"]
    # Nothing else the tool prints is worth a line in a user's job log.
    assert not any("banner" in line for line in lines)
    assert os.path.exists(out)


def test_the_band_is_passed_rows_first_and_the_host_check_is_skipped(installed, tmp_path):
    out = str(tmp_path / "erased.mp4")
    eraser.run_erase(_video(tmp_path), out, (660, 800, 0, 608),
                     log=lambda _: None, cancel_check=lambda: False)
    with open(out + ".args.json", encoding="utf-8") as f:
        seen = json.load(f)
    assert seen["area"] == [660, 800, 0, 608]
    assert seen["vsr"] == config.ERASER_VSR_DIR
    # Without this PaddleX spends seconds asking four model hosts whether they
    # are up -- and the eraser needs none of them.
    assert seen["check"] == "True"


def test_the_whole_frame_sends_no_band(installed, tmp_path):
    out = str(tmp_path / "erased.mp4")
    eraser.run_erase(_video(tmp_path), out, None, log=lambda _: None, cancel_check=lambda: False)
    with open(out + ".args.json", encoding="utf-8") as f:
        assert json.load(f)["area"] is None


def test_a_cancel_kills_the_run_instead_of_waiting_for_it(installed, tmp_path, monkeypatch):
    # There is no stage boundary inside one erase to stop politely at: the
    # stub would sleep for 30 seconds, and the user asked for it to stop now.
    monkeypatch.setenv("STUB_MODE", "slow")
    out = str(tmp_path / "erased.mp4")
    started = time.time()
    with pytest.raises(JobCancelled):
        eraser.run_erase(_video(tmp_path), out, None,
                         log=lambda _: None, cancel_check=lambda: True)
    assert time.time() - started < 10
    assert not os.path.exists(out)


def test_a_failure_carries_the_last_thing_the_tool_said(installed, tmp_path, monkeypatch):
    monkeypatch.setenv("STUB_MODE", "fail")
    with pytest.raises(RuntimeError, match="something went wrong deep inside"):
        eraser.run_erase(_video(tmp_path), str(tmp_path / "erased.mp4"), None,
                         log=lambda _: None, cancel_check=lambda: False)


def test_no_pack_is_its_own_answer(tmp_path, monkeypatch):
    # Not a failed run: the routes turn this into the 409 that offers the
    # download, and a job is never started at all.
    monkeypatch.setattr(config, "ERASER_PYTHON", "")
    monkeypatch.setattr(config, "ERASER_VSR_DIR", "")
    with pytest.raises(eraser.EraserMissing):
        eraser.run_erase(_video(tmp_path), str(tmp_path / "out.mp4"), None,
                         log=lambda _: None, cancel_check=lambda: False)
    with pytest.raises(eraser.EraserMissing):
        eraser.suggest_area(_video(tmp_path))


def test_a_pack_whose_files_are_gone_counts_as_missing(installed, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ERASER_VSR_DIR", str(tmp_path / "not-here"))
    with pytest.raises(eraser.EraserMissing):
        eraser.suggest_area(_video(tmp_path))


def test_suggest_area_reads_the_answer_past_the_banners(installed, tmp_path):
    assert eraser.suggest_area(_video(tmp_path)) == {
        "found": True, "area": [600, 800, 0, 500],
        "width": 500, "height": 900, "frames": 9,
    }


def test_suggest_area_says_so_when_the_answer_is_not_an_answer(installed, tmp_path, monkeypatch):
    bad = tmp_path / "bad.py"
    bad.write_text(BAD_SUGGEST_STUB, encoding="utf-8")
    monkeypatch.setattr(eraser, "SUGGEST_SCRIPT", str(bad))
    with pytest.raises(RuntimeError, match="Could not read where the subtitles are"):
        eraser.suggest_area(_video(tmp_path))
