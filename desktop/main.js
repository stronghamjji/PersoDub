import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from "electron";
import { join, dirname, basename } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseEnvFile, KIT_ENV, migrateKitEnv } from "./src/kitEnv.js";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULTS, defaultKitDir, kitPathTooLong, notEnoughSpace, freeSpaceAt } from "./src/config.js";
import { checkKit, readKitVersion } from "./src/engineCheck.js";
import { killStalePids, startEngines } from "./src/orchestrator.js";
import { buildSteps, bytesStillNeeded, baseSteps, packSteps, packInstalled, packInstallingMarker, syncEraserKitEnv, torchVariantFor, PACKS, PACK_DIRS } from "./src/installSpec.js";
import { runInstall, openSteps, packPercent, downloadInterrupted, DOWNLOAD_INTERRUPTED } from "./src/installer.js";
import { revealAllowed } from "./src/revealPolicy.js";
import { cancelCurrent } from "./src/exec.js";
import { readRuntime } from "./src/runtimeFile.js";
import { download } from "./src/download.js";
import { uniqueName } from "./src/downloadPath.js";
import { extractTarGz } from "./src/extract.js";
import { run } from "./src/exec.js";
import { resolveUpdateMode, resolveFeed, nextUpdateState } from "./src/updater.js";
import { findForeignLockers } from "./src/lockCheck.js";
import { resolveAnalyticsMode, countEvent, classifyError, loadState, saveState } from "./src/analytics.js";
import { buildReport, collectEnvironment, maskText, resolveReportMode, worthReporting } from "./src/report.js";
import { buildLogArchive } from "./src/reportLogs.js";
import { ARCHIVE_EXT, REPORT_EXT, partitionQueue, pendingWork, queueBase } from "./src/reportQueue.js";
import { IS_WIN } from "./src/platform.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let engines = null;
// The boot's install context (kit, bundled payload, downloader), kept so the
// pack IPC below can run a pack's steps from the same table later.
let installCtx = null;
// The old-path kit main.js walked away from at boot (issue #6); the cleanup
// step removes it once its models are carried over.
let abandonedKitDir = null;

// The shell's own lines go to a file as well as the console: a packaged app
// has no console, and the one question a support log could not answer on
// Windows (2026-09-07) was why a pack's process did not start.
function shellLog(line) {
  console.log(line);
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "shell.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging never breaks the app */ }
}

// The last line a person can act on, out of a tool's whole transcript: the
// page showed two screens of pip output in red (Windows, 2026-09-07).
function lastReason(message) {
  const lines = String(message || "").split("\n").map((l) => l.trim())
    // Traceback scaffolding names files, not causes.
    .filter((l) => l && !/^File "/.test(l) && !/^Traceback/.test(l) && !/^\^+$/.test(l));
  if (!lines.length) return "The install could not finish.";
  // The sentence that names the error: "ERROR: …", "OSError: …",
  // "ConnectionResetError(…)" -- a path that merely contains "error" is not one.
  const err = [...lines].reverse().find((l) => /^ERROR\b|[A-Za-z]+Error\b|\bError:/.test(l) && !/^WARNING/.test(l));
  return (err || lines[lines.length - 1]).slice(0, 200);
}
let updateDownloaded = false;
// The update as last announced -- re-sent to the page on every load, so a
// page that arrives after the check (boot) or reloads mid-download still
// shows the right pill. Null until an update is found.
let updateState = null;
let bootedKitDir = null;   // for the dub counts, which arrive long after boot


// Usage counts. What leaves, and the switches that stop it, are decided in
// src/analytics.js; this is only the wiring. Every call is fire-and-forget:
// a count must never delay a launch, and countEvent never rejects, so a dead
// endpoint or a full disk costs a number and nothing else.
const COUNT_ENDPOINT = "https://persodub-count.persodub.workers.dev";

// The environment the user's own switches live in: this process's, with the
// kit's kit.env laid over it. Read fresh at every call, because Settings
// writes those switches into that file and turning one off has to take effect
// on the very next event rather than at the next restart. A GUI app's
// process.env never carries them, which is why the file is read at all.
function envWithKit(kitDir) {
  try {
    const kitEnvPath = kitDir ? join(kitDir, KIT_ENV) : null;
    if (kitEnvPath && existsSync(kitEnvPath)) {
      return { ...process.env, ...parseEnvFile(readFileSync(kitEnvPath, "utf8")) };
    }
  } catch { /* unreadable kit.env: fall back to process.env */ }
  return process.env;
}

function analyticsMode(kitDir) {
  return resolveAnalyticsMode({ isPackaged: app.isPackaged, env: envWithKit(kitDir) });
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

// Automatic failure reports. The count above says a dub failed; this says why
// -- the machine, the step, the error, and the logs -- and it becomes a GitHub
// issue without the user needing an account or knowing what an issue is.
// What may leave is decided in src/report.js (an allow-list, masked); this is
// the wiring: gather, send, and if that fails, keep it for the next launch.
const REPORT_ENDPOINT = "https://persodub-report.persodub.workers.dev";
// Reports wait here rather than in userData: a report belongs to the kit that
// produced it, and a user who deletes a kit is done with its failures too.
const reportsDir = (kitDir) => join(kitDir, "reports");
// The install id lives in its own file, not analytics.json: the two switches
// are independent, so a user who turned the counts off must not get an id
// minted for them by the report path, or a file that says otherwise.
const REPORT_STATE = () => join(app.getPath("userData"), "reports.json");
// What the page shows once a report has gone out ("Report sent - #142").
let lastReport = null;

function reportMode(kitDir) {
  return resolveReportMode({ isPackaged: app.isPackaged, env: envWithKit(kitDir) });
}

// The last lines of a file, as text. Reads the whole file: shell.log is the
// shell's own, written a line at a time, and has never been large.
function readFileText(path, maxBytes = 8 * 1024 * 1024) {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return "";
  }
}

// The backend's half: the failed job's stage and engines, and the two logs
// only it knows where to find. A dead engine (the boot failures, which are
// most of what this exists for) simply means the shell reports what it has.
async function fetchBundle(jobId) {
  if (!engines || !engines.url) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const q = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
    const res = await fetch(`${engines.url}/api/report/bundle${q}`, { signal: abort.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, timeoutMs = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The archive of full logs, sent after the report so the issue exists even
// when this half fails. Its own request, its own retry.
//
// Three answers, not two. "gone" is the one that matters: the relay only
// remembers a report id for a week, and a refusal that says the id is unknown
// (or the archive is malformed) will say the same thing on every future
// launch. Retrying that forever would be a request a day for nothing, so it is
// treated as an answer and the queued copy is dropped.
async function postLogs(id, archive, timeoutMs = 30000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${REPORT_ENDPOINT}/report/${encodeURIComponent(id)}/logs`, {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: archive,
      signal: abort.signal,
    });
    if (res.ok) return "ok";
    // 404 the id is forgotten, 413 the archive is too big, 410 gone, 501 the
    // relay has nowhere to put logs: all final, and none of them get better by
    // being asked again tomorrow.
    return [404, 410, 413, 501].includes(res.status) ? "gone" : "retry";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/** Everything about one failure, masked, in the shape the relay accepts. */
async function collectReport({ kind, kitDir, step, code, message, jobId }) {
  const home = app.getPath("home");
  const bundle = await fetchBundle(jobId);
  const job = (bundle && bundle.job) || {};
  const shellLogText = maskText(readFileText(join(app.getPath("userData"), "logs", "shell.log")), { home, kit: kitDir });
  const packs = (bundle && bundle.packs)
    || Object.fromEntries(PACKS.map((p) => [p.id, packInstalled(kitDir, p.id) ? "ready" : "missing"]));
  const report = buildReport({
    kind,
    step,
    stage: job.stage,
    stageMarker: job.stageMarker,
    code,
    // The job's own sentence when there is one: it is the line the user saw.
    message: message || job.error || "",
    home,
    // The kit's own paths survive masking -- which model, which venv, which
    // folder a step died in is the diagnosis. Everything else under home does not.
    kit: kitDir,
    version: app.getVersion(),
    installId: loadState(REPORT_STATE()).device,
    env: collectEnvironment({
      appVersion: app.getVersion(),
      kitVersion: readKitVersion(kitDir) || "",
      torchVariant: torchVariantFor(kitDir),
      packs,
      freeDiskBytes: await freeSpaceAt(kitDir),
    }),
    logTails: {
      shell: shellLogText,
      app: (bundle && bundle.logTails && bundle.logTails.app) || "",
      job: (bundle && bundle.logTails && bundle.logTails.job) || "",
    },
  });
  const archive = buildLogArchive({
    shell: shellLogText,
    app: (bundle && bundle.logs && bundle.logs.app) || "",
    job: (bundle && bundle.logs && bundle.logs.job) || "",
  });
  return { report, archive };
}

/** Write a report (and its archive) into the kit's queue for the next launch. */
function queueReport(kitDir, entry, archive) {
  try {
    const dir = reportsDir(kitDir);
    mkdirSync(dir, { recursive: true });
    const base = queueBase(entry.report.fingerprint, Date.now());
    writeFileSync(join(dir, `${base}${REPORT_EXT}`), JSON.stringify(entry));
    if (archive) writeFileSync(join(dir, `${base}${ARCHIVE_EXT}`), archive);
  } catch { /* a report that cannot be saved is a report that is lost, nothing more */ }
}

function announceReport(sent) {
  lastReport = sent;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("shell:report-sent", sent);
  }
}

/**
 * Send one report, then its logs. Says what landed and leaves the keeping to
 * the caller -- a first attempt starts a queue entry, a retry updates the one
 * it already has, and the difference matters: re-queueing under a new name
 * would restart the week a report is allowed to keep trying for.
 */
async function deliver(report, archive) {
  const answer = await postJson(REPORT_ENDPOINT + "/report", report);
  if (!answer || !answer.id) return { sent: false, id: null, logsSent: false };
  const logs = archive ? await postLogs(answer.id, archive) : "ok";
  announceReport({ id: answer.id, issue: answer.issue ?? null, url: answer.url ?? null, dedup: !!answer.dedup });
  return { sent: true, id: answer.id, logsSent: logs !== "retry" };
}

function sendReport(opts) {
  void (async () => {
    try {
      const kitDir = opts.kitDir;
      if (!kitDir) return;
      const mode = reportMode(kitDir);
      if (mode === "off") return;
      // Every failure is classified and counted; only the ones somebody here
      // could act on become an issue. A full disk and a refused cloud key are
      // the user's own situation -- they are told on screen, and an issue
      // about them is one more thing for a person to read and close
      // (user, 2026-09-11).
      if (!worthReporting(opts.code)) {
        shellLog(`[persodub-report] not sent (${opts.code}): the user's own situation`);
        return;
      }
      // The install id is minted (and written) only on a run that really
      // reports -- the same rule the counts follow, so a machine that never
      // reports never gets one, and no file appears claiming otherwise. It has
      // to happen BEFORE the report is built, or the id in the report and the
      // id on disk would be two different ids.
      if (mode === "on") saveState(REPORT_STATE(), loadState(REPORT_STATE()));
      const { report, archive } = await collectReport(opts);
      if (mode === "debug") {
        shellLog(`[persodub-report] would send: ${JSON.stringify(report)}`);
        shellLog(`[persodub-report] would attach ${archive ? archive.length : 0} bytes of logs`);
        return;
      }
      const { sent, id, logsSent } = await deliver(report, archive);
      if (!sent) queueReport(kitDir, { report, id: null }, archive);
      else if (!logsSent) queueReport(kitDir, { report, id }, archive);
    } catch { /* a failure to report a failure stops here */ }
  })();
}

/**
 * Reports that could not be sent when they happened. Runs once a launch, after
 * the app is up, and never blocks it: the network is the reason they are here.
 */
async function flushReports(kitDir) {
  const dir = reportsDir(kitDir);
  if (!kitDir || !existsSync(dir)) return;
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  const { retry, expired } = partitionQueue(names);
  const remove = (base) => {
    for (const ext of [REPORT_EXT, ARCHIVE_EXT]) rmSync(join(dir, `${base}${ext}`), { force: true });
  };
  for (const base of expired) remove(base);
  if (reportMode(kitDir) !== "on") return;   // off or debug: nothing leaves, nothing is deleted
  for (const base of retry) {
    let entry = null;
    try { entry = JSON.parse(readFileSync(join(dir, `${base}${REPORT_EXT}`), "utf8")); } catch { entry = null; }
    const archivePath = join(dir, `${base}${ARCHIVE_EXT}`);
    const hasArchive = existsSync(archivePath);
    const work = pendingWork(entry, { hasArchive });
    if (work === "done") { remove(base); continue; }
    const archive = hasArchive ? readFileSync(archivePath) : null;
    if (work === "send") {
      const { sent, id, logsSent } = await deliver(entry.report, archive);
      if (sent && logsSent) remove(base);
      // Sent, but its logs did not follow: keep the pair under the same name
      // (so the week it has to try in keeps running) with the id written in,
      // and only the upload is retried next launch.
      else if (sent) writeFileSync(join(dir, `${base}${REPORT_EXT}`), JSON.stringify({ report: entry.report, id }));
      continue;
    }
    if (await postLogs(entry.id, archive) !== "retry") remove(base);
  }
}

// Auto-update (packaged builds only -- see src/updater.js for the decision
// rules). Checks GitHub Releases after the window is up, downloads in the
// background, and lets the page offer "Restart to update"; nothing is ever
// forced. electron-updater validates the new build's code signature, which is
// why signing came first. Errors are logged and swallowed: an update check
// must never break a working app.
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

let updaterStarted = false;
async function startUpdater(win, kitDir) {
  // Boot can run more than once (the error screen's Retry); the updater's
  // listeners and its network check must not.
  if (updaterStarted) return;
  updaterStarted = true;
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
    // A downloaded update applies on plain quit too -- but not on Windows:
    // there the update is an NSIS run that fails, after the window is gone,
    // whenever another program holds a file in the install folder. That path
    // has a pre-flight (shell:restart-to-update below) and a quit handler
    // cannot run it, so Windows keeps the button as the one way in.
    autoUpdater.autoInstallOnAppQuit = !IS_WIN;
    const announce = (event, info) => {
      const next = nextUpdateState(updateState, event, info);
      if (next === updateState) return;
      updateState = next;
      if (!win.isDestroyed()) win.webContents.send("shell:update-state", updateState);
    };
    autoUpdater.on("update-available", (info) => {
      shellLog(`PERSODUB_UPDATE available ${info?.version ?? ""}`);
      announce("update-available", info);
    });
    autoUpdater.on("download-progress", (info) => announce("download-progress", info));
    autoUpdater.on("update-downloaded", (info) => {
      updateDownloaded = true;
      shellLog(`PERSODUB_UPDATE downloaded ${info?.version ?? ""}`);
      announce("update-downloaded", info);
      // Test-only hook: lets the end-to-end update test apply the swap without
      // a human clicking the banner. (true, false) = silent, no relaunch --
      // the test verifies the version stamp on disk, and a relaunched app
      // would fight the real one over the sidecar port. Never set outside tests.
      if (process.env.PERSODUB_TEST_AUTO_RESTART === "1") {
        if (engines) engines.stopAll();
        autoUpdater.quitAndInstall(true, false);
      }
    });
    autoUpdater.on("error", (err) => shellLog(`PERSODUB_UPDATE check failed: ${String(err?.message || err)}`));
    await autoUpdater.checkForUpdates();
  } catch (err) {
    shellLog(`PERSODUB_UPDATE unavailable: ${String((err && err.message) || err)}`);
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
        shellLog(`PERSODUB_KIT could not carry models over: ${String((err && err.message) || err)}`);
      }
      abandonedKitDir = cfg.kitDir;
      cfg = { ...cfg, kitDir: freshKitDir };
    }
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
    // that was never installed is left alone here -- a later task adds the
    // IPC to install one on demand.
    installCtx = payload ? { kitDir: cfg.kitDir, payloadDir: payload, download, extract: extractTarGz, run, abandonedKitDir } : null;
    // A pack's "installing" stamp left by a crash would read as downloading forever.
    for (const p of PACKS) rmSync(packInstallingMarker(cfg.kitDir, p.id), { force: true });
    const all = installCtx ? buildSteps(installCtx) : null;
    const toRun = all && [
      ...baseSteps(all),
      ...PACKS.filter((p) => packInstalled(cfg.kitDir, p.id)).flatMap((p) => packSteps(all, p.id)),
    ];
    if (kitOk && payload) {
      const open = await openSteps(toRun);
      unfinished = open.length > 0;
      if (unfinished) shellLog(`PERSODUB_KIT resuming an unfinished install: ${open.map((s) => s.id).join(", ")}`);
    }
    if (!kitOk || unfinished) {
      if (!payload) {
        await win.loadFile(join(HERE, "screens", "not-installed.html"), {
          query: { v: app.getVersion(), kitDir: cfg.kitDir, missing: checkKit(cfg.kitDir, kitVersion).missing.join(",") },
        });
        return;
      }
      // Before the first byte: a path Windows cannot reach the bottom of would
      // otherwise fail tens of gigabytes later, deep inside a venv, as a
      // file-not-found nobody can act on.
      const tooLong = kitPathTooLong(cfg.kitDir);
      if (tooLong) {
        countUsage("install_failure", cfg.kitDir, "path-too-long");
        sendReport({ kind: "install", kitDir: cfg.kitDir, code: "path-too-long", message: tooLong });
        await win.loadFile(join(HERE, "screens", "error.html"), {
          // No logDir: this stopped before a byte was written, so there is no
          // log to point at.
          query: { v: app.getVersion(), title: "Choose a shorter install location", message: tooLong },
        });
        return;
      }
      // The other preflight, and for the same reason: five machines reported a
      // disk-full from deep inside a step, after gigabytes had already been
      // downloaded. Only the steps still missing are counted, so a half-done
      // install asks for the remainder rather than the whole kit again.
      const stillNeeded = await bytesStillNeeded(toRun);
      const noRoom = notEnoughSpace(stillNeeded, await freeSpaceAt(cfg.kitDir));
      if (noRoom) {
        countUsage("install_failure", cfg.kitDir, "disk-full");
        sendReport({ kind: "install", kitDir: cfg.kitDir, code: "disk-full", message: noRoom });
        await win.loadFile(join(HERE, "screens", "error.html"), {
          query: { v: app.getVersion(), title: "Not enough space to install", message: noRoom },
        });
        return;
      }
      await win.loadFile(join(HERE, "screens", "installing.html"), {
        query: {
          // Same kit again (an update) or a first install: the screen's title.
          mode: existsSync(join(cfg.kitDir, KIT_ENV)) ? "update" : "install",
          // What the steps still to run add up to -- the figure the title shows.
          bytes: String(stillNeeded),
        },
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
        const message = String((err && err.message) || err);
        const code = classifyError(message, { install: true });
        countUsage("install_failure", cfg.kitDir, code, failedStep);
        sendReport({ kind: "install", kitDir: cfg.kitDir, code, step: failedStep, message });
        await win.loadFile(join(HERE, "screens", "error.html"), {
          query: {
            v: app.getVersion(),
            title: "The install could not finish",
            message: String((err && err.message) || err),
            logDir: cfg.kitDir,
          },
        });
        return;
      }
    }
    shellLog(`PERSODUB_KIT kitDir=${cfg.kitDir} version=${kitVersion ?? "unknown"}`);
  }

  // The update check starts here -- before the engines, which take up to a
  // minute to come up and which the check used to wait on before even asking.
  // On the install path it starts once the install above has succeeded, since
  // that is what this line sits after. Whatever it learns is re-sent on every
  // page load below, so the app page gets it the moment it appears.
  startUpdater(win, cfg.kitDir); // deliberately not awaited: boot never waits on the network
  await win.loadFile(join(HERE, "screens", "loading.html"), { query: { v: app.getVersion() } });
  try {
    engines = await startEngines(cfg, {
      logDir: join(app.getPath("userData"), "logs"),
      appVersion: app.getVersion(), // desktop/package.json -- the one place the version lives
      preferredBackendPort: readRememberedPorts().backend,
    });
    rememberPorts({ backend: engines.port });
    await win.loadURL(engines.url);
    shellLog(`PERSODUB_READY ${engines.url}`);
    bootedKitDir = cfg.kitDir;
    countUsage("app_launch", cfg.kitDir);
    // Reports from earlier launches that had no network. Deliberately not
    // awaited, and after the page is up: the queue is never the reason a
    // launch is slow.
    void flushReports(cfg.kitDir).catch(() => {});
  } catch (err) {
    // The kit installed fine and the app still cannot run. Such a machine fires
    // no other event -- install_failure's other codes do not apply and
    // PERSODUB_READY was never reached -- so without this it is invisible.
    countUsage("install_failure", cfg.kitDir, "engine-start");
    sendReport({ kind: "install", kitDir: cfg.kitDir, code: "engine-start", message: String((err && err.message) || err) });
    await win.loadFile(join(HERE, "screens", "error.html"), {
      query: { v: app.getVersion(), message: String((err && err.message) || err), logDir: String((err && err.logDir) || "") },
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

// "Saved to Downloads · Show". The page knows where the app wrote a file and
// asks for it to be shown; this decides whether it may be. Only the two
// folders this app writes into (revealPolicy.js) -- a reveal that took any
// path the page named would be a way to point the user at any file on the
// disk. A refusal is logged and answered quietly: the page's own line has
// already said where the file went.
ipcMain.handle("shell:reveal", (_e, target) => {
  const folders = [app.getPath("downloads"), bootedKitDir].filter(Boolean);
  if (!revealAllowed(target, folders)) {
    shellLog(`PERSODUB_REVEAL refused: ${String(target).slice(0, 200)}`);
    return { ok: false };
  }
  shell.showItemInFolder(target);
  return { ok: true };
});

app.whenReady().then(() => {
  // One greppable line naming the running version -- the e2e update test (and
  // any future bug report) reads it instead of guessing from filenames.
  shellLog(`PERSODUB_VERSION ${app.getVersion()}`);

  // The app server names the file (dub_en.mp4); the folder comes from the job's
  // date and project, so three episodes do not collapse into "dub_en (1).mp4".
  // Nothing here is fatal: on any failure Electron picks the path the way it
  // always did -- which is also what happens when the UI runs in a plain
  // browser and never sent us the job.
  session.defaultSession.on("will-download", (_event, item, webContents) => {
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
  // Packaged builds carry build/icon.icns / icon.ico; a dev run (npm start)
  // would otherwise show Electron's own icon in the dock and the taskbar.
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(join(HERE, "build", "icon.png")); } catch { /* cosmetic */ }
  }
  const win = new BrowserWindow({
    icon: join(HERE, "build", "icon.png"),
    // What the frame is painted with before the first page arrives. The app is
    // dark (0.5.5), and Electron's default white flashed on every launch.
    backgroundColor: "#1e1e22",
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
  // Every page load -- the app page arriving after boot, or a reload mid
  // download -- gets the update's current state again; announcements sent to
  // the loading screen would otherwise be the last the app page never hears.
  win.webContents.on("did-finish-load", () => {
    if (updateState && !win.isDestroyed()) win.webContents.send("shell:update-state", updateState);
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
    const detail = String((msg && msg.detail) || "");
    const code = status === "error" ? classifyError(detail) : undefined;
    countUsage(status === "done" ? "dub_success" : "dub_failure", bootedKitDir, code);
    // Only a failure is worth a report, and only the shell may name the job:
    // the page is a web page, so its id is checked against the shape a job id
    // has before it is put in a URL.
    if (status === "error") {
      const jobId = /^[0-9a-f]{6,32}$/.test(String((msg && msg.job) || "")) ? msg.job : undefined;
      sendReport({ kind: "dub", kitDir: bootedKitDir, code, message: detail, jobId });
    }
  });

  // An erase that failed. Same rules as a dub's: only a failure travels, a
  // cancel is not one, and the job id is checked against the shape an id has
  // before it goes anywhere near a URL. Erasing subtitles is the new thing in
  // 0.5.5 and so the likeliest of the three to fail on a machine nobody here
  // has seen -- and it was the only kind that sent nothing at all
  // (user, 2026-09-11).
  ipcMain.on("shell:count-erase", (_e, msg) => {
    const status = msg && msg.status;
    if (status !== "done" && status !== "error") return;
    const detail = String((msg && msg.detail) || "");
    const code = status === "error" ? classifyError(detail) : undefined;
    countUsage(status === "done" ? "erase_success" : "erase_failure", bootedKitDir, code);
    if (status === "error") {
      const jobId = /^[0-9a-f]{6,32}$/.test(String((msg && msg.job) || "")) ? msg.job : undefined;
      sendReport({ kind: "erase", kitDir: bootedKitDir, code, message: detail, jobId });
    }
  });

  // Packs: the heavy bundles (the engines venv with Demucs, the Ollama
  // runtime) the first install leaves out. The page asks for one when a dub
  // needs it; the install runs the pack's own steps from the table the boot
  // install uses, reports on the same progress channel tagged with the pack,
  // then starts the pack's process -- so dubbing goes on without a restart.
  let packCancelled = false;
  let packInFlight = null;   // one pack at a time: two at once shared one progress and one Cancel
  ipcMain.handle("shell:install-pack", async (_e, id) => {
    if (!PACKS.some((p) => p.id === id)) return { ok: false, reason: `Unknown pack: ${id}` };
    if (!installCtx) return { ok: false, reason: "This build carries no bundled files to install from." };
    if (packInFlight) return { ok: false, reason: `${packInFlight} is still installing. Wait for it to finish.` };
    const steps = packSteps(buildSteps(installCtx), id);
    const noRoom = notEnoughSpace(await bytesStillNeeded(steps), await freeSpaceAt(installCtx.kitDir));
    if (noRoom) return { ok: false, reason: noRoom };
    packCancelled = false;
    packInFlight = id;
    const marker = packInstallingMarker(installCtx.kitDir, id);
    try {
      mkdirSync(join(installCtx.kitDir, ".install"), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
      shellLog(`PERSODUB_PACK install ${id}: ${steps.map((s) => s.id).join(", ")}`);
      // The page gets the pack's overall percent on every event (installer.js
      // packPercent), not the running step's own -- a pip step has none.
      const done = new Set();
      let lastPct = 0;
      try {
        await runInstall(steps, {
          onProgress: (p) => {
            if (p.state === "start" || p.state === "done" || p.state === "error") shellLog(`PERSODUB_PACK ${id} ${p.stepId} ${p.state}${p.detail ? ": " + p.detail.slice(0, 300) : ""}`);
            if (p.state === "done" || p.state === "skipped") done.add(p.stepId);
            // A progress line without a percent (unpacking, a pip line) keeps
            // the pack's last one: the dialog fell back to 0% for those (2026-09-08).
            const pct = p.state === "progress" && p.pct == null
              ? lastPct
              : packPercent(steps, done, p.stepId, p.state === "progress" ? p.pct : null);
            lastPct = pct;
            if (!win.isDestroyed()) win.webContents.send("shell:install-progress", { ...p, pack: id, pct });
          },
        });
      } catch (err) {
        const full = String((err && err.message) || err);
        shellLog(`PERSODUB_PACK install ${id} failed: ${full}`);
        return { ok: false, reason: packCancelled ? "Cancelled." : downloadInterrupted(full) ? DOWNLOAD_INTERRUPTED : lastReason(full) };
      }
      if (engines && engines.startPack) {
        // The last step's line would sit in the dialog for the ~40 s the
        // process takes to answer; say what is happening instead.
        if (!win.isDestroyed()) win.webContents.send("shell:install-progress", { pack: id, stepId: "start", title: "Installed. Starting it up", state: "progress", pct: 100 });
        try {
          await engines.startPack(id);
          shellLog(`PERSODUB_PACK ${id} process up: ${JSON.stringify(readRuntime(installCtx.kitDir))}`);
        } catch (err) {
          shellLog(`PERSODUB_PACK ${id} installed but did not start: ${String((err && err.message) || err)}`);
          return { ok: false, reason: `Installed, but it could not start: ${lastReason(String((err && err.message) || err))}` };
        }
      }
      shellLog(`PERSODUB_PACK install ${id} ok`);
      return { ok: true };
    } finally {
      packInFlight = null;
      rmSync(marker, { force: true });
    }
  });
  ipcMain.handle("shell:cancel-pack", async () => {
    packCancelled = true;
    cancelCurrent();   // the step's process dies, runInstall rejects, install-pack answers Cancelled
  });
  ipcMain.handle("shell:remove-pack", async (_e, id) => {
    const pack = PACKS.find((p) => p.id === id);
    const kitDir = installCtx ? installCtx.kitDir : bootedKitDir;
    if (!pack) return { ok: false, reason: `Unknown pack: ${id}` };
    if (!kitDir) return { ok: false, reason: "No kit to remove it from." };
    if (engines && engines.stopPack) engines.stopPack(id);
    // The pack's folders and its steps' done-stamps, so a later install runs
    // the steps again rather than skipping them on a stale stamp. Models
    // pulled through Ollama stay: they are listed and removed as models.
    const dirs = PACK_DIRS[id] || [];
    try {
      for (const d of dirs) rmSync(join(kitDir, d), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      for (const step of pack.steps) rmSync(join(kitDir, ".install", `${step}.ok`), { force: true });
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
    // The eraser's two keys go with its files: the app judges the pack by
    // whether kit.env carries them, so a leftover key would point the app at
    // a python that is no longer there.
    if (id === "subtitle-eraser") syncEraserKitEnv(kitDir);
    return { ok: true };
  });
  ipcMain.handle("shell:pack-status", async () => {
    const kitDir = installCtx ? installCtx.kitDir : bootedKitDir;
    return Object.fromEntries(PACKS.map((p) => [p.id, kitDir && packInstalled(kitDir, p.id) ? "ready" : "missing"]));
  });

  // What the page needs to say "Report sent - #142": whether reports are on at
  // all, and the last one that went out. A page that loads after the report
  // was sent (the error screen's own reload) reads it back rather than missing
  // the announcement.
  ipcMain.handle("shell:last-report", async () => ({
    mode: bootedKitDir ? reportMode(bootedKitDir) : "off",
    last: lastReport,
  }));

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
      shellLog(`PERSODUB_UPDATE lock check: ${lockers.length} foreign holder(s)${lockers.length > 0 ? " -- " + lockers.map((l) => l.exe || l.name).join(", ") : ""}`);
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
    // (silent, relaunch): without the flags the NSIS wizard opened and asked
    // for three clicks (user, Next, Finish) on 2026-09-08. Mac ignores them.
    electronUpdater.autoUpdater.quitAndInstall(true, true);
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
