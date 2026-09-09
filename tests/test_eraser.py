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

from app import engines_status, eraser
from app.jobs import JobCancelled
from app.scripts import erase_subtitles

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
if mode == "nosub":
    print("Traceback (most recent call last):", file=sys.stderr, flush=True)
    print("    raise Exception(tr['Main']['NoSubtitleDetected'].format(self.video_path))",
          file=sys.stderr, flush=True)
    print("Exception: No subtitles detected. Check file: /Users/x/holiday.mp4",
          file=sys.stderr, flush=True)
    sys.exit(1)
for percent in (10, 55, 100):
    print("progress %d%%" % percent, flush=True)
if mode == "slow":
    time.sleep(30)
print('check {"frames_checked": 40, "frames_with_text": 0, "sample_times": []}', flush=True)
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


def kit_env(tmp_path, monkeypatch, text=""):
    """A desktop kit whose kit.env says `text`. The file is what the shell
    writes the pack's two lines into, and rewriting it is how these tests
    install and remove the pack while the app is "running"."""
    kit = tmp_path / "kit"
    kit.mkdir(exist_ok=True)
    path = kit / "kit.env"
    path.write_text(text, encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    return path


@pytest.fixture
def installed(tmp_path, monkeypatch):
    """A pack that is "installed": this interpreter, a folder, and stubs in
    place of the two scripts."""
    import sys
    vsr = tmp_path / "vsr"
    vsr.mkdir()
    kit_env(tmp_path, monkeypatch,
            "ERASER_PYTHON=%s\nERASER_VSR_DIR=%s\n" % (sys.executable, vsr))

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
    # The check is a number for the record, not a line in the user's log.
    assert not any("check" in line for line in lines)
    assert lines == ["progress 10%", "progress 55%", "progress 100%"]
    # Nothing else the tool prints is worth a line in a user's job log.
    assert not any("banner" in line for line in lines)
    assert os.path.exists(out)


def test_what_the_eraser_found_when_it_checked_its_own_work_comes_back(installed, tmp_path):
    # The screen and the agent show this; a job that says "done" while three
    # letters are still on screen is the one thing this feature cannot do.
    check = eraser.run_erase(_video(tmp_path), str(tmp_path / "erased.mp4"), None,
                             log=lambda _: None, cancel_check=lambda: False)
    assert check == {"frames_checked": 40, "frames_with_text": 0, "sample_times": []}


def test_the_band_is_passed_rows_first_and_the_host_check_is_skipped(installed, tmp_path):
    out = str(tmp_path / "erased.mp4")
    eraser.run_erase(_video(tmp_path), out, (660, 800, 0, 608),
                     log=lambda _: None, cancel_check=lambda: False)
    with open(out + ".args.json", encoding="utf-8") as f:
        seen = json.load(f)
    assert seen["area"] == [660, 800, 0, 608]
    assert seen["vsr"] == eraser.paths_now()[1]
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


def test_a_band_with_no_writing_in_it_tells_the_user_what_to_do(installed, tmp_path, monkeypatch):
    # Not a fault to report: the box simply missed the subtitles, and the way
    # out is to move it. The tool's own sentence ends in the user's file path,
    # so it is not the one shown.
    monkeypatch.setenv("STUB_MODE", "nosub")
    with pytest.raises(RuntimeError) as failed:
        eraser.run_erase(_video(tmp_path), str(tmp_path / "erased.mp4"), (0, 100, 0, 100),
                         log=lambda _: None, cancel_check=lambda: False)
    assert str(failed.value) == eraser.NO_SUBTITLES_MESSAGE
    assert "holiday.mp4" not in str(failed.value)


def test_no_pack_is_its_own_answer(tmp_path, monkeypatch):
    # Not a failed run: the routes turn this into the 409 that offers the
    # download, and a job is never started at all.
    kit_env(tmp_path, monkeypatch)
    with pytest.raises(eraser.EraserMissing):
        eraser.run_erase(_video(tmp_path), str(tmp_path / "out.mp4"), None,
                         log=lambda _: None, cancel_check=lambda: False)
    with pytest.raises(eraser.EraserMissing):
        eraser.suggest_area(_video(tmp_path))


def test_a_pack_whose_files_are_gone_counts_as_missing(installed, tmp_path, monkeypatch):
    import sys
    kit_env(tmp_path, monkeypatch,
            "ERASER_PYTHON=%s\nERASER_VSR_DIR=%s\n" % (sys.executable, tmp_path / "not-here"))
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


def test_the_pack_is_seen_the_moment_kit_env_names_it(tmp_path, monkeypatch):
    """No restart. The pack is downloaded while the app is open and the desktop
    shell writes its two lines into kit.env there and then -- a value read once
    at startup kept the screen refusing until the next launch."""
    import sys
    vsr = tmp_path / "vsr"
    vsr.mkdir()
    monkeypatch.delenv("ERASER_PYTHON", raising=False)
    monkeypatch.delenv("ERASER_VSR_DIR", raising=False)
    path = kit_env(tmp_path, monkeypatch, "PERSODUB_NO_ANALYTICS=0\n")
    assert engines_status.eraser_available() is False

    path.write_text("ERASER_PYTHON=%s\nERASER_VSR_DIR=%s\n" % (sys.executable, vsr),
                    encoding="utf-8")
    assert engines_status.eraser_available() is True

    # Removing the pack takes the two lines back out, and no line means no pack.
    path.write_text("PERSODUB_NO_ANALYTICS=0\n", encoding="utf-8")
    assert engines_status.eraser_available() is False


# --- the seam between two sentences ----------------------------------------

def _detector_class(stretches):
    class Detect:
        @staticmethod
        def find_continuous_ranges_with_same_mask(sub_list):
            return list(stretches)
    return Detect


def test_the_mask_at_a_seam_carries_both_sentences_and_the_stretches_do_not_move():
    """Where one line gives way to a longer one, the tool paints the changeover
    frames with the OLD line's boxes and the new line's ends survive. Folding
    the neighbours in fixes that without moving a single stretch edge."""
    short = (100, 300, 660, 800)      # xmin, xmax, ymin, ymax
    long_line = (20, 580, 660, 800)
    sub_list = {1: [short], 2: [short], 3: [short],
                4: [long_line], 5: [long_line], 6: [long_line]}
    detector = _detector_class([(1, 3), (4, 6)])

    erase_subtitles.widen_masks_at_seams(detector, frames=2)
    stretches = detector.find_continuous_ranges_with_same_mask(sub_list)

    assert stretches == [(1, 3), (4, 6)]
    # The frames at the changeover now carry the longer line too, so the mask
    # built from the first stretch covers its ends.
    assert long_line in sub_list[3]
    assert short in sub_list[4]
    # Away from the seam nothing is added -- the picture there is not repainted
    # for no reason.
    assert sub_list[1] == [short]
    assert sub_list[6] == [long_line]


def test_the_tool_s_own_ffmpeg_is_used_where_the_computer_has_none(tmp_path, monkeypatch):
    # A Windows kit need not have ffmpeg on PATH, and the eraser has to put the
    # sound back without one. video-subtitle-remover ships a copy per platform.
    monkeypatch.setattr(erase_subtitles.shutil, "which", lambda _name: None)
    monkeypatch.setattr(erase_subtitles.platform, "system", lambda: "Darwin")
    bundled = tmp_path / "backend" / "ffmpeg" / "macos"
    bundled.mkdir(parents=True)
    (bundled / "ffmpeg").write_text("", encoding="utf-8")

    assert erase_subtitles.find_tool("ffmpeg", str(tmp_path)) == str(bundled / "ffmpeg")
    # No ffprobe is shipped, and asking a name that is not there would hang the
    # run on a missing executable -- has_audio answers yes instead.
    assert erase_subtitles.find_tool("ffprobe", str(tmp_path)) == "ffprobe"
    assert erase_subtitles.has_audio("clip.mp4", "ffprobe") is True
