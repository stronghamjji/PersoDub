# Data and privacy

[← Back to README](../README.md)

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

## The Dub Agent

The Dub Agent on the finished screen is a third way data can leave this machine, and
it is worth the same precision. It does not run an assistant of ours: it runs a CLI
you already have installed — **Claude Code** or **Codex** — as a program on your own
machine, and that CLI talks to its own vendor on your own account.

| Assistant | What it can reach here | Where the conversation goes |
|---|---|---|
| **Claude Code** | PersoDub's own script tools only. Reading files and running shell commands are denied, and your own MCP servers are left out. | Anthropic |
| **Codex** | Runs **read-only by default**, and its shell cannot reach the network. An escalation its own reviewer model approves may write to PersoDub's own agent folder (and the system temp folder) - not to the rest of your files. It can still **read any file on this computer that you can read**. If you keep standing instructions for Codex in your own `AGENTS.md` file, those are read into every turn here too. | OpenAI |

In both cases the script of the job on screen is part of the conversation. With Codex,
so is anything else it chooses to read. Your video is never uploaded for this.

The conversation carries on from one job to the next, and the thread is kept by that
assistant's own CLI on your machine — closing PersoDub does not end it. Picking no
assistant means nothing runs and nothing is sent.

## Usage counts

PersoDub reports six events — app launch, dub finished, dub failed, subtitles erased,
erasing failed, install failed — to see how many installs finish a dub. Each carries the app version, your operating
system, a random install ID, and on a failure one short code off a fixed list. A failed
install also names which of its ten steps it stopped at, again off a fixed list. Never
your video, audio, subtitles, filenames, paths or error text; no IP address is stored.

A launch counts once a day; every dub counts. Turn it off in **Settings → Privacy** or
with `PERSODUB_NO_ANALYTICS=1` in the kit's `kit.env`; it applies to the next event, no
restart. `PERSODUB_ANALYTICS_DEBUG=1` prints what would be sent instead of sending it.

## Failure reports

When an install or a dub fails, the app sends one report so the failure can be fixed.
It becomes a public issue in this repository — a hundred machines that broke the same
way land on one issue rather than a hundred.

A report carries the machine (operating system and version, CPU, memory, free disk,
which torch build, which packs are installed), where it stopped, one error code off a
fixed list, the error sentence, your app version, a random install ID, and the logs:
the last 200 lines of each in the issue itself, and the three logs in full as an
attached archive, kept for 30 days behind a signed link.

Before anything leaves your machine, every line of it is put through three rules: a
path under your home folder is cut down to `~/…/*.mp4` — the name of the folder and the
name of the file both go, and so does yours; anything shaped like an API key becomes
`[REDACTED]`; and a link is cut down to its site. The one exception is PersoDub's own
installation folder, whose paths are kept readable minus your name, because which model
or which folder a step died in is the answer we are looking for. Your `kit.env` — the
file your API keys live in — is never read by the reporting code at all, and no video,
audio, subtitle, project name or filename is ever included. The relay that posts the
issue does not store your IP address, and applies the same rules a second time.

Turn it off in **Settings → Privacy** or with `PERSODUB_NO_REPORTS=1` in the kit's
`kit.env`; it applies to the next failure, no restart. This is a separate switch from
the usage counts above — turning one off leaves the other alone.
`PERSODUB_REPORTS_DEBUG=1` prints what would be sent instead of sending it, and a
PersoDub run from source never reports at all.

With reports off, a failure can still be sent by hand: the bug report form on the
Issues page asks for the same facts, and you choose what to paste.

## Dubbing from a link

Link fetching is powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(released under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)),
installed from PyPI on your machine at install time; PersoDub does not bundle or
redistribute its code. The fetched video is saved locally and dubbed locally, like any
dropped file. Only dub videos you hold the rights to — downloading content may be
restricted by the source platform's terms of service, and that responsibility is yours.
