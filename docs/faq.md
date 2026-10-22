# Troubleshooting & FAQ

[← Back to README](../README.md)

## Troubleshooting

**The first launch seems to take forever.** It is setting up the app — roughly 0.6 GB on
macOS, 0.9 GB on Windows. The AI engine, translation runtime, and models download the
first time you dub on this computer. Later launches start immediately.

**The engine dropdowns are greyed out.** While **Choose a model** is set to **Perso API**, Perso
does every step, so the other choices do not apply. Set **Choose a model** to **Local
model**, the default, to pick them. A cloud choice with no key saved asks for the key
when you pick it.

**I saved a key but nothing changed.** Keys are read each time a dub starts, so a saved
key applies to the next dub. No restart is needed.

**A job failed and mentioned an engine by name.** The message names the stage that
failed. Switching that stage to its local option (Whisper for transcription, Gemma for
translation) is usually the fastest way to confirm whether the problem is the cloud
service or the input file.

**A job failed with "Unexpected error".** That wording means the failure was a bug, not
something the app knows how to explain. The details are in that job's own log — see
below.

### Logs

Two logs sit side by side in the app's `logs` folder,
`~/Library/Application Support/persodub-desktop-shell/logs` on macOS and
`%APPDATA%\persodub-desktop-shell\logs` on Windows:

| File | What it holds |
|---|---|
| `job-<id>.log` | One dubbing job's progress, the same lines the screen shows, plus the full details of a failure |
| `persodub.log` | The app itself: what it did at startup, and the whole story behind any "An internal error occurred" |

Beside them, `timeline.log` is these logs and the app's own `shell.log` merged in time
order, the one file to read first; the app rewrites it every five minutes and when it
quits.

`persodub.log` rolls over at about 2 MB and keeps three older copies
(`persodub.log.1` and so on), so it never grows without limit. Both are plain text —
attach them to a bug report.

Set `PERSODUB_DEBUG=1` before starting the app to record much more detail in
`persodub.log`; set `PERSODUB_LOG_DIR` to put both logs somewhere else when you
run the server yourself (the desktop app always keeps them in its own folder).

## FAQ

**Does my video leave my computer?**
By default, no: Start dubbing uses this computer. **Speech-to-text** (under **Dubbing step settings**) set to **Perso API** uploads it for transcription, and
**Choose a model** set to **Perso API** uploads it to Perso's
cloud, which makes the whole dub. Translation sends only the transcript text: to
ChatGPT through your own sign-in on a new install, or nowhere with a local translator.
See [Data and privacy](privacy.md).

**Can I use PersoDub commercially?**
Yes. It is AGPL-3.0: commercial use is allowed, and if you distribute a changed PersoDub
or run one as a network service, the changed source must be shared under the same
license. You remain responsible for holding the rights to the material you dub, and for
the terms of any optional online service you enable.

**Why are Intel Macs not supported?**
The Mac build targets Apple Silicon, whose built-in acceleration the pipeline relies on;
an Intel Mac has no equivalent path and would run every stage on the processor. Linux is
on the [roadmap](roadmap.md) but has no date.

**Why is the first-run download so large?**
The first setup downloads only the app and Python — roughly 0.6 GB on macOS, 0.9 GB on
Windows. The AI engine, translation runtime, and models download the first time you dub
on this computer, so you get only what you choose. After that, a dub on this computer
with Whisper and a local translator runs offline; Perso and ChatGPT need the network.

**Do I need a GPU?**
On a Mac, no — PersoDub uses the acceleration built into Apple Silicon. On Windows, an
NVIDIA GPU is used when one is present; AMD and Intel graphics are not accelerated.
Everything still runs on the processor without a supported GPU, just much slower — see
[Speed without a GPU](#speed-without-a-gpu) below. Memory matters too; 24 GB is
comfortable.

**Is the dubbed audio watermarked?**
No. Please disclose AI-dubbed audio as synthetic wherever you publish it — see
[Responsible use](responsible-use.md).

**How is this different from subtitle translators?**
Subtitles leave the original voice in place. PersoDub replaces the speech with a cloned
version of the same speaker's voice, so the result sounds like that person speaking the
target language.

<a id="speed-without-a-gpu"></a>

## Speed without a GPU

On this computer, PersoDub runs entirely on the processor when no supported GPU is
present. Nothing breaks and no step is skipped, but voice synthesis gets noticeably
slower, and so do a local translator and Mel-Band RoFormer separation; the gap grows
with the length of the video. Transcribing (Whisper) and Demucs separation run on the
processor either way, so a short clip stays comfortable; a clip with dense dialogue
takes a lot longer. A Perso API dub runs on Perso's side and does not depend on your
hardware.

**Without a GPU, stick to short clips.** Long videos are best left to a machine that has
one. If you've measured how much slower on your own machine, an
[issue](https://github.com/stronghamjji/PersoDub/issues) with your results would help.
