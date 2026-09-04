# Troubleshooting & FAQ

[← Back to README](../README.md)

## Troubleshooting

**The first launch seems to take forever.** It is downloading the models and runtimes —
roughly 3 GB on macOS, about 12 GB on Windows. This happens once; later launches start
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
[Data and privacy](privacy.md).

**Can I use PersoDub commercially?**
Yes. It is Apache-2.0. You remain responsible for holding the rights to the material you
dub, and for the terms of any optional cloud service you enable.

**Why are Intel Macs not supported?**
The Mac build targets Apple Silicon, whose built-in acceleration the pipeline relies on;
an Intel Mac has no equivalent path and would run every stage on the processor. Linux is
on the [roadmap](roadmap.md) but has no date.

**Why is the first-run download so large?**
PersoDub ships no AI models. On first launch it downloads the separation, recognition,
diarization, translation and speech-synthesis models — roughly 3 GB on macOS, about
12 GB on Windows, which also carries the CUDA build of PyTorch — so that everything can
run offline afterwards. It happens once.

**Do I need a GPU?**
On a Mac, no — PersoDub uses the acceleration built into Apple Silicon. On Windows, an
NVIDIA GPU is used when one is present; AMD and Intel graphics are not accelerated.
Everything still runs on the processor without a supported GPU, just much slower — see
[Speed without a GPU](#speed-without-a-gpu) below. Memory matters too; 24 GB is
comfortable.

**Is the dubbed audio watermarked?**
No. Please disclose AI-dubbed audio as synthetic wherever you publish it — see
[Responsible use](../README.md#responsible-use).

**How is this different from subtitle translators?**
Subtitles leave the original voice in place. PersoDub replaces the speech with a cloned
version of the same speaker's voice, so the result sounds like that person speaking the
target language.

<a id="speed-without-a-gpu"></a>

## Speed without a GPU

PersoDub runs entirely on the processor when no supported GPU is present. Nothing
breaks and no step is skipped — but two of the six stages, translation and voice
synthesis, get noticeably slower, and the gap grows with the length of the video.
Separating the background and transcribing don't use the GPU either way, so a short
clip stays comfortable; a clip with dense dialogue takes a lot longer.

**Without a GPU, stick to short clips.** Long videos are best left to a machine that has
one. If you've measured how much slower on your own machine, an
[issue](https://github.com/stronghamjji/PersoDub/issues) with your results would help.
