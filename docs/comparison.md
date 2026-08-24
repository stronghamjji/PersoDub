# Where PersoDub fits

[← Back to README](../README.md)

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
artifact is what this project exists to eliminate. Each line is translated to land
within ±15% of its subtitle slot, and the assembly stage's watchdog flags any deviation
from 1.000× playback speed in the job log — the rule is enforced in code, not by
convention.

**On licensing:** PersoDub is Apache-2.0, so it can be used inside a commercial or
closed-source product without the copyleft obligations that GPL-3.0 and AGPL-3.0 carry.
