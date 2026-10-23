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
    --clip paris-en-subs-10s.mp4 --subs-clip paris-en-subs-10s.mp4 --out ~/e2e-runs/today \
    --srt paris-ko-3cues.srt --kit <kit> --logs <logs>
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
- `--srt`: step 11's subtitle file, cues in Korean (our fixture `paris-ko-3cues.srt`).
  Left out, the run writes three English cues of its own.
- `--kit`: the app's kit folder, whose `kit.env` step 10 reads. Left out, that half
  of step 10 is not run.
- `--logs`: the app's logs folder, whose `job-<id>.log` steps 15 and 16 read
  (`backend.log` beside it keeps only each stage's START and DONE). Left out,
  they read the job record's log, which holds the same lines.

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
10. The edition: `GET /api/setup`'s default Dubbing mode is `local`, the
    open-source edition's, and with `--kit` kit.env has 0
    `PERSODUB_EDITION=production` lines.
11. A dub started with a subtitle file attached (the `srt` field, used as is):
    `stage_seconds.translate` 0 or absent, the script's lines equal the file's cues
    (3 for the fixture), and the video as long as the clip. Speech is still
    transcribed, for the speakers, so that stage's time is only reported.
12. `POST /api/dub/jobs/{id}/redub` on step 2's dub: a new job, made on this
    computer, whose video is as long as the clip.
13. The six routes no screen calls: `GET /api/tts/engines`, `POST /api/tts/say`
    (a wav longer than 0.5 s, in the voice step 2's dub cloned, read from that
    dub's folder), `POST /api/translate` and `GET .../subtitle_preview` (a JPEG)
    answer 200; `perso/script/{line}/fit` and `/reset` need a Perso dub, which
    spends credits, so they are asked of the local dub and must answer 409.
14. The hidden translators, `qwen` and `vertex`: in neither `GET /api/setup`'s
    translator choices nor a field of `GET /api/engines`. No route answers a
    translator's `offered` flag (`app/engines_status.py`), so the choice list
    is what is checked.
15. Step 2's dub checked for the original voice leaking through: 1 or more
    `leakage gate:` lines in its log and none saying it was skipped; the verdict
    is reported. Steps 15 and 16 read `job-<id>.log`, not `backend.log`, which
    has none of these lines.
16. Step 2's dub looked for laughs and breaths: 1 or more `nonverbal whitelist:`
    lines and no `whisper veto unavailable`; the counts are reported.
17. A dub with `num_speakers` 1: the record keeps 1, the finished script names
    exactly one speaker, and the video is as long as the clip.

A job may wait in line behind somebody else's: the app runs one local job at
a time. A job still running after 30 minutes is cancelled and fails its step.

### What it leaves behind

- Projects named `e2e-...` in the app (step 9's is named after the clip,
  `e2e-<clip>`; step 12's remake joins step 2's `e2e-dub`) and the two clips in
  its holding area.
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
computer; the finished script table and timeline; the subtitles turned on by the
timeline's eye and the Subtitle style chip over them (12 looks, Sticker pressed, the
panel closes and the project saves sticker; Download lists "Dubbed video with
subtitles" and "Script (original + translation, .xlsx)"); Export; Home again with
the new project's card; Burn in subtitles from Home's card: the video and a three-line .srt fed into
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

## agent-tools.py

Calls each of the Dub Agent's 23 tools (`app/mcp_server.py`) the way a terminal AI
does: it starts its own `python -m app.mcp_server` against the app and speaks MCP
(JSON-RPC over stdin/stdout) to it. Each agent reply is a new server process, as the
CLI starts one per message, so the confirm gates are met as the user meets them: the
plan in one reply, the yes in the next, and a yes in the same reply must be refused.

    PERSODUB_FFPROBE=<kit>/bin/ffprobe python tests/e2e/agent-tools.py --base http://127.0.0.1:51404 \
        --clip paris-en-subs-10s.mp4 --srt paris-ko-3cues.srt --out ~/e2e-runs/today \
        [--python <kit>/app_venv/bin/python] [--kit <kit>]

- `--python`: a Python with the app's packages (`mcp`, `httpx`); default `<repo>/.venv`.
  The repository's own `app/` is put on its `PYTHONPATH`.
- `--kit`: the app's kit folder; its `models` folder must not change while
  `download_model` is called.

It spends no Perso credits and downloads nothing: the dub, the erase and the
subtitles are all on this computer, `change_speaker` and `proofread_dub` are only
asked of a local dub (and must refuse), `download_model` only ever offers a button,
and `download_video` gets `not-a-link`, which the app refuses before going online.
The steps and their numbers: 23 tools listed with descriptions; get_setup's six
stages; list_videos and list_jobs against the folder and the app; get_job_status on
the newest finished `e2e-` dub and `no such job: ...` for a bad id; a local dub
cancelled once running (cancelled within 60 s), and another run to done (within
400 s out of line) and listed done; get_script's 3 lines and 14 fields, check_fit per
line; line 2 edited, translated again (the dub's own translator) and put back;
line 1's voice and then every voice made again (the dub's video rewritten, 10.0 s
± 0.1); the script exported as .srt (3 cues; the tool has no other format, the
.xlsx is regress.py's step 5); two subtitle looks burned, each 10.0 s ± 0.1; 3 cues
extracted; a 5.5 s cut ± 0.2; an erase within 700 s with `frames_with_text` 0, saved
where asked; voice_quality set, read back and put back; and no line of any tool
answer holds an e-mail address, a key of a shape `app/report_mask.py` masks (`sk-`,
`AIza`, `ghp_`, `hf_`, a JWT) or a run of 32+ letters and digits (only the kind is
reported, never the text; a hyphen or underscore ends a run, as in Perso's export names). It leaves two `e2e-agent-<time>` dubs (one
cancelled) and an `e2e-agent-erase-<time>` erase in the app, an `-script.srt` in the
dub's folder, and its media under `--out`. Exit code 1 when any step failed.

## restart.mjs

What only a boot shows: it stops and starts an isolated test app (its own kit
folder and user data, never the installed app) with one kit.env line changed,
and puts the line back. Node 22 or later, no packages.

    cd desktop && PERSODUB_KIT_DIR=<kit> npx electron . --remote-debugging-port=9333 --user-data-dir=<dir>
    node tests/e2e/restart.mjs --kit <kit> --user-data <dir> --video <short mp4> --out <folder> [--port 9333] [--lock <dir>]

- P2: `PERSODUB_DOWNLOAD_DIR=<folder>/dl` with the app running; the newest finished
  local `e2e-` dub's Download dialog names `dl` with Use default shown, one row lands
  in `dl/<day>/<project>/`, and Use default makes the line name Downloads and the
  kit.env value empty.
- P3: the value set to a folder that is not there; the dialog says it cannot find it
  once, before and after a download, and the file lands in `~/Downloads/<day>/<project>/`
  (moved into `<folder>/p3`).
- P4: `dl` again; the newest finished `e2e-` erase's video (skipped with a note when
  there is none) and a Save video of a copy of `--video` each land as one .mp4 under
  `dl`, with no new file under `~/Downloads`; the draft card Save video leaves is deleted.
- H18: quit on that dub's screen and launch; within 15 s the page is on the same
  screen (`data-screen` done, the same job id).
- S2: `PERSODUB_APP_REPO_DIR` (the backend's folder, the kit.env line the shell
  starts an engine with) set to a missing folder; the "could not start" screen, and
  Try again adds one `backend START` line to shell.log and brings the same screen back.
- S3: launched with `PERSODUB_KIT_DIR` on an empty folder; the not-installed screen
  names it and its four missing files, and the report counts the terminal commands
  in its words. What the boot wrote into the folder is removed.
- final: the backend port the app started on answers, its engines are running,
  kit.env is byte for byte the backup (`cmp`), the page is on Home, the lock is free.

A quit is a SIGTERM to the test app's Electron (whose command line names
`--user-data-dir=<dir>`), which stops its engines; any of its backend or voice engine
left 30 s later is killed. Every boot must come up on the backend port the app had
(`<dir>/ports.json`); one on another port is quit and booted again, and the ports seen
are in the report. kit.env is copied to `kit.env.e2e-backup` first and put back after
every step that stops the app; the run refuses to start while a backup that differs
from kit.env is there (an earlier run stopped before putting it back), and removes it
once the final check passes. kit.env.bak, which Use default rewrites, is put back too.
With `--lock` the app is stopped or pressed only while holding that folder (mkdir takes
it, retried every 15 s, `who` names the run; rmdir gives it back) and only when
GET /api/dub/jobs has no running or queued job, in four holds (downloads, reopen,
engines fail, not installed), each well under 15 minutes. It spends no Perso credits
and signs in to nothing. `<folder>` gets `NN-<id>.png` for each step and a few more
(`p2-use-default`, `p3-folder-gone`, `p4-erase-saved`, `p4-save-video-saved`,
`h18-reopened`, `s2-could-not-start`, `s2-after-try-again`, `s3-not-installed`),
`app-NN.log` for each launch, `report.md` and `report.json`. Exit code 1 when any step failed.
