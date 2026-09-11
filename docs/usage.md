# Using PersoDub

A walkthrough of the app, screen by screen. To install it, see the
[Installation section of the README](../README.md#installation).

> The screenshots that used to be here have been taken out while a video
> walkthrough is made. Everything below describes 0.6.0 as it stands.

## First launch

The first time PersoDub opens it sets itself up. The base install is under 1 GB,
and the heavy parts arrive later: the AI engine, the translation runtime and the
models download the first time you start a dub, and the subtitle eraser downloads
the first time you use it. The window lists the steps and ticks them off; closing
the app partway through does not lose the work, setup resumes where it stopped.

## The window

Down the left is the rail:

- **Dubbing**, the first screen.
- **Erase subtitles**, for taking burned-in subtitles out of a video.
- **Projects** at the foot, every job this app has run.
- **Settings** below it.

Along the top is the bar for whatever screen you are on: the way home, the name of
the job, and its buttons. On the right is the **Dub Agent** panel, which can be
folded away with the pane button in the top bar.

## Dubbing

The first screen asks one thing: which video? Drop files on the drop zone, click
**Choose files** to browse, or paste a video link. MP4 and MOV are accepted, up to
2 GB each. Several at once is fine: they queue and run one after another.

A pasted link is fetched onto your machine before anything else happens, with the
percentage on screen. Once it is here it behaves exactly like a file you dropped:
you can play it, trim it, and save a copy. See
[Dubbing from a link](privacy.md#dubbing-from-a-link).

## New project

As soon as a video is ready the **New project** dialog opens.

**Trim** is the bar under the video. Drag the two handles to pick the part you want,
or press play to hear the selection. Leave it alone to take the whole video. A
trimmed video is re-encoded before the work starts, which takes a moment but cuts
exactly where you asked.

**Original language** can stay on *Auto-detect* unless detection gets it wrong.

**Target language** is the language to dub into. Ten are supported: English, Korean,
Chinese, Japanese, French, German, Italian, Portuguese, Russian and Spanish.

Three things can be done with the video from here:

- **Save clip** writes the trimmed part into Downloads.
- **Erase subtitles** hands it to the eraser screen.
- **Start dubbing** begins the dub. It is the only filled button, because it is the
  one that goes on.

### Advanced options

Collapsed by default. The defaults are the fully local, free path and are a good
place to start.

| Field | Default | Notes |
|---|---|---|
| **Speech-to-text** | Whisper | Turns the speech in your video into text. *Perso API* needs a Perso key, and becomes the default once one is saved. |
| **Translation** | Hunyuan | Translates the transcribed text, locally. *Gemini API* needs a Google key. |
| **Text-to-speech** | Qwen3-TTS | Speaks the translated lines in the cloned voice. |
| **Voice quality** | Fast | *Fast* voices each line once. *High quality* voices it four times and keeps the best take, which is noticeably better and takes about four times as long. |
| **Number of speakers** | Auto-detect | Auto-detect assumes at least two speakers. Set it to 1 for a single-speaker video. |

An engine that needs a key it cannot find is shown as unavailable rather than
failing quietly when you press Start.

## While it runs

The running screen shows your video behind the progress card, with the four stages
ticking off: separating the audio, transcribing it, translating it, and dubbing.
The dubbing stage counts the lines as it voices them. **Cancel** sits at the foot of
that card, and the job stops at its next stage boundary.

The Dub Agent stays available while a dub runs. Asking it to stop the job, or how
far along it is, are the two things people actually want at that moment.

## The finished screen

When the job finishes it opens on the screen the app is really about: the script.

- **The table** on the left is one row per line: its number, who spoke it, when it
  starts, the original line, the translation, and how much longer or shorter the
  dubbed line runs than the slot it has to fit.
- **The play button** before a translation plays that line alone.
- **The remake button** makes that line's voice again, which is what you press after
  changing the words. A line you have edited also offers **revert**.
- **Original** and **Dubbing** swap which file the player shows.
- **The timeline** underneath has a lane for the translation, one for the original
  and one for the subtitles. A bar that runs past its slot is marked.
- **Export** in the top bar saves the dubbed video, the translated `.srt`, and, for a
  job that started from a link, the original video.
- The click target on the job's name in the top bar renames the project. The folder
  keeps the name it was made with; the screens show the name you gave it.

A narrow window folds columns away rather than cutting words in half. The end of each
time slot goes first, then the original line, so the translation always stays whole.

### Export

**Export** opens a dialog with a line per file. The app saves without asking, into
`Downloads` / the day the job ran / the project's name, and each row says where its
file went once it has landed.

## Erase subtitles

The second tool on the rail takes subtitles that are burned into the picture back
out of it.

Drop a video or paste a link, the same two ways in the dubbing screen offers. The app
looks for the writing and draws a box where it thinks it is: red while it is looking,
green once it has found something. Drag the box if it missed, and use the trim bar to
pick a part of the video if you do not need all of it.

The row under the picture says what it will cost in minutes before you start. It is
slow work, minutes for every minute of video, because every frame in the band has to
be painted over. **Erase** starts it.

When it finishes, the tabs above the picture swap between the original and the
erased version so you can see what changed. **Export** saves the clean video, and
**Start dubbing** hands it straight to a new project. If something goes wrong, the
card says which half of the work it stopped in, **Try again** runs it again on the
same video and the same box, and **Raw log** has the detail.

The eraser is a pack of its own, downloaded the first time you use it.

## The Dub Agent

The panel on the right is the Dub Agent. Ask for a fix in plain words, "shorten line
4 so it fits, then remake its voice", and it edits the script and remakes voices
through PersoDub's own tools, showing each step as it goes.

Pick which assistant answers from the button beside the box. It runs a CLI that is
**already installed on your computer**, Claude Code or Codex, and is billed to your
own account with that vendor. Once it has answered once, the button also names the
model it answered with.

**Sign in first, in Terminal.** PersoDub does not log in for you. Before your first
message, run `claude` for Claude Code and follow the browser sign-in, or `codex
login` for Codex. A CLI that is not signed in says so in the panel rather than
failing in a way you have to decode, and the panel notices a sign-in that happens
while the app is open.

The agent is never locked. It answers on a finished job, on a job that failed, while
a dub is running, and on the home screen with nothing open at all, which is where you
would ask it to dub the videos in a folder.

What each assistant can reach on your machine, and the fact that **Codex can read
files on this computer even in its read-only sandbox**, is spelled out in
[The Dub Agent and your files](../README.md#the-dub-agent-and-your-files).

## Projects

**Projects** on the rail lists every job this app knows about, newest first, with a
mark for its state: a tick for finished, a ring for waiting, a cross for failed, a
struck-through ring for cancelled. Erases are in the list too, marked as erases.

Click one to reopen it. A finished job comes back on the finished screen, a failed one
on its failure card with the reason and a button to try the same video again.
**Delete** removes that job's folder, the video, the script and the voices, and cannot
be undone.

The list is built from a `job.json` written beside each job's files, so it survives
quitting the app. A job that was still running when the app quit comes back as
interrupted.

## Settings

The gear at the foot of the rail. Six sections:

**Appearance** switches between the dark app and the older light one.

**Models** lists the packs: the AI engine, the translation models, the subtitle
eraser. Each row says how big it is and whether it is installed, and can be
downloaded or removed from here.

**API keys** are both optional. Without them PersoDub uses its free local engines.
Keys are saved on your machine and apply to the next dub, no restart needed.

- **Perso API key** enables the paid transcription and speaker-labelling path. With a
  key saved, **Perso workspace** picks which workspace the jobs run in.
- **Google (Gemini) key** enables the paid translation path.

**Storage** shows the folder your dubs are saved into.

**Privacy** has two switches, both on to begin with: *Send anonymous usage counts*
and *Send failure reports automatically*. Keys and folder names are removed from a
report before it leaves.

**About** has the version and the licences of the open-source components. The full
text ships inside the app as `NOTICE`.

## Where the files go

See [Data and privacy](../README.md#data-and-privacy) in the README for what is
written to disk and what, if anything, leaves your machine.
