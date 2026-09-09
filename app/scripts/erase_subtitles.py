#!/usr/bin/env python3
"""Erase the subtitles burned into a video, run OUTSIDE the app's own venv
under a dedicated interpreter (see app/eraser.py, ERASER_PYTHON) -- the same
"heavy deps in a separate process" convention as app/scripts/demucs_separate.py.

The tool is video-subtitle-remover (https://github.com/YaoFANGUK/video-subtitle-remover),
checked out at --vsr-dir. This is the wrapper verified on this Mac 2026-09-04
turned into the script the app runs, and it keeps that wrapper's two hard-won
lines:

  * the inpaint mode MUST be STTN_DET. The other one, sttn-auto, does no
    detection: it hands the whole band to the model as one mask. Given no band
    at all it repaints the entire frame from nothing to refer to and returns
    the video unchanged, no error and no warning. Given a band it does take
    the colour out of the writing -- but it shrinks that whole band to the
    model's small input and blows it back up, so a grey ghost of every letter
    stays behind (measured on this Mac 2026-09-09: where the letters had been
    was 40 to 75 levels darker than the band around it, against 10 to 44 for
    STTN_DET, which masks only the letters the detector found and fills those).
  * backend/config.py's `tr` table has to be read, or the first progress
    message the library prints dies with a KeyError.

Progress goes to stdout as `progress N%` lines and `done` at the end. It is
polled off the remover rather than taken from its progress callback -- see
report_progress -- and the library's `finished` flag is not to be trusted
either (it stays false at 100%): the process ending is what completion means,
and app/eraser.py reads it that way.

Usage: python erase_subtitles.py --vsr-dir DIR -i in.mp4 -o out.mp4
                                 [--area YMIN YMAX XMIN XMAX]
Coordinates are (ymin, ymax, xmin, xmax) -- rows first, not the usual (x, y).
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time


def report_progress(remover, stop):
    """Print the percent as it changes, until `stop` is set.

    Not the library's own progress listener: that only fires while frames are
    being repainted, and the search for the subtitles which comes first is
    most of the wait -- 190 seconds of the 317 this clip took (2026-09-09) --
    so the screen would sit at nothing and then race. Both phases do keep a
    counter: the search fills progress_total from 0 to 50 and never touches
    progress_remover, which the repainting then drives from 0 to 100. Read
    together they make one number that only ever goes up.
    """
    last = -1
    while not stop.wait(1.0):
        painted = int(getattr(remover, "progress_remover", 0) or 0)
        percent = 50 + painted // 2 if painted else min(50, int(getattr(remover, "progress_total", 0) or 0))
        if percent != last:
            last = percent
            print("progress %d%%" % percent, flush=True)


def find_tool(name, vsr_dir):
    """ffmpeg or ffprobe: the one on PATH, else the copy the tool ships.

    A Windows kit need not have either on PATH, and video-subtitle-remover
    carries an ffmpeg of its own for each platform (no ffprobe -- see
    has_audio, which does without one).
    """
    found = shutil.which(name)
    if found:
        return found
    if name == "ffmpeg":
        windows = platform.system() == "Windows"
        folder = {"Windows": "win_x64", "Linux": "linux_x64"}.get(platform.system(), "macos")
        bundled = os.path.join(vsr_dir, "backend", "ffmpeg", folder,
                               "ffmpeg.exe" if windows else "ffmpeg")
        if os.path.exists(bundled):
            return bundled
    return name


def has_audio(path, ffprobe):
    """Whether `path` carries sound. Without an ffprobe to ask, the answer is
    yes -- which makes the caller try the mux rather than skip it, and a mux
    that was not needed costs a second and changes nothing."""
    if not shutil.which(ffprobe) and not os.path.exists(ffprobe):
        return True
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return bool((r.stdout or "").strip())


def restore_audio(source, out_path, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    """Put the original sound back when the tool dropped it.

    video-subtitle-remover does carry the audio over -- but it extracts it with
    `-acodec copy` into an .aac file, which only works when the audio really is
    AAC. A link downloaded as Opus in MP4 (our own test clip, 2026-09-09) comes
    back silent, and a silent video is no use to a dubbing app. Copy the stream
    across if the container will take it, re-encode if it will not, and if
    neither works say so rather than throwing away a video that is otherwise
    exactly what was asked for.
    """
    if not has_audio(source, ffprobe) or has_audio(out_path, ffprobe):
        return
    tmp = out_path + ".sound.mp4"
    for audio in (["-c:a", "copy"], ["-c:a", "aac", "-b:a", "192k"]):
        cmd = ([ffmpeg, "-y", "-v", "error", "-i", out_path, "-i", source,
                "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"] + audio
               + ["-shortest", "-movflags", "+faststart", tmp])
        if subprocess.run(cmd, capture_output=True).returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, out_path)
            return
    if os.path.exists(tmp):
        os.remove(tmp)
    print("the sound could not be carried over", flush=True)


# How many frames on either side of a stretch are folded into its mask.
#
# video-subtitle-remover cuts the video into stretches that share one mask, and
# paints every frame of a stretch with the boxes IT found -- so at the frame
# where one sentence gives way to the next, the new sentence is already on
# screen while the old sentence's boxes are still the mask. If the new one is
# the longer of the two, its ends fall outside that mask and survive: six
# frames of a 685-frame video kept the ends of their line (Windows, 2026-09-09).
# Four frames covers a changeover at 30fps; the tool's own timeline expand is
# +-3, and this is the same idea applied to the mask rather than the timing.
SEAM_FRAMES = 4

# Where the tool cut the video into stretches, kept as widen_masks goes past
# it: those edges are the frames the check below looks at hardest, because a
# survivor is a frame painted with the neighbouring stretch's mask.
STRETCHES = []

# And every box is given a little room at each end. The detector draws its box
# around the letters it is sure of, and a stroke, a shadow or the tail of the
# last character sits just outside it -- which is exactly what survives as a
# smear. Six percent of the box's own width, so a long line gets more room than
# a short one, and never less than a few pixels. (The tool pads every box by a
# fixed 10px of its own on top of this, in all four directions.)
BOX_SIDE_PAD = 0.06
BOX_SIDE_PAD_MIN = 6


def pad_sideways(box):
    """One (xmin, xmax, ymin, ymax) box with room added at its two ends."""
    xmin, xmax, ymin, ymax = box
    pad = max(BOX_SIDE_PAD_MIN, int((xmax - xmin) * BOX_SIDE_PAD))
    return (max(0, xmin - pad), xmax + pad, ymin, ymax)


def widen_masks(detector_class, frames=SEAM_FRAMES):
    """Fold each frame's neighbours into its own box list, and give every box
    room at its ends -- after the stretches have been cut, so their edges do
    not move.

    The checkout itself is never edited (the pack unpacks the original zip), so
    this wraps the one call that sits between the two uses of the detector's
    answer. `video_inpaint` asks find_continuous_ranges_with_same_mask where
    the stretches are, and from then on reads the same dictionary only to build
    each stretch's mask. Widening it inside the wrapper therefore leaves every
    stretch exactly where the tool cut it, and adds to a stretch's mask only
    the boxes of the frames just outside it -- which at a seam is both
    sentences at once. Inside a stretch nothing else changes: the mask there is
    already the union of all its frames.
    """
    original = detector_class.find_continuous_ranges_with_same_mask

    def widened(sub_list):
        stretches = original(sub_list)
        STRETCHES[:] = stretches
        near = {}
        for no in sub_list:
            boxes = []
            for other in range(no - frames, no + frames + 1):
                for box in sub_list.get(other, ()):
                    roomy = pad_sideways(box)
                    if roomy not in boxes:
                        boxes.append(roomy)
            near[no] = boxes
        sub_list.update(near)
        return stretches

    # staticmethod, because video_inpaint calls this through the instance and a
    # plain function there would be handed the detector as its first argument.
    detector_class.find_continuous_ranges_with_same_mask = staticmethod(widened)


# The finished video is looked at again before it is handed over -- with the
# same detector, because "gone" has to be judged the way the tool itself would
# judge it. Every sample is an OCR pass, so the check is aimed rather than
# blind: the changeovers first (that is where a survivor comes from), a thin
# sweep of the rest next, and the ring around each changeover after that, until
# either the list or the time runs out.
CHECK_SEAM_SEC = 0.3
CHECK_SWEEP_SEC = 1.0
MAX_CHECKS = 300
# The share of the erasing the check may spend. Measured on this Mac
# (2026-09-09), a frame costs 0.31s to read and the whole 300 come to about
# 100s; on a short clip that would be longer than the erasing itself, so the
# budget -- not the list -- is what actually stops it there.
CHECK_BUDGET = 0.15
# How much of the video around a survivor is painted again in the second pass.
REPAINT_PAD_SEC = 0.3


def frames_to_check(total, fps, stretches):
    """Which frames of the finished video to read, most telling first.

    A survivor is a frame painted with the neighbouring stretch's mask, so the
    changeovers are where to look: those frames come first, then one thin sweep
    of everything else so a failure nobody predicted still shows up, then the
    ring around each changeover widening out to CHECK_SEAM_SEC. Order matters
    because the caller stops when its time is up: what it does not reach is the
    far edge of a changeover, never the changeover itself.

    A round with more frames in it than there is room for is thinned across the
    whole video rather than cut off at MAX_CHECKS -- an hour-long video has more
    changeovers than any check can read, and reading only the ones in its first
    two minutes would be a check of its opening titles.
    """
    edges = sorted({edge for stretch in stretches or () for edge in stretch})
    rounds = [edges,                                # the changeover frames
              [edge + 1 for edge in edges],         # and the frame it turns into
              list(range(1, total + 1, max(1, int(round(fps * CHECK_SWEEP_SEC)))))]
    for reach in range(1, max(1, int(round(fps * CHECK_SEAM_SEC))) + 1):
        rounds.append([edge - reach for edge in edges]
                      + [edge + 1 + reach for edge in edges])

    order, seen = [], set()
    for group in rounds:
        room = MAX_CHECKS - len(order)
        if room <= 0:
            break
        fresh = sorted(no for no in set(group) if 1 <= no <= total and no not in seen)
        if len(fresh) > room:
            fresh = ([fresh[i * (len(fresh) - 1) // (room - 1)] for i in range(room)]
                     if room > 1 else fresh[:1])
        seen.update(fresh)
        order.extend(fresh)
    return order


def writing_left(detector, frame, area):
    """The boxes of any writing the detector still finds in this frame's band.

    It is shown the band alone, not the whole picture. What the detector costs
    is set by how many pixels it is given, and the band is a fifteenth of the
    frame in our test clip: 0.31s a frame against 3.30s (this Mac, 2026-09-09),
    with the same verdict on all 27 frames the two were compared on. Its
    sub_areas move to the crop's own corner for the moment of the question,
    because it filters what it found by them, and the boxes it hands back are
    moved into the frame's own corner again -- the second pass paints THOSE,
    which is why they are worth carrying back rather than a yes or no.
    """
    if not area:
        return [tuple(box) for box in detector.detect_subtitle(frame)]
    ymin, ymax, xmin, xmax = area
    was = detector.sub_areas
    detector.sub_areas = [(0, ymax - ymin, 0, xmax - xmin)]
    try:
        found = detector.detect_subtitle(frame[ymin:ymax, xmin:xmax])
    finally:
        detector.sub_areas = was
    # (xmin, xmax, ymin, ymax) -- the detector's own order.
    return [(bx0 + xmin, bx1 + xmin, by0 + ymin, by1 + ymin)
            for bx0, bx1, by0, by1 in found]


def check_result(path, area, detector_class, frames=None, deadline=None):
    """Count the sampled frames of `path` that still hold writing in the band.

    Returns ({frames_checked, frames_with_text, sample_times}, {frame: boxes})
    -- the times are seconds, for the person reading the job, and the boxes are
    what the second pass paints. `deadline` is a time.monotonic() reading to
    stop at, so the check costs a share of the erasing rather than a fixed
    amount.
    """
    import cv2

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frames is None:
        # Frame numbers are 1-based here, the way the tool counts them.
        frames = frames_to_check(total, fps, STRETCHES)
    detector = detector_class(path, [tuple(area)] if area else [])
    checked, found = 0, {}
    for no in frames:
        if deadline is not None and time.monotonic() >= deadline:
            break
        cap.set(cv2.CAP_PROP_POS_FRAMES, no - 1)
        ok, frame = cap.read()
        if not ok:
            continue
        checked += 1
        boxes = writing_left(detector, frame, area)
        if boxes:
            found[no] = boxes
    cap.release()
    return ({"frames_checked": checked, "frames_with_text": len(found),
             "sample_times": [round((no - 1) / fps, 2) for no in sorted(found)]},
            found)


def masks_for_repaint(found, fps):
    """{frame: boxes} for the second pass, out of what the check found.

    The boxes the check drew, not the band. Painting the whole band was the
    first thing tried and it is wrong: on a wide band (239 by 1547 pixels, a
    1080p short, this Mac 2026-09-09) the model was handed a mask far larger
    than anything it can fill and smeared the picture across it -- the same
    failure sttn-auto has, for the same reason. The check has just told us
    exactly where the writing is; the second pass paints that, with the room a
    stroke needs, and spread over the frames either side because a survivor
    lasts longer than the one frame that happened to be sampled.
    """
    pad = max(1, int(round(fps * REPAINT_PAD_SEC)))
    fixed = {}
    for no, boxes in found.items():
        roomy = [pad_sideways(box) for box in boxes]
        for near in range(max(1, no - pad), no + pad + 1):
            here = fixed.setdefault(near, [])
            here.extend(box for box in roomy if box not in here)
    return fixed


def repaint_frames(path, found, detector_class, remover_class):
    """Paint the seconds around what the check found again, with its own boxes.

    Only those stretches -- every other frame of the video is copied through
    untouched, and no OCR runs at all, so this costs a fraction of what the
    first pass did.
    """
    import cv2

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()

    tmp = path + ".pass2.mp4"
    remover = remover_class(path)
    remover.video_out_path = tmp
    fixed = masks_for_repaint(found, fps)
    detector_class.find_subtitle_frame_no = lambda self, sub_remover=None: dict(fixed)
    remover.run()
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description="Erase burned-in subtitles from a video")
    ap.add_argument("--vsr-dir", required=True, help="the video-subtitle-remover checkout")
    ap.add_argument("-i", "--input", required=True)
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--area", nargs=4, type=int, metavar=("YMIN", "YMAX", "XMIN", "XMAX"),
                    help="the band to work in; left out, the whole frame is searched")
    a = ap.parse_args()

    vsr_dir = os.path.abspath(a.vsr_dir)
    input_path = os.path.abspath(a.input)
    out_path = os.path.abspath(a.output)

    # The repository names its own weights and interface files by paths
    # relative to the working directory, so the process stands in it.
    os.chdir(vsr_dir)
    sys.path.insert(0, vsr_dir)

    # Its two progress bars are written straight to sys.__stdout__, which is
    # the pipe app/eraser.py is reading: thousands of carriage-return updates
    # would arrive between two of our own lines. Sent nowhere instead -- the
    # `progress N%` lines above are what the job's log is for.
    sys.__stdout__ = open(os.devnull, "w")

    from backend.config import config, tr
    from backend.main import SubtitleRemover
    from backend.tools.constant import InpaintMode
    from backend.tools.subtitle_detect import SubtitleDetect

    config.set(config.interface, "en")
    tr.read(os.path.join(vsr_dir, "backend", "interface", "en.ini"), encoding="utf-8")
    config.inpaintMode.value = InpaintMode.STTN_DET
    widen_masks(SubtitleDetect)

    remover = SubtitleRemover(input_path)
    # Set before run(), or the result is written beside the ORIGINAL as
    # <name>_no_sub.mp4 and the app never finds it.
    remover.video_out_path = out_path
    remover.sub_areas = [tuple(a.area)] if a.area else []

    stop = threading.Event()
    watcher = threading.Thread(target=report_progress, args=(remover, stop), daemon=True)
    watcher.start()
    started = time.monotonic()
    try:
        remover.run()
    finally:
        stop.set()
    erasing = time.monotonic() - started
    print("progress 100%", flush=True)

    # Handing back a video with three surviving letters in it is worse than
    # taking another minute to look: the whole point of the feature is that the
    # writing is gone. What is still there is painted again, once, and the
    # answer travels with the job either way. The looking is given a share of
    # the time the erasing took and no more.
    check, leftovers = check_result(out_path, a.area, SubtitleDetect,
                                    deadline=time.monotonic() + erasing * CHECK_BUDGET)
    repainted = 0
    if leftovers:
        repaint_frames(out_path, leftovers, SubtitleDetect, SubtitleRemover)
        repainted = len(leftovers)
        after, _still = check_result(out_path, a.area, SubtitleDetect,
                                     frames=sorted(leftovers))
        check["frames_with_text"] = after["frames_with_text"]
        check["sample_times"] = after["sample_times"]
    check["repainted"] = repainted
    print("check " + json.dumps(check), flush=True)

    restore_audio(input_path, out_path,
                  find_tool("ffmpeg", vsr_dir), find_tool("ffprobe", vsr_dir))
    print("done", flush=True)


if __name__ == "__main__":
    main()
