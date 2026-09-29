# Requirements

| | |
|---|---|
| **Hardware** | Apple Silicon Mac (M1 or newer), or a 64-bit PC. Intel Macs are not supported. |
| **OS** | macOS 11 (Big Sur) or later, or Windows 10 (21H2) / Windows 11. Linux is [planned](roadmap.md). |
| **Graphics (Windows)** | An NVIDIA GPU is strongly recommended — AMD and Intel graphics are not accelerated. Everything works without one, just slower; see [Speed without a GPU](faq.md#speed-without-a-gpu). |
| **Memory** | 16 GB or more recommended (24 GB for the Gemma translator). PersoDub won't start a dub on a computer with less than 8 GB. |
| **Disk** | 30 GB free on macOS, 35 GB on Windows. The first setup is under 1 GB; Python + PyTorch and the voice models download when you first dub: about 9 GB on a Mac, 16 GB on a Windows PC with an NVIDIA GPU, 9 GB without one. A local translator, if you pick one instead of ChatGPT, adds 2–10 GB with its runtime. Erasing subtitles needs a pack of its own, downloaded the first time you use it: 3.9 GB on macOS, 4.4 GB on Windows without an NVIDIA GPU and 8.5 GB with one. |
| **Network** | Required for the first-run download, and for translation with ChatGPT (the default). With a local translator PersoDub runs offline unless you enable a cloud engine. |
| **Video length** | Up to 30 minutes per video is recommended. Longer videos work, but take much longer, and how long depends on your computer; trimming a long video into parts is the better path. As a guide, a 22-minute video took about an hour and a half on a PC with an RTX 3080. |

## What downloads when

| Step | Size | When |
|---|---|---|
| The app | under 1 GB | Install |
| Python + PyTorch and voice models (separation, transcription, voices) | about 9 GB on a Mac, 16 GB on Windows with an NVIDIA GPU, 9 GB without | First dub |
| Local translator (optional; ChatGPT is the default and downloads nothing) | 2–10 GB with its runtime, by model | When you pick one |
| Subtitle eraser | 3.9–8.5 GB | First erase |

Everything is fetched from its own upstream source; see [NOTICE](../NOTICE).
