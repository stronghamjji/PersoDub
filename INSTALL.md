# PersoDub installation guide (Mac)

How to install **PersoDub**, the app that auto-dubs videos into other languages,
starting from scratch. Written so you can follow along without being technical —
just go step by step.

**What you need**
- An Apple Silicon Mac (M1/M2/M3/M4 — most MacBooks from 2021 onward; Intel Macs are not supported)
- macOS 11 (Big Sur) or later
- 16 GB of memory (RAM) or more (24 GB recommended — the AI models use a lot of memory while dubbing)
- An internet connection and at least 30 GB of free disk space
- Time: about 30 minutes to install + 30 minutes to 2 hours for the automatic engine setup on first launch

> Developer tools like Node.js are **prepared automatically by the install command** — no need to install them yourself.

---

## Step 1. Open Terminal

1. Press **⌘ (command) + Space** to open Spotlight search.
2. Type `Terminal` and press Enter.
3. When a window with a text prompt appears, you are ready.

> From here on, "run a command" always means: **copy the command → paste it into Terminal → press Enter**.

## Step 2. Install the developer tool (git) — once

Paste this into Terminal and press Enter:

```
xcode-select --install
```

- If a popup appears, click **Install** and wait for it to finish (5–15 minutes).
- If it says it is already installed, just move on to the next step.

## Step 3. Run the install command (one line)

Paste this single line into Terminal and press Enter:

```
curl -fsSL https://raw.githubusercontent.com/stronghamjji/PersoDub/master/install.sh | bash
```

This one line does everything: **fetch the code → auto-install Node.js → build → install → launch**.
Progress is shown as `[1/7]`, `[2/7]`, and so on. **It takes 10–20 minutes — keep the Terminal window open.**

> If that line is blocked on your network (a 404 error), you can fetch the code first and run it locally:
> 1. Install the **GitHub Desktop** app from https://desktop.github.com
> 2. File → Clone Repository → pick `stronghamjji/PersoDub`
> 3. In Terminal, go into the cloned folder and run `bash install.sh`
>    (the script detects that folder automatically)

## Step 4. First launch

- The app opens automatically at the end.
- **If you see an "unidentified developer" warning**: System Settings → Privacy & Security → click **"Open Anyway"** at the bottom (needed only once).
- On a first install, a "Setting up PersoDub" screen appears and the engines install automatically (30 minutes to 2 hours). It is safe to quit during this — reopening the app resumes where it left off.

## Step 5. Add API keys (optional)

Translation runs on the local **Gemma** model by default, so dubbing works with no keys at all.
To enable the cloud engines:

1. Open **Settings** in the app.
2. Enter the keys. Both are optional; only the ones you enter take effect.
   - **Perso API key** — improves transcription and speaker-labeling accuracy.
     Don't have one? Click **"Get a Perso API key"** under the field — it opens the
     signup page (a Perso account is required; signing up is free).
   - **Gemini API key** — improves translation quality.
     Get one from [Google AI Studio](https://aistudio.google.com/app/apikey).
3. Save, then quit and reopen the app to apply them.

## Step 6. Try your first dub

1. Drop a short video file (mp4) onto the app.
2. Pick the target language and press start.
3. When it finishes, save the result.

---

## Common problems

| Symptom | Fix |
|---|---|
| `command not found` | Make sure you copied the **entire line**. Typing just a file name does not work — paste the command exactly as shown. |
| `curl: (56) ... error: 404` | Your network may be blocking the download. Use the "fetch the code first" method from Step 3. |
| `xcode-select: note: install requested...` then nothing | It is already installed. Move on to the next step. |
| The build stops with an error | Re-running the script is safe (completed steps are skipped). If it still fails, screenshot the error in Terminal and [open an issue](https://github.com/stronghamjji/PersoDub/issues). |
| The app won't open and shows a security warning | See "Open Anyway" in Step 4. |
| The install was interrupted | Run the same command again — it resumes where it stopped. |

## Updating to a new version later

Run the **same one-line command** you installed with. It fetches the latest code, rebuilds, and replaces the app.
