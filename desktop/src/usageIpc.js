import { analyticsFile, classifyError, countEvent, dubFacts, resolveAnalyticsMode } from "./analytics.js";
import { envWithKit } from "./kitEnv.js";
import { IS_WIN } from "./platform.js";

// Usage counts. What leaves, and the switches that stop it, are decided in
// analytics.js; this is only the wiring. Every call is fire-and-forget:
// a count must never delay a launch, and countEvent never rejects, so a dead
// endpoint or a full disk costs a number and nothing else.
const COUNT_ENDPOINT = "https://persodub-count.persodub.workers.dev";

// Whether a Perso key is set -- decided here so the key itself never comes
// near the count; what travels is yes or no.
export const hasPersoKey = (kitDir) => (envWithKit(kitDir).PERSO_API_KEY || "").trim() !== "";

// The shape a job id has. An id the page hands over is checked against it
// before it goes anywhere near a URL: the page is a web page.
export const isJobId = (id) => /^[0-9a-f]{6,32}$/.test(String(id || ""));

/** countUsage(event, kitDir, errorCode, step, facts), for this app. */
export function usageCounter(app) {
  function analyticsMode(kitDir) {
    return resolveAnalyticsMode({ isPackaged: app.isPackaged, env: envWithKit(kitDir) });
  }

  return function countUsage(event, kitDir, errorCode, step, facts = {}) {
    try {
      const mode = analyticsMode(kitDir);
      if (mode === "off") return;
      void countEvent(event, {
        mode,
        stateFile: analyticsFile(app),
        url: COUNT_ENDPOINT,
        os: IS_WIN ? "windows" : "mac",
        version: app.getVersion(),
        errorCode,
        step,
        // A dub's Perso facts (dubFacts) or a launch's key flag; analytics.js
        // decides which of them may leave and in what words.
        ...facts,
      });
    } catch { /* a count is never worth interrupting a launch for */ }
  };
}

/** The page's word that a dub, an erase or a separation ended: counted, a
 *  failure reported, and a finished job's record sent. */
export function registerUsageIpc({ ipcMain, ctx, countUsage, sendReport, shellLog, lastRunClosedByUser }) {
  // A finished job's own record: which engines it ran, what it spent on Perso
  // and how long the video was, for the usage count -- which must not take the
  // page's word for any of it. A backend that will not answer costs the facts,
  // never the count.
  async function fetchJob(jobId) {
    if (!jobId || !ctx.engines || !ctx.engines.url) return null;
    try {
      const res = await fetch(`${ctx.engines.url}/api/dub/jobs/${jobId}`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // A job that finished sends its record (src/reporting.js, code "ok"): the
  // logs a failure would send, and how long the job took, off its own record
  // (`job` when the caller already has it). A job the page could not name has
  // no log to send, so it sends nothing.
  async function sendRecord(kind, jobId, job) {
    if (!jobId) return;
    const timing = dubFacts(job || await fetchJob(jobId)).timing;
    sendReport({ kind, kitDir: ctx.bootedKitDir, code: "ok", jobId, timing });
  }

  // A dub finished. The page cannot be trusted to name the outcome or the
  // reason -- it is a web page served over http -- so the status is checked
  // against the two that count and the detail is reduced to one published
  // word here. A cancel is not a failure and is deliberately not counted.
  // A job is counted and reported once. The page calls this every time it
  // draws a finished job -- opening it from the list, walking back to it, the
  // last screen being restored at launch -- and nothing remembered that the
  // job had already been sent. Nine pairs of duplicate issues came of it, and
  // the second of each pair arrived empty: a job's log is deliberately not
  // saved to disk (app/jobs.py SAVED_FIELDS), so after a restart the page has
  // nothing to send, an empty message fingerprints differently from the real
  // one, and the relay files it as a failure nobody had seen (2026-09-18).
  const countedJobs = new Set();
  ipcMain.on("shell:count-dub", async (_e, msg) => {
    const status = msg && msg.status;
    if (status !== "done" && status !== "error") return;
    const detail = String((msg && msg.detail) || "");
    // Only the shell may name the job: the page is a web page, so its id is
    // checked against the shape a job id has before it is put in a URL.
    const jobId = isJobId(msg && msg.job) ? msg.job : undefined;
    if (jobId) {
      if (countedJobs.has(jobId)) return;
      countedJobs.add(jobId);
    }
    // Which parts went through Perso, what it cost and how long the video
    // was -- off the job's own record, not the page's message.
    const job = await fetchJob(jobId);
    // A dub the app was killed under is not a failure of the dub. The engine
    // marks it on restore (app/jobs.py: a job still "running" becomes an error
    // reading "interrupted"), and the page's log tail is empty by then, so
    // without this the report went out as "unknown" -- indistinguishable from
    // a crash. It is still reported, under its own name, because an engine
    // that keeps taking the app down with it looks exactly like this from here
    // (user, 2026-09-18).
    const code = status === "error"
      ? (job && job.error === "interrupted" ? "interrupted" : classifyError(detail))
      : undefined;
    countUsage(status === "done" ? "dub_success" : "dub_failure", ctx.bootedKitDir, code, undefined, dubFacts(job));
    if (status === "done") return sendRecord("dub", jobId, job);
    // The user closed the app on it: not a fault, so no issue (user,
    // 2026-09-28). Still counted above, as "interrupted".
    if (status === "error" && code === "interrupted" && lastRunClosedByUser) {
      shellLog("[persodub-report] not sent (interrupted): the app was closed normally");
      return;
    }
    // Only a failure is worth a report.
    if (status === "error") {
      // An interrupted job has no log left to send, and an empty body reads as
      // "(no message)" in the issue. Say what happened instead.
      const message = code === "interrupted"
        ? "The app stopped without a normal quit while this job was still running."
        : detail;
      sendReport({ kind: "dub", kitDir: ctx.bootedKitDir, code, message, jobId });
    }
  });

  // An erase that ended. Same rules as a dub's: a failure is reported and a
  // finished one sends its record, a cancel is neither, and the job id is
  // checked against the shape an id has before it goes anywhere near a URL.
  // Erasing subtitles is the new thing in 0.5.5 and so the likeliest of the
  // three to fail on a machine nobody here has seen -- and it was the only
  // kind that sent nothing at all (user, 2026-09-11).
  ipcMain.on("shell:count-erase", (_e, msg) => {
    const status = msg && msg.status;
    if (status !== "done" && status !== "error") return;
    const detail = String((msg && msg.detail) || "");
    const code = status === "error" ? classifyError(detail) : undefined;
    countUsage(status === "done" ? "erase_success" : "erase_failure", ctx.bootedKitDir, code);
    const jobId = isJobId(msg && msg.job) ? msg.job : undefined;
    if (status === "done") return sendRecord("erase", jobId);
    sendReport({ kind: "erase", kitDir: ctx.bootedKitDir, code, message: detail, jobId });
  });
}
