import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from "electron";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killStalePids } from "./src/orchestrator.js";
import { markCleanExit, takeCleanExit } from "./src/cleanExit.js";
import { createReporter } from "./src/reporting.js";
import { analyticsFile, keepDevice } from "./src/analytics.js";
import { usageCounter, registerUsageIpc } from "./src/usageIpc.js";
import { createUpdater } from "./src/updateFlow.js";
import { createBoot, findPayloadDir } from "./src/bootFlow.js";
import { registerDownloadIpc } from "./src/downloadsIpc.js";
import { registerPackIpc } from "./src/packIpc.js";
import { createWindow } from "./src/windowFactory.js";
import { EDITIONS, readEdition } from "./src/edition.js";
import { useLanguage, systemLocale } from "./src/i18n.js";
import { logLine } from "./src/logLine.js";
import { writeTimeline } from "./src/timeline.js";

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
const edition = readEdition({ payloadDir: findPayloadDir(HERE), env: process.env });
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
};

// Fired on the FIRST instance when a second launch is attempted; bring the
// existing window forward instead. Registered even before app.whenReady(), as
// Electron docs ask -- but win does not exist until the app is ready, so a
// second launch before then is simply dropped (nothing to focus yet).
app.on("second-instance", () => {
  const { win } = ctx;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

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

const reporter = createReporter({ app, BrowserWindow, ctx, shellLog });
const countUsage = usageCounter(app);
const updater = createUpdater({ app, dialog, ctx, shellLog, edition });
const boot = createBoot({
  app, ctx, appDir: HERE, edition, shellLog, countUsage,
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
  shellLog(`PERSODUB_EDITION ${edition} ${EDITIONS[edition]}`);

  // This computer's random id, made on the first launch and kept: every report
  // and job record names the computer by it (src/analytics.js keepDevice).
  keepDevice(analyticsFile(app));

  // The computer's language, read once it can be (app.getLocale needs the app
  // ready); the kit's own setting is laid over it when the boot finds the kit.
  useLanguage({ osLocale: app.getLocale() });

  session.defaultSession.on("will-download", downloads.willDownload);
  ctx.win = createWindow({ app, BrowserWindow, screen, shell, ctx, appDir: HERE, repo: EDITIONS[edition], locale: systemLocale() });
  // Re-entrancy guard: mashing "Try again" on the error screen used to run
  // overlapping boots, whose duplicate engines then fought over the fixed
  // sidecar port and blocked the next clean launch.
  let bootInFlight = false;
  const guardedBoot = async () => {
    if (bootInFlight) return;
    bootInFlight = true;
    try { await boot(ctx.win); } finally { bootInFlight = false; }
  };
  registerUsageIpc({ ipcMain, ctx, countUsage, sendReport: reporter.sendReport, shellLog, lastRunClosedByUser });
  registerPackIpc({ ipcMain, dialog, shell, ctx, shellLog });

  // What the page needs to say "Report sent - #142": whether reports are on at
  // all, and the last one that went out. A page that loads after the report
  // was sent (the error screen's own reload) reads it back rather than missing
  // the announcement.
  // The update as last announced (src/updateFlow.js), for a page that started
  // listening after the announcement went out.
  ipcMain.handle("shell:last-update-state", () => ctx.updateState);
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
app.on("will-quit", () => {
  // A second launch quits without ever starting an engine of its own; the
  // pids.json here is the FIRST instance's, not a stale leftover, so this
  // must not touch it -- that was the double-launch bug (2026-09-18).
  if (!gotLock) return;
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
