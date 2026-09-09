#!/usr/bin/env python3
"""Where a video's subtitles sit -- the band the Erase subtitles screen opens
with. Runs OUTSIDE the app's own venv beside app/scripts/erase_subtitles.py
(see app/eraser.py, ERASER_PYTHON).

Detection is video-subtitle-remover's own SubtitleDetect, not a second text
detector of our own: the box this suggests has to be the box the eraser will
then work in, and the only way to be sure of that is to ask the same model the
same way.

A dozen frames spread evenly through the video are read; the text boxes in the
bottom 45% of the frame are grouped into horizontal bands, and the band seen
in the most frames wins -- a subtitle is the writing that keeps coming back in
the same place, while a shop sign or a name caption appears once. The winner is
padded (6% of the height above and below, 4% of the width either side) because
the eraser only touches what is inside the band, and a letter's tail hanging
out of it would survive.

Prints one line of JSON to stdout:
    {"found": true, "area": [ymin, ymax, xmin, xmax], "width": W,
     "height": H, "frames": n}
found false means nothing was detected and `area` is the bottom quarter -- a
sane place to start the user off, not a claim about this video.

Usage: python suggest_area.py --vsr-dir DIR -i in.mp4
"""
import argparse
import json
import os
import sys

# How many frames to look at. Twelve is about 15 seconds on an M4 Air, which
# is what the screen can be kept waiting; the detector's own accuracy stops
# improving long before the cost does.
FRAMES = 12
# Text lower than this much of the frame counts as a subtitle candidate.
BOTTOM = 0.55
# Two boxes belong to the same band when their rows are no further apart than
# this much of the height -- one line of subtitles broken into several boxes.
BAND_GAP = 0.02
PAD_Y = 0.06
PAD_X = 0.04


def sample_frames(cv2, path, count):
    """`count` frames spread evenly through the video, and its size."""
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames = []
    if total > 0:
        # Neither end: a title card or an end card is not what is being looked
        # for, and both are where they live.
        step = max(1, int(total * 0.8) // count)
        wanted = [int(total * 0.1) + i * step for i in range(count)]
        for no in wanted:
            if no >= total:
                break
            cap.set(cv2.CAP_PROP_POS_FRAMES, no)
            ok, frame = cap.read()
            if ok:
                frames.append(frame)
                if not height:
                    height, width = frame.shape[0], frame.shape[1]
    cap.release()
    return frames, width, height


def bands(boxes, gap):
    """Group (frame_no, xmin, xmax, ymin, ymax) boxes into horizontal bands.

    Each band keeps the extent of everything in it and the frames it was seen
    in -- the count of those frames is what picks the winner.
    """
    out = []
    for no, xmin, xmax, ymin, ymax in sorted(boxes, key=lambda b: b[3]):
        for band in out:
            if ymin <= band["ymax"] + gap and ymax >= band["ymin"] - gap:
                band["ymin"] = min(band["ymin"], ymin)
                band["ymax"] = max(band["ymax"], ymax)
                band["xmin"] = min(band["xmin"], xmin)
                band["xmax"] = max(band["xmax"], xmax)
                band["frames"].add(no)
                break
        else:
            out.append({"ymin": ymin, "ymax": ymax, "xmin": xmin, "xmax": xmax,
                        "frames": {no}})
    return out


def suggest(path):
    import cv2
    from backend.tools.subtitle_detect import SubtitleDetect

    frames, width, height = sample_frames(cv2, path, FRAMES)
    if not frames or not height:
        raise RuntimeError("could not read any frame of %s" % os.path.basename(path))

    detector = SubtitleDetect(path, [])
    boxes = []
    for no, frame in enumerate(frames):
        # detect_subtitle answers (xmin, xmax, ymin, ymax) per box.
        for xmin, xmax, ymin, ymax in detector.detect_subtitle(frame):
            if ymin >= height * BOTTOM:
                boxes.append((no, xmin, xmax, ymin, ymax))

    if not boxes:
        return {"found": False, "area": [int(height * 0.75), height, 0, width],
                "width": width, "height": height, "frames": len(frames)}

    best = max(bands(boxes, height * BAND_GAP), key=lambda b: (len(b["frames"]), b["ymax"] - b["ymin"]))
    pad_y, pad_x = int(height * PAD_Y), int(width * PAD_X)
    return {
        "found": True,
        "area": [max(0, best["ymin"] - pad_y), min(height, best["ymax"] + pad_y),
                 max(0, best["xmin"] - pad_x), min(width, best["xmax"] + pad_x)],
        "width": width,
        "height": height,
        "frames": len(best["frames"]),
    }


def main():
    ap = argparse.ArgumentParser(description="Guess where a video's subtitles are")
    ap.add_argument("--vsr-dir", required=True, help="the video-subtitle-remover checkout")
    ap.add_argument("-i", "--input", required=True)
    a = ap.parse_args()

    vsr_dir = os.path.abspath(a.vsr_dir)
    # Same as erase_subtitles.py: the repository reads its own weights by
    # relative path, and its progress bar goes to a pipe the app is reading.
    os.chdir(vsr_dir)
    sys.path.insert(0, vsr_dir)
    sys.__stdout__ = open(os.devnull, "w")

    from backend.config import config, tr
    config.set(config.interface, "en")
    tr.read(os.path.join(vsr_dir, "backend", "interface", "en.ini"), encoding="utf-8")

    print(json.dumps(suggest(os.path.abspath(a.input))), flush=True)


if __name__ == "__main__":
    main()
