# Configuration

By default, **Start dubbing** runs on this computer and needs no key: transcription and
speaker-labeling run on local Whisper + CAM++ (on Perso instead while a Perso key is
saved), and translation runs on ChatGPT through your own free sign-in, or on local
Hunyuan via Ollama on a computer that already has the Hunyuan model.

Want better quality, or Perso API dubbing (**Choose a model > Perso API**)?
Add an API key in the app's **Settings** screen ([guide](usage.md#settings)):

| Add this key | Improves | Get it from |
|---|---|---|
| **Perso API key** | Perso API dubbing; on this computer, transcription and speaker-labeling accuracy | [Perso Dubbing](https://perso.ai/dubbing?utm_source=desktop_app_github&utm_medium=desktop-app&utm_campaign=desktop_app&utm_content=readme) (includes a free allowance) |
| **Google Gemini key** | Translation quality | [Google AI Studio](https://aistudio.google.com/app/apikey) |

Keys are stored on your machine and take effect from your next dub — no restart needed.

> **Note:** PersoDub is made by ESTsoft corp., the company behind Perso. ChatGPT and
> Google Gemini are optional third-party services; PersoDub is not affiliated with or
> endorsed by OpenAI or Google.

## The Dub Agent and your files

The Dub Agent is **Claude Code** or **Codex**, run as a program on your computer, that
PersoDub asks to edit the script. Claude Code must already be installed; Codex can be
your own copy or the one PersoDub downloads for the ChatGPT sign-in. PersoDub has no
assistant of its own, and your video is never sent anywhere for this. How much each one
can see is different:

- **Claude Code** can only use PersoDub's script tools. It cannot read your files or
  run shell commands, and it runs without your own Claude Code settings, `CLAUDE.md` or
  memory files (your sign-in still works). **The safer choice.**
- **Codex** can also **read any file you can read** on this computer, and whatever it
  reads goes to OpenAI as part of the chat. It runs in a Codex folder of PersoDub's own,
  signed in with the app's ChatGPT sign-in, so your own Codex settings and `AGENTS.md`
  are not read. It cannot change your files or use the network. If that matters to you,
  use Claude Code.

The conversation continues from one job to the next, kept by the assistant's own tool
on your machine — closing PersoDub doesn't end it. Either one answers on your account
with that vendor and is billed there.

What leaves the computer, and how to turn it off, is in [Data and privacy](privacy.md).
