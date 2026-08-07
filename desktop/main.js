import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULTS } from "./src/config.js";
import { checkKit, readKitVersion } from "./src/engineCheck.js";
import { killStalePids, startEngines } from "./src/orchestrator.js";
import { buildSteps } from "./src/installSpec.js";
import { runInstall } from "./src/installer.js";
import { download } from "./src/download.js";
import { extractTarGz } from "./src/extract.js";
import { run } from "./src/exec.js";
import { pullOllamaModel } from "./src/ollamaPull.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let engines = null;

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
      cfg = { ...cfg, kitDir: join(app.getPath("userData"), "kit") };
    }
    if (!checkKit(cfg.kitDir, kitVersion).ok) {
      if (!payload) {
        await win.loadFile(join(HERE, "screens", "not-installed.html"), {
          query: { kitDir: cfg.kitDir, missing: checkKit(cfg.kitDir, kitVersion).missing.join(",") },
        });
        return;
      }
      await win.loadFile(join(HERE, "screens", "installing.html"));
      const ctx = { kitDir: cfg.kitDir, payloadDir: payload, download, extract: extractTarGz, run, pullOllama: pullOllamaModel };
      try {
        await runInstall(buildSteps(ctx), {
          onProgress: (p) => win.webContents.send("shell:install-progress", p),
        });
      } catch (err) {
        await win.loadFile(join(HERE, "screens", "error.html"), {
          query: { message: String((err && err.message) || err), logDir: cfg.kitDir },
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
  } catch (err) {
    await win.loadFile(join(HERE, "screens", "error.html"), {
      query: { message: String((err && err.message) || err), logDir: String((err && err.logDir) || "") },
    });
  }
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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
  ipcMain.on("shell:retry", guardedBoot);
  // app.quit() (not app.exit()) so will-quit still runs and stops the child
  // engines before the fresh instance starts -- exit() would orphan them.
  ipcMain.on("shell:relaunch", () => { app.relaunch(); app.quit(); });
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
