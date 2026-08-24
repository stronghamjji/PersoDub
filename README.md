# PersoDub

**PersoDub - 100% Locally on Your Desktop: Dub Videos in Your Own Voice**

PersoDub re-voices a video into another language in the speaker's own cloned voice,
entirely on your desktop. No cloud, no account, no uploads: your footage never leaves
your computer.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#requirements)
[![Version](https://img.shields.io/badge/version-0.3.6-green.svg)](https://github.com/stronghamjji/PersoDub/releases)
[![Privacy](https://img.shields.io/badge/privacy-your%20footage%20stays%20local-brightgreen.svg)](#data-and-privacy)

<p>
  <a href="https://github.com/stronghamjji/PersoDub/releases/latest"><img src="https://img.shields.io/badge/Download-macOS%20(.dmg)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  <a href="https://github.com/stronghamjji/PersoDub/releases/latest"><img src="https://img.shields.io/badge/Download-Windows%20(.exe)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
</p>

<sub><b>macOS:</b> signed and notarized, opens with a double-click. &middot; <b>Windows (beta):</b> not signed yet, so SmartScreen asks first - click <b>More info</b>, then <b>Run anyway</b>. <a href="INSTALL.md#windows-beta">Details</a>.</sub>

> [!WARNING]
> **The only official source for PersoDub is
> [github.com/stronghamjji/PersoDub](https://github.com/stronghamjji/PersoDub).**
>
> Downloads, when published, appear only on
> [this repository's Releases page](https://github.com/stronghamjji/PersoDub/releases).
> Copies of this project hosted under any other account are not maintained by us --
> please do not run software you obtained from them.

---

## What is PersoDub?

**Dub a video into another language in the original speaker's own voice — entirely on your desktop.**

PersoDub is a desktop app that takes one video file and returns a dubbed version of it.
It separates speech from background audio, transcribes it, works out who spoke when,
translates each line, clones each speaker's voice, and mixes the result back over the
original soundtrack. With the default settings, every one of those steps runs locally.

<img src="docs/images/advanced-options.png" width="100%"
     alt="PersoDub main window with Advanced options expanded: a drop zone for the video, pickers for speech-to-text, original language, target language and voice quality, and below them the translation engine, the text-to-speech engine, and the number of speakers.">

> **Status: early release (v0.3.6).** PersoDub is usable today and is under active
> development. macOS on Apple Silicon and Windows (beta) are supported; Linux is planned.
> Interfaces and defaults may change. Please report problems through
> [Issues](https://github.com/stronghamjji/PersoDub/issues).

## Hear the difference

The same clip, dubbed English → Korean by each tool with the speaker's own voice
cloned.

<table>
<tr>
<td width="50%">

### Original (English)

---

https://github.com/user-attachments/assets/39589651-83fe-4673-91b4-fa078f0e523e

</td>
<td width="50%">

### PersoDub

---

https://github.com/user-attachments/assets/09f6dbd8-70f1-487f-bf8d-2d9fa5cb6433

</td>
</tr>
</table>

<table>
<tr>
<td width="25%" align="center"><b><a href="https://github.com/Huanshere/VideoLingo">VideoLingo</a></b></td>
<td width="25%" align="center"><b><a href="https://github.com/krillinai/KrillinAI">KrillinAI</a></b></td>
<td width="25%" align="center"><b><a href="https://github.com/abus-aikorea/voice-pro">Voice-Pro</a></b></td>
<td width="25%" align="center"><b><a href="https://github.com/debpalash/VoiceStudio">VoiceStudio</a></b></td>
</tr>
<tr>
<td width="25%">

https://github.com/user-attachments/assets/1045c7f6-eb6e-4df5-aee9-16cd231e5d53

</td>
<td width="25%">

https://github.com/user-attachments/assets/7cd0456a-0f0f-4be9-88d8-5ab5dece2f5a

</td>
<td width="25%">

https://github.com/user-attachments/assets/1d84b466-57b4-43ea-8760-35eae9a198d3

</td>
<td width="25%">

https://github.com/user-attachments/assets/fac60bb8-a18b-47ec-a9c8-c1a4509fa4fb

</td>
</tr>
</table>

Listen for pacing: PersoDub's lines land inside their original time slots without
speeding the audio up — the difference explained in [Why PersoDub](#why-persodub).
The source files live in [docs/demo](docs/demo).

---

## Installation

Both platforms install the same way: **go to the
[latest release](https://github.com/stronghamjji/PersoDub/releases/latest)** and
download the file for your computer.

| Your computer | File to download |
|---|---|
| Mac with Apple Silicon (M1 or newer) | `PersoDub-<version>-arm64.dmg` |
| Windows 10 (21H2+) / 11, 64-bit | `PersoDub-Setup-<version>.exe` |

### macOS

Open the downloaded `.dmg` and drag **PersoDub** into your Applications folder. The
app is signed and notarized, so it opens with a normal double-click, and it keeps
itself up to date: on launch it checks for a newer release and offers to install it.

Developers who prefer to build from source can follow
[INSTALL.md](INSTALL.md#macos--install-from-source-for-developers).

### Windows (beta)

Run the downloaded **`PersoDub-Setup-<version>.exe`**.
It installs for your user account only, into `%LOCALAPPDATA%\Programs\PersoDub`, so no
administrator rights are needed.

The Windows build is not code-signed yet, so SmartScreen shows **"Windows protected your
PC"** the first time you run the installer. Click **More info**, then **Run anyway**.

On either platform, the first launch downloads the AI models and runtimes — roughly
19 GB on macOS, about 34 GB on Windows, where the kit carries the CUDA build of PyTorch
(see [Requirements](#requirements)). On Windows the download took about 27 minutes on a
fast connection. It happens once; [docs/usage.md](docs/usage.md#first-launch) shows what
that screen looks like. On Windows the kit is stored in `%LOCALAPPDATA%\PersoDub`.

Already installed? On macOS, launch **PersoDub** from your Applications folder, or from
Terminal:

```bash
open -a PersoDub
```

On Windows, launch **PersoDub** from the Start menu.

## Table of contents

- [What is PersoDub?](#what-is-persodub)
- [Hear the difference](#hear-the-difference)
- [Installation](#installation)
- [Why PersoDub](#why-persodub)
- [Where PersoDub fits](#where-persodub-fits)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Usage](#usage)
- [Supported languages](#supported-languages)
- [Configuration](#configuration)
- [Data and privacy](#data-and-privacy)
- [Responsible use](#responsible-use)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Why PersoDub

**Your footage stays yours — processing is 100% local by default.** Separation,
transcription, diarization, translation and speech synthesis all run on your machine,
offline after the one-time model download. No account, no API key, no uploads. If you
dub confidential, unreleased or personal footage, nothing about it ever touches a
server — cloud engines are available but strictly opt-in. They and the usage counts are
both covered in [Data and privacy](#data-and-privacy).

**No time-stretching.** Most dubbing tools speed the audio up when a translation runs
longer than the original line. That is the main reason dubs sound rushed and artificial.
PersoDub never resamples the dubbed audio. Instead the constraint is moved upstream: each
line is translated to land within ±15% of its subtitle slot, and the assembly stage
carries a watchdog that measures every placed line and flags any deviation from 1.000×
playback speed in the job log. The rule is enforced in code, not by convention.

**Voice cloning, not narration.** Each speaker's timbre is cloned from the source audio,
so the dub sounds like that person speaking another language rather than a generic
synthetic narrator.

**Everything else is preserved.** Music and effects stay untouched; only speech is
replaced. Translated subtitles (`.srt`) are exported alongside the dubbed video.

## Where PersoDub fits

Open-source video dubbing has good options, and they solve different problems. If
PersoDub is not the right fit, one of these probably is:

| Project | License | Shape |
|---|---|---|
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | Apache-2.0 | Subtitle-first pipeline with dubbing, web UI |
| [KrillinAI](https://github.com/krillinai/KrillinAI) | GPL-3.0 | Translation and dubbing with scriptable stages and a CLI |
| [Voice-Pro](https://github.com/abus-aikorea/voice-pro) | GPL-3.0 | Broad voice toolkit — transcription, cloning, separation |
| [VoiceStudio](https://github.com/debpalash/VoiceStudio) | AGPL-3.0 | Local voice cloning and voice design across many languages |

**What PersoDub does differently: it refuses to time-stretch.** Every other approach
absorbs a length mismatch in the audio. PersoDub absorbs it in the translation instead,
and backs that with a watchdog that verifies, line by line, that no resampling took
place. If you have ever noticed a dub subtly sped up to fit its slot, that specific
artifact is what this project exists to eliminate.

**On licensing:** PersoDub is Apache-2.0, so it can be used inside a commercial or
closed-source product without the copyleft obligations that GPL-3.0 and AGPL-3.0 carry.

## How it works

```
video ──► source separation ──► transcription ──► speaker diarization
             (Demucs)         (faster-whisper)        (CAM++)
                                                          │
        finished video ◄── mix & mux ◄── speech synthesis ◄── translation
             (.mp4 + .srt)     (FFmpeg)      (Qwen3-TTS)    (Gemma via Ollama)
```

The app itself is a thin orchestrator. Each heavy stage runs as an isolated
subprocess with its own Python environment, so a failure in one stage cannot take
down the others. Architecture details are in [docs/development.md](docs/development.md).

## Requirements

| | |
|---|---|
| **Hardware** | Apple Silicon Mac (M1 or newer), or a 64-bit PC. Intel Macs are not supported. |
| **OS** | macOS 11 (Big Sur) or later, or Windows 10 (21H2) / Windows 11. Linux is [planned](#roadmap). |
| **Graphics (Windows)** | An NVIDIA GPU is strongly recommended. Everything works without one, but see [Speed without a GPU](#speed-without-a-gpu). AMD and Intel graphics are not accelerated. |
| **Memory** | 24 GB recommended, 16 GB minimum |
| **Disk** | 30 GB free on macOS, 45 GB on Windows. The first launch downloads the AI models and runtimes once — roughly 19 GB on macOS, 34 GB on Windows, which additionally carries the CUDA build of PyTorch. |
| **Network** | Required for the first-run download. Afterwards PersoDub runs offline unless you enable a cloud engine. |

<a id="speed-without-a-gpu"></a>

### Speed without a GPU

PersoDub runs entirely on the processor when no supported GPU is present. Nothing
breaks and no step is skipped — but two of the six stages, translation and voice
synthesis, get **much** slower, and the gap grows with the length of the video.

Measured on one desktop (Core i9-13900K, RTX 3080), same clip and settings, with the
GPU available and then hidden:

| | With GPU | Processor only |
|---|---|---|
| 10-second clip | about 1 minute | about 2 minutes |
| Per line of dialogue: translation | about 1 second | about 30 seconds |
| Per line of dialogue: voice synthesis | about 2 seconds | about 19 seconds |

A short clip stays comfortable because half the work — separating the background and
transcribing — never used the GPU anyway. A minute of dense dialogue is a different
story: the same work that takes a few minutes on a GPU can take the better part of an
hour without one, and a laptop processor is slower again than the desktop measured here.

**Without a GPU, stick to short clips.** Long videos are best left to a machine that
has one.

## Usage

1. Launch **PersoDub** — from your Applications folder on macOS, or the Start menu on
   Windows.
2. Drag a video file onto the window.
3. Choose the language to dub into.
4. Start the job. Progress is shown stage by stage.
5. When it finishes, download the dubbed video and the translated `.srt`.

Engine choices (transcription, translation, quality) live under **Advanced options**.
The defaults are the fully local, free path and are a good starting point.

A screen-by-screen walkthrough, with screenshots of every option, is in
**[docs/usage.md](docs/usage.md)**.

## Supported languages

English · Korean · Chinese · Japanese · French · German · Italian · Portuguese ·
Russian · Spanish

## Configuration

PersoDub works with no configuration. The settings below are **optional** and are
entered in the app's **Settings** screen
([screenshot](docs/usage.md#settings)).

| Setting | Default behavior | With a key |
|---|---|---|
| **Perso API key** | Transcription and diarization run on local Whisper + CAM++ | Higher transcription and speaker-labeling accuracy (cloud) |
| **Google Gemini key** | Translation runs on local Gemma via Ollama | Higher translation quality (cloud) |

- **Perso key** — available from [Perso Dubbing](https://perso.ai/dubbing?utm_source=desktop_app_github&utm_medium=desktop-app&utm_campaign=desktop_app&utm_content=readme), including a free allowance. The Settings screen links to the same page.
- **Gemini key** — available from [Google AI Studio](https://aistudio.google.com/app/apikey).

Keys are stored on your machine and take effect after you **restart the app**.

> **Note:** PersoDub is an independent open-source project. It integrates with Perso and
> Google Gemini as optional third-party services and is not affiliated with or endorsed
> by either.

## Data and privacy

**With the default engines, nothing leaves your machine.** Separation, transcription,
diarization, translation and speech synthesis all run locally.

Enabling an optional cloud engine changes that, so it is worth being precise:

| If you add | What is sent | Where |
|---|---|---|
| **Perso API key** | **The video file itself** is uploaded for transcription. Perso also becomes the default transcription engine for subsequent jobs. | Perso |
| **Google Gemini key** | **The transcript text only** — not the video, not the audio. | Google |

Clearing the key in **Settings** returns PersoDub to fully local processing.

When a Perso key is configured, requests to Perso carry a header identifying the
application name, version, and operating system family so the vendor can attribute API
usage.

The desktop app checks GitHub Releases once at launch to learn whether a newer
version exists, and downloads it in the background when there is one. The request
carries no personal data — it is the same anonymous read anyone makes opening the
releases page. Set `PERSODUB_DISABLE_UPDATE_CHECK=1` in the kit's `kit.env` to turn
the check off entirely.

### Usage counts

PersoDub reports four events — app launch, dub finished, dub failed, install failed —
to see how many installs finish a dub. Each carries the app version, your operating
system, a random install ID, and on a failure one short code off a fixed list. A failed
install also names which of its ten steps it stopped at, again off a fixed list. Never
your video, audio, subtitles, filenames, paths or error text; no IP address is stored.

A launch counts once a day; every dub counts. Turn it off in **Settings → Privacy** or
with `PERSODUB_NO_ANALYTICS=1` in the kit's `kit.env`; it applies to the next event, no
restart. `PERSODUB_ANALYTICS_DEBUG=1` prints what would be sent instead of sending it.

## Responsible use

PersoDub clones the voices of real people. Please use it accordingly.

- Only clone a voice that is yours, or one you have explicit permission to use.
- Disclose AI-dubbed audio as synthetic wherever you publish it.
- Do not use PersoDub to impersonate anyone, or to misrepresent what a person said.
- You are responsible for holding the rights to your source material and for complying
  with the laws and regulations that apply where you are.

**Dubbing from a link.** Link fetching is powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(released under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)),
installed from PyPI on your machine at install time; PersoDub does not bundle or
redistribute its code. The fetched video is saved locally and dubbed locally, like any
dropped file. Only dub videos you hold the rights to — downloading content may be
restricted by the source platform's terms of service, and that responsibility is yours.

## Known limitations

- **Emotional delivery is weaker than the original.** Timbre is cloned faithfully, but
  intense emotional performance does not fully carry over.
- **Diarization can slip when speakers sound alike.** Similar voices may be merged or
  swapped, particularly in crowded scenes.
- **Without a GPU, long videos are impractical.** Everything still runs, but translation
  and voice synthesis fall back to the processor and slow down sharply — see
  [Speed without a GPU](#speed-without-a-gpu). Short clips remain fine.
- **Linux is not supported yet.** macOS (Apple Silicon) and Windows are; see
  [Roadmap](#roadmap).
- **The voice-leak check reports, it does not correct.** It measures whether original
  speech bleeds through beneath the dub and surfaces the result; it does not modify the mix.

## Roadmap

Planned, in no committed order:

- **Additional platforms** — a Linux desktop build
- Stronger emotional delivery in synthesized speech
- More reliable diarization when speakers sound alike

Have a use case that is not covered? Open an
[issue](https://github.com/stronghamjji/PersoDub/issues) — it helps set priorities.

## Troubleshooting

**The first launch seems to take forever.** It is downloading the models and runtimes —
roughly 19 GB on macOS, about 34 GB on Windows. This happens once; later launches start
immediately.

**A cloud engine is greyed out in the dropdown.** Save the corresponding API key in
Settings, then restart the app. Engine availability is evaluated at startup.

**I saved a key but nothing changed.** Keys are read when the engines start. Restart the
app to apply them.

**A job failed and mentioned an engine by name.** The message names the stage that
failed. Switching that stage to its local option (Whisper for transcription, Gemma for
translation) is usually the fastest way to confirm whether the problem is the cloud
service or the input file.

## FAQ

**Does my video leave my computer?**
Not with the default settings — every stage runs locally. It leaves only if you add a
Perso key, which uploads the video for transcription. See
[Data and privacy](#data-and-privacy).

**Can I use PersoDub commercially?**
Yes. It is Apache-2.0. You remain responsible for holding the rights to the material you
dub, and for the terms of any optional cloud service you enable.

**Why are Intel Macs not supported?**
The Mac build targets Apple Silicon, whose built-in acceleration the pipeline relies on;
an Intel Mac has no equivalent path and would run every stage on the processor. Linux is
on the [roadmap](#roadmap) but has no date.

**Why is the first-run download so large?**
PersoDub ships no AI models. On first launch it downloads the separation, recognition,
diarization, translation and speech-synthesis models — roughly 19 GB on macOS, about
34 GB on Windows, which also carries the CUDA build of PyTorch — so that everything can
run offline afterwards. It happens once.

**Do I need a GPU?**
On a Mac, no — PersoDub uses the acceleration built into Apple Silicon. On Windows, an
NVIDIA GPU is used when one is present; AMD and Intel graphics are not accelerated.
Everything still runs on the processor without a supported GPU, just much slower — see
[Speed without a GPU](#speed-without-a-gpu). Memory matters too; 24 GB is comfortable.

**Is the dubbed audio watermarked?**
No. Please disclose AI-dubbed audio as synthetic wherever you publish it — see
[Responsible use](#responsible-use).

**How is this different from subtitle translators?**
Subtitles leave the original voice in place. PersoDub replaces the speech with a cloned
version of the same speaker's voice, so the result sounds like that person speaking the
target language.

## Development

Setup, architecture, and how to run the test suite are documented in
**[docs/development.md](docs/development.md)**.

The backend targets Python 3.11 and is not yet compatible with 3.13 or later.

## Contributing

Issues and pull requests are welcome. Please open an issue describing the problem or
proposal before starting substantial work, so effort is not duplicated. Bug reports are
most useful when they include your operating system version — macOS version and your
Mac's chip, or your Windows version and whether the machine has an NVIDIA GPU — and the
job log from the failing run.

## Security

Please do not report security issues in public issues. Use GitHub's
[private vulnerability reporting](https://github.com/stronghamjji/PersoDub/security/advisories/new)
so the problem can be addressed before disclosure.

PersoDub stores your API keys in a file on your machine. Treat that file, and any log or
screenshot you share, the way you would treat the keys themselves.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

[NOTICE](NOTICE) lists the third-party components and their licenses. This repository
redistributes the CAM++ speaker model and a small amount of ported Demucs source
(MIT, © Meta Platforms, Inc. and affiliates). Everything else is fetched from its own
upstream source during installation.

## Acknowledgments

PersoDub stands on these open-source projects.

| Project | Role |
|---|---|
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Voice-cloning speech synthesis |
| [Demucs](https://github.com/adefossez/demucs) | Source separation — splits speech from background audio |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Speech recognition |
| [CAM++ (3D-Speaker)](https://github.com/modelscope/3D-Speaker) | Speaker diarization |
| [Ollama](https://github.com/ollama/ollama) + [Gemma](https://github.com/google-deepmind/gemma) | Local translation model and runtime |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Video and audio processing |
| [Electron](https://github.com/electron/electron) | Desktop application framework |

---

<div align="center">

Ever winced at a dub crammed into its slot at 1.3× speed? That is the problem this exists to fix.

⭐ **Star the repo** so the next person looking for a way out finds it.

</div>
