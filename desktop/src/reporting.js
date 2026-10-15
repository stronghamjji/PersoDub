import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freeSpaceAt } from "./config.js";
import { readKitVersion } from "./engineCheck.js";
import { packInstalled, torchVariantFor, PACKS } from "./installSpec.js";
import { loadState, saveState } from "./analytics.js";
import { probesFor, runProbes } from "./diagnostics.js";
import { buildReport, collectEnvironment, maskText, resolveReportMode, worthReporting } from "./report.js";
import { buildLogArchive } from "./reportLogs.js";
import { ARCHIVE_EXT, REPORT_EXT, partitionQueue, pendingWork, queueBase } from "./reportQueue.js";
import { envWithKit } from "./kitEnv.js";

// Automatic failure reports. The usage count (usageIpc.js) says a dub failed;
// this says why -- the machine, the step, the error, and the logs -- and it
// becomes a GitHub issue without the user needing an account or knowing what
// an issue is. What may leave is decided in report.js (an allow-list,
// masked); this is the wiring: gather, send, and if that fails, keep it for
// the next launch.
export const REPORT_ENDPOINT = "https://persodub-report.persodub.workers.dev";
// Reports wait here rather than in userData: a report belongs to the kit that
// produced it, and a user who deletes a kit is done with its failures too.
const reportsDir = (kitDir) => join(kitDir, "reports");

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

/**
 * The shell's failure reports, for this app. `ctx.engines` is read each time a
 * report is gathered: the backend's half of a report comes from engines that
 * may not be up yet, or never came up. `fetchImpl` is the real fetch, and
 * `probeImpl` the real probes, everywhere but the tests.
 */
export function createReporter({ app, BrowserWindow, ctx, shellLog, fetchImpl = fetch, probeImpl = runProbes }) {
  // The install id lives in its own file, not analytics.json: the two switches
  // are independent, so a user who turned the counts off must not get an id
  // minted for them by the report path, or a file that says otherwise.
  const REPORT_STATE = () => join(app.getPath("userData"), "reports.json");
  // What the page shows once a report has gone out ("Report sent - #142").
  let lastReport = null;

  function reportMode(kitDir) {
    return resolveReportMode({ isPackaged: app.isPackaged, env: envWithKit(kitDir) });
  }

  // The backend's half: the failed job's stage and engines, and the two logs
  // only it knows where to find. A dead engine (the boot failures, which are
  // most of what this exists for) simply means the shell reports what it has.
  async function fetchBundle(jobId) {
    if (!ctx.engines || !ctx.engines.url) return null;
    try {
      const q = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
      const res = await fetchImpl(`${ctx.engines.url}/api/report/bundle${q}`, { signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async function postJson(url, body, timeoutMs = 8000) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
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
    try {
      const res = await fetchImpl(`${REPORT_ENDPOINT}/report/${encodeURIComponent(id)}/logs`, {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: archive,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return "ok";
      // 404 the id is forgotten, 413 the archive is too big, 410 gone, 501 the
      // relay has nowhere to put logs: all final, and none of them get better by
      // being asked again tomorrow.
      return [404, 410, 413, 501].includes(res.status) ? "gone" : "retry";
    } catch {
      return "retry";
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
    // What this machine can say about this kind of failure (diagnostics.js):
    // who signed the certificate pip refused, whether the runtime files are
    // there. Four seconds at most, and a probe that fails is a line in the
    // report, never a lost report.
    const names = probesFor(code, message || job.error);
    if (names.length) shellLog(`PERSODUB_REPORT diagnostics ${names.join(", ")}`);
    const diagnostics = names.length ? await probeImpl(names, { kitDir }) : {};
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
      diagnostics,
    });
    const archive = buildLogArchive({
      shell: shellLogText,
      app: (bundle && bundle.logs && bundle.logs.app) || "",
      job: (bundle && bundle.logs && bundle.logs.job) || "",
      // The probes' answers in full, for the dashboard: the issue body keeps
      // only the first report of a fingerprint, so the second machine's
      // security product or certificate signer would otherwise be lost.
      diagnostics: names.length ? maskText(JSON.stringify(diagnostics, null, 2), { home, kit: kitDir }) : "",
    });
    return { report, archive };
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

  // Fire and forget: the caller goes on at once and nothing it does waits on
  // the network. The promise is returned for the tests; it never rejects.
  function sendReport(opts) {
    return (async () => {
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

  return { sendReport, flushReports, reportMode, lastReport: () => lastReport };
}
