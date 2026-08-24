# Known limitations & roadmap

[← Back to README](../README.md)

## Known limitations

- **Emotional delivery is weaker than the original.** Timbre is cloned faithfully, but
  intense emotional performance does not fully carry over.
- **Diarization can slip when speakers sound alike.** Similar voices may be merged or
  swapped, particularly in crowded scenes.
- **Without a GPU, long videos are impractical.** Everything still runs, but translation
  and voice synthesis fall back to the processor and slow down sharply — see
  [Speed without a GPU](faq.md#speed-without-a-gpu). Short clips remain fine.
- **Linux is not supported yet.** macOS (Apple Silicon) and Windows are supported.
- **The voice-leak check reports, it does not correct.** It measures whether original
  speech bleeds through beneath the dub and surfaces the result; it does not modify the
  mix.

## Roadmap

Planned, in no committed order:

- **Additional platforms** — a Linux desktop build
- Stronger emotional delivery in synthesized speech
- More reliable diarization when speakers sound alike

Have a use case that is not covered? Open an
[issue](https://github.com/stronghamjji/PersoDub/issues) — it helps set priorities.
