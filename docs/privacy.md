# Data and privacy

[← Back to README](../README.md)

**By default, Start dubbing runs on this computer and needs no key.** Separation
and speech synthesis run locally, and speech-to-text runs on local Whisper and
CAM++, key or no key. One step can still leave by default: translation sends the
transcript text through your own ChatGPT account on a new install (a computer that
already has the Hunyuan model translates locally). With **Whisper** and a local translator (Hunyuan or
Gemma), nothing from the video leaves at all. Set **Choose a model** to
**Perso API** and the video is uploaded to Perso, which makes the whole
dub; that needs a Perso API key.

Perso is a service of ESTsoft Inc. What it does with an uploaded video is set out in
its own [privacy policy](https://perso.ai/privacy) and
[terms of use](https://info.perso.ai/policy-perso-saas/policy/terms-of-service-en/docs/260526.html).

What each dubbing service receives, precisely:

| If you add | What is sent | Where |
|---|---|---|
| **Perso API key** | **The video file itself** (the part you kept) is uploaded. With Perso API dubbing, Perso transcribes, translates and voices it and sends back the finished video; the project's name goes with it, as its title on your Perso workspace. Dubbing on this computer, the default, can set **Speech-to-text** and **Voice separation** to Perso; each of those uploads the video too, with the project's name, as does **Separate audio** on Perso. | Perso |
| **Google Gemini key** | **The transcript text only** — not the video, not the audio. | Google |
| **ChatGPT sign-in** (the default translator) | **The transcript text**, with the translation instructions, sent through your own ChatGPT account, under that account's own data settings. The program that carries it (OpenAI's Codex) runs in a folder of PersoDub's own with every tool switched off, so it reads nothing else on your computer and none of your own Codex settings go along; OpenAI's program may send its own usage statistics. The sign-in is OpenAI's own flow and stays on your computer; PersoDub never sees the password or token. | OpenAI |

Clearing the key in **Settings** stops that engine. Picking a local translator (Hunyuan or Gemma) under **Dubbing step settings** keeps translation on your computer too.

When a Perso key is configured, requests to Perso carry a header identifying the
application name, version, and operating system family so the vendor can attribute API
usage.

The desktop app checks GitHub Releases once at launch to learn whether a newer
version exists, and downloads it in the background when there is one, with that
version's list of changes from the repository for the update window. The request
carries no personal data — it is the same anonymous read anyone makes opening the
releases page. Set `PERSODUB_DISABLE_UPDATE_CHECK=1` in the kit's `kit.env` to turn
the check off entirely.

## The Dub Agent

The Dub Agent on the finished screen is a third way data can leave this machine, and
it is worth the same precision. It does not run an assistant of ours: it runs
**Claude Code** or **Codex** as a program on your own machine, and that program
talks to its own vendor on your account. Claude Code must already be installed;
Codex can be your own copy or the one PersoDub downloads for the ChatGPT sign-in.

| Assistant | What it can reach here | Where the conversation goes |
|---|---|---|
| **Claude Code** | PersoDub's own script tools only. Reading files and running shell commands are denied, and your own MCP servers are left out. It runs apart from your own Claude Code setup: none of your settings files, hooks, plugins, `CLAUDE.md` or memory files are loaded, only your sign-in. | Anthropic |
| **Codex** | Runs **read-only by default**, and its shell cannot reach the network. An escalation its own reviewer model approves may write to PersoDub's own agent folder (and the system temp folder) - not to the rest of your files. It can still **read any file on this computer that you can read**. It runs in a Codex folder of PersoDub's own, signed in with the app's ChatGPT sign-in, so your own Codex settings and `~/.codex/AGENTS.md` are not read. | OpenAI |

**ChatGPT** is not a Dub Agent choice: it is the translator's sign-in, which the Codex assistant shares. Whichever assistant answers, an email address in its answer is shown as "(email hidden)", and the panel names only the kind of account that is signed in.

In both cases the script of the job on screen is part of the conversation. With Codex,
so is anything else it chooses to read. Your video is never uploaded for this.

The conversation carries on from one job to the next, and the thread is kept by that
assistant's own CLI on your machine — closing PersoDub does not end it. Picking no
assistant means nothing runs and nothing is sent.

## Usage counts

PersoDub reports six events — app launch, dub finished, dub failed, subtitles erased,
erasing failed, install failed — to see how many installs finish a dub. Each carries the app version, your operating
system, a random install ID, and on a failure one short code off a fixed list. A failed
install also names which of its twelve steps it stopped at, again off a fixed list. From
0.6.2 a dub also says which of its parts went through Perso — transcription, separation,
or the whole dub — each as one of two words, how many Perso credits that one job used,
and the video's length in seconds (0.6.2 and 0.6.3 sent whole minutes). From 0.8.6 it
also says the hour it started on your computer's clock, how many seconds it ran, and
the seconds of each of separation, transcription, translation and voices that ran, as
whole numbers. A launch says whether a Perso key is set, as yes or no. Never your video, audio, subtitles, filenames, paths, error text, key,
workspace or balance; no IP address is stored.

A launch counts once a day; every dub counts. Turn it off in **Settings → Privacy** or
with `PERSODUB_NO_ANALYTICS=1` in the kit's `kit.env`; it applies to the next event, no
restart. `PERSODUB_ANALYTICS_DEBUG=1` prints what would be sent instead of sending it.
The random install ID is made the first time the app starts, whether the counts are on
or off, and kept on this computer. With the counts off it is not sent here; its first 12
characters still go with the job logs below while they are on.

## Share App Analytics

From 0.9.2 the app can record which buttons, links, tabs and menu items you press and which
screens you open, to see which parts of it people use. Each press is a name taken from the
app's own markup (for example `home_nav_settings`), the screen's name and the time; each
batch also carries the random install ID, the app version, the edition, and your operating
system and its version, and, signed in to the production edition, the account as a one-way
hash of its Perso number that cannot be turned back into the account. Never what you type,
your video, files, filenames, paths, links, scripts, the account's number or its address. The batches go to the same relay as the job logs, every 30
seconds, which passes them to Google Analytics (and later Amplitude) and keeps nothing itself.

The same switch records the steps of your way through the app: the app opened (and whether
it is this computer's first time) and closed (on which screen, signed in or not, after how
many seconds), the install, the sign-in (started, handed to the browser, finished, cancelled
or failed, whether the account was just made, whether it has an API key), a video brought in
(picked, dropped or a link, video or sound), a dubbing started (local or Perso API, the
language it goes into, the video's length in minutes and seconds, the speakers asked for), its
stages and how long each took, how it ended and, for a failure, the one error code a failure
report would carry, the erase, burn and download tools, the credit popups and a Recharge
pressed, a key saved, an inquiry sent (its kind only), an error screen's code and an update
found or installed (its version). Each step is a name with a few words and numbers chosen by
the app from a fixed list: never a title, a file name, a link, what an inquiry says or an
address. The last batch is sent as the app closes, waiting three seconds at most; what does
not get through goes the next time the app opens.

It is on to begin with in the production edition and off in the open-source edition. Turn
it on or off in **Settings → Privacy**, or with `PERSODUB_EVENTS=1` or `0` in `kit.env`; it
applies to the next batch. With the usage counts off (`PERSODUB_NO_ANALYTICS=1`) nothing
leaves, and `PERSODUB_EVENTS_DEBUG=1` writes how many would have been sent into the app's
log instead of sending them. `PERSODUB_EVENTS_SEND=1` is the opposite, for checking the road end to end from a
from-source run: it sends even where a developer's run would only count. No build sets it.

## Job logs

With this switch on, the full logs of every job, finished or failed, are kept for 30 days
on a private dashboard and never put in a public issue. When a dub, a subtitle erase or
an audio separation finishes, its logs go there with a short record: which kind of job it
was, the machine and the app version as a report below carries them, and how many whole
seconds it took, in all and for each of separation, transcription, translation and
voices. A job that finished never becomes an issue.

When an install, a dub or a subtitle erase fails, the app also sends one report so the
failure can be fixed. It becomes a public issue in this repository, so that a hundred
machines that broke the same way land on one issue rather than a hundred.

A report carries the machine (operating system and version, CPU, memory, free disk,
which torch build, which packs are installed), where it stopped, one error code off a
fixed list, the error sentence, your app version, a random install ID, and the logs:
the last 200 lines of each of the app's three logs in the issue itself (and a dub
log's first 25 too), the last 80 lines of the console output of each engine running
on your computer, and the logs in full (the engines' last 2 MB) as an archive that
is deleted after 30 days.

From 0.8.4 a report also carries what the machine could say about that kind of failure,
and nothing for the other kinds. A network or certificate error: which of the five sites
the app uses could be reached, who signed each one's certificate (under security software
that inspects HTTPS, that is the product's name), and whether a proxy is set, never its
address. A file a program could not open: the security products Windows lists, and whether
the install folder can be written. An engine that would not start: which Visual C++ runtime
files are missing, and the NVIDIA driver line. An out-of-memory error: the memory free.
Product names, yes-or-no answers, error codes and numbers only.

From 0.8.8 every report and every finished job's record also carries the first 12
characters of the usage counts' random install ID, so the logs of one computer can be read
together (0.8.7 sent them only while the counts were on). It is a random number, never
anything personal, and it goes to the private dashboard only, never into a public issue.

Before anything leaves your machine, every line of it is put through three rules: a
path under your home folder is cut down to `~/…/*.mp4` — the name of the folder and the
name of the file both go, and so does yours; anything shaped like an API key becomes
`[REDACTED]`; and a link is cut down to its site. A web request in the engines' console
output loses its query and any encoded name first, since a file's path can sit there
in a form the rules would not recognise. The one exception is PersoDub's own
installation folder, whose paths are kept readable minus your name, because which model
or which folder a step died in is the answer we are looking for. Your `kit.env`, the
file your API keys live in, is read by the reporting code only for its on/off switches
and the name of the torch build; nothing else from it goes into a report, and no video,
audio, subtitle, project name or filename is ever included. The logs themselves never
record what was said: a transcribed or translated line, or what a voice check hears, is written down by its length,
not its words, and a Perso job by the credits it used, never your balance (from 0.6.4;
earlier versions could quote a translation in an error sentence). The relay that posts the
issue does not store your IP address, and applies the same rules a second time.

Turn it off in **Settings → Privacy** (**Help improve PersoDub**) or with `PERSODUB_NO_REPORTS=1`
in the kit's `kit.env`; it applies to the next job, no restart. This is a separate switch from
the usage counts above — turning one off leaves the other alone.
`PERSODUB_REPORTS_DEBUG=1` prints what would be sent instead of sending it, and a
PersoDub run from source never reports at all.

With reports off, a failure can still be sent by hand: the bug report form on the
Issues page asks for the same facts, and you choose what to paste.

## Dubbing from a link

Link fetching is powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(released under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)),
installed from PyPI on your machine at install time; PersoDub does not bundle or
redistribute its code. Reading and fetching a link contacts the site it points to, and
when a fetch fails for a reason other than the network, the app updates yt-dlp from PyPI
and tries once more. The fetched video is saved locally and is dubbed where **Choose a model**
says (this computer by default), like any
dropped file. Only dub videos you hold the rights to — downloading content may be
restricted by the source platform's terms of service, and that responsibility is yours.
