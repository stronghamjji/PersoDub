import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freeSpaceAt } from "./config.js";
import { readKitVersion } from "./engineCheck.js";
import { packInstalled, torchVariantFor, PACKS } from "./installSpec.js";
import { analyticsFile, loadState, savedDevice, saveState } from "./analytics.js";
import { probesFor, runProbes } from "./diagnostics.js";
import { buildInquiry, buildReport, collectEnvironment, describeDevice, maskText, MAX_DETAILS_CHARS, resolveReportMode, withoutEncodedNames } from "./report.js";
import { buildLogArchive } from "./reportLogs.js";
import { ARCHIVE_EXT, REPORT_EXT, partitionQueue, pendingWork, queueBase } from "./reportQueue.js";
import { envWithKit } from "./kitEnv.js";
import { kitEdition } from "./edition.js";
import { readFileEnd } from "./fileEnd.js";

// Automatic failure reports. The usage count (usageIpc.js) says a dub failed;
// this says why -- the machine, the step, the error, and the logs -- and it
// becomes a GitHub issue without the user needing an account or knowing what
// an issue is. What may leave is decided in report.js (an allow-list,
// masked); this is the wiring: write the failure down, gather, send, and keep
// whatever did not land for the next launch.
//
// A job that finished goes the same way under the same switch, as a record
// (code "ok", report.js): its logs and how long it took, to the relay's
// /record, which keeps them for the private dashboard and never opens an
// issue (owner, 2026-10-22).
//
// The production edition's Service inquiry never goes to the relay: Cloudflare
// is not among the processors Perso's privacy policy lists (owner,
// 2026-10-27). It goes straight to the support web app the build names
// (PERSODUB_INQUIRY_URL, edition.js BUILD_KEYS), which mails it to the support
// inbox, a bug report with the same masked logs a failure sends (sendInquiry
// below). It waits in the same queue, and goes whatever the switch says: the
// person pressed Send, after agreeing to it on the form.
export const REPORT_ENDPOINT = "https://persodub-report.persodub.workers.dev";
// Reports wait here rather than in userData: a report belongs to the kit that
// produced it, and a user who deletes a kit is done with its failures too.
const reportsDir = (kitDir) => join(kitDir, "reports");

// The engines' console logs, beside shell.log (orchestrator.js): where a voice
// engine or Ollama that crashed says why. Their last 2 MB is plenty of history.
const ENGINE_LOGS = { backend: "backend.log", sidecar: "sidecar.log", ollama: "ollama.log" };
const ENGINE_LOG_BYTES = 2 * 1024 * 1024;

// A bug inquiry's logs ride inside it as base64. Past 20 MB they are left out
// and its details say so, so the inquiry itself still lands.
const MAX_INQUIRY_LOGS = 20 * 1024 * 1024;
const LOGS_LEFT_OUT = "\n\n(logs too large, not attached)";

// The Perso account an inquiry is from: the production edition's signed-in
// account, its full e-mail and Perso's number for it (`signedIn`, src/auth.js
// signedInAccount), or empty strings signed out and in the open-source edition.
function accountForInquiry(signedIn) {
  const account = signedIn() || {};
  return { email: account.email || "", id: account.id || "" };
}

/** Write a queue entry (and its archive) into the kit's queue, under its base name. */
function queueReport(kitDir, base, entry, archive) {
  try {
    const dir = reportsDir(kitDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}${REPORT_EXT}`), JSON.stringify(entry));
    if (archive) writeFileSync(join(dir, `${base}${ARCHIVE_EXT}`), archive);
  } catch { /* a report that cannot be saved is a report that is lost, nothing more */ }
}

/** Take a queue entry, and its archive, out of the kit's queue. */
function unqueue(kitDir, base) {
  for (const ext of [REPORT_EXT, ARCHIVE_EXT]) rmSync(join(reportsDir(kitDir), `${base}${ext}`), { force: true });
}

/**
 * The shell's failure reports, for this app. `ctx.engines` is read each time a
 * report is gathered: the backend's half of a report comes from engines that
 * may not be up yet, or never came up. `inquiryUrl` is the support web app
 * Customer support's inquiries go to, "" when the build names none, and
 * `account` answers the signed-in Perso account an inquiry is from.
 * `fetchImpl` is the real fetch, and `probeImpl` the real probes, everywhere
 * but the tests.
 */
export function createReporter({ app, BrowserWindow, ctx, shellLog, inquiryUrl = "", account = () => null,
                                 fetchImpl = fetch, probeImpl = runProbes }) {
  // The report's install id, which the relay's daily limit counts by, lives in
  // its own file and is minted only by a run that really reports. The id the
  // dashboard knows a computer by is analytics.json's, which the launch makes
  // (analytics.js keepDevice).
  const REPORT_STATE = () => join(app.getPath("userData"), "reports.json");
  // What the page shows once a report has gone out ("Report sent - #142").
  let lastReport = null;
  // The queue entries being worked on right now, by sendReport or a flush, by
  // base name. Flushes overlap -- the one as a launch starts, the one after an
  // install stopped, the one once the app is up -- and a report sent twice is
  // counted twice, and spends two of the five a day the relay takes from one
  // machine. An entry in here is left to whoever has it.
  const inHand = new Set();

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

  // The newest job, for a bug inquiry's logs: the one the person most likely
  // means. None when the engines are not up or there is no job yet.
  async function latestJobId() {
    if (!ctx.engines || !ctx.engines.url) return "";
    try {
      const res = await fetchImpl(`${ctx.engines.url}/api/dub/jobs`, { signal: AbortSignal.timeout(5000) });
      return res.ok ? (((await res.json()).jobs || [])[0] || {}).id || "" : "";
    } catch {
      return "";
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
  async function collectReport({ kind, kitDir, step, code, message, jobId, timing }) {
    const home = app.getPath("home");
    const bundle = await fetchBundle(jobId);
    const job = (bundle && bundle.job) || {};
    const logsDir = join(app.getPath("userData"), "logs");
    const shellLogText = maskText(readFileEnd(join(logsDir, "shell.log")), { home, kit: kitDir });
    // The encoded names out first, so that the masks see every path in them.
    const engineLogs = Object.fromEntries(Object.entries(ENGINE_LOGS)
      .map(([key, file]) => [key, withoutEncodedNames(readFileEnd(join(logsDir, file), ENGINE_LOG_BYTES))]));
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
      // The computer's id, read and never minted (the launch makes it), counts
      // on or off: the one number the dashboard tells computers apart by
      // (owner, 2026-10-22).
      device: savedDevice(analyticsFile(app)).slice(0, 12),
      env: collectEnvironment({
        appVersion: app.getVersion(),
        kitVersion: readKitVersion(kitDir) || "",
        torchVariant: torchVariantFor(kitDir),
        packs,
        freeDiskBytes: await freeSpaceAt(kitDir),
        edition: kitEdition(kitDir) || "",
        installed: app.isPackaged,
      }),
      timing,
      logTails: {
        shell: shellLogText,
        app: (bundle && bundle.logTails && bundle.logTails.app) || "",
        // The job's whole log when the backend sent it, not its tail: the
        // report keeps the log's first lines too (report.js maskTail).
        job: (bundle && bundle.logs && bundle.logs.job) || (bundle && bundle.logTails && bundle.logTails.job) || "",
        ...engineLogs,
      },
      diagnostics,
    });
    const archive = buildLogArchive({
      shell: shellLogText,
      app: (bundle && bundle.logs && bundle.logs.app) || "",
      job: (bundle && bundle.logs && bundle.logs.job) || "",
      ...Object.fromEntries(Object.entries(engineLogs).map(([key, text]) => [key, maskText(text, { home, kit: kitDir })])),
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
   * the caller -- a first attempt keeps it in the entry its failure was written
   * to, a retry updates the one it already has, and the difference matters:
   * re-queueing under a new name would restart the week a report is allowed to
   * keep trying for.
   */
  async function deliver(report, archive) {
    // A finished job's record has a door of its own, which never reaches
    // GitHub, and nothing to announce: nothing broke.
    const record = report.outcome === "ok";
    const answer = await postJson(REPORT_ENDPOINT + (record ? "/record" : "/report"), report);
    if (!answer || !answer.id) return { sent: false, id: null, logsSent: false };
    const logs = archive ? await postLogs(answer.id, archive) : "ok";
    if (report.userSide) shellLog(`[persodub-report] sent (no issue: the user's own situation) id ${answer.id}`);
    else if (!record) {
      shellLog(`[persodub-report] sent id ${answer.id} issue #${answer.issue ?? "?"}${answer.url ? ` (${answer.url})` : ""}`);
      announceReport({ id: answer.id, issue: answer.issue ?? null, url: answer.url ?? null, dedup: !!answer.dedup });
    }
    return { sent: true, id: answer.id, logsSent: logs !== "retry" };
  }

  /**
   * One inquiry, whole, to the support web app: its fields, and a bug's
   * masked logs as base64 under `logs`. The web app answers through a
   * redirect, which fetch follows, with {ok, id} once the mail has gone and
   * {error} when it has not. The id, or null.
   */
  async function postInquiry(inquiry, archive) {
    let body = inquiry;
    if (inquiry.type === "bug" && archive) {
      const logs = archive.toString("base64");
      body = logs.length <= MAX_INQUIRY_LOGS ? { ...inquiry, logs }
        : { ...inquiry, details: inquiry.details.slice(0, MAX_DETAILS_CHARS - LOGS_LEFT_OUT.length) + LOGS_LEFT_OUT };
    }
    const answer = await postJson(inquiryUrl, body, 20000);
    const id = answer && answer.ok === true && answer.id ? String(answer.id) : null;
    shellLog(`[persodub-report] inquiry ${id ? `sent ${id}` : "queued"}`);
    return id;
  }

  // Fire and forget: the caller goes on at once and nothing it does waits on
  // the network. The promise is returned for the tests; it never rejects.
  function sendReport(opts) {
    return (async () => {
      let base = null;
      try {
        const kitDir = opts.kitDir;
        if (!kitDir) return;
        const mode = reportMode(kitDir);
        if (mode === "off") return;
        // Every failure is sent; only the ones somebody here could act on
        // become an issue. A full disk and a refused cloud key are the user's
        // own situation (report.js userSide) -- told on screen, kept for the
        // private dashboard, and never one more issue for a person to read and
        // close (user, 2026-09-11; owner, 2026-10-28).
        // The install id is minted (and written) only on a run that really
        // reports -- the same rule the counts follow, so a machine that never
        // reports never gets one, and no file appears claiming otherwise. It has
        // to happen BEFORE the report is built, or the id in the report and the
        // id on disk would be two different ids.
        if (mode === "on") {
          saveState(REPORT_STATE(), loadState(REPORT_STATE()));
          // The failure goes on disk before anything is gathered, and before the
          // first await. Gathering and sending take seconds -- the backend, the
          // probes, the relay -- and a person who closes the error screen at
          // once quits the app before they are done: an install that ran out of
          // memory on 2026-10-20 was counted and never reported. The next
          // launch's flush builds the report from this entry.
          const at = Date.now();
          base = queueBase(randomBytes(6).toString("hex"), at);
          inHand.add(base);
          // A finished job's record is written down the same way, its timing
          // with it: the job's record forgets it at the next restart.
          const { kind, code, step, message, jobId, timing } = opts;
          queueReport(kitDir, base, { failure: { kind, code, step, message, jobId, timing }, at });
        }
        const { report, archive } = await collectReport(opts);
        if (mode === "debug") {
          shellLog(`[persodub-report] would send: ${JSON.stringify(report)}`);
          shellLog(`[persodub-report] would attach ${archive ? archive.length : 0} bytes of logs`);
          return;
        }
        const { sent, id, logsSent } = await deliver(report, archive);
        // Landed whole: off the queue. Otherwise the entry becomes the report
        // itself (id null until the relay has taken it), under the failure's
        // own name, so the week it may keep trying in counts from the failure.
        // At least once rather than at most: a launch that ends between the
        // relay's answer and this line sends it again, and a sighting counted
        // twice is better than a failure nobody hears of.
        if (sent && logsSent) unqueue(kitDir, base);
        else queueReport(kitDir, base, { report, id }, archive);
      } catch { /* a failure to report a failure stops here */ } finally {
        if (base) inHand.delete(base);
      }
    })();
  }

  /**
   * Customer support's Service inquiry, from the page, to the support web app
   * (postInquiry). Written into the queue first, a bug's logs beside it as a
   * failure's are, so one that cannot land now goes with the next launch's
   * flush. Answers {id} once the web app has it, {queued: true} when it waits,
   * {needReplyTo: true}, sending nothing, when no one could be answered (no
   * Reply-to, and an account with no e-mail), and null when it could not even
   * be built or the build names nowhere to send it.
   */
  async function sendInquiry(form, { kitDir, os, osVersion }) {
    if (!kitDir) return null;
    if (!inquiryUrl) {
      shellLog("[persodub-report] inquiry no destination");
      return null;
    }
    const from = accountForInquiry(account);
    const inquiry = buildInquiry({
      ...form, os, osVersion, version: app.getVersion(), edition: kitEdition(kitDir) || "",
      device: describeDevice({ installed: app.isPackaged, edition: kitEdition(kitDir) || "" }),
      accountEmail: from.email, accountId: from.id,
      // The computer's id, the one the dashboard knows it by and hides the
      // owner's own computers by (EXCLUDED_DEVICES).
      installId: savedDevice(analyticsFile(app)) || loadState(REPORT_STATE()).device,
    });
    if (!inquiry) return null;
    if (!inquiry.replyTo && !inquiry.accountEmail) return { needReplyTo: true };
    const base = queueBase(randomBytes(6).toString("hex"), Date.now());
    inHand.add(base);
    try {
      const archive = inquiry.type === "bug"
        ? (await collectReport({ kind: "unknown", kitDir, code: "unknown", jobId: await latestJobId() })).archive : null;
      queueReport(kitDir, base, { inquiry, id: null }, archive);
      const id = await postInquiry(inquiry, archive);
      if (id) unqueue(kitDir, base);
      return id ? { id } : { queued: true };
    } catch {
      return null;
    } finally {
      inHand.delete(base);
    }
  }

  /**
   * Signed out: every inquiry still waiting goes, its logs with it. Each
   * holds the account's full e-mail, which must not outlive the sign-in on
   * this computer. Failure reports stay.
   */
  function dropInquiries(kitDir) {
    const dir = kitDir ? reportsDir(kitDir) : "";
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    let dropped = 0;
    for (const name of names.filter((n) => n.endsWith(REPORT_EXT))) {
      let entry = null;
      try { entry = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
      if (!entry || !entry.inquiry) continue;
      unqueue(kitDir, name.slice(0, -REPORT_EXT.length));
      dropped++;
    }
    if (dropped) shellLog(`[persodub-report] inquiry dropped at sign-out: ${dropped}`);
  }

  /**
   * Reports that could not be sent when they happened, and failures a launch
   * wrote down but did not live to report. Runs as a launch starts, after an
   * install that stopped, and once the app is up (bootFlow.js), and never
   * blocks any of them: the network is the reason they are here.
   */
  async function flushReports(kitDir) {
    const dir = reportsDir(kitDir);
    if (!kitDir || !existsSync(dir)) return;
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    const { retry, expired } = partitionQueue(names);
    const remove = (base) => unqueue(kitDir, base);
    for (const base of expired) remove(base);
    // Off or debug: nothing leaves and nothing is deleted, but an inquiry,
    // which the person sent themselves, once the build names where it goes.
    const reporting = reportMode(kitDir) === "on";
    for (const base of retry) {
      if (inHand.has(base)) continue;
      inHand.add(base);
      try { await flushOne(base); } finally { inHand.delete(base); }
    }

    // One entry: whatever its json says is still to do.
    async function flushOne(base) {
      let entry = null;
      try { entry = JSON.parse(readFileSync(join(dir, `${base}${REPORT_EXT}`), "utf8")); } catch { entry = null; }
      if (entry && entry.inquiry ? !inquiryUrl : !reporting) return;
      const archivePath = join(dir, `${base}${ARCHIVE_EXT}`);
      const hasArchive = existsSync(archivePath);
      let work = pendingWork(entry, { hasArchive });
      if (work === "done") { remove(base); return; }
      let archive = hasArchive ? readFileSync(archivePath) : null;
      // An inquiry goes whole, its logs inside it, to the web app.
      if (entry.inquiry) {
        if (await postInquiry(entry.inquiry, archive)) remove(base);
        return;
      }
      if (work === "collect") {
        // A dub's or an erase's report is half the backend's -- its stage and
        // its job's log, which only the engines can give -- and built without
        // them it would fingerprint as a failure nobody has seen. One that
        // names a job waits for a flush with the engines up.
        if (entry.failure.jobId && !(ctx.engines && ctx.engines.url)) return;
        // Only the failure was written down: the launch that met it ended
        // before its report was built (sendReport). It is built now, from logs
        // that still hold that launch's lines, and kept as an ordinary unsent
        // report before it goes -- the install id minted first, as there.
        saveState(REPORT_STATE(), loadState(REPORT_STATE()));
        const built = await collectReport({ ...entry.failure, kitDir });
        entry = { report: built.report, id: null };
        archive = built.archive;
        queueReport(kitDir, base, entry, archive);
        work = "send";
      }
      if (work === "send") {
        const { sent, id, logsSent } = await deliver(entry.report, archive);
        if (sent && logsSent) remove(base);
        // Sent, but its logs did not follow: keep the pair under the same name
        // (so the week it has to try in keeps running) with the id written in,
        // and only the upload is retried next launch.
        else if (sent) writeFileSync(join(dir, `${base}${REPORT_EXT}`), JSON.stringify({ report: entry.report, id }));
        return;
      }
      if (await postLogs(entry.id, archive) !== "retry") remove(base);
    }
  }

  return { sendReport, sendInquiry, dropInquiries, flushReports, reportMode, lastReport: () => lastReport };
}
