# Using PersoDub

A walkthrough of the app, screen by screen. To install it, see the
[Get started section of the README](../README.md#get-started).

> The screenshots that used to be here have been taken out while a video
> walkthrough is made. Everything below describes 0.8.5 as it stands.

## First launch

The first time PersoDub opens it sets itself up. The base install is under 1 GB,
and the heavy parts arrive later: Python + PyTorch, Ollama (only for a local translator) and the
models download the first time you start a dub on this computer, and the subtitle eraser downloads
the first time you use it. The window lists the steps and ticks them off; closing
the app partway through does not lose the work, setup resumes where it stopped.

## The window

The Home screen has a sidebar down the left:

- **Tools**: **Dubbing**, **Erase subtitles**, **Burn in subtitles** and **Save video**.
- **Management**: **Projects**, every job this app has run, and **Settings**.
- At its foot, **Help**, **Send feedback** and **What's new**.

Beside it are the **Create project** banner, a row of cards (the **Dub Agent** and
the four tools) and your projects.

A project opens on the work screen: tabs on the left (**Dubbing**, **Erase**, **Burn in
subtitles**, **Save video**, between **Home** and **New project**), the video in
the middle, the **Dub Agent** panel on the right and the timeline under all three.
Along the top is the bar with the project's name, **Settings** and the three pane
buttons that show or hide the left panel, the timeline and the Dub Agent. **Download**
is at the right end of the tabs above the video.

## Dubbing

The first screen asks one thing: which video? Drop files on the **Create project**
banner, click it to choose them, or paste a video link into its link box. MP4 and MOV
are accepted, up to 2 GB each. Several at once is fine: they queue and run one after
another.

A pasted link is fetched onto your machine before anything else happens, with the
percentage on screen. Once it is here it behaves exactly like a file you dropped:
you can play it, cut it, and save a copy. See
[Dubbing from a link](privacy.md#dubbing-from-a-link).

## New project

As soon as one video is ready it opens as a new project: the work screen, with the
**Dubbing** tab on the left showing **Before dubbing**. Its **Video** card has
**Replace**, which opens the file picker and puts the video you choose in its place
(the old one's Draft card leaves Home), and **Remove**, which asks first, deletes this
draft and leaves the project empty for another video. Several videos at once open the **New project** dialog instead, where
one set of choices starts them all.

**Cutting** happens on the timeline under the video: **Split at playhead**, **Delete
left of playhead**, **Delete right of playhead** and **Delete selected** take out what
you do not want, with **Undo** and **Redo**. Leave it alone to take the whole video. A
cut video is re-encoded before the work starts, which takes a moment but cuts
exactly where you asked.

**Choose a model**, first, is how the dub is made: **Local model**, the free path on this
computer and the one a first project starts on, or **Perso API**, where the video is
uploaded to Perso and Perso makes the whole dub, which needs a Perso API key and uses
Perso credits. With **Perso API** the **Dubbing model** row under it picks Perso's voice
model: *Linnet 4* to begin with (*Oriole* for a language Linnet 4 does not have),
*Nightingale*, *Wren* and the others. Later projects start
on the choices you made last.

**Original language** can stay on *Auto-detect* unless detection gets it wrong.

**Target language** is the language to dub into: ten on this computer (English, Korean,
Chinese, Japanese, French, German, Italian, Portuguese, Russian and Spanish), 100+ with
the Perso API, depending on the **Dubbing model** above ([full list](languages.md)).
It opens as a list with a search field on top: type part of a name, in your language
or in English, or a code such as *zh*, and only the languages that match stay, with a
count such as *2 of 77* under them.

From here:

- **Download**, at the right end of the tabs above the video, saves the kept part as a
  video, or as audio only, into Downloads.
- The **Erase** and **Burn in subtitles** tabs work on the same video.
- **Start dubbing** begins the dub. With **Perso API** the line beside it says what the
  dub costs and how many credits your Perso workspace has left. Perso charges the dubbing
  model's credits a second for the whole seconds that are spoken, so a new video says *up
  to* that rate times every whole second kept, and one opened with **+ Add language** says
  *about* that rate times the seconds its first dubbing's script speaks.

### Dubbing step settings

Always shown under **Choose a model**. The rows from **Voice separation** to **Voice quality** apply only
with **Local model**. While Perso dubs they are greyed out and read *Perso*; what you chose
for the local model comes back when you choose it again.

| Field | Default | Notes |
|---|---|---|
| **Voice separation** | Demucs | Splits the voice from the music and effects. *Mel-Band RoFormer* is a choice in this list too: a cleaner background, slower, and a 0.9 GB download. *Perso API* needs a Perso key. |
| **Speech-to-text** | Whisper; Perso API when you choose it | Turns the speech in your video into text. *Perso API* uploads the video. |
| **Translation** | ChatGPT (Hunyuan on a computer that already has the Hunyuan model) | *ChatGPT* uses your own free ChatGPT account; you sign in on your first dub. *Hunyuan* and *Gemma 3* translate locally. *Gemini API* needs a Google key. |
| **Text-to-speech** | Qwen3-TTS | Speaks the translated lines in the cloned voice. |
| **Voice quality** | Fast | *Fast* voices each line once. *High quality* voices it four times and keeps the best take, which is noticeably better and takes about four times as long. |
| **Number of speakers** | Auto-detect | Auto-detect works the number out from the voices. Set it to 1 for a single-speaker video. |

Picking an option that needs a key you have not saved opens a small window for the
key.

## While it runs

While a dub runs, the **Dubbing** tab shows its progress card, with the four stages
ticking off: separating the audio, transcribing it, translating it, and dubbing.
The dubbing stage counts the lines as it voices them. For a Perso API dub the
card's title follows Perso's steps instead: **Uploading to Perso**, **Dubbing at
Perso**, **Delivering**. The middle panel plays your original video. **Stop** sits at
the foot of the card, beside **Raw log**; it asks once, and the job then stops at the
next point where it can, such as between two lines.

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
- **Original** and **Dubbed**, above the player, swap which file it shows.
- **The timeline** underneath has a lane for the video, one for the original, one
  for the translation and one for the captions. A bar that runs past its slot is
  marked.
- **Download**, at the right of **Original** and **Dubbed**, saves the dubbed video, with
  or without the subtitles burned in, the dubbed audio, the original voice and the
  background, the translated `.srt`, the script as a spreadsheet (each line's speaker,
  times, original and translation, laid out as Perso's web app downloads it), and, for
  a job that started from a link, the original video (each when the job has one).
- The click target on the job's name in the top bar renames the project. The folder
  keeps the name it was made with; the screens show the name you gave it.

A narrow window folds columns away rather than cutting words in half. The end of each
time slot goes first, then the original line, so the translation always stays whole.

### Download

**Download** opens a dialog with a row per file, each with a tick box; a dubbing's rows
stand under three headings, **Video**, **Subtitles & script** and **Audio**. The dialog's own
**Download** button saves the ticked rows. Sound rows can be MP3 or WAV. The app saves
without asking, into `Downloads` / the day the job ran / the project's name; a saved
row gets a check, and the line under the rows says where it went.

## Erase subtitles

**Erase subtitles** on the Home screen, or the **Erase** tab of a project, takes
subtitles that are burned into the picture back out of it.

- **Why:** Original subtitles left in the video overlap the translated ones.
- **How:** Fit the box → Erase subtitles → Dubbing → burn in a Subtitle style.
- **Time:** About 10 min for a 10-second video (Local model).

Drop a video or paste a link, the same two ways in the dubbing screen offers. The app
looks for the writing and draws a box where it thinks it is: red while it is looking,
green once it has found something. Drag the box if it missed, and cut the video on
the timeline if you do not need all of it.

The foot of the panel says about how many minutes it will take before you start. It
is slow work, minutes for every minute of video, because every frame in the band has
to be painted over. **Erase** starts it.

When it finishes, **Original** and **Erased** above the picture swap between the two
so you can see what changed. **Download**, at the right of the two, saves the clean video,
**Dubbing** opens it as a new project to dub, and the **Burn in subtitles** tab puts a
subtitle file on it. If something goes wrong, the panel says
why it stopped, **Try again** runs it again on the same video and the same box, and
**Raw log** has the detail.

The eraser is a pack of its own, downloaded the first time you use it.

## Burn in subtitles

The **Burn in subtitles** card on the home screen, or the tab of the same name in a
project, puts a subtitle file (`.srt`) on a video in the look you choose. Bring the
video the same ways the Dubbing tab offers; in a project the tab uses that project's
video (the original it was cut from, while the app still has it), and on the erase
screen the erased one. Then drop the `.srt` file, and the two open as a new project.

Its tab names the two files and holds the looks, **A-** / **A+** for the size, **All
lines** / **This line** for the boxed looks, and **Show**. Clicking the subtitle on the
picture picks that line. **Download** saves the video with the subtitles burned in.

In a dub, the **Subtitle style** button just above the subtitle, shown while the video
is paused, opens the same looks for the dub's own subtitles.

## Save video

The **Save video** card on the home screen puts the cursor in the link box at the
top ("Paste a YouTube, TikTok or Reels link"). Paste a link and it opens as a new
project on the Dubbing tab, where the video is fetched onto your computer with the
percentage on screen.

From there **Download** > **Video** saves the file, in the shape the **Ratio** button is
set to. The same video can also be dubbed or have its subtitles erased
without fetching it again.

Links are fetched with yt-dlp on your computer. Saving uploads nothing; dubbing or
separating the video with Perso uploads it. See
[Dubbing from a link](privacy.md#dubbing-from-a-link).

## The Dub Agent

The panel on the right is the Dub Agent. Ask for a fix in plain words, "shorten line
4 so it fits, then remake its voice", and it edits the script and remakes voices
through PersoDub's own tools, showing each step as it goes.

Pick which assistant answers, and its model, from the button beside the box. It runs
Claude Code or Codex as a program on your computer, billed to your own account with
that vendor. Claude Code must already be installed; Codex can be your own copy or the
one PersoDub downloads for the ChatGPT sign-in. Once it has answered once, the button
also names the model it answered with.

**Signing in.** When the chosen assistant is not signed in, the panel's heading says
so, with a **Sign in** button. For Claude Code the app starts `claude auth login`,
which opens your browser; for Codex it opens the app's own ChatGPT sign-in window, the
same sign-in the ChatGPT translator uses. If the app cannot start Claude's sign-in,
the panel says to run `claude` in Terminal. The panel also notices a Claude Code
sign-in made in Terminal while the app is open.

The agent is never locked. It answers on a finished job, on a job that failed, while
a dub is running, and on the home screen with nothing open at all, which is where you
would ask it to dub the videos in a folder.

What each assistant can reach on your machine, and the fact that **Codex can read
files on this computer even in its read-only sandbox**, is spelled out in
[The Dub Agent and your files](configuration.md#the-dub-agent-and-your-files).

## Projects

**Projects** on the Home screen shows every job this app knows about, newest first,
as cards (the sidebar's **Projects** scrolls to them). A card's chip says **Queued**,
**Failed** or **Cancelled**, or how far a running job has got; a finished one has
none. Erases and separations carry a small mark of their own, and a video you left
before dubbing it is a **Draft** card. One video dubbed into several languages is one
card.

Click one to reopen it. A finished job comes back on the finished screen; a failed or
cancelled one shows the reason, with **Resume**, which carries on from where it
stopped, and **Start over** (a Perso API dub has only **Start over**). A Perso API dub
on a free-plan workspace ends as **See it on Perso**: Perso made it but does not let a
free plan download it, and **Open in Perso** opens it on Perso's site. The **...**
menu on a card has **Rename** and **Delete** (a draft's, **Delete** alone); **Delete**
removes the project's folders, with the video, the script and the voices, and cannot
be undone.

The list is built from a `job.json` written beside each job's files, so it survives
quitting the app. A job that was still running when the app quit comes back as
interrupted.

## Settings

The gear in the top bar, or **Settings** in the Home screen's sidebar. Five tabs;
nothing is saved until you press **Save**:

**Models** lists the packs and models: Python + PyTorch, Ollama, the subtitle eraser,
Qwen3-TTS, Whisper, Mel-Band RoFormer and the translation models. Each row says how
big it is and whether it is installed, and can be downloaded or removed from here.

**API keys**: a Perso key is needed for Perso API dubbing; dubbing on this
computer, the default, works without any key. Keys are saved on your machine and apply to the
next dub, no restart needed.

- **Perso API key** enables Perso API dubbing, separation and transcription, which
  use Perso credits. With a key saved, **Perso workspace** picks which workspace the
  jobs run in.
- **Google (Gemini) key** enables the paid translation path.
- **ChatGPT**: **Sign in with ChatGPT** signs the ChatGPT translator in with your own
  account.

**Storage** opens the folder your finished videos are saved in (**Show in Finder**, or
**Show in Explorer** on Windows).

**Privacy** has three switches: *Anonymous usage counts* and *Help improve PersoDub*, both on to
begin with, and *Share App Analytics*, on to begin with in the production edition only.
Keys and folder names are removed from a job's logs before they leave.

**About** has the version (press it to see what is new) and, under
**Acknowledgements**, the licences of the open-source components. The full text
ships inside the app as `NOTICE`.

## Where the files go

See [Data and privacy](privacy.md) for what leaves your machine, and
[The kit and the other folders](architecture.md#12-the-kit-and-the-other-folders) for
what is written to disk.
