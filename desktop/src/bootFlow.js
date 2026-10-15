import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, DEFAULTS, defaultKitDir, kitPathTooLong, notEnoughSpace, freeSpaceAt, inEnglish } from "./config.js";
import { checkKit, readKitVersion } from "./engineCheck.js";
import { startEngines } from "./orchestrator.js";
import { rememberedEdition } from "./edition.js";
import { buildSteps, bytesStillNeeded, bootSteps, packInstallingMarker, PACKS } from "./installSpec.js";
import { runInstall, openSteps } from "./installer.js";
import { classifyError } from "./analytics.js";
import { download } from "./download.js";
import { extractTarGz } from "./extract.js";
import { run } from "./exec.js";
import { KIT_ENV, migrateKitEnv } from "./kitEnv.js";
import { errorText } from "./errorText.js";
import { hasPersoKey } from "./usageIpc.js";
import { useLanguage, systemLocale, t } from "./i18n.js";
import { screenFile } from "./screenText.js";

// Packaged builds carry the payload under Resources/; a dev checkout may have
// one at desktop/resources/payload after running collect-payload. Exported
// because main.js reads the build's edition from the same folder (edition.js).
export function findPayloadDir(appDir) {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "payload") : null,
    join(appDir, "resources", "payload"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "app-repo"))) ?? null;
}

/**
 * The launch: find the kit (installing what it is missing), start the
 * engines, load the app page. Returns boot(win), which the error screen's
 * Retry runs again. Boot sets ctx.installCtx, for the pack IPC, and
 * ctx.engines and ctx.bootedKitDir once the engines are up.
 */
export function createBoot({ app, ctx, appDir, edition, shellLog, countUsage, sendReport, flushReports, startUpdater }) {
  // The old-path kit boot walked away from (issue #6); the cleanup step
  // removes it once its models are carried over.
  let abandonedKitDir = null;

  // <userData>/ports.json -- {"backend": 51799}: the port the backend listened
  // on last time. Reused when free so the page's origin (and its localStorage:
  // the seen "What's new" version, timeline state, pane sizes) survives a
  // relaunch. Unreadable or missing just means "pick a free port", as before.
  const PORTS_FILE = () => join(app.getPath("userData"), "ports.json");
  function readRememberedPorts() {
    try { return JSON.parse(readFileSync(PORTS_FILE(), "utf8")) || {}; } catch { return {}; }
  }
  function rememberPorts(ports) {
    try { writeFileSync(PORTS_FILE(), JSON.stringify(ports)); } catch { /* a forgotten port costs one blank launch, never the boot */ }
  }

  function fakeOverrides() {
    return {
      sidecarPort: 0,
      sidecarCmd: [process.execPath, join(appDir, "fake", "fake_sidecar.mjs"), "{port}"],
      backendCmd: [process.execPath, join(appDir, "fake", "fake_backend.mjs"), "{port}"],
      backendCwd: appDir,
    };
  }

  // One of the bundled screens (screens/), with the version on its query string
  // so the screen can name the build the user is on -- in the user's language,
  // through a translated copy in userData when there is one (screenText.js).
  function showScreen(win, name, query = {}) {
    const file = screenFile(join(appDir, "screens"), name, join(app.getPath("userData"), "screens"));
    return win.loadFile(file, { query: { v: app.getVersion(), ...query } });
  }

  // Prefer an existing kit (e.g. a mac_kit install); otherwise install into
  // the app's own data dir. An explicit PERSODUB_KIT_DIR is honored as-is.
  // A kit whose KIT_VERSION doesn't match this app's own bundled payload
  // fails the check below. What happens next depends on which kit it was:
  // the DEFAULT (legacy setup_mac.sh) kit is abandoned outright -- cfg.kitDir
  // is redirected to a fresh per-user kit folder just below (defaultKitDir),
  // which starts out with none of
  // buildSteps' .ok markers, so runInstall does a full install there (Python,
  // venvs, models -- everything), not a cheap one. An explicit non-default
  // kitDir is never redirected this way; if its venvs/models are already
  // present and only the app code is stale, runInstall only re-runs
  // installSpec's payload step -- that path really is a cheap app-code-only
  // refresh.
  function abandonStaleDefaultKit(cfg, kitVersion) {
    if (!checkKit(cfg.kitDir, kitVersion).ok && cfg.kitDir === DEFAULTS.kitDir) {
      // Not userData: that is the Roaming half of AppData on Windows, which a
      // domain profile syncs to a server -- somewhere a 30+ GB kit must never
      // go. defaultKitDir picks the per-user LOCAL application-data directory
      // each platform defines; ignoreLegacy keeps the replacement out of the
      // very folder this branch exists to abandon.
      const freshKitDir = defaultKitDir({ ignoreLegacy: true });
      // models/: version-independent weights, up to ~15 GB, and pure data --
      // safe to move. engines_venv/ is NOT: a venv records its own absolute
      // path in every console script's shebang (bin/pip, bin/uvicorn), and
      // `python -m venv` over a moved directory repairs bin/python but leaves
      // those shebangs pointing at the path we just renamed away. The kit
      // would fail at `pip install` and, past that, at the sidecar's uvicorn.
      try {
        const oldModels = join(cfg.kitDir, "models");
        const newModels = join(freshKitDir, "models");
        if (freshKitDir !== cfg.kitDir && existsSync(oldModels) && !existsSync(newModels)) {
          mkdirSync(freshKitDir, { recursive: true });
          renameSync(oldModels, newModels);
          shellLog(`PERSODUB_KIT moved models from ${oldModels} to ${newModels}`);
        }
      } catch (err) {
        shellLog(`PERSODUB_KIT could not carry models over: ${errorText(err)}`);
      }
      abandonedKitDir = cfg.kitDir;
      cfg = { ...cfg, kitDir: freshKitDir };
    }
    return cfg;
  }

  // Runs whatever the kit still needs from the bundled payload. True when the
  // kit is ready to start; false when a screen now says why it is not, and
  // boot goes no further.
  async function prepareKit(win, cfg, payload, kitVersion) {
    // checkKit sees files and a version, not whether the steps that produce
    // them finished: the payload step writes KIT_VERSION first, so an install
    // closed during the venv step looked "installed", the engines then failed
    // to start, and Try again could never get back in (Windows, 2026-09-04).
    // The installer's own step markers are the truth -- any open step reopens
    // it, and it skips everything already done.
    const kitOk = checkKit(cfg.kitDir, kitVersion).ok;
    let unfinished = false;
    // The boot install: the base steps every launch needs, plus only the
    // packs already on this kit's disk. An existing user's engine/
    // ollama-runtime keep being refreshed the way they always were; a pack
    // that was never installed is left alone here -- the page installs one on
    // demand through src/packIpc.js.
    ctx.installCtx = payload ? { kitDir: cfg.kitDir, payloadDir: payload, download, extract: extractTarGz, run, abandonedKitDir } : null;
    // A pack's "installing" stamp left by a crash would read as downloading forever.
    for (const p of PACKS) rmSync(packInstallingMarker(cfg.kitDir, p.id), { force: true });
    const all = ctx.installCtx ? buildSteps(ctx.installCtx) : null;
    const toRun = all && bootSteps(all, cfg.kitDir);
    if (kitOk && payload) {
      const open = await openSteps(toRun);
      unfinished = open.length > 0;
      if (unfinished) shellLog(`PERSODUB_KIT resuming an unfinished install: ${open.map((s) => s.id).join(", ")}`);
    }
    if (!kitOk || unfinished) {
      if (!payload) {
        await showScreen(win, "not-installed.html", { kitDir: cfg.kitDir, missing: checkKit(cfg.kitDir, kitVersion).missing.join(",") });
        return false;
      }
      // Before the first byte: a path Windows cannot reach the bottom of would
      // otherwise fail tens of gigabytes later, deep inside a venv, as a
      // file-not-found nobody can act on.
      const tooLong = kitPathTooLong(cfg.kitDir);
      if (tooLong) {
        countUsage("install_failure", cfg.kitDir, "path-too-long");
        // The report in English, whatever the screen says it in.
        sendReport({ kind: "install", kitDir: cfg.kitDir, code: "path-too-long", message: kitPathTooLong(cfg.kitDir, process.platform, inEnglish) });
        // No logDir: this stopped before a byte was written, so there is no
        // log to point at.
        await showScreen(win, "error.html", { title: t("Choose a shorter install location"), message: tooLong });
        return false;
      }
      // The other preflight, and for the same reason: five machines reported a
      // disk-full from deep inside a step, after gigabytes had already been
      // downloaded. Only the steps still missing are counted, so a half-done
      // install asks for the remainder rather than the whole kit again.
      const stillNeeded = await bytesStillNeeded(toRun);
      const free = await freeSpaceAt(cfg.kitDir);
      const noRoom = notEnoughSpace(stillNeeded, free);
      if (noRoom) {
        countUsage("install_failure", cfg.kitDir, "disk-full");
        sendReport({ kind: "install", kitDir: cfg.kitDir, code: "disk-full", message: notEnoughSpace(stillNeeded, free, inEnglish) });
        await showScreen(win, "error.html", { title: t("Not enough space to install"), message: noRoom });
        return false;
      }
      await showScreen(win, "installing.html", {
        // Same kit again (an update) or a first install: the screen's title.
        mode: existsSync(join(cfg.kitDir, KIT_ENV)) ? "update" : "install",
        // What the steps still to run add up to -- the figure the title shows.
        bytes: String(stillNeeded),
      });
      // runInstall already reports which step failed; without keeping it the
      // count says only "somewhere in ten steps", which is what made the first
      // four real install failures unactionable.
      let failedStep;
      try {
        await runInstall(toRun, {
          onProgress: (p) => {
            if (p.state === "error") failedStep = p.stepId;
            win.webContents.send("shell:install-progress", p);
          },
        });
      } catch (err) {
        const message = errorText(err);
        const code = classifyError(message, { install: true });
        countUsage("install_failure", cfg.kitDir, code, failedStep);
        sendReport({ kind: "install", kitDir: cfg.kitDir, code, step: failedStep, message });
        await showScreen(win, "error.html", { title: t("The install could not finish"), message, logDir: cfg.kitDir });
        return false;
      }
    }
    return true;
  }

  // The engines, then the app page in the window.
  async function startApp(win, cfg) {
    await showScreen(win, "loading.html");
    // The kit's own edition, remembered from its first run (src/edition.js).
    const runEdition = rememberedEdition(cfg.kitDir, edition);
    shellLog(`PERSODUB_EDITION kit runs as ${runEdition}`);
    try {
      ctx.engines = await startEngines(cfg, {
        logDir: join(app.getPath("userData"), "logs"),
        appVersion: app.getVersion(), // desktop/package.json -- the one place the version lives
        locale: systemLocale(),
        edition: runEdition, // where a dub runs by default (app/setup.py)
        preferredBackendPort: readRememberedPorts().backend,
      });
      rememberPorts({ backend: ctx.engines.port });
      await win.loadURL(ctx.engines.url);
      shellLog(`PERSODUB_READY ${ctx.engines.url}`);
      // An engine that did not start no longer stops the app (orchestrator.js):
      // the page tells the user through GET /api/engines. Counted and reported
      // as the whole boot's failure was, with the pack's first step saying which.
      for (const f of ctx.engines.failed) {
        shellLog(`PERSODUB_PACK ${f.pack} did not start: ${f.message}`);
        const step = PACKS.find((p) => p.id === f.pack)?.steps[0];
        countUsage("install_failure", cfg.kitDir, "engine-start", step);
        sendReport({ kind: "install", kitDir: cfg.kitDir, code: "engine-start", step, message: f.message });
      }
      ctx.bootedKitDir = cfg.kitDir;
      countUsage("app_launch", cfg.kitDir, undefined, undefined, { persoKey: hasPersoKey(cfg.kitDir) });
      // Reports from earlier launches that had no network. Deliberately not
      // awaited, and after the page is up: the queue is never the reason a
      // launch is slow.
      void flushReports(cfg.kitDir).catch(() => {});
    } catch (err) {
      // The kit installed fine and the app still cannot run. Such a machine fires
      // no other event -- install_failure's other codes do not apply and
      // PERSODUB_READY was never reached -- so without this it is invisible.
      countUsage("install_failure", cfg.kitDir, "engine-start");
      sendReport({ kind: "install", kitDir: cfg.kitDir, code: "engine-start", message: errorText(err) });
      await showScreen(win, "error.html", { message: errorText(err), logDir: String((err && err.logDir) || "") });
    }
  }

  return async function boot(win) {
    let cfg = loadConfig();
    if (process.env.PERSODUB_FAKE === "1") cfg = { ...cfg, ...fakeOverrides() };
    const usingOverrides = cfg.sidecarCmd != null && cfg.backendCmd != null;

    if (!usingOverrides) {
      const payload = findPayloadDir(appDir);
      const kitVersion = payload ? readKitVersion(payload) : null;
      if (kitVersion == null) {
        // No bundled payload (typical dev `npm start`, or -- rarely -- a
        // payload whose KIT_VERSION is unreadable) means there's nothing to
        // compare a kit's version against: checkKit falls back to its
        // pre-versioning 4-file-only check so the dev loop still works.
        shellLog("PERSODUB_KIT no bundled payload KIT_VERSION found -- version enforcement skipped, falling back to file-presence check");
      }

      // A kit installed before the settings file was renamed still calls it
      // mac.env, which is on checkKit's required list under its new name -- so
      // this runs first, or an installed kit reads as missing and the whole
      // 30+ GB is downloaded again. Both candidate directories are tried
      // because the redirect below may still move the target.
      for (const dir of [cfg.kitDir, defaultKitDir({ ignoreLegacy: true })]) {
        if (migrateKitEnv(dir)) shellLog(`PERSODUB_KIT migrated mac.env -> kit.env in ${dir}`);
      }

      cfg = abandonStaleDefaultKit(cfg, kitVersion);
      // The kit is known now, and its kit.env may name a language (Settings >
      // About) over the computer's: the install screens already speak it.
      useLanguage({ kitDir: cfg.kitDir });
      // ...and every page load after this reads it again (windowFactory.js),
      // so a language saved in Settings reaches the shell's dialogs at once.
      ctx.kitDir = cfg.kitDir;
      if (!(await prepareKit(win, cfg, payload, kitVersion))) return;
      shellLog(`PERSODUB_KIT kitDir=${cfg.kitDir} version=${kitVersion ?? "unknown"}`);
    }

    // The update check starts here -- before the engines, which take up to a
    // minute to come up and which the check used to wait on before even asking.
    // On the install path it starts once the install above has succeeded, since
    // that is what this line sits after. Whatever it learns is re-sent on every
    // page load below, so the app page gets it the moment it appears.
    startUpdater(win, cfg.kitDir); // deliberately not awaited: boot never waits on the network
    await startApp(win, cfg);
  };
}
