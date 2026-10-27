import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, screen, session, shell } from "electron";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killStalePids } from "./src/orchestrator.js";
import { markCleanExit, takeCleanExit } from "./src/cleanExit.js";
import { createReporter } from "./src/reporting.js";
import { analyticsFile, keepDevice, savedDevice } from "./src/analytics.js";
import { usageCounter, registerUsageIpc } from "./src/usageIpc.js";
import { createEvents, osName } from "./src/events.js";
import { createUpdater } from "./src/updateFlow.js";
import { createBoot } from "./src/bootFlow.js";
import { registerDownloadIpc } from "./src/downloadsIpc.js";
import { registerPackIpc } from "./src/packIpc.js";
import { createWindow } from "./src/windowFactory.js";
import { EDITIONS, displayName, readEdition, readBuildEnv, findPayloadDir } from "./src/edition.js";
import { setAppName, useLanguage, systemLocale } from "./src/i18n.js";
import { logLine } from "./src/logLine.js";
import { writeTimeline } from "./src/timeline.js";
import { createShellAuth, keyMadeCheck, registerAuthIpc } from "./src/authIpc.js";
import { clearSignInStorage, keyWindowFactory, signInWindowFactory } from "./src/signInWindow.js";

// Two launches must never both start backends: the second would overwrite
// pids.json with its own PIDs, and killStalePids on the NEXT boot (whichever
// happens first) then reads and kills the OTHER instance's engines -- the
// double-launch race that took down a running instance's uvicorns within 12 s
// (Windows, 2026-09-18). The lock makes a second launch a no-op before it
// touches pids.json, an engine, or a window; the first instance's window
// comes to the front instead. Must run before anything else in the app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
// Read before anything can quit again: did the last run end with a normal quit?
const lastRunClosedByUser = gotLock && takeCleanExit(join(app.getPath("userData"), "logs"));

const HERE = dirname(fileURLToPath(import.meta.url));
// Which build this is, and so which repository the updates come from and the
// page's GitHub links open (src/edition.js). Read once, from the same payload
// the boot installs from; the window is made before the boot runs.
const payloadDir = findPayloadDir(HERE);
const edition = readEdition({ payloadDir, env: process.env });
// ...and what the production build was given when it was made: its support
// web app (src/edition.js readBuildEnv).
const built = readBuildEnv({ payloadDir, env: process.env });
// Every sentence that names the app says this edition's name (src/edition.js).
setAppName(displayName(edition));
// What the shell's parts share. Set as the app comes up, and read by each part
// at the moment it needs it -- none of it exists when the parts are made.
const ctx = {
  engines: null,
  win: null, // the app's one window; a second launch focuses it instead of opening another
  // The boot's install context (kit, bundled payload, downloader), kept so the
  // pack IPC can run a pack's steps from the same table later.
  installCtx: null,
  bootedKitDir: null,   // for the dub counts, which arrive long after boot
  // The update as last announced -- re-sent to the page on every load, so a
  // page that arrives after the check (boot) or reloads mid-download still
  // shows the right pill. Null until an update is found.
  updateState: null,
  // The signed-in Perso account, hashed, for the button events (src/events.js
  // eventsUserId). Empty until the production edition's sign-in fills it.
  userId: "",
};

// Fired on the FIRST instance when a second launch is attempted; bring the
// existing window forward instead. Registered even before app.whenReady(), as
// Electron docs ask -- but win does not exist until the app is ready, so a
// second launch before then is simply dropped (nothing to focus yet).
function focusWindow() {
  const { win } = ctx;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
app.on("second-instance", () => focusWindow());

// The shell's own lines go to a file as well as the console: a packaged app
// has no console, and the one question a support log could not answer on
// Windows (2026-09-07) was why a pack's process did not start.
function shellLog(line, level = "INFO") {
  console.log(line);
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "shell.log"), `${logLine("shell", level, line)}\n`);
  } catch { /* logging never breaks the app */ }
}

// The page's buttons and screens, and the steps of a person's way through the
// app (src/events.js): made first, since the sign-in, the boot and the
// updater each record theirs.
const events = createEvents({ app, ctx, edition, shellLog });

// Perso sign-in in a window of the app's own, over the app's window,
// production edition only (src/auth.js, src/signInWindow.js). The window
// comes back through a port on this computer, so nothing is registered with
// the system. A sign-out wipes that window's cookies, so the next sign-in asks
// Perso for the account again, and drops the inquiries still waiting: each
// holds the account's full e-mail (src/reporting.js dropInquiries).
const auth = createShellAuth({ app, safeStorage, net, shell, ctx, edition, shellLog, focus: focusWindow, appName: displayName(edition),
                               makeSignInWindow: signInWindowFactory({ BrowserWindow, shell, parent: () => ctx.win, title: displayName(edition) }),
                               clearSignInSession: () => clearSignInStorage(session),
                               logoPath: join(HERE, "screens", "logo.png"), onSignOut: () => reporter.dropInquiries(ctx.kitDir),
                               track: events.track });

const reporter = createReporter({ app, BrowserWindow, ctx, shellLog, inquiryUrl: built.PERSODUB_INQUIRY_URL || "",
                                  account: () => auth.signedInAccount() });
const countUsage = usageCounter(app);
// The last batch of events, sent once as the app goes (src/events.js quit):
// before Restart to update quits, or at the first will-quit, which waits for it.
let eventsSent = false;
function sendLastEvents() {
  eventsSent = true;
  return events.quit({ signed_in: Boolean(auth.signedInAccount()) });
}
const updater = createUpdater({ app, dialog, ctx, shellLog, edition, track: events.track, beforeQuit: sendLastEvents });
const boot = createBoot({
  app, ctx, appDir: HERE, edition, shellLog, countUsage, track: events.track,
  sendReport: reporter.sendReport, flushReports: reporter.flushReports, startUpdater: updater.startUpdater,
});

// The page's remember-job, reveal and download folder are answered from the
// first moment; the download naming they feed is attached once the app is
// ready, below.
const downloads = registerDownloadIpc({ app, ipcMain, shell, dialog, ctx, shellLog });

app.whenReady().then(() => {
  // A second launch already quit above; nothing here may run for it -- there
  // is no guarantee 'ready' fires only for the instance that holds the lock.
  if (!gotLock) return;

  // One greppable line naming the running version -- the e2e update test (and
  // any future bug report) reads it instead of guessing from filenames.
  shellLog(`PERSODUB_VERSION ${app.getVersion()}`);
  // ...and the edition, so a support log says which repository this build updates from.
  shellLog(`PERSODUB_EDITION ${edition} ${EDITIONS[edition] || "no repository"}`);

  // This computer's random id, made on the first launch and kept: every report
  // and job record names the computer by it (src/analytics.js keepDevice).
  // None saved yet is this computer's first launch.
  const firstRun = !savedDevice(analyticsFile(app));
  keepDevice(analyticsFile(app));
  events.track("app_launch", { first_run: firstRun });

  // The computer's language, read once it can be (app.getLocale needs the app
  // ready); the kit's own setting is laid over it when the boot finds the kit.
  useLanguage({ osLocale: app.getLocale() });

  session.defaultSession.on("will-download", downloads.willDownload);
  ctx.win = createWindow({ app, BrowserWindow, screen, shell, ctx, appDir: HERE, repo: EDITIONS[edition], locale: systemLocale(),
                          edition });
  // Re-entrancy guard: mashing "Try again" on the error screen used to run
  // overlapping boots, whose duplicate engines then fought over the fixed
  // sidecar port and blocked the next clean launch.
  let bootInFlight = false;
  const guardedBoot = async () => {
    if (bootInFlight) return;
    bootInFlight = true;
    try { await boot(ctx.win); } finally { bootInFlight = false; }
  };
  registerUsageIpc({ ipcMain, ctx, countUsage, sendReport: reporter.sendReport, shellLog, lastRunClosedByUser, track: events.track });
  registerPackIpc({ ipcMain, dialog, shell, ctx, shellLog });
  const keyWindow = keyWindowFactory({ BrowserWindow, shell, parent: () => ctx.win, title: displayName(edition),
                                       onKeyMade: keyMadeCheck({ auth, closeKeyWindow: () => keyWindow.close() }) });
  registerAuthIpc({ ipcMain, auth, track: events.track, openKeyWindow: keyWindow.open, closeKeyWindow: keyWindow.close });
  void auth.start();

  // What the page needs to say "Report sent - #142": whether reports are on at
  // all, and the last one that went out. A page that loads after the report
  // was sent (the error screen's own reload) reads it back rather than missing
  // the announcement.
  // The update as last announced (src/updateFlow.js), for a page that started
  // listening after the announcement went out.
  ipcMain.handle("shell:last-update-state", () => ctx.updateState);
  // The page's buttons and screens, every 30 seconds (src/events.js). The
  // answer says whether recording is on, so the page knows whether to record.
  ipcMain.handle("shell:events", (_e, list) => events.take(list));
  // The production edition's Service inquiry, straight to the support web app (src/reporting.js sendInquiry).
  ipcMain.handle("shell:send-inquiry", (_e, form) => reporter.sendInquiry(form || {}, {
    kitDir: ctx.bootedKitDir, os: osName(), osVersion: process.getSystemVersion(),
  }));
  ipcMain.handle("shell:last-report", async () => ({
    mode: ctx.bootedKitDir ? reporter.reportMode(ctx.bootedKitDir) : "off",
    last: reporter.lastReport(),
  }));

  ipcMain.on("shell:retry", guardedBoot);
  // app.quit() (not app.exit()) so will-quit still runs and stops the child
  // engines before the fresh instance starts -- exit() would orphan them.
  ipcMain.on("shell:relaunch", () => { app.relaunch(); app.quit(); });
  ipcMain.on("shell:restart-to-update", updater.restartToUpdate);
  guardedBoot();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", (e) => {
  // A second launch quits without ever starting an engine of its own; the
  // pids.json here is the FIRST instance's, not a stale leftover, so this
  // must not touch it -- that was the double-launch bug (2026-09-18).
  if (!gotLock) return;
  // The last batch first: app_quit, and what the page and the shell still
  // hold, three seconds at most (src/events.js quit); then the quit again,
  // which comes back here and goes on.
  if (!eventsSent) {
    e.preventDefault();
    void sendLastEvents().finally(() => app.quit());
    return;
  }
  markCleanExit(join(app.getPath("userData"), "logs"));
  shellLog("QUIT: stopping engines");
  // The merged timeline.log, with the line above in it, before the engines go.
  writeTimeline(join(app.getPath("userData"), "logs"), shellLog);
  if (ctx.engines) {
    ctx.engines.stopAll();
  } else {
    // Quitting while the engines are still starting up (the 2-minute health
    // wait) orphans them: `ctx.engines` is only assigned after startEngines
    // resolves. pids.json records what was spawned -- kill those instead of
    // leaving uvicorns behind until the next launch cleans them.
    killStalePids(join(app.getPath("userData"), "logs"));
  }
});
