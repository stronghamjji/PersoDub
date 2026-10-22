# End-to-end runs against the real app

These drive a running PersoDub; they are not part of any test suite.

## regress.py

`regress.py` drives a running PersoDub app through its core flows over the
app's own HTTP API, in the shapes the page sends, and writes what it saw into
the `--out` folder: `report.md` (one table: step, result, seconds, evidence)
and `report.json`. Run it before a push, against an app on this computer with
its models installed. Python 3.8+ and ffprobe; nothing to install.

```
python tests/e2e/regress.py --base http://127.0.0.1:52252 \
    --clip paris-en-subs-10s.mp4 --subs-clip paris-en-subs-10s.mp4 --out ~/e2e-runs/today
```

- `--base`: the running app. Its port is the last `backend START (port N)`
  line of the desktop shell's `shell.log` (macOS:
  `~/Library/Application Support/persodub-desktop-shell/logs`).
- `--clip`: about 10 seconds of English speech.
- `--subs-clip`: about 10 seconds with subtitles burned into the picture.
  One clip may serve both when it has speech and burned-in subtitles; our
  fixture `paris-en-subs-10s.mp4` (English speech, Korean captions) does.
- `--translator`: the dub's translator, any name in `app/engines_status.py`
  `TRANSLATORS` (`hunyuan`, `chatgpt`, ...), sent in the dub's own request as
  the Translation dropdown sends it. Left out, the saved one translates.
- `--perso`: also dub through Perso. Spends Perso credits; needs a Perso key in Settings.

ffprobe is `PERSODUB_FFPROBE` when that is set, else the kit's own copy
(`<kit>/bin`) when the script runs on the kit's Python, else the one on PATH.

The exit code is 1 when any step failed, 0 when every step passed or was skipped.

### On Windows

Run it in Command Prompt with the kit's own Python, which also finds the
kit's ffprobe, from the repository's folder:

```
"%LOCALAPPDATA%\PersoDub\python\python.exe" tests\e2e\regress.py --base http://127.0.0.1:<port> ^
    --clip "%USERPROFILE%\e2e-fixtures\paris-en-subs-10s.mp4" --subs-clip "%USERPROFILE%\e2e-fixtures\paris-en-subs-10s.mp4" ^
    --out "%USERPROFILE%\e2e-runs\today" --translator hunyuan
```

`<port>` is in `%APPDATA%\persodub-desktop-shell\logs\shell.log`, as above.
The two clips are not in the repository (media is never committed): copy them
into `%USERPROFILE%\e2e-fixtures` first.

### Steps

1. `GET /api/engines` and `GET /api/settings` answer with every field the page reads.
2. A dubbing on this computer, English to Korean: its video is as long as the
   clip (within 1 s), and every line of its script has a voice length and the
   fields the length column judges it by.
3. Separate audio: the voice and the background are each as long as the clip.
4. Erase subtitles in the band `POST /api/erase/suggest` finds, which must lie
   in the bottom third of the picture around the fixture's captions (90 px above
   the bottom edge); the eraser's own check finds no writing left
   (`frames_with_text` 0) and `erased.mp4` is as long as the clip.
5. Every Export row of the finished dub answers with a whole file, the script
   spreadsheet among them: a workbook whose sheet has the header and a row per
   script line, named `<project>_<SRC>to<TGT>_OriginalTranslatedScript.xlsx` by
   the route. Saving it into Downloads is the desktop shell's half, and is not run.
6. A Perso dubbing, only with `--perso`.
7. The interface language is written, read back and put back. The API keys
   and the privacy switches are never written.
8. The finished dub's record has the times the usage count sends:
   `elapsed_seconds` and `stage_seconds` for separate, transcribe, translate
   and synthesize, each a whole number above 0, the four no more than the whole.
9. Subtitles on their own (the Subtitle style tab with no project): the held
   clip and a three-line .srt the run writes, `POST /api/captions/import`, make
   a finished job of kind `captions`; its video in the Sticker look is as long
   as the clip and its .srt has 3 cues. A file with no subtitles is refused with
   422, a video that is not held with 404.

A job may wait in line behind somebody else's: the app runs one local job at
a time. A job still running after 30 minutes is cancelled and fails its step.

### What it leaves behind

- Projects named `e2e-...` in the app (step 9's is named after the clip,
  `e2e-<clip>`) and the two clips in its holding area.
  Delete the projects from Projects when they are no longer wanted.
- kit.env's `PERSODUB_LANG` line, holding the language setting it had before
  (`auto` where there was no line, which is what no line means), and the
  `kit.env.bak` any Settings save leaves.
- The files it fetched, under `--out`. Media; never commit them.

Not collected by pytest (no `test_` prefix): it needs a live app and minutes
of real work, where the suite in `tests/` is pure logic.

## click.mjs

Presses the app's own buttons over the Chrome DevTools Protocol, as a person would,
with a screenshot and a time for each step. Node 22 or later (global WebSocket), no packages.

    cd desktop && npx electron . --remote-debugging-port=9333
    node tests/e2e/click.mjs --video <short mp4 with speech> --out <folder> [--port 9333] [--translator hunyuan]

Nine steps: Home; Settings > Models; a new dubbing of the video into Korean on this
computer; the finished script table and timeline; the video panel's Subtitle style
(12 looks, Sticker pressed, the panel closes and the project saves sticker; Download
lists "Dubbed video with subtitles" and "Script (original + translation, .xlsx)");
Export; Home again with the new project's card; the Subtitle style tab with no
project open (Home, Dubbing card, the tab): the video and a three-line .srt fed into
its two blocks, the files row, Sticker, and Download's two rows both saved and
measured (the video as long as the input within 1 s, the .srt 3 cues); then its
Dubbing tab's "Prepare this video for dubbing", the prep screen's Back, and Home.
Leave the app on Home. A dub already in the queue makes step 4 wait (30 minutes at
most). Each run leaves two projects on Home, `e2e-click-<time>` and its subtitle
project `e2e-click-<time>-cap`, and a second copy of the video in the holding area
(the prep screen's). ffprobe is on PATH or `PERSODUB_FFPROBE`.
Dubbing, audio separation and speech-to-text are all set to this computer, so a run
never spends Perso credits; step 3 fails at once if the dub it started uses Perso for any of them.

It needs an app whose translator is ready: an installed build with ChatGPT signed in, a real Gemini key, or the local pack (a dev build cannot install packs, so Start stops at the download dialog); `--translator hunyuan` picks the local one in Advanced options, and without the flag the dub keeps the translator the app starts a new project on.

`<folder>` gets `NN-<step>.png` (step 5 also `05-look-looks.png` with the looks open,
step 8 `08-captions-files.png`, step 9 `09-captions-dub-card.png`), `report.md` and
`report.json`. A failed step exits 1 and the report has its screenshot and a DOM
snippet. Export's file is moved out of Downloads into `<folder>/export`, the subtitle
project's two into `<folder>/export-captions`, and the language and options the run
picked and the Download dialog's ticks are put back as the app's remembered choices
afterwards. A `<select>` is set through the page:
its macOS menu is native and CDP cannot press it.
