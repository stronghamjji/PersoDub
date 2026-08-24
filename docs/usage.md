# Using PersoDub

A screen-by-screen walkthrough of the app. To install it, see the
[Installation section of the README](../README.md#installation).

## First launch

The first time PersoDub opens, it downloads its engines and AI models — roughly 19 GB
in total. This happens once. The window lists the steps and ticks them off as they
finish; if the app is closed partway through, setup resumes where it left off.

<img src="images/installing.png" width="100%"
     alt="First-launch setup screen: a numbered list of ten install steps with the finished ones ticked off, and a progress bar underneath.">

Nothing else is needed while this runs. When it completes, the app opens on the
**Upload** tab.

## Dubbing a video

<img src="images/main-window.png" width="100%"
     alt="PersoDub main window: a drop zone for the video, with pickers for speech-to-text, original language, target language, and voice quality.">

1. **Add your video.** Drop a file onto the upload area, click it to browse, or paste a
   video link. MP4 and MOV are accepted, up to 2 GB.

2. **Speech-to-text** — turns the speech in your video into text.

   | Option | Notes |
   |---|---|
   | Whisper (free, offline) | Default. Runs on your machine; no account, no key. |
   | Perso API (paid, best quality) | Needs a Perso API key — see [Settings](#settings). |

3. **Original language** — leave this on *Auto-detect (recommended)* unless detection
   gets it wrong.

4. **Target language** — the language to dub into. Ten are supported: English, Korean,
   Chinese, Japanese, French, German, Italian, Portuguese, Russian and Spanish.

5. **Voice quality**

   | Option | Notes |
   |---|---|
   | Fast (1 voice take per line) | One take per line. |
   | High quality (best of 4 takes, ~4× slower) | Default. Each line is voiced four times and the best take is kept. Noticeably better voices, but the voice stage takes about 4× longer. |

6. **Start dubbing.** Progress is shown stage by stage in the bar at the top.

7. When the job finishes, the **Export** tab unlocks. Download the dubbed video and the
   translated `.srt` there. The translated lines are listed beside the player with the
   time slot each one lands in.

<img src="images/export.png" width="100%"
     alt="The Export tab of a finished job: the dubbed video with Download video and Download subtitles buttons, and beside them the translated lines with their time slots.">

Finished and in-progress jobs are listed under **Recent jobs** on the left.

## Advanced options

These sit behind the **Advanced options** toggle on the Upload tab. The defaults are the
fully local, free path and are a good starting point.

<img src="images/advanced-options.png" width="100%"
     alt="Advanced options expanded, showing the translation engine, the text-to-speech engine, and the number of speakers.">

| Field | Default | Notes |
|---|---|---|
| **Translation** | Gemma (free, offline) | Translates the transcribed text. The alternative, *Gemini API (paid, best quality)*, needs a Google Gemini key. |
| **Text-to-speech** | Qwen3-TTS (free, offline) | Speaks the translated lines in the cloned voice. |
| **Number of speakers** | Auto-detect | Auto-detect currently assumes at least two speakers. Set it to 1 for a single-speaker video. |

An engine that needs a key it cannot find is marked as unavailable rather than
silently failing.

## Settings

Open Settings with the gear icon at the bottom left of the window.

<img src="images/settings.png" width="100%"
     alt="The Settings window, with optional API key fields, the output location, a developer-details toggle, and the list of bundled open-source licenses.">

**API keys** — both are optional. Without them, PersoDub uses its free local engines
(Whisper for transcription, Gemma for translation). Keys are saved into the app's own
config file on your machine. **Restart PersoDub after saving** for them to take effect.

- **Perso API key** — enables the paid transcription and diarization path. Once a key is
  saved, **Perso workspace** lets you pick which workspace the jobs run in, and whose
  credits they use.
- **Google (Gemini) key** — enables the paid translation path.

**Output location** — read-only for now. Each job's files are managed automatically;
download them from the Export tab when the job finishes.

**Developer details** — off by default. When on, a dub shows the detailed stage tracker
and the raw pipeline log (internal stage names and timings) instead of just the progress
bar.

**About** — the app version, and the licenses of the open-source components bundled with
it. The full text ships inside the app as `NOTICE`.

## Where the files go

See [Data and privacy](../README.md#data-and-privacy) in the README for what is written
to disk and what, if anything, leaves your machine.
