// Electron preload (CommonJS — sandboxed preloads cannot use ESM).
const { contextBridge, ipcRenderer } = require("electron");

// The window passes the repository the build's edition points at on its
// command line (src/windowFactory.js additionalArguments): a value fixed for
// the whole run needs no channel.
const REPO_ARG = "--persodub-repo=";
// The computer's language the same way (src/i18n.js): what Auto means.
const LOCALE_ARG = "--persodub-locale=";
// The name this edition shows the user (src/edition.js displayName).
const NAME_ARG = "--persodub-name=";
// And which system the window is on ("win32", "darwin"), the same way. Stamped
// on the page as data-platform before its stylesheet is read, so Windows gets
// its own scrollbars drawn (static/css/app.css) and the Mac keeps the system's,
// and the page's top bar makes room for each one's window buttons (2026-10-21).
// The preload runs before the page has an element to stamp when
// the document is still empty; then it waits for one.
const PLATFORM_ARG = "--persodub-platform=";
// And the build's edition ("opensource", "production"), the same way: the
// page shows the production edition's names and links from it (ui/src/edition.mjs).
const EDITION_ARG = "--persodub-edition=";
const platform = process.argv.find((a) => a.startsWith(PLATFORM_ARG))?.slice(PLATFORM_ARG.length) || "";
// The edition is stamped the same way, as data-edition, so the production
// edition's palette and type are there from the first paint (static/css/app.css).
const edition = process.argv.find((a) => a.startsWith(EDITION_ARG))?.slice(EDITION_ARG.length) || "";
if (platform || edition) {
  const stamp = () => {
    if (platform) document.documentElement.dataset.platform = platform;
    if (edition) document.documentElement.dataset.edition = edition;
  };
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
  // The buttons pressed and screens shown, as names the page made from its
  // own markup (ui/src/events.mjs); the shell checks them and sends them
  // (src/events.js). Resolves to {on, kept, sent, recent}; [] only asks.
  sendEvents: (list) => ipcRenderer.invoke("shell:events", list),
  // Automatic failure reports (src/report.js). The page neither builds nor
  // sends one -- it only gets to show what happened: the shell announces a
  // report the moment it lands, and getLastReport answers for a page that
  // loaded after that. `mode` is "on", "off" or "debug", so a build that
  // cannot report (a from-source run, or the switch turned off) shows nothing
  // rather than promising a report nobody will receive.
  onReportSent: (cb) => ipcRenderer.on("shell:report-sent", (_e, sent) => cb(sent)),
  getLastReport: () => ipcRenderer.invoke("shell:last-report"),
  // The production edition's Service inquiry (ui/src/feedbackSheet.mjs): the
  // form's {type, subject, details, replyTo, locale}, which the shell sends to
  // the support web app with the app's version and this computer (src/reporting.js).
  // Resolves to {id} once it landed, {queued: true} when it waits for the next
  // launch, {needReplyTo: true} when there is no Reply-to and the account has
  // no e-mail (nothing sent), and null when it could not be sent at all.
  sendInquiry: (form) => ipcRenderer.invoke("shell:send-inquiry", form),
  // Perso sign-in in a window of the app's (src/auth.js), the production edition's.
  // authStatus answers {enabled, required, signedIn, account, accountId, hasKey, waiting, where}:
  // `required` is the production edition signed out, when the page shows its
  // sign-in screen; `account` is the account's full e-mail (its name without
  // one), shown on Home and in Settings, and `accountId` Perso's number
  // for the account; the events key it by a hash of it (src/events.js eventsUserId). `where` is where a
  // waiting sign-in goes on: "window", or "browser" once Google or Microsoft
  // took it to the computer's browser ("" with none waiting). authLogin opens the sign-in window
  // and answers when the sign-in ends: {outcome, key, keyReason?, error?}
  // (outcomes and key answers are listed at createAuth); authShow brings that
  // window forward again, or, after a hand-off, runs Perso's Google or Microsoft
  // start again in the browser (Continue). authCheckKey looks for
  // the account's API key again, after authOpenKeyPage let the user make one.
  // onAuthState hears the status whenever it changes. In the open-source
  // edition every answer is {outcome: "disabled"} and authStatus's enabled is false.
  authStatus: () => ipcRenderer.invoke("shell:auth-status"),
  authLogin: () => ipcRenderer.invoke("shell:auth-login"),
  authCancel: () => ipcRenderer.invoke("shell:auth-cancel"),
  authShow: () => ipcRenderer.invoke("shell:auth-show"),
  authLogout: () => ipcRenderer.invoke("shell:auth-logout"),
  authCheckKey: () => ipcRenderer.invoke("shell:auth-check-key"),
  authOpenKeyPage: () => ipcRenderer.invoke("shell:auth-open-key-page"),
  onAuthState: (cb) => ipcRenderer.on("shell:auth-state", (_e, state) => cb(state)),
  // "owner/repo" for the page's GitHub links (src/edition.js); "" when the
  // window passed none.
  repo: process.argv.find((a) => a.startsWith(REPO_ARG))?.slice(REPO_ARG.length) || "",
  // "ko" or "en" (ui/src/i18n.mjs); "" when the window passed none.
  locale: process.argv.find((a) => a.startsWith(LOCALE_ARG))?.slice(LOCALE_ARG.length) || "",
  // "" when the window passed none: the page is the open-source one.
  edition: process.argv.find((a) => a.startsWith(EDITION_ARG))?.slice(EDITION_ARG.length) || "",
  // What the app is called on screen: "PersoDub", or "PersoDubbing" in the production edition.
  name: process.argv.find((a) => a.startsWith(NAME_ARG))?.slice(NAME_ARG.length) || "PersoDub",
});
