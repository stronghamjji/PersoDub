# Requirements

| | |
|---|---|
| **Hardware** | Apple Silicon Mac (M1 or newer), or a 64-bit PC. Intel Macs are not supported. |
| **OS** | macOS 13 (Ventura) or later, or Windows 10 (21H2) / Windows 11. Linux is [planned](roadmap.md). |
| **Graphics (Windows)** | An NVIDIA GPU is strongly recommended — AMD and Intel graphics are not accelerated. Everything works without one, just slower; see [Speed without a GPU](faq.md#speed-without-a-gpu). |
| **Memory** | 16 GB or more recommended (24 GB for the Gemma translator). PersoDub won't start a dub on this computer with less than 8 GB; a Perso API dub is not checked. |
| **Disk** | 30 GB free on a Mac, 40 GB on Windows with an NVIDIA GPU, 30 GB without one: enough for everything below with room to work. The first setup is under 1 GB; Python + PyTorch and the voice models download the first time you dub on this computer: about 10 GB on a Mac, 17 GB on a Windows PC with an NVIDIA GPU, 9 GB without one (about 3 GB less when Perso does the speech-to-text). A local translator, if you pick one instead of ChatGPT, adds 2–10 GB with its runtime. Erasing subtitles needs a pack of its own, downloaded the first time you use it: 4.4 GB on macOS, 4.4 GB on Windows without an NVIDIA GPU and 9.3 GB with one. |
| **Network** | Required for the first-run download, for Perso API dubbing, and for translation with ChatGPT (the default translator on this computer). A dub on this computer with Whisper and a local translator runs offline. |
| **Video length** | Up to 30 minutes per video is recommended. Longer videos work, but take much longer, and how long depends on your computer; trimming a long video into parts is the better path. As a guide, a 22-minute video took about an hour and a half on a PC with an RTX 3080. |

## What downloads when

| Step | Size | When |
|---|---|---|
| The app | under 1 GB | Install |
| Python + PyTorch and voice models (separation, transcription, voices) | about 10 GB on a Mac, 17 GB on Windows with an NVIDIA GPU, 9 GB without | First dub on this computer |
| Local translator (optional; ChatGPT is the default and downloads nothing) | 1.6–10 GB with its runtime, by model and computer | When you pick one |
| Mel-Band RoFormer (optional; Demucs separates until it is there) | 0.9 GB | When you download it in Settings |
| Subtitle eraser | 4.4–9.3 GB | First erase |
| Everything above | about 25 GB on a Mac, 38 GB on Windows with an NVIDIA GPU, 26 GB without | |

Everything is fetched from its own upstream source; see [NOTICE](../NOTICE).
