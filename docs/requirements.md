# Requirements

| | |
|---|---|
| **Hardware** | Apple Silicon Mac (M1 or newer), or a 64-bit PC. Intel Macs are not supported. |
| **OS** | macOS 11 (Big Sur) or later, or Windows 10 (21H2) / Windows 11. Linux is [planned](roadmap.md). |
| **Graphics (Windows)** | An NVIDIA GPU is strongly recommended — AMD and Intel graphics are not accelerated. Everything works without one, just slower; see [Speed without a GPU](faq.md#speed-without-a-gpu). |
| **Memory** | 16 GB or more recommended (24 GB for the Gemma translator). PersoDub won't start a dub on a computer with less than 8 GB. |
| **Disk** | 30 GB free on macOS, 35 GB on Windows. The first setup is under 1 GB; the AI engine, translation runtime, and models download when you first dub — roughly 2–9 GB more depending on what you choose. Erasing subtitles needs a pack of its own, downloaded the first time you use it: 3.9 GB on macOS, 4.4 GB on Windows without an NVIDIA GPU and 8.5 GB with one. |
| **Network** | Required for the first-run download. Afterwards PersoDub runs offline unless you enable a cloud engine. |

## What downloads when

| Step | Size | When |
|---|---|---|
| The app | under 1 GB | Install |
| AI engine (separation, transcription, voices) | about 8 GB | First dub |
| Translation runtime and model | 1–8 GB, by model | First dub |
| Subtitle eraser | 3.9–8.5 GB | First erase |

Everything is fetched from its own upstream source; see [NOTICE](../NOTICE).
