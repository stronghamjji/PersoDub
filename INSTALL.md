# PersoDub installation guide

How to install **PersoDub**, the app that auto-dubs videos into other languages,
starting from scratch. Written so you can follow along without being technical —
just go step by step.

Pick the path for your computer: **[macOS](#macos)** or **[Windows](#windows)**.
Both end in the same place — [After installing](#after-installing).

---

## macOS

**What you need**
- An Apple Silicon Mac (M1/M2/M3/M4 — most MacBooks from 2021 onward; Intel Macs are not supported)
- macOS 11 (Big Sur) or later
- 16 GB of memory (RAM) or more (24 GB recommended — the AI models use a lot of memory while dubbing)
- An internet connection and at least 30 GB of free disk space

### Download and install

1. Go to the [latest release](https://github.com/stronghamjji/PersoDub/releases/latest).
2. Download **`PersoDub-<version>-arm64.dmg`**.
3. Open the downloaded file and drag **PersoDub** into your **Applications** folder.
4. Launch **PersoDub** from Applications. The app is signed and notarized, so it opens
   with a normal double-click — no security warnings.

On a first install, a "Setting up PersoDub" screen appears and the engines install
automatically (30 minutes to 2 hours). It is safe to quit during this — reopening the
app resumes where it left off. Installed this way, the app also keeps itself up to
date: on launch it checks for a newer release and offers to install it.

Next: [After installing](#after-installing).

---

## macOS — install from source (for developers)

The download above is the recommended way to install. This path builds the app from
the repository instead — use it if you want to work on PersoDub itself, or if you
installed this way before (updates on this path arrive by re-running the same
command).

> Developer tools like Node.js are **prepared automatically by the install command** — no need to install them yourself.

### Step 1. Open Terminal

1. Press **⌘ (command) + Space** to open Spotlight search.
2. Type `Terminal` and press Enter.
3. When a window with a text prompt appears, you are ready.

> From here on, "run a command" always means: **copy the command → paste it into Terminal → press Enter**.

### Step 2. Install the developer tool (git) — once

Paste this into Terminal and press Enter:

```
xcode-select --install
```

- If a popup appears, click **Install** and wait for it to finish (5–15 minutes).
- If it says it is already installed, just move on to the next step.

### Step 3. Run the install command (one line)

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

### Step 4. First launch

- The app opens automatically at the end.
- **If you see an "unidentified developer" warning**: System Settings → Privacy & Security → click **"Open Anyway"** at the bottom (needed only once).
- On a first install, a "Setting up PersoDub" screen appears and the engines install automatically (30 minutes to 2 hours). It is safe to quit during this — reopening the app resumes where it left off.

Next: [After installing](#after-installing).

---

## Windows

Windows has had less use than the Mac version so far, so please [report anything that breaks](https://github.com/stronghamjji/PersoDub/issues).

**What you need**
- Windows 10 (21H2 or newer) or Windows 11, 64-bit
- About 40 GB of free disk space
- An NVIDIA graphics card — strongly recommended, see [Graphics: NVIDIA only](#graphics-nvidia-only) below
- An internet connection
- No administrator rights

### Download and run the installer

Download **`PersoDub-Setup-<version>.exe`** from the project's
[Releases page](https://github.com/stronghamjji/PersoDub/releases) and double-click it.

### "Windows protected your PC"

The build is not code-signed yet, so Windows shows a blue box titled
**"Windows protected your PC"** with only a **Don't run** button. This is ordinary for
unsigned open-source software. To carry on:

1. Click **More info**.
2. Click **Run anyway**.

Signing is planned. Once the build is signed, the warning stops appearing.

### Where it installs

The installer is per-user, which is why it never asks for an administrator password.
It installs the app into `%LOCALAPPDATA%\Programs\PersoDub`, adds a **Start menu** entry
and a desktop shortcut, and registers an uninstaller.

### First launch

The first time you open PersoDub, it downloads the engine kit into
`%LOCALAPPDATA%\PersoDub` — about **12 GB**, roughly **8 minutes** on a fast
connection. This happens once.

Leave the app open while it downloads. If it closes, open it again — setup resumes where
it left off.

### Graphics: NVIDIA only

On Windows, only NVIDIA graphics are accelerated. With AMD or Intel graphics everything
still runs, on the processor instead. Nothing is skipped and no step fails, but
translation and voice synthesis get much slower, and long videos become impractical.
The measured numbers are in [Speed without a GPU](README.md#speed-without-a-gpu).

### Uninstalling

Use the uninstaller in the **Start menu**, or **Settings > Apps**.

> **That removes the app, but not the engine kit.** The roughly 12 GB in
> `%LOCALAPPDATA%\PersoDub` stays on your disk. To get that space back, open that folder
> and delete it yourself.

### Log files

Attach these when you report a bug:

- Per-dub logs: `%LOCALAPPDATA%\PersoDub\app\logs`
- Engine logs: `%APPDATA%\persodub-desktop-shell\logs`

Next: [After installing](#after-installing).

---

## After installing

These two steps are the same on macOS and Windows.

### Step 5. Add API keys (optional)

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

### Step 6. Try your first dub

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
| **Windows:** "Windows protected your PC" blocks the installer | Click **More info**, then **Run anyway**. See ["Windows protected your PC"](#windows-protected-your-pc). |
| **Windows:** the app was force-quit and engines are still running | Start PersoDub again. It clears the leftovers as it launches. |
| **Windows:** uninstalled, but the disk space is still gone | The engine kit is left behind on purpose. Delete `%LOCALAPPDATA%\PersoDub` by hand. |
| **Windows:** during an update or reinstall, the installer says "PersoDub cannot be closed. Please close it manually and click Retry to continue." even though PersoDub isn't running, and **Retry** does nothing | Another program — a code editor, antivirus, or backup tool are common culprits — has a file inside the install folder open, so the installer can't replace it yet. Close anything that might be reading files in `%LOCALAPPDATA%\Programs\PersoDub` (or just restart Windows), then click **Retry**. You can also cancel and run the installer again afterward. |

## Updating to a new version later

**On both platforms the app updates itself**: it checks for updates on launch,
downloads them in the background, and offers **Restart to update** when one is
ready. You can also update by hand anytime — download the newer file for your
platform from the [latest release](https://github.com/stronghamjji/PersoDub/releases/latest)
and install it over the existing app.

**Installed from source on macOS?** Run the **same one-line command** you
installed with. It fetches the latest code, rebuilds, and replaces the app.
