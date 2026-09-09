#!/usr/bin/env python3
"""Erase the subtitles burned into a video, run OUTSIDE the app's own venv
under a dedicated interpreter (see app/eraser.py, ERASER_PYTHON) -- the same
"heavy deps in a separate process" convention as app/scripts/demucs_separate.py.

The tool is video-subtitle-remover (https://github.com/YaoFANGUK/video-subtitle-remover),
checked out at --vsr-dir. This is the wrapper verified on this Mac 2026-09-04
turned into the script the app runs, and it keeps that wrapper's two hard-won
lines:

  * the inpaint mode MUST be STTN_DET. The default (sttn-auto) skips text
    detection and repaints the whole area with nothing to refer to, so it
    burns the same minutes and hands back a video with every subtitle still
    on it -- no error, no warning.
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

    config.set(config.interface, "en")
    tr.read(os.path.join(vsr_dir, "backend", "interface", "en.ini"), encoding="utf-8")
    config.inpaintMode.value = InpaintMode.STTN_DET

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
    restore_audio(input_path, out_path)
    print("done", flush=True)


if __name__ == "__main__":
    main()
