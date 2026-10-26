// Electron preload (CommonJS — sandboxed preloads cannot use ESM).
const { contextBridge, ipcRenderer } = require("electron");

// The window passes the repository the build's edition points at on its
// command line (src/windowFactory.js additionalArguments): a value fixed for
// the whole run needs no channel.
const REPO_ARG = "--persodub-repo=";
// The computer's language the same way (src/i18n.js): what Auto means.
const LOCALE_ARG = "--persodub-locale=";
// And which system the window is on ("win32", "darwin"), the same way. Stamped
// on the page as data-platform before its stylesheet is read, so Windows gets
// its own scrollbars drawn (static/css/app.css) and the Mac keeps the system's,
// and the page's top bar makes room for each one's window buttons (2026-10-21).
// The preload runs before the page has an element to stamp when
// the document is still empty; then it waits for one.
const PLATFORM_ARG = "--persodub-platform=";
const platform = process.argv.find((a) => a.startsWith(PLATFORM_ARG))?.slice(PLATFORM_ARG.length) || "";
if (platform) {
  const stamp = () => { document.documentElement.dataset.platform = platform; };
  if (document.documentElement) stamp(); else document.addEventListener("DOMContentLoaded", stamp);
}

contextBridge.exposeInMainWorld("persodubShell", {
  retry: () => ipcRenderer.send("shell:retry"),
  // Downloads land in <Downloads>/<day>/<project>/, which only the page knows.
  // Handed over when a finished job is rendered, so will-download (a synchronous
  // callback that cannot await a fetch) can read it back.
  rememberJob: (job) => ipcRenderer.send("shell:remember-job", job),
  // A finished (or failed) download. The shell saves without a save dialog, so
  // the page has no other way to know one landed -- the Export dialog's "where
  // it goes" line reads this and says where it went.
  onDownloadDone: (cb) => ipcRenderer.on("shell:download-done", (_e, info) => cb(info)),
  // The folder downloads go into, for the Download dialog's line and Settings >
  // Storage: {folder, chosen, missing}. pickDownloadFolder is the dialog's
  // Change, the computer's own folder picker, kept for every download after
  // it; resetDownloadFolder is Use default, Downloads again. Each answers with
  // the folder as it is then.
  downloadFolder: () => ipcRenderer.invoke("shell:download-folder"),
  pickDownloadFolder: () => ipcRenderer.invoke("shell:pick-download-folder"),
  resetDownloadFolder: () => ipcRenderer.invoke("shell:reset-download-folder"),
  // "Saved to Downloads · Show": show a file the app just wrote in Finder or
  // Explorer. The shell opens only what is inside Downloads, the folder picked
  // for downloads or the kit, so this is a request rather than a command.
  revealPath: (path) => ipcRenderer.invoke("shell:reveal", path),
  // For a "Restart now" button: asking a non-technical user to quit and reopen
  // by hand was the step that silently didn't happen. No page calls it today
  // (keys apply without a restart); src/preloadContract.test.mjs lists it.
  relaunch: () => ipcRenderer.send("shell:relaunch"),
  onInstallProgress: (cb) => ipcRenderer.on("shell:install-progress", (_e, p) => cb(p)),
  // Packs (the engines venv, the Ollama runtime) are the shell's to install,
  // stop and remove; the page asks and follows the progress channel above,
  // where a pack's events carry `pack: id`.
  installPack: (id) => ipcRenderer.invoke("shell:install-pack", id),
  cancelPack: (id) => ipcRenderer.invoke("shell:cancel-pack", id),
  removePack: (id) => ipcRenderer.invoke("shell:remove-pack", id),
  packStatus: () => ipcRenderer.invoke("shell:pack-status"),
  // Auto-update: the shell announces the update's state -- {version, phase:
  // "downloading" | "ready", pct, releaseDate?, releaseNotes?, whatsNew?} -- as it
  // changes and again whenever the page loads, so the top bar's update icon
  // lights within seconds of launch and the update window's button turns
  // into "Restart to update" when the file is on disk.
  onUpdateState: (cb) => ipcRenderer.on("shell:update-state", (_e, state) => cb(state)),
  // ...and that state on request, for a page that started listening after the
  // announcement (ui/src/updateWindow.mjs asks once it listens).
  getUpdateState: () => ipcRenderer.invoke("shell:last-update-state"),
  restartToUpdate: () => ipcRenderer.send("shell:restart-to-update"),
  // Usage counts for finished dubs. The page hands over the raw log tail
  // because it cannot classify it -- the shell turns that into one published
  // word and drops the text. Nothing here reaches the network.
  countDub: (status, detail, job) => ipcRenderer.send("shell:count-dub", { status, detail, job }),
  // The same for an erase. It goes down its own road -- the erase screen polls
  // its own job and never touches handleJobUpdate -- so it needed its own way
  // to say how it ended. Subtitle erasing is the new thing in 0.5.5 and so the
  // likeliest to fail on someone else's machine, and it was the one kind of
  // failure that sent nothing at all (user, 2026-09-11).
  countErase: (status, detail, job) => ipcRenderer.send("shell:count-erase", { status, detail, job }),
  // Automatic failure reports (src/report.js). The page neither builds nor
  // sends one -- it only gets to show what happened: the shell announces a
  // report the moment it lands, and getLastReport answers for a page that
  // loaded after that. `mode` is "on", "off" or "debug", so a build that
  // cannot report (a from-source run, or the switch turned off) shows nothing
  // rather than promising a report nobody will receive.
  onReportSent: (cb) => ipcRenderer.on("shell:report-sent", (_e, sent) => cb(sent)),
  getLastReport: () => ipcRenderer.invoke("shell:last-report"),
  // "owner/repo" for the page's GitHub links (src/edition.js); "" when the
  // window passed none.
  repo: process.argv.find((a) => a.startsWith(REPO_ARG))?.slice(REPO_ARG.length) || "",
  // "ko" or "en" (ui/src/i18n.mjs); "" when the window passed none.
  locale: process.argv.find((a) => a.startsWith(LOCALE_ARG))?.slice(LOCALE_ARG.length) || "",
});
