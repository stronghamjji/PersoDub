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
import subprocess
import sys
import threading


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


def has_audio(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return bool((r.stdout or "").strip())


def restore_audio(source, out_path):
    """Put the original sound back when the tool dropped it.

    video-subtitle-remover does carry the audio over -- but it extracts it with
    `-acodec copy` into an .aac file, which only works when the audio really is
    AAC. A link downloaded as Opus in MP4 (our own test clip, 2026-09-09) comes
    back silent, and a silent video is no use to a dubbing app. Copy the stream
    across if the container will take it, re-encode if it will not, and if
    neither works say so rather than throwing away a video that is otherwise
    exactly what was asked for.
    """
    if not has_audio(source) or has_audio(out_path):
        return
    tmp = out_path + ".sound.mp4"
    for audio in (["-c:a", "copy"], ["-c:a", "aac", "-b:a", "192k"]):
        cmd = (["ffmpeg", "-y", "-v", "error", "-i", out_path, "-i", source,
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


def widen_masks_at_seams(detector_class, frames=SEAM_FRAMES):
    """Fold each frame's neighbours into its own box list -- after the stretches
    have been cut, so their edges do not move.

    The checkout itself is never edited (the pack unpacks the original zip), so
    this wraps the one call that sits between the two uses of the detector's
    answer. `video_inpaint` asks find_continuous_ranges_with_same_mask where
    the stretches are, and from then on reads the same dictionary only to build
    each stretch's mask. Widening it inside the wrapper therefore leaves every
    stretch exactly where the tool cut it, and adds to a stretch's mask only
    the boxes of the frames just outside it -- which at a seam is both
    sentences at once. Inside a stretch nothing changes: the mask there is
    already the union of all its frames.
    """
    original = detector_class.find_continuous_ranges_with_same_mask

    def widened(sub_list):
        stretches = original(sub_list)
        near = {}
        for no in sub_list:
            boxes = list(sub_list[no])
            for other in range(no - frames, no + frames + 1):
                for box in sub_list.get(other, ()):
                    if box not in boxes:
                        boxes.append(box)
            near[no] = boxes
        sub_list.update(near)
        return stretches

    # staticmethod, because video_inpaint calls this through the instance and a
    # plain function there would be handed the detector as its first argument.
    detector_class.find_continuous_ranges_with_same_mask = staticmethod(widened)


# The finished video is looked at again before it is handed over: a fifth of a
# second is about how long a survivor lasts, so that is how often it is sampled
# -- up to a point, since every sample is an OCR pass and a ten-minute video
# would otherwise spend longer being checked than being cleaned.
CHECK_EVERY_SEC = 0.2
MAX_CHECKS = 300
# How much of the video around a survivor is painted again in the second pass.
REPAINT_PAD_SEC = 0.3


def check_result(path, area, detector_class, frames=None):
    """Count the sampled frames of `path` that still hold writing in the band.

    The same detector the erasing used, on the same band: "gone" has to be
    measured the way the tool itself would judge it. Returns
    ({frames_checked, frames_with_text, sample_times}, [frame numbers]) --
    the times are seconds, for the person reading the job, and the numbers are
    for the second pass.
    """
    import cv2

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frames is None:
        # Frame numbers are 1-based here, the way the tool counts them.
        step = max(1, int(round(fps * CHECK_EVERY_SEC)), -(-total // MAX_CHECKS))
        frames = list(range(1, total + 1, step))
    detector = detector_class(path, [tuple(area)] if area else [])
    checked, times, bad = 0, [], []
    for no in frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, no - 1)
        ok, frame = cap.read()
        if not ok:
            continue
        checked += 1
        if detector.detect_subtitle(frame):
            times.append(round((no - 1) / fps, 2))
            bad.append(no)
    cap.release()
    return ({"frames_checked": checked, "frames_with_text": len(bad),
             "sample_times": times}, bad)


def repaint_frames(path, area, frames, detector_class, remover_class):
    """Paint the seconds around `frames` again, with the whole band as the mask.

    No detection this time: writing that survived is writing the detector
    already missed once, so asking it the same question would get the same
    answer. The band itself becomes the mask, and only over the stretches
    around those frames -- every other frame of the video is copied through
    untouched, and no OCR runs at all, so this costs seconds rather than the
    minutes the first pass did.
    """
    import cv2

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()
    pad = max(1, int(round(fps * REPAINT_PAD_SEC)))
    wanted = set()
    for no in frames:
        wanted.update(range(max(1, no - pad), no + pad + 1))

    tmp = path + ".pass2.mp4"
    remover = remover_class(path)
    remover.video_out_path = tmp
    remover.sub_areas = [tuple(area)] if area else []
    # (xmin, xmax, ymin, ymax) -- the detector's own order, which is not the
    # (ymin, ymax, xmin, xmax) an area is given in.
    box = ((area[2], area[3], area[0], area[1]) if area else
           (0, remover.frame_width, 0, remover.frame_height))
    fixed = {no: [box] for no in sorted(wanted)}
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
    widen_masks_at_seams(SubtitleDetect)

    remover = SubtitleRemover(input_path)
    # Set before run(), or the result is written beside the ORIGINAL as
    # <name>_no_sub.mp4 and the app never finds it.
    remover.video_out_path = out_path
    remover.sub_areas = [tuple(a.area)] if a.area else []

    stop = threading.Event()
    watcher = threading.Thread(target=report_progress, args=(remover, stop), daemon=True)
    watcher.start()
    try:
        remover.run()
    finally:
        stop.set()
    print("progress 100%", flush=True)

    # Handing back a video with three surviving letters in it is worse than
    # taking another minute to look: the whole point of the feature is that the
    # writing is gone. What is still there is painted again, once, and the
    # answer travels with the job either way.
    check, leftovers = check_result(out_path, a.area, SubtitleDetect)
    if leftovers:
        repaint_frames(out_path, a.area, leftovers, SubtitleDetect, SubtitleRemover)
        after, _still = check_result(out_path, a.area, SubtitleDetect, frames=leftovers)
        check = {"frames_checked": check["frames_checked"],
                 "frames_with_text": after["frames_with_text"],
                 "sample_times": after["sample_times"],
                 "second_pass": True}
    print("check " + json.dumps(check), flush=True)

    restore_audio(input_path, out_path)
    print("done", flush=True)


if __name__ == "__main__":
    main()
