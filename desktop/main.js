import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from "electron";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnvFile, KIT_ENV, migrateKitEnv } from "./src/kitEnv.js";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULTS, defaultKitDir, kitPathTooLong, notEnoughSpace, freeSpaceAt } from "./src/config.js";
import { checkKit, readKitVersion } from "./src/engineCheck.js";
import { killStalePids, startEngines } from "./src/orchestrator.js";
import { buildSteps, bytesStillNeeded } from "./src/installSpec.js";
import { runInstall } from "./src/installer.js";
import { download } from "./src/download.js";
import { uniqueName } from "./src/downloadPath.js";
import { extractTarGz } from "./src/extract.js";
import { run } from "./src/exec.js";
import { pullOllamaModel } from "./src/ollamaPull.js";
import { resolveUpdateMode, resolveFeed } from "./src/updater.js";
import { findForeignLockers } from "./src/lockCheck.js";
import { resolveAnalyticsMode, countEvent, classifyError } from "./src/analytics.js";
import { IS_WIN } from "./src/platform.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let engines = null;
let updateDownloaded = false;
let bootedKitDir = null;   // for the dub counts, which arrive long after boot


// Usage counts. What leaves, and the switches that stop it, are decided in
// src/analytics.js; this is only the wiring. Every call is fire-and-forget:
// a count must never delay a launch, and countEvent never rejects, so a dead
// endpoint or a full disk costs a number and nothing else.
const COUNT_ENDPOINT = "https://persodub-count.persodub.workers.dev";

// Read fresh every time: the Settings switch writes PERSODUB_NO_ANALYTICS into
// this same file, so turning counts off takes effect on the very next event
// instead of waiting for a restart.
function analyticsMode(kitDir) {
  // The off switch lives in the kit's kit.env beside the user's other
  // settings, the same place the update check reads its own -- a GUI app's
  // process.env never carries it.
  let env = process.env;
  const kitEnvPath = kitDir ? join(kitDir, KIT_ENV) : null;
  if (kitEnvPath && existsSync(kitEnvPath)) {
    env = { ...process.env, ...parseEnvFile(readFileSync(kitEnvPath, "utf8")) };
  }
  return resolveAnalyticsMode({ isPackaged: app.isPackaged, env });
}

function countUsage(event, kitDir, errorCode, step) {
  try {
    const mode = analyticsMode(kitDir);
    if (mode === "off") return;
    void countEvent(event, {
      mode,
      stateFile: join(app.getPath("userData"), "analytics.json"),
      url: COUNT_ENDPOINT,
      os: IS_WIN ? "windows" : "mac",
      version: app.getVersion(),
      errorCode,
      step,
    });
  } catch { /* a count is never worth interrupting a launch for */ }
}

// Auto-update (packaged builds only -- see src/updater.js for the decision
// rules). Checks GitHub Releases after the window is up, downloads in the
// background, and lets the page offer "Restart to update"; nothing is ever
// forced. electron-updater validates the new build's code signature, which is
// why signing came first. Errors are logged and swallowed: an update check
// must never break a working app.
async function startUpdater(win, kitDir) {
  // The documented off-switch (PERSODUB_DISABLE_UPDATE_CHECK=1) lives in the
  // kit's kit.env with the user's other settings -- read it from there, since
  // a GUI app's process.env never carries it.
  let env = process.env;
  try {
    const kitEnvPath = kitDir ? join(kitDir, KIT_ENV) : null;
    if (kitEnvPath && existsSync(kitEnvPath)) {
      env = { ...process.env, ...parseEnvFile(readFileSync(kitEnvPath, "utf8")) };
    }
  } catch { /* unreadable kit.env: fall back to process.env */ }
  if (resolveUpdateMode({ isPackaged: app.isPackaged, env }) !== "auto") return;
  try {
    const { default: electronUpdater } = await import("electron-updater");
    const { autoUpdater } = electronUpdater;
    const feed = resolveFeed(process.env);
    if (feed) autoUpdater.setFeedURL(feed);
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => {
      updateDownloaded = true;
      console.log(`PERSODUB_UPDATE downloaded ${info?.version ?? ""}`);
      win.webContents.send("shell:update-ready", { version: info?.version ?? "" });
      // Test-only hook: lets the end-to-end update test apply the swap without
      // a human clicking the banner. (true, false) = silent, no relaunch --
      // the test verifies the version stamp on disk, and a relaunched app
      // would fight the real one over the sidecar port. Never set outside tests.
      if (process.env.PERSODUB_TEST_AUTO_RESTART === "1") {
        if (engines) engines.stopAll();
        autoUpdater.quitAndInstall(true, false);
      }
    });
    autoUpdater.on("error", (err) => console.warn("PERSODUB_UPDATE check failed:", String(err?.message || err)));
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn("PERSODUB_UPDATE unavailable:", String((err && err.message) || err));
  }
}

function fakeOverrides() {
  return {
    sidecarPort: 0,
    sidecarCmd: [process.execPath, join(HERE, "fake", "fake_sidecar.mjs"), "{port}"],
    backendCmd: [process.execPath, join(HERE, "fake", "fake_backend.mjs"), "{port}"],
    backendCwd: HERE,
  };
}

// Packaged builds carry the payload under Resources/; a dev checkout may have
// one at desktop/resources/payload after running collect-payload.
function findPayloadDir() {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "payload") : null,
    join(HERE, "resources", "payload"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "app-repo"))) ?? null;
}

async function boot(win) {
  let cfg = loadConfig();
  if (process.env.PERSODUB_FAKE === "1") cfg = { ...cfg, ...fakeOverrides() };
  const usingOverrides = cfg.sidecarCmd != null && cfg.backendCmd != null;

  if (!usingOverrides) {
    const payload = findPayloadDir();
    const kitVersion = payload ? readKitVersion(payload) : null;
    if (kitVersion == null) {
      // No bundled payload (typical dev `npm start`, or -- rarely -- a
      // payload whose KIT_VERSION is unreadable) means there's nothing to
      // compare a kit's version against: checkKit falls back to its
      // pre-versioning 4-file-only check so the dev loop still works.
      console.warn("PERSODUB_KIT no bundled payload KIT_VERSION found -- version enforcement skipped, falling back to file-presence check");
    }

    // A kit installed before the settings file was renamed still calls it
    // mac.env, which is on checkKit's required list under its new name -- so
    // this runs first, or an installed kit reads as missing and the whole
    // 30+ GB is downloaded again. Both candidate directories are tried
    // because the redirect below may still move the target.
    for (const dir of [cfg.kitDir, defaultKitDir({ ignoreLegacy: true })]) {
      if (migrateKitEnv(dir)) console.log(`PERSODUB_KIT migrated mac.env -> kit.env in ${dir}`);
    }

    // Prefer an existing kit (e.g. a mac_kit install); otherwise install into
    // the app's own data dir. An explicit PERSODUB_KIT_DIR is honored as-is.
    // A kit whose KIT_VERSION doesn't match this app's own bundled payload
    // fails the check below. What happens next depends on which kit it was:
    // the DEFAULT (legacy setup_mac.sh) kit is abandoned outright -- cfg.kitDir
    // is redirected to userData/kit just below, which starts out with none of
    // buildSteps' .ok markers, so runInstall does a full install there (Python,
    // venvs, models -- everything), not a cheap one. An explicit non-default
    // kitDir is never redirected this way; if its venvs/models are already
    // present and only the app code is stale, runInstall only re-runs
    // installSpec's payload step -- that path really is a cheap app-code-only
    // refresh.
    if (!checkKit(cfg.kitDir, kitVersion).ok && cfg.kitDir === DEFAULTS.kitDir) {
      // Not userData: that is the Roaming half of AppData on Windows, which a
      // domain profile syncs to a server -- somewhere a 30+ GB kit must never
      // go. defaultKitDir picks the per-user LOCAL application-data directory
      // each platform defines; ignoreLegacy keeps the replacement out of the
      // very folder this branch exists to abandon.
      cfg = { ...cfg, kitDir: defaultKitDir({ ignoreLegacy: true }) };
    }
    if (!checkKit(cfg.kitDir, kitVersion).ok) {
      if (!payload) {
        await win.loadFile(join(HERE, "screens", "not-installed.html"), {
          query: { kitDir: cfg.kitDir, missing: checkKit(cfg.kitDir, kitVersion).missing.join(",") },
        });
        return;
      }
      // Before the first byte: a path Windows cannot reach the bottom of would
      // otherwise fail tens of gigabytes later, deep inside a venv, as a
      // file-not-found nobody can act on.
      const tooLong = kitPathTooLong(cfg.kitDir);
      if (tooLong) {
        countUsage("install_failure", cfg.kitDir, "path-too-long");
        await win.loadFile(join(HERE, "screens", "error.html"), {
          // No logDir: this stopped before a byte was written, so there is no
          // log to point at.
          query: { title: "Choose a shorter install location", message: tooLong },
        });
        return;
      }
      const ctx = { kitDir: cfg.kitDir, payloadDir: payload, download, extract: extractTarGz, run, pullOllama: pullOllamaModel };
      const steps = buildSteps(ctx);
      // The other preflight, and for the same reason: five machines reported a
      // disk-full from deep inside a step, after gigabytes had already been
      // downloaded. Only the steps still missing are counted, so a half-done
      // install asks for the remainder rather than the whole kit again.
      const noRoom = notEnoughSpace(await bytesStillNeeded(steps), await freeSpaceAt(cfg.kitDir));
      if (noRoom) {
        countUsage("install_failure", cfg.kitDir, "disk-full");
        await win.loadFile(join(HERE, "screens", "error.html"), {
          query: { title: "Not enough space to install", message: noRoom },
        });
        return;
      }
      await win.loadFile(join(HERE, "screens", "installing.html"));
      // runInstall already reports which step failed; without keeping it the
      // count says only "somewhere in ten steps", which is what made the first
      // four real install failures unactionable.
      let failedStep;
      try {
        await runInstall(steps, {
          onProgress: (p) => {
            if (p.state === "error") failedStep = p.stepId;
            win.webContents.send("shell:install-progress", p);
          },
        });
      } catch (err) {
        countUsage("install_failure", cfg.kitDir, classifyError(String((err && err.message) || err), { install: true }), failedStep);
        await win.loadFile(join(HERE, "screens", "error.html"), {
          query: {
            title: "The install could not finish",
            message: String((err && err.message) || err),
            logDir: cfg.kitDir,
          },
        });
        return;
      }
    }
    console.log(`PERSODUB_KIT kitDir=${cfg.kitDir} version=${kitVersion ?? "unknown"}`);
  }

  await win.loadFile(join(HERE, "screens", "loading.html"));
  try {
    engines = await startEngines(cfg, {
      logDir: join(app.getPath("userData"), "logs"),
      appVersion: app.getVersion(), // desktop/package.json -- the one place the version lives
    });
    await win.loadURL(engines.url);
    console.log(`PERSODUB_READY ${engines.url}`);
    bootedKitDir = cfg.kitDir;
    countUsage("app_launch", cfg.kitDir);
    startUpdater(win, cfg.kitDir); // deliberately not awaited: boot never waits on the network
  } catch (err) {
    // The kit installed fine and the app still cannot run. Such a machine fires
    // no other event -- install_failure's other codes do not apply and
    // PERSODUB_READY was never reached -- so without this it is invisible.
    countUsage("install_failure", cfg.kitDir, "engine-start");
    await win.loadFile(join(HERE, "screens", "error.html"), {
      query: { message: String((err && err.message) || err), logDir: String((err && err.logDir) || "") },
    });
  }
}

// Filled by the screen when it renders a finished job, read back synchronously
// inside will-download (which cannot await a fetch).
const jobFolders = new Map();
ipcMain.on("shell:remember-job", (_e, job) => {
  if (job && job.id && job.project && job.day) {
    jobFolders.set(job.id, { project: job.project, day: job.day });
  }
});

app.whenReady().then(() => {
  // One greppable line naming the running version -- the e2e update test (and
  // any future bug report) reads it instead of guessing from filenames.
  console.log(`PERSODUB_VERSION ${app.getVersion()}`);

  // The app server names the file (dub_en.mp4); the folder comes from the job's
  // date and project, so three episodes do not collapse into "dub_en (1).mp4".
  // Nothing here is fatal: on any failure Electron picks the path the way it
  // always did -- which is also what happens when the UI runs in a plain
  // browser and never sent us the job.
  session.defaultSession.on("will-download", (_event, item) => {
    try {
      const jid = new URL(item.getURL()).pathname.split("/")[4];
      const folder = jid && jobFolders.get(jid);
      if (!folder) return;
      const dir = join(app.getPath("downloads"), folder.day, folder.project);
      mkdirSync(dir, { recursive: true });
      const name = uniqueName(item.getFilename(), (n) => existsSync(join(dir, n)));
      if (name) item.setSavePath(join(dir, name));
    } catch {
      /* fall through to Electron's default naming */
    }
  });
  // The finished screen is a table beside a video with a strip under both, and
  // it needs 1280 to show the table's full set of columns. Clamped to the screen
  // the window opens on, so a small laptop gets a window that fits it rather
  // than one hanging off the bottom. The floor is the narrowest window the
  // screens are still whole at. Nothing remembers a size between launches, so
  // this is what every launch opens at.
  const room = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1280, room.width),
    height: Math.min(800, room.height),
    minWidth: Math.min(960, room.width),
    minHeight: Math.min(640, room.height),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Outbound links (the credit popup's Recharge button, Settings' "get a key") belong in
  // the user's own browser. This window has no chrome -- no address bar, no Back -- so
  // letting a page open here strands the user with only force-quit to get out.
  // Two routes lead out, and both are closed: target=_blank / window.open goes through
  // setWindowOpenHandler, a same-window navigation through will-navigate. Only http(s) is
  // handed to the OS, so a page can never make us open file:// or a custom scheme.
  const openExternally = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // The app's own pages (the local backend, the bundled screens/) must still
    // navigate. Compare parsed origins, not string prefixes: with a prefix
    // check, "http://127.0.0.1:5001@evil.com" (real host evil.com) passed.
    if (url === win.webContents.getURL()) return;
    const here = engines?.url;
    try {
      if (url.startsWith("file://") || (here && new URL(url).origin === new URL(here).origin)) return;
    } catch { /* unparseable URL: treat as external */ }
    e.preventDefault();
    openExternally(url);
  });
  // Re-entrancy guard: mashing "Try again" on the error screen used to run
  // overlapping boots, whose duplicate engines then fought over the fixed
  // sidecar port and blocked the next clean launch.
  let bootInFlight = false;
  const guardedBoot = async () => {
    if (bootInFlight) return;
    bootInFlight = true;
    try { await boot(win); } finally { bootInFlight = false; }
  };
  // A dub finished. The page cannot be trusted to name the outcome or the
  // reason -- it is a web page served over http -- so the status is checked
  // against the two that count and the detail is reduced to one published
  // word here. A cancel is not a failure and is deliberately not counted.
  ipcMain.on("shell:count-dub", (_e, msg) => {
    const status = msg && msg.status;
    if (status !== "done" && status !== "error") return;
    countUsage(
      status === "done" ? "dub_success" : "dub_failure",
      bootedKitDir,
      status === "error" ? classifyError(String((msg && msg.detail) || "")) : undefined,
    );
  });

  ipcMain.on("shell:retry", guardedBoot);
  // app.quit() (not app.exit()) so will-quit still runs and stops the child
  // engines before the fresh instance starts -- exit() would orphan them.
  ipcMain.on("shell:relaunch", () => { app.relaunch(); app.quit(); });
  ipcMain.on("shell:restart-to-update", async () => {
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
      console.log(`PERSODUB_UPDATE lock check: ${lockers.length} foreign holder(s)${lockers.length > 0 ? " -- " + lockers.map((l) => l.exe || l.name).join(", ") : ""}`);
      if (lockers.length > 0) {
        const names = [...new Set(lockers.map((l) => l.name || l.exe))].join(", ");
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          title: "PersoDub update",
          message: `Close ${names} first, then update`,
          detail:
            "That program is using files in PersoDub's installation folder, so the " +
            "update would stall halfway through. Close it and click \"Restart to " +
            "update\" again -- or choose Update anyway to try regardless.",
          buttons: ["OK", "Update anyway"],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 0) return;
      }
    }
    const { default: electronUpdater } = await import("electron-updater");
    // quitAndInstall bypasses will-quit in some paths -- stop the engines
    // explicitly first so no uvicorn is orphaned across the swap.
    if (engines) engines.stopAll();
    electronUpdater.autoUpdater.quitAndInstall();
  });
  guardedBoot();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  if (engines) {
    engines.stopAll();
  } else {
    // Quitting while the engines are still starting up (the 2-minute health
    // wait) orphans them: `engines` is only assigned after startEngines
    // resolves. pids.json records what was spawned -- kill those instead of
    // leaving uvicorns behind until the next launch cleans them.
    killStalePids(join(app.getPath("userData"), "logs"));
  }
});
