# Regression run

`regress.py` drives a running PersoDub app through its core flows over the
app's own HTTP API, in the shapes the page sends, and writes what it saw into
the `--out` folder: `report.md` (one table: step, result, seconds, evidence)
and `report.json`. Run it before a push, against an app on this computer with
its models installed. Python 3.8+ and ffprobe; nothing to install.

```
python tests/e2e/regress.py --base http://127.0.0.1:52252 \
    --clip speech-10s.mp4 --subs-clip subtitles-10s.mp4 --out ~/e2e-runs/today
```

- `--clip`: about 10 seconds of English speech.
- `--subs-clip`: about 10 seconds with subtitles burned into the picture.
- `--perso`: also dub through Perso. Spends Perso credits; needs a Perso key in Settings.
- `--ffprobe`: where ffprobe is, when it is not on PATH.

The exit code is 1 when any step failed, 0 when every step passed or was skipped.

## Steps

1. `GET /api/engines` and `GET /api/settings` answer with every field the page reads.
2. A dubbing on this computer, English to Korean: its video is as long as the
   clip (within 1 s), and every line of its script has a voice length and the
   fields the length column judges it by.
3. Separate audio: the voice and the background are each as long as the clip.
4. Erase subtitles in the band `POST /api/erase/suggest` finds; the eraser's
   own check finds no writing left (`frames_with_text` 0).
5. Every Export row of the finished dub answers with a whole file. Saving it
   into Downloads is the desktop shell's half, and is not run.
6. A Perso dubbing, only with `--perso`.
7. The interface language is written, read back and put back. The API keys
   and the privacy switches are never written.

A job may wait in line behind somebody else's: the app runs one local job at
a time. A job still running after 30 minutes is cancelled and fails its step.

## What it leaves behind

- Projects named `e2e-...` in the app and the two clips in its holding area.
  Delete the projects from Projects when they are no longer wanted.
- kit.env's `PERSODUB_LANG` line, holding the language setting it had before
  (`auto` where there was no line, which is what no line means), and the
  `kit.env.bak` any Settings save leaves.
- The files it fetched, under `--out`. Media; never commit them.

Not collected by pytest (no `test_` prefix): it needs a live app and minutes
of real work, where the suite in `tests/` is pure logic.
