import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envWithKit, setKitEnvValue } from "./kitEnv.js";
import { revealAllowed } from "./revealPolicy.js";
import { uniqueName } from "./downloadPath.js";

// The folder the Download dialog's Change picked, kept in kit.env with the
// user's other settings: the engine reads the same line for the files it
// writes itself (app/downloads.py save_folder). Empty, or no line, is Downloads.
const DOWNLOAD_DIR_KEY = "PERSODUB_DOWNLOAD_DIR";

const isFolder = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * Where a finished job's files are saved, and showing one of them. Registers
 * the page's channels at once; the session's will-download listener is
 * returned for the caller to attach once the app is ready, since the session
 * does not exist before then.
 */
export function registerDownloadIpc({ app, ipcMain, shell, dialog, ctx, shellLog }) {
  // Filled by the screen when it renders a finished job, read back synchronously
  // inside will-download (which cannot await a fetch).
  const jobFolders = new Map();
  ipcMain.on("shell:remember-job", (_e, job) => {
    if (job && job.id && job.project && job.day) {
      jobFolders.set(job.id, { project: job.project, day: job.day });
    }
  });

  // Where downloads go, for the Download dialog's line and Settings > Storage:
  // {folder, chosen, missing}. `chosen` is the folder picked ("" for none),
  // `missing` whether it is gone (a drive taken out), and `folder` where the
  // files go now: the one picked while it is there, else Downloads.
  function downloadFolder() {
    const chosen = envWithKit(ctx.bootedKitDir)[DOWNLOAD_DIR_KEY] || "";
    const missing = !!chosen && !isFolder(chosen);
    return { folder: chosen && !missing ? chosen : app.getPath("downloads"), chosen, missing };
  }
  // The log says that the folder changed, never which it is: shell.log goes
  // out with failure reports, whose masks know only the home folder and the kit.
  function keepFolder(path) {
    try {
      setKitEnvValue(ctx.bootedKitDir, DOWNLOAD_DIR_KEY, path);
      shellLog(`PERSODUB_DOWNLOAD_FOLDER ${path ? "picked" : "back to Downloads"}`);
    } catch (e) {
      shellLog(`PERSODUB_DOWNLOAD_FOLDER not kept (${e.code || "refused"})`, "ERROR");
    }
  }
  ipcMain.handle("shell:download-folder", () => downloadFolder());
  // Change: the computer's own folder picker, open on the folder in use. Kept
  // for this download and every one after it; closed without a folder,
  // nothing changes.
  ipcMain.handle("shell:pick-download-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(ctx.win, {
      properties: ["openDirectory", "createDirectory"], defaultPath: downloadFolder().folder,
    });
    if (!canceled && filePaths && filePaths[0]) keepFolder(filePaths[0]);
    return downloadFolder();
  });
  // Use default: Downloads again.
  ipcMain.handle("shell:reset-download-folder", () => {
    keepFolder("");
    return downloadFolder();
  });

  // "Saved to Downloads · Show". The page knows where the app wrote a file and
  // asks for it to be shown; this decides whether it may be. Only the folders
  // this app writes into (revealPolicy.js) -- Downloads, the folder picked for
  // downloads, the kit -- since a reveal that took any path the page named
  // would be a way to point the user at any file on the disk. A refusal is
  // logged and answered quietly: the page's own line has already said where
  // the file went.
  ipcMain.handle("shell:reveal", (_e, target) => {
    const folders = [app.getPath("downloads"), downloadFolder().chosen, ctx.bootedKitDir].filter(Boolean);
    if (!revealAllowed(target, folders)) {
      shellLog(`PERSODUB_REVEAL refused: ${String(target).slice(0, 200)}`);
      return { ok: false };
    }
    shell.showItemInFolder(target);
    return { ok: true };
  });

  // The app server names the file (dub_en.mp4); the folder comes from the job's
  // date and project, so three episodes do not collapse into "dub_en (1).mp4",
  // inside the download folder: Downloads, or the one picked while it is
  // there. A download the page never described (the separated sounds) goes
  // loose in that folder. Nothing here is fatal: on any failure Electron picks
  // the path the way it always did.
  function willDownload(_event, item, webContents) {
    // The window saves silently, so without a word back the page has nothing to
    // show and the user, seeing nothing happen, clicks Download again. Attached
    // before the naming below so a download we did not rename still reports.
    item.once("done", (_e, state) => {
      const path = item.getSavePath();
      if (webContents && !webContents.isDestroyed()) {
        webContents.send("shell:download-done", {
          state,
          path,
          filename: basename(path),
          folder: dirname(path),
        });
      }
    });
    try {
      const jid = new URL(item.getURL()).pathname.split("/")[4];
      const folder = jid && jobFolders.get(jid);
      const root = downloadFolder().folder;
      const dir = folder ? join(root, folder.day, folder.project) : root;
      mkdirSync(dir, { recursive: true });
      const name = uniqueName(item.getFilename(), (n) => existsSync(join(dir, n)));
      if (name) item.setSavePath(join(dir, name));
    } catch {
      /* fall through to Electron's default naming */
    }
  }

  return { willDownload };
}
