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
print('check {"frames_checked": 40, "frames_with_text": 0, "sample_times": [], '
      '"repainted": 0}', flush=True)
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
    assert check == {"frames_checked": 40, "frames_with_text": 0,
                     "sample_times": [], "repainted": 0}


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

    erase_subtitles.widen_masks(detector, frames=2)
    stretches = detector.find_continuous_ranges_with_same_mask(sub_list)

    assert stretches == [(1, 3), (4, 6)]
    # The frames at the changeover now carry the longer line too, so the mask
    # built from the first stretch covers its ends.
    roomy_short = erase_subtitles.pad_sideways(short)
    roomy_long = erase_subtitles.pad_sideways(long_line)
    assert roomy_long in sub_list[3]
    assert roomy_short in sub_list[4]
    # Away from the seam only the box's own elbow room is added -- the picture
    # there is not repainted for no reason.
    assert sub_list[1] == [roomy_short]
    assert sub_list[6] == [roomy_long]


def test_a_box_is_given_room_for_the_stroke_the_detector_stopped_short_of():
    # A box tight around the letters leaves the outline and the last stroke
    # outside the mask, and that is what stays behind as a smear.
    assert erase_subtitles.pad_sideways((100, 300, 660, 800)) == (88, 312, 660, 800)
    # Never off the left edge of the frame, and a tiny box still gets pixels.
    assert erase_subtitles.pad_sideways((2, 20, 10, 30)) == (0, 26, 10, 30)


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


# --- the check the eraser runs on its own work ------------------------------

def test_the_check_reads_the_changeovers_first_and_sweeps_the_rest_after():
    """Three sentences over three seconds. The frames worth an OCR pass are the
    six stretch edges and the six frames they turn into; only then is the rest
    of the video worth a thin sweep, because that is where nothing can have
    gone wrong."""
    order = erase_subtitles.frames_to_check(90, 30.0, [(1, 30), (31, 60), (61, 90)])

    assert order[:6] == [1, 30, 31, 60, 61, 90]
    assert order[6:9] == [2, 32, 62]
    # No frame is read twice, and none of them is outside the video.
    assert len(order) == len(set(order))
    assert all(1 <= no <= 90 for no in order)
    # Everything after the sweep sits within 0.3s -- nine frames at 30fps -- of
    # a changeover: past that a survivor is not what would be found.
    edges = {1, 30, 31, 60, 61, 90}
    assert all(any(abs(no - edge) <= 10 for edge in edges) for no in order)


def test_a_video_with_more_changeovers_than_the_check_can_read_is_thinned_evenly():
    # An hour of subtitles has thousands of stretch edges. Reading the first
    # three hundred would be a check of the opening titles, so the round is
    # spread over the whole video instead.
    stretches = [(n, n + 9) for n in range(1, 100000, 10)]
    order = erase_subtitles.frames_to_check(100000, 30.0, stretches)

    assert len(order) == erase_subtitles.MAX_CHECKS
    assert max(order) > 90000
    assert order == sorted(order)          # one round only: it is already in order


def test_with_no_changeovers_to_aim_at_the_check_is_the_plain_sweep():
    order = erase_subtitles.frames_to_check(300, 30.0, [])
    assert order == list(range(1, 301, 30))


class _FakeFrame:
    """Stands in for a decoded picture: it remembers whether it was cropped."""

    def __init__(self, no, cropped=False):
        self.no, self.cropped = no, cropped

    def __getitem__(self, _key):
        return _FakeFrame(self.no, cropped=True)


def _fake_cv2(total, fps):
    import types

    class Cap:
        def __init__(self, path):
            self.pos = 0

        def get(self, prop):
            return {"fps": fps, "count": total}[prop]

        def set(self, prop, value):
            self.pos = int(value)

        def read(self):
            self.pos += 1
            return (self.pos <= total, _FakeFrame(self.pos))

        def release(self):
            pass

    mod = types.ModuleType("cv2")
    mod.CAP_PROP_FPS, mod.CAP_PROP_FRAME_COUNT, mod.CAP_PROP_POS_FRAMES = "fps", "count", "pos"
    mod.VideoCapture = Cap
    return mod


def _fake_detector(with_text, seen_crops):
    class Detect:
        def __init__(self, path, sub_areas):
            self.sub_areas = sub_areas

        def detect_subtitle(self, frame):
            seen_crops.append((frame.no, frame.cropped, tuple(self.sub_areas)))
            # (xmin, xmax, ymin, ymax), the detector's own order, in the
            # coordinates of whatever picture it was handed.
            return [(10, 20, 30, 40)] if frame.no in with_text else []
    return Detect


def test_the_check_says_how_many_frames_it_read_and_where_the_writing_is(monkeypatch):
    seen = []
    monkeypatch.setitem(__import__("sys").modules, "cv2", _fake_cv2(90, 30.0))
    area = (660, 800, 0, 608)

    check, leftovers = erase_subtitles.check_result(
        "erased.mp4", area, _fake_detector({31, 61}, seen), frames=[1, 31, 61, 90])

    assert check == {"frames_checked": 4, "frames_with_text": 2,
                     "sample_times": [1.0, 2.0]}
    # The boxes come back in the frame's own corner, not the crop's: the second
    # pass paints them, and it works in whole-frame coordinates.
    assert leftovers == {31: [(10, 20, 690, 700)], 61: [(10, 20, 690, 700)]}
    # The detector was shown the band, not the whole picture -- ten times
    # cheaper -- with its areas moved to the crop's own corner, and it got its
    # own areas back afterwards.
    assert [no for no, _crop, _areas in seen] == [1, 31, 61, 90]
    assert all(cropped for _no, cropped, _areas in seen)
    assert all(areas == ((0, 140, 0, 608),) for _no, _cropped, areas in seen)


def test_the_check_stops_when_its_share_of_the_time_is_spent(monkeypatch):
    seen = []
    monkeypatch.setitem(__import__("sys").modules, "cv2", _fake_cv2(90, 30.0))

    check, _leftovers = erase_subtitles.check_result(
        "erased.mp4", None, _fake_detector(set(), seen), frames=list(range(1, 91)),
        deadline=time.monotonic() - 1)

    # An OCR pass is seconds, not milliseconds: a check that outlasted the
    # erasing would be the slowest thing in the app.
    assert check["frames_checked"] == 0
    assert seen == []


def test_the_second_pass_paints_the_boxes_the_check_drew_and_not_the_band():
    """Handing the model the whole band as one mask is what sttn-auto does, and
    on a wide band it smears the picture instead of filling it. The check has
    just said where the writing is; that is what gets painted."""
    found = {50: [(100, 300, 900, 960)]}

    fixed = erase_subtitles.masks_for_repaint(found, 30.0)

    # Nine frames either side -- a survivor lasts longer than the one frame the
    # check happened to look at.
    assert sorted(fixed) == list(range(41, 60))
    assert fixed[41] == [erase_subtitles.pad_sideways((100, 300, 900, 960))]
    # Two frames that survived close together share one box list, once each.
    fixed = erase_subtitles.masks_for_repaint({50: [(100, 300, 900, 960)],
                                               52: [(100, 300, 900, 960)]}, 30.0)
    assert fixed[50] == [erase_subtitles.pad_sideways((100, 300, 900, 960))]


# --- the band the user drew is not the band the tool is given ---------------

def test_the_band_is_let_out_before_the_tool_sees_it_and_never_off_the_picture():
    """vsr only counts a box that falls ENTIRELY inside the area, so a band a
    few pixels short of the letters' outline is not "nothing to do" -- it is a
    crash. More room up and down, where the miss happens, than at the ends."""
    # 140 tall, 608 wide: 6% of 140 is 8, 4% of 608 is 24.
    assert erase_subtitles.pad_band((660, 800, 0, 608), 608, 1080) == (652, 808, 0, 608)
    # The picture's own edges are the limit in all four directions.
    assert erase_subtitles.pad_band((4, 1076, 6, 602), 608, 1080) == (0, 1080, 0, 608)
    # A thin band still gets whole pixels, not a fraction of one.
    assert erase_subtitles.pad_band((500, 520, 300, 340), 608, 1080) == (492, 528, 292, 348)



class _NothingFound(Exception):
    pass


def _remover_class(fail_times, bands):
    """A stand-in for SubtitleRemover that fails the first `fail_times` runs
    the way vsr does when the band caught no writing it would take."""
    state = {"runs": 0}

    class Remover:
        def __init__(self, path):
            self.sub_areas = []
            self.video_out_path = None

        def run(self):
            state["runs"] += 1
            bands.append(tuple(self.sub_areas[0]) if self.sub_areas else None)
            if state["runs"] <= fail_times:
                raise _NothingFound(
                    "No subtitles detected. Check file: /Users/x/holiday.mp4")
    Remover.runs = state
    return Remover


# The white subtitle of the 1080p short the eraser was measured on: the box
# runs 41 pixels below the band the brief drew, which is why no percentage was
# ever going to be the right amount to widen by.
CLIP_B_BAND = (850, 970, 420, 1920)
CLIP_B_TEXT = [(898, 1492, 957, 1011), (906, 1480, 961, 1009),
               (102, 312, 963, 1005)]      # the last one is the side panel


def test_a_band_that_caught_nothing_is_asked_of_the_detector_and_tried_once_more(capsys):
    bands = []
    remover = _remover_class(fail_times=1, bands=bands)

    _seconds, band = erase_subtitles.erase_with_band(
        remover, "in.mp4", "out.mp4", CLIP_B_BAND, 1920, 1080,
        find_text=lambda: CLIP_B_TEXT)

    # Twice, and only twice: the padded band, then the one the writing needs.
    # The side panel at x 102..312 never touches the band, so it is not in it.
    assert remover.runs["runs"] == 2
    # The writing runs to row 1011, 41 below the band the user drew; the second
    # band covers it and is let out by the usual 6% and 4% on top.
    assert bands == [(842, 978, 360, 1920), (949, 1019, 874, 1516)]
    assert band == (949, 1019, 874, 1516)
    said = capsys.readouterr().out.splitlines()
    assert said == ["band 842..978 x 360..1920 (padded from 850..970 x 420..1920)",
                    "band 949..1019 x 874..1516 "
                    "(from detected text overlapping 850..970 x 420..1920)"]


def test_only_the_boxes_that_touch_the_band_are_taken_and_then_taken_whole():
    band = (850, 970, 420, 1920)
    # A line the band clips has to go entirely -- half a sentence cannot be
    # erased -- so the box is taken whole even though only its top is inside.
    assert erase_subtitles.overlapping_union(CLIP_B_TEXT, band) == (957, 1011, 898, 1492)
    # A watermark below and a title above are not candidates at all.
    away = [(0, 100, 20, 60), (800, 900, 1040, 1070)]
    assert erase_subtitles.overlapping_union(away, band) is None
    # Touching along an edge is not overlapping.
    assert erase_subtitles.overlapping_union([(420, 700, 700, 850)], band) is None
    assert erase_subtitles.overlapping_union([(420, 700, 700, 851)], band) == (700, 851, 420, 700)


def test_a_union_that_is_no_longer_the_band_the_user_drew_is_refused():
    band = (850, 970, 420, 1920)              # 120 tall, in a 1080-tall frame
    assert erase_subtitles.union_is_usable((900, 1020, 420, 1920), band, 1080) is True
    # Three times the height they drew is the limit.
    assert erase_subtitles.union_is_usable((700, 1060, 420, 1920), band, 1080) is True
    assert erase_subtitles.union_is_usable((699, 1060, 420, 1920), band, 1080) is False
    # And never most of the picture, however big the band was.
    assert erase_subtitles.union_is_usable((600, 1040, 0, 1920),
                                           (600, 1040, 0, 1920), 1080) is False


def test_a_band_the_detector_finds_no_writing_near_is_not_retried(capsys):
    # Nothing overlaps: there really is no writing where the user pointed, and
    # the sentence about moving the box is the true answer -- not another five
    # minutes spent erasing somebody else's watermark.
    bands = []
    remover = _remover_class(fail_times=2, bands=bands)

    with pytest.raises(Exception, match="No subtitles detected"):
        erase_subtitles.erase_with_band(remover, "in.mp4", "out.mp4", CLIP_B_BAND,
                                        1920, 1080, find_text=lambda: [(0, 100, 20, 60)])

    assert remover.runs["runs"] == 1
    # The script decides whether to retry by the same words app/eraser.py turns
    # into the user's sentence; they have to stay in step or one of them stops
    # recognising the case.
    assert erase_subtitles.NO_SUBTITLES_MARKS == eraser.NO_SUBTITLES_MARKS


def test_the_second_band_is_the_last_one_tried():
    # Even when the detector's band is a good one, it gets one go. A third
    # attempt would be a third guess, and the user is already minutes in.
    bands = []
    remover = _remover_class(fail_times=2, bands=bands)

    with pytest.raises(Exception, match="No subtitles detected"):
        erase_subtitles.erase_with_band(remover, "in.mp4", "out.mp4", CLIP_B_BAND,
                                        1920, 1080, find_text=lambda: CLIP_B_TEXT)

    assert remover.runs["runs"] == 2


def test_any_other_failure_is_not_retried():
    # A band that caught nothing is worth a second go; a torch that fell over
    # would only fall over again, five minutes later.
    class Remover:
        runs = {"runs": 0}

        def __init__(self, path):
            self.sub_areas = []
            self.video_out_path = None

        def run(self):
            Remover.runs["runs"] += 1
            raise RuntimeError("MPS backend out of memory")

    with pytest.raises(RuntimeError, match="out of memory"):
        erase_subtitles.erase_with_band(Remover, "in.mp4", "out.mp4",
                                        (660, 800, 0, 608), 608, 1080)
    assert Remover.runs["runs"] == 1


def test_the_whole_frame_is_not_a_band_to_widen():
    class Remover:
        def __init__(self, path):
            self.sub_areas = ["untouched"]
            self.video_out_path = None

        def run(self):
            assert self.sub_areas == []

    _seconds, band = erase_subtitles.erase_with_band(Remover, "in.mp4", "out.mp4",
                                                     None, 608, 1080)
    assert band is None
