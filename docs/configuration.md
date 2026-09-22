# Configuration

PersoDub works with no configuration: by default, transcription and speaker-labeling
run on local Whisper + CAM++, and translation runs on local Hunyuan via Ollama.

Want better quality? Add an API key in the app's **Settings** screen
([screenshot](usage.md#settings)) to switch that one step to a cloud engine:

| Add this key | Improves | Get it from |
|---|---|---|
| **Perso API key** | Transcription and speaker-labeling accuracy | [Perso Dubbing](https://perso.ai/dubbing?utm_source=desktop_app_github&utm_medium=desktop-app&utm_campaign=desktop_app&utm_content=readme) — includes a free allowance |
| **Google Gemini key** | Translation quality | [Google AI Studio](https://aistudio.google.com/app/apikey) |

Keys are stored on your machine and take effect from your next dub — no restart needed.

> **Note:** PersoDub is an independent open-source project. It integrates with Perso and
> Google Gemini as optional third-party services and is not affiliated with or endorsed
> by either.

## The Dub Agent and your files

The Dub Agent is an assistant **already installed on your computer** — Claude Code or
Codex — that PersoDub asks to edit the script. PersoDub has no assistant of its own,
and your video is never sent anywhere for this. How much each one can see is different:

- **Claude Code** can only use PersoDub's script tools. It cannot read your files or
  run shell commands. **The safer choice.**
- **Codex** can also **read any file you can read** on this computer, and whatever it
  reads goes to OpenAI as part of the chat (including your own `AGENTS.md`, if you keep
  one). It cannot change your files or use the network. If that matters to you, use
  Claude Code.

The conversation continues from one job to the next, kept by the assistant's own tool
on your machine — closing PersoDub doesn't end it. Either one answers on your account
with that vendor and is billed there.

What leaves the computer, and how to turn it off, is in [Data and privacy](privacy.md).
