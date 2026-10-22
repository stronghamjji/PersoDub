import { dirname, join } from "node:path";
import { resolveUpdateMode, resolveFeed, nextUpdateState, INSTALL_ON_QUIT, feedText, updateFileUrl, updateErrorText,
  whatsNewUrl, readWhatsNew } from "./updater.js";
import { findForeignLockers } from "./lockCheck.js";
import { markCleanExit } from "./cleanExit.js";
import { envWithKit } from "./kitEnv.js";
import { t } from "./i18n.js";
import { homeText, secondsSince, sizeText, urlText } from "./logLine.js";

// Auto-update (packaged builds only -- see updater.js for the decision
// rules). Checks GitHub Releases after the window is up, downloads in the
// background, and lets the page offer "Restart to update"; nothing is ever
// forced. electron-updater validates the new build's code signature, which is
// why signing came first. Errors are logged and swallowed: an update check
// must never break a working app.
//
// ctx.updateState is the update as last announced, which the window re-sends
// on every page load; ctx.engines and ctx.win are read when they are needed.
// `edition` is the build's (edition.js), whose repository the updates come from.
export function createUpdater({ app, dialog, ctx, shellLog, edition }) {
  let updaterStarted = false;
  let updateDownloaded = false;

  async function startUpdater(win, kitDir) {
    // Boot can run more than once (the error screen's Retry); the updater's
    // listeners and its network check must not.
    if (updaterStarted) return;
    updaterStarted = true;
    // The documented off-switch (PERSODUB_DISABLE_UPDATE_CHECK=1) lives in the
    // kit's kit.env with the user's other settings -- read it from there, since
    // a GUI app's process.env never carries it.
    if (resolveUpdateMode({ isPackaged: app.isPackaged, env: envWithKit(kitDir) }) !== "auto") {
      shellLog(`UPDATE CHECK OFF: ${app.isPackaged ? "PERSODUB_DISABLE_UPDATE_CHECK=1" : "not a packaged app"}`);
      return;
    }
    // Whether the error event below has said what went wrong: a failed check
    // also rejects checkForUpdates, and the catch at the end must not say it twice.
    let reported = false;
    const announce = (event, info) => {
      const next = nextUpdateState(ctx.updateState, event, info);
      if (next === ctx.updateState) return;
      ctx.updateState = next;
      if (!win.isDestroyed()) win.webContents.send("shell:update-state", ctx.updateState);
    };
    try {
      const { default: electronUpdater } = await import("electron-updater");
      const { autoUpdater } = electronUpdater;
      const feed = resolveFeed(process.env, edition);
      autoUpdater.setFeedURL(feed);
      // What electron-updater's own requests met, each once: the address and
      // what answered it, a redirect and where it led (GitHub hands a release
      // file to its download host, behind a signed link whose query urlText
      // cuts), or why there was no answer. They run on a session of their own
      // (electron-updater's NET_SESSION_NAME); an abort is electron-updater
      // dropping a request it no longer needs, not a failure.
      const { session, net } = await import("electron");
      const said = new Set();
      const once = (line, level) => { if (!said.has(line)) { said.add(line); shellLog(line, level); } };
      const web = session.fromPartition("electron-updater", { cache: false }).webRequest;
      web.onResponseStarted((d) => once(`CONNECTED update: HTTP ${d.statusCode} from ${urlText(d.url)}`));
      web.onBeforeRedirect((d) => once(`REDIRECT update: HTTP ${d.statusCode} from ${urlText(d.url)} to ${urlText(d.redirectURL)}`));
      web.onErrorOccurred((d) => {
        if (d.error !== "net::ERR_ABORTED") once(`CONNECT FAILED update: ${d.error} at ${urlText(d.url)}`, "ERROR");
      });
      autoUpdater.autoDownload = true;
      // A downloaded update waits for "Restart to update" on every platform; a
      // plain quit leaves the app as it is (updater.js INSTALL_ON_QUIT).
      autoUpdater.autoInstallOnAppQuit = INSTALL_ON_QUIT;
      // The update's own DOWNLOAD lines (logLine.js shapes): START from the
      // release file's full address as it is found -- electron-updater names
      // its cache folder only once the file is saved, so the FILE line says
      // where it went -- and DONE once electron-updater has checked the
      // file's sha512, which it does before it announces the download.
      let downloadFrom = null;
      let checkFrom = null;
      autoUpdater.on("update-available", async (info) => {
        shellLog(`PERSODUB_UPDATE available ${info?.version ?? ""}`);
        const file = info?.files?.[0];
        if (file) {
          shellLog(`UPDATE CHECK DONE (${secondsSince(checkFrom)}s): ${info.version} available, ${file.url} ${sizeText(file.size)}`);
          shellLog(`DOWNLOAD START update from ${urlText(updateFileUrl(feed, info))}`);
          downloadFrom = Date.now();
        }
        checkFrom = null;
        // The new version's own list for the window, read first so the window
        // opens on it rather than on the release's English notes that it then
        // replaces; five seconds at most (updater.js readWhatsNew). Electron's
        // own fetch, so the computer's proxy and certificates apply, as they do
        // to electron-updater's requests.
        const url = whatsNewUrl(feed, info);
        const whatsNew = url ? await readWhatsNew(url, { fetch: (u, o) => net.fetch(u, o), log: shellLog }) : null;
        announce("update-available", whatsNew ? { ...info, whatsNew } : info);
      });
      autoUpdater.on("update-not-available", (info) => {
        shellLog(`UPDATE CHECK DONE (${secondsSince(checkFrom)}s): up to date, the latest release is ${info?.version ?? "unknown"}`);
        checkFrom = null;
      });
      autoUpdater.on("download-progress", (info) => announce("download-progress", info));
      autoUpdater.on("update-downloaded", (info) => {
        updateDownloaded = true;
        shellLog(`PERSODUB_UPDATE downloaded ${info?.version ?? ""}`);
        const file = info?.files?.[0];
        if (file && downloadFrom) {
          shellLog(`DOWNLOAD FILE update: ${homeText(info.downloadedFile)} ${sizeText(file.size)} from ${urlText(updateFileUrl(feed, info))}`);
          shellLog(`DOWNLOAD DONE update: ${sizeText(file.size)} in ${secondsSince(downloadFrom)}s, sha512 ok`);
          downloadFrom = null;
        }
        announce("update-downloaded", info);
        // Test-only hook: lets the end-to-end update test apply the swap without
        // a human clicking the banner. (true, false) = silent, no relaunch --
        // the test verifies the version stamp on disk, and a relaunched app
        // would fight the real one over the sidecar port. Never set outside tests.
        if (process.env.PERSODUB_TEST_AUTO_RESTART === "1") {
          if (ctx.engines) ctx.engines.stopAll();
          autoUpdater.quitAndInstall(true, false);
        }
      });
      // One line, whichever part failed: the check before it found an answer,
      // or the download after it began (updater.js updateErrorText).
      autoUpdater.on("error", (err) => {
        reported = true;
        if (downloadFrom) {
          shellLog(`DOWNLOAD FAILED update after ${secondsSince(downloadFrom)}s: ${updateErrorText(err)}`, "ERROR");
          downloadFrom = null;
          // The window says it, not a button left at its last percent.
          announce("download-failed");
        } else if (checkFrom) {
          shellLog(`UPDATE CHECK FAILED (${secondsSince(checkFrom)}s): ${updateErrorText(err)}`, "ERROR");
          checkFrom = null;
          // The window says the check failed, not "up to date".
          announce("check-failed");
        } else {
          shellLog(`UPDATE FAILED: ${updateErrorText(err)}`, "ERROR");
        }
      });
      shellLog(`UPDATE CHECK START from ${feedText(feed)}, this app ${app.getVersion()}`);
      checkFrom = Date.now();
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (!reported) {
        shellLog(`UPDATE CHECK FAILED: ${updateErrorText(err)}`, "ERROR");
        announce("check-failed");
      }
    }
  }

  // The page's "Restart to update".
  async function restartToUpdate() {
    if (!updateDownloaded) return; // stray click before a download finished
    // Windows only: the NSIS updater replaces every file in the install dir
    // and, when some OTHER program holds one open (an editor pinning
    // app.asar, antivirus, backup tools), it fails AFTER the app has quit --
    // behind a retry dialog that blames the app and can't succeed until the
    // real culprit lets go. Ask the Restart Manager now, while there is
    // still a window to name that program in. findForeignLockers fails open,
    // so a broken probe can only ever skip the warning, never the update.
    if (process.platform === "win32") {
      const lockers = await findForeignLockers({
        installDir: dirname(process.execPath),
        ownExePath: process.execPath,
      });
      // One greppable line per check -- when a user reports the installer's
      // file-in-use dialog anyway, this says what the pre-flight saw.
      shellLog(`PERSODUB_UPDATE lock check: ${lockers.length} foreign holder(s)${lockers.length > 0 ? " -- " + lockers.map((l) => l.exe || l.name).join(", ") : ""}`);
      if (lockers.length > 0) {
        const names = [...new Set(lockers.map((l) => l.name || l.exe))].join(", ");
        // In front, and awake. Parented to the window is not enough on
        // Windows: the box opened behind the app and the user pressed
        // Restart to update, saw nothing happen for three minutes, and had
        // every reason to call the update broken (Windows, 2026-09-11).
        if (ctx.win.isMinimized()) ctx.win.restore();
        ctx.win.show();
        ctx.win.focus();
        const { response } = await dialog.showMessageBox(ctx.win, {
          type: "warning",
          title: t("PersoDub update"),
          message: t("Close {names} first, then update", { names }),
          detail: t("That program is using files in PersoDub's installation folder, so the update may stall halfway through. Close it and click \"Restart to update\" again, or update anyway and PersoDub will try regardless."),
          // Update anyway leads, because it is the one that finishes: the
          // other button asks the user to go and close something first, and
          // they came here to update.
          buttons: [t("Update anyway"), t("Not now")],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 1) return;
      }
    }
    const { default: electronUpdater } = await import("electron-updater");
    // quitAndInstall bypasses will-quit in some paths -- stop the engines
    // explicitly first so no uvicorn is orphaned across the swap.
    if (ctx.engines) ctx.engines.stopAll();
    markCleanExit(join(app.getPath("userData"), "logs"));
    // (silent, relaunch): without the flags the NSIS wizard opened and asked
    // for three clicks (user, Next, Finish) on 2026-09-08. Mac ignores them.
    electronUpdater.autoUpdater.quitAndInstall(true, true);
  }

  return { startUpdater, restartToUpdate };
}
