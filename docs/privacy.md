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
| **Codex** | Runs **read-only by default**, and its shell cannot reach the network. An escalation its own reviewer model approves may write to PersoDub's own agent folder, and nowhere else. It can still **read any file on this Mac that you can read**. | OpenAI |

In both cases the script of the job on screen is part of the conversation. With Codex,
so is anything else it chooses to read. Your video is never uploaded for this.

The conversation carries on from one job to the next, and the thread is kept by that
assistant's own CLI on your machine — closing PersoDub does not end it. Picking no
assistant means nothing runs and nothing is sent.

## Usage counts

PersoDub reports four events — app launch, dub finished, dub failed, install failed —
to see how many installs finish a dub. Each carries the app version, your operating
system, a random install ID, and on a failure one short code off a fixed list. A failed
install also names which of its ten steps it stopped at, again off a fixed list. Never
your video, audio, subtitles, filenames, paths or error text; no IP address is stored.

A launch counts once a day; every dub counts. Turn it off in **Settings → Privacy** or
with `PERSODUB_NO_ANALYTICS=1` in the kit's `kit.env`; it applies to the next event, no
restart. `PERSODUB_ANALYTICS_DEBUG=1` prints what would be sent instead of sending it.

## Dubbing from a link

Link fetching is powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(released under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)),
installed from PyPI on your machine at install time; PersoDub does not bundle or
redistribute its code. The fetched video is saved locally and dubbed locally, like any
dropped file. Only dub videos you hold the rights to — downloading content may be
restricted by the source platform's terms of service, and that responsibility is yours.
